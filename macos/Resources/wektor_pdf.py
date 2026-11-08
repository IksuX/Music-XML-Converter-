#!/usr/bin/env python3
"""
wektor_pdf.py — reads a vector PDF exported from a notation program
(Finale, MuseScore, Dorico, Sibelius — the Maestro and SMuFL fonts) and writes MusicXML.
Handles single-staff songs and multi-voice scores (e.g. a choir), including
voices hidden in some systems. Writes MusicXML without image recognition.

Notes, rests, beams, dots, ties, accidentals and barlines are read from
the exact glyph and line positions in the PDF. Lyrics, chord symbols,
rehearsal marks (ZWR/REF), title, authors and tempo come from the PDF's
text layer, so they arrive without any OCR errors.

Usage:
    python3 wektor_pdf.py input.pdf output.musicxml

Exit codes:
    0 – success (warnings in stdout as lines starting with "UWAGA:")
    3 – the PDF does not contain vector notation (e.g. a scan) — use OMR
    4 – the notation is vector-based, but the read is not credible (e.g. an unknown program) — use OMR
    1 – other error
"""
from __future__ import annotations

import os
import re
import sys
import math
from dataclasses import dataclass, field
from fractions import Fraction as F
from xml.sax.saxutils import escape

try:
    import pymupdf  # PyMuPDF >= 1.24
except ImportError:  # starsze wersje
    import fitz as pymupdf  # type: ignore

VERSION = "0.4.1"

# --------------------------------------------------------------------------- fonty nutowe

# Fonts whose glyphs are music symbols (not text).
MUSIC_FONT_HINTS = ("maestro", "petrucci", "jazz", "broadway", "engraver font",
                    "bravura", "leland", "petaluma", "finale", "sonata", "opus",
                    "musescore", "emmentaler", "feta", "gonville", "november")
# EngraverTextT is a Finale *text* font (used, e.g., for the note in "q = 120").

# Glyph mapping in the Maestro font family (Finale).
HEAD_BLACK = {"œ", "¿", "Ï"}   # ¿/Ï: główka krzyżykowa (x)
HEAD_X = {"¿", "Ï"}
HEAD_HALF = {"˙"}
HEAD_WHOLE = {"w", "W"}
HEAD_SLASH_BLACK = {"Û", "’"}
HEAD_SLASH_HALF = {"·", "‘"}
RESTS = {"Œ": F(1), "‰": F(1, 2), "≈": F(1, 4), "®": F(1, 8)}
# Ó: pauza półnutowa albo całonutowa zależnie od położenia; ∑: pauza całotaktowa
FLAGS = {"j": 1, "J": 1, "r": 2, "R": 2, "Â": 3, "Ù": 3}
ACCIDENTALS = {"#": 1, "b": -1, "n": 0, "º": -2, "Ü": 2, "Ý": 2}
CLEFS = {"&": "G", "?": "F", "B": "C", "V": "G8"}
TIME_DIGITS = set("0123456789")


# SMuFL (MuseScore 3/4, Dorico, Finale 27+, Sibelius z Bravurą…): kod znaku → odpowiednik Maestro.
SMUFL = {
    0xE0A4: "œ", 0xE0A3: "˙", 0xE0A2: "w", 0xE0A0: "w", 0xE0A9: "¿",
    0xE100: "Û", 0xE101: "Û", 0xE103: "·", 0xE104: "·",
    0xE4E3: "∑", 0xE4E4: "Ó", 0xE4E5: "Œ", 0xE4E6: "‰", 0xE4E7: "≈", 0xE4E8: "®",
    0xE240: "j", 0xE241: "J", 0xE242: "r", 0xE243: "R", 0xE244: "Â", 0xE245: "Ù",
    0xE260: "b", 0xE261: "n", 0xE262: "#", 0xE263: "Ü", 0xE264: "º",
    0xE050: "&", 0xE052: "V", 0xE062: "?", 0xE05C: "B",
    0xE08A: "c", 0xE08B: "C",
    0xE1E7: ".", 0xE044: ".",
    0xE003: "⎡", 0xE004: "⎣",
}
for _i in range(10):
    SMUFL[0xE080 + _i] = str(_i)


def is_music_font(name: str) -> bool:
    n = name.lower()
    return any(h in n for h in MUSIC_FONT_HINTS)


# --------------------------------------------------------------------------- struktury

@dataclass
class Glyph:
    c: str
    x: float          # origin x (lewa krawędź)
    y: float          # origin y (dla główek: środek)
    x1: float         # prawa krawędź
    size: float


@dataclass
class TextChar:
    c: str
    x0: float
    x1: float
    y: float          # linia bazowa
    size: float
    font: str
    span: int = -1    # numer fragmentu tekstu w PDF (MuseScore: osobny dla każdej sylaby)


@dataclass
class Staff:
    top: float
    sp: float         # odstęp między liniami
    x0: float
    x1: float
    page: int
    lines: int = 5    # 0 = pięciolinia niewidoczna (rytm)
    xlines: float = 0.0   # gdzie naprawdę kończą się linie (staff.x1 może sięgać dalej)
    band_lo: float = -1e9  # pasek pionowy „należący” do tej pięciolinii (połowa odstępu do sąsiadów)
    band_hi: float = 1e9

    def in_band(self, y: float) -> bool:
        return self.band_lo <= y <= self.band_hi

    @property
    def bottom(self) -> float:
        return self.top + 4 * self.sp

    @property
    def mid(self) -> float:
        return self.top + 2 * self.sp


@dataclass
class Stem:
    x: float
    y0: float
    y1: float


@dataclass
class Poly:
    x0: float
    x1: float
    y0: float
    y1: float
    yl: float         # wysokość środka przy lewym końcu
    yr: float         # wysokość środka przy prawym końcu
    curved: bool

    def y_at(self, x: float) -> float:
        if self.x1 - self.x0 < 1e-6:
            return (self.yl + self.yr) / 2
        t = (x - self.x0) / (self.x1 - self.x0)
        return self.yl + (self.yr - self.yl) * t


@dataclass
class Event:
    x: float                      # lewa krawędź główki / pauzy
    x1: float
    rest: bool
    heads: list = field(default_factory=list)   # [(y, glyph)]
    head_kind: str = "black"      # black/half/whole/slash/slashhalf
    base: F = F(1)
    dur: F = F(1)
    dots: int = 0
    stem: Stem | None = None
    tie_start_ys: set = field(default_factory=set)
    accs: dict = field(default_factory=dict)    # y -> alter
    measure_rest: bool = False
    pitches: list = field(default_factory=list)  # [(step, octave, alter, show_acc)]
    ties_out: set = field(default_factory=set)   # indeksy w pitches
    ties_in: set = field(default_factory=set)
    lyrics: dict = field(default_factory=dict)   # verse -> (text, syllabic, extend)
    harmonies: list = field(default_factory=list)  # [(Chord, offset Fraction)]
    slash: bool = False
    cue: bool = False
    xhead: bool = False


@dataclass
class Measure:
    x0: float
    x1: float
    events: list = field(default_factory=list)
    key: int | None = None
    time: tuple | None = None
    clef: str | None = None
    rehearsal: list = field(default_factory=list)
    words: list = field(default_factory=list)
    tempo: int | None = None
    left_bar: str | None = None    # "forward"
    right_bar: str | None = None   # "backward", "final", "double"
    ending_start: str | None = None
    ending_stop: str | None = None
    new_system: bool = False
    new_page: bool = False
    staff: Staff | None = None


@dataclass
class Chord:
    text: str
    root: str
    alter: int
    kind: str
    kind_text: str
    bass: str | None = None
    bass_alter: int = 0
    degrees: list = field(default_factory=list)


class Warnings(list):
    def add(self, msg: str):
        if msg not in self:
            self.append(msg)


# --------------------------------------------------------------------------- odczyt strony

def read_page(page, pno: int):
    glyphs: list[Glyph] = []
    texts: list[TextChar] = []
    raw = page.get_text("rawdict")
    span_no = 0
    for b in raw["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                span_no += 1
                font = s["font"]
                music = is_music_font(font)
                for ch in s["chars"]:
                    c = ch["c"]
                    if not c.strip():
                        if not music:
                            texts.append(TextChar(c, ch["bbox"][0], ch["bbox"][2], ch["origin"][1], s["size"], font, span_no))
                        continue
                    if music:
                        cp = ord(c)
                        if 0xE000 <= cp <= 0xF8FF:
                            c = SMUFL.get(cp)
                            if c is None:
                                continue   # inny znak SMuFL (np. nuta w oznaczeniu tempa)
                        glyphs.append(Glyph(c, ch["origin"][0], ch["origin"][1], ch["bbox"][2], s["size"]))
                    else:
                        texts.append(TextChar(c, ch["bbox"][0], ch["bbox"][2], ch["origin"][1], s["size"], font, span_no))

    hlines, vlines, polys, rects = [], [], [], []
    for d in page.get_drawings():
        items = d["items"]
        w = d.get("width") or 0
        if d["type"] == "s" and all(it[0] == "l" for it in items):
            for it in items:
                p1, p2 = it[1], it[2]
                if abs(p1.y - p2.y) < 0.05 and abs(p1.x - p2.x) > 0.5:
                    hlines.append((min(p1.x, p2.x), max(p1.x, p2.x), (p1.y + p2.y) / 2, w))
                elif abs(p1.x - p2.x) < 0.05 and abs(p1.y - p2.y) > 0.5:
                    vlines.append(((p1.x + p2.x) / 2, min(p1.y, p2.y), max(p1.y, p2.y), w))
        elif d["type"] == "s" and any(it[0] == "re" for it in items):
            for it in items:
                if it[0] == "re":
                    r = it[1]
                    rects.append((r.x0, r.y0, r.x1, r.y1))
        elif d["type"] in ("f", "fs"):
            pts = []
            curved = False
            for it in items:
                if it[0] == "l":
                    pts += [it[1], it[2]]
                elif it[0] == "c":
                    curved = True
                    pts += [it[1], it[4]]
                elif it[0] == "re":
                    r = it[1]
                    pts += [pymupdf.Point(r.x0, r.y0), pymupdf.Point(r.x1, r.y1)]
                elif it[0] == "qu":
                    q = it[1]
                    pts += [q.ul, q.ur, q.ll, q.lr]
            if not pts:
                continue
            xs = [p.x for p in pts]
            ys = [p.y for p in pts]
            x0, x1 = min(xs), max(xs)
            tol = max(0.4, (x1 - x0) * 0.08)
            left = [p.y for p in pts if p.x <= x0 + tol]
            right = [p.y for p in pts if p.x >= x1 - tol]
            yl = sum(left) / len(left)
            yr = sum(right) / len(right)
            polys.append(Poly(x0, x1, min(ys), max(ys), yl, yr, curved))
    return glyphs, texts, hlines, vlines, polys, rects


def merge_segments(hlines):
    """Joins horizontal segments at the same height that touch each other (MuseScore draws staff lines per measure)."""
    out = []
    for h in sorted(hlines, key=lambda h: (round(h[2], 1), h[0])):
        if out and abs(out[-1][2] - h[2]) < 0.06 and h[0] - out[-1][1] < 1.5 and abs(out[-1][3] - h[3]) < 0.05:
            o = out[-1]
            out[-1] = (o[0], max(o[1], h[1]), o[2], o[3])
        else:
            out.append(h)
    return out


def find_staves(hlines, pno) -> list[Staff]:
    """Pięciolinia = 5 długich poziomych linii o równych odstępach i tym samym zakresie x."""
    hlines = merge_segments(hlines)
    long = sorted([h for h in hlines if h[1] - h[0] > 60], key=lambda h: (round(h[0]), h[2]))
    staves = []
    used = set()
    by_y = sorted(long, key=lambda h: h[2])
    for i, h in enumerate(by_y):
        if i in used:
            continue
        group = [i]
        for j in range(i + 1, len(by_y)):
            if j in used:
                continue
            g = by_y[j]
            if abs(g[0] - h[0]) < 2 and abs(g[1] - h[1]) < 2:
                group.append(j)
                if len(group) == 5:
                    break
        if len(group) == 5:
            ys = [by_y[k][2] for k in group]
            gaps = [ys[k + 1] - ys[k] for k in range(4)]
            if max(gaps) - min(gaps) < 0.35 and 2.0 < gaps[0] < 15:
                used.update(group)
                staves.append(Staff(ys[0], sum(gaps) / 4, h[0], h[1], pno))
    staves.sort(key=lambda s: s.top)
    return staves


def build_staves(glyphs, hlines, vlines, pno) -> list[Staff]:
    staves = find_staves(hlines, pno)
    for st in staves:
        st.xlines = st.x1
    sp = staves[0].sp if staves else 4.5
    page_x0 = min((st.x0 for st in staves), default=50.0)
    page_x1 = max((st.x1 for st in staves), default=560.0)

    def in_band(y, st):
        return st.top - 2 * st.sp <= y <= st.bottom + 2 * st.sp

    # staff lines ending earlier, but the system continues (e.g. measures with chords only)
    for st in staves:
        far = [x for (x, y0, y1, w) in vlines
               if w > 0.6 and x > st.x1 + 2 and y0 < st.bottom + st.sp and y1 > st.top - st.sp]
        if far:
            st.x1 = max(far)

    # systems without a staff: thick barlines and/or slash heads outside any staff
    cands = [(x, (y0 + y1) / 2) for (x, y0, y1, w) in vlines
             if w > 0.6 and 1.5 * sp < y1 - y0 < 7 * sp and not any(in_band((y0 + y1) / 2, st) for st in staves)]
    heads = [g for g in glyphs if g.c in HEAD_SLASH_BLACK | HEAD_SLASH_HALF
             and not any(in_band(g.y, st) for st in staves)]
    groups = []
    for x, yc in sorted(cands, key=lambda t: t[1]):
        for gp in groups:
            if abs(gp[0] - yc) < 2 * sp:
                gp[1].append(x)
                break
        else:
            groups.append([yc, [x], 0])
    for g in heads:
        for gp in groups:
            if -1 * sp < gp[0] - g.y < 4.5 * sp:
                gp[2] += 1
                break
        else:
            groups.append([g.y + 2.4 * sp, [], 1])
    for mid, xs, nheads in groups:
        if len(xs) < 2 and nheads == 0:
            continue
        x1 = max(xs) if xs else page_x1
        staves.append(Staff(mid - 2 * sp, sp, page_x0, max(x1, page_x0 + 40), pno, lines=0, xlines=0))
    staves.sort(key=lambda st: st.top)
    for i, st in enumerate(staves):
        if i > 0:
            st.band_lo = (staves[i - 1].bottom + st.top) / 2
        if i + 1 < len(staves):
            st.band_hi = (st.bottom + staves[i + 1].top) / 2
    return staves


# --------------------------------------------------------------------------- analiza systemu

def pitch_from(staff: Staff, y: float, clef: str):
    h = staff.sp / 2
    pos = round((staff.bottom - y) / h)
    base = {"G": 30, "G8": 23, "F": 18, "C": 24}[clef]   # dolna linia: E4 / E3 / G2 / F3
    d = base + pos
    return "CDEFGAB"[d % 7], d // 7, d


def system_glyphs(staff, glyphs, above, below):
    lo = max(staff.top - above, staff.band_lo)
    hi = min(staff.bottom + below, staff.band_hi)
    return [g for g in glyphs if lo <= g.y <= hi and staff.x0 - 2 <= g.x <= staff.x1 + 2]


def analyse_staff(staff: Staff, glyphs, vlines, polys, warn: Warnings, state: dict):
    sp = staff.sp
    h = sp / 2
    gs = system_glyphs(staff, glyphs, 4.5 * sp, 4.5 * sp)
    gs.sort(key=lambda g: g.x)

    # --- barlines: vertical lines spanning the full staff height
    bars = []
    stems = []
    head_glyphs = [g for g in gs if g.c in HEAD_BLACK | HEAD_HALF | HEAD_WHOLE | HEAD_SLASH_BLACK | HEAD_SLASH_HALF]

    def touches_head(x, y0, y1):
        return any(g.x - 0.8 <= x <= g.x1 + 0.8 and (abs(g.y - y0) < h * 1.3 or abs(g.y - y1) < h * 1.3)
                   for g in head_glyphs)

    full = [w for (x, y0, y1, w) in vlines
            if staff.x0 - 2 <= x <= staff.x1 + 2 and abs(y0 - staff.top) < 0.6 and abs(y1 - staff.bottom) < 0.6
            and not touches_head(x, y0, y1)]
    bar_w = max(full) if full else 0.0

    for (x, y0, y1, w) in vlines:
        if not (staff.x0 - 2 <= x <= staff.x1 + 2):
            continue
        if staff.lines:
            stem_like = touches_head(x, y0, y1) and (w < 0.33 or (bar_w and w < bar_w * 0.8))
            if abs(y0 - staff.top) < 0.6 and abs(y1 - staff.bottom) < 0.6 and not stem_like:
                bars.append((x, w))
                continue
            if x > staff.xlines + 2 and w > 0.6 and y0 < staff.bottom + sp and y1 > staff.top - sp:
                bars.append((x, w))
                continue
        else:
            if w > 0.6 and y0 < staff.mid + 3 * sp and y1 > staff.mid - 3 * sp and (y1 - y0) > 1.5 * sp:
                bars.append((x, w))
                continue
        if y1 - y0 > 1.5 * sp and w < 0.6 and staff.top - 5 * sp < y0 and y1 < staff.bottom + 5 * sp \
                and staff.in_band((y0 + y1) / 2):
            stems.append(Stem(x, y0, y1))

    # stems that are actually barlines (rare) – a stem must touch a notehead
    heads = [g for g in gs if g.c in HEAD_BLACK | HEAD_HALF | HEAD_WHOLE | HEAD_SLASH_BLACK | HEAD_SLASH_HALF]
    cue_size = max((g.size for g in heads), default=0)

    # --- clef, key, time at the start of the staff
    clef = state.get("clef", "G")
    for g in gs:
        if g.c in CLEFS and g.x < staff.x0 + 6 * sp:
            clef = CLEFS[g.c]
            break

    # --- beams and ties
    beams = [p for p in polys if not p.curved and staff.top - 6 * sp < p.y0 and p.y1 < staff.bottom + 6 * sp
             and staff.in_band((p.y0 + p.y1) / 2) and staff.x0 - 2 <= p.x0 <= staff.x1 + 2 and (p.x1 - p.x0) > 1.2 and (p.y1 - p.y0) < (p.x1 - p.x0) * 0.8 + 1.6 * h]
    slashes = [p for p in polys if not p.curved and staff.top - h <= p.y0 and p.y1 <= staff.bottom + h
               and (p.x1 - p.x0) < 1.8 * sp and (p.y1 - p.y0) > 1.3 * sp and p not in beams]
    curves = [p for p in polys if p.curved and staff.top - 6 * sp < p.y0 and p.y1 < staff.bottom + 6 * sp
              and staff.in_band((p.y0 + p.y1) / 2) and staff.x0 - 3 <= p.x0 <= staff.x1 + 3]

    # --- build events
    events: list[Event] = []
    head_used = set()
    for st in sorted(stems, key=lambda s: s.x):
        attached = []
        for i, g in enumerate(heads):
            if i in head_used or g.c in HEAD_WHOLE:
                continue   # a whole note never has a stem
            if g.x - 0.8 <= st.x <= g.x1 + 0.8 and st.y0 - h * 1.3 <= g.y <= st.y1 + h * 1.3:
                attached.append(i)
        if not attached:
            continue
        # one stem = one head size (normal or cue); a normal head lying on a cue stem is a different voice
        ref = min(attached, key=lambda i: min(abs(heads[i].x1 - st.x), abs(heads[i].x - st.x)))
        ref_size = heads[ref].size
        attached = [i for i in attached if abs(heads[i].size - ref_size) < 1.0]
        hs = []
        for i in attached:
            g = heads[i]
            if not any(abs(g.y - o.y) < 0.4 and abs(g.x - o.x) < 1.0 for o in hs):
                hs.append(g)
        # stem direction: are the heads at the lower end?
        mean_y = sum(g.y for g in hs) / len(hs)
        up = abs(mean_y - st.y1) < abs(mean_y - st.y0)
        for i in attached:
            head_used.add(i)
        ev = Event(x=min(g.x for g in hs), x1=max(g.x1 for g in hs), rest=False,
                   heads=sorted(((g.y, g.c) for g in hs), key=lambda t: t[0]), stem=st)
        kinds = {g.c for g in hs}
        if kinds & HEAD_HALF:
            ev.head_kind, ev.base = "half", F(2)
        elif kinds & HEAD_SLASH_HALF:
            ev.head_kind, ev.base, ev.slash = "slashhalf", F(2), True
        elif kinds & HEAD_SLASH_BLACK:
            ev.head_kind, ev.base, ev.slash = "slash", F(1), True
        else:
            ev.head_kind, ev.base = "black", F(1)
        ev.cue = all(g.size < cue_size - 1 for g in hs)
        ev.xhead = bool(kinds & HEAD_X)
        if ev.base == 1:
            # flags
            nflag = 0
            for g in gs:
                if g.c in FLAGS and abs(g.x - st.x) < 1.5:
                    nflag = max(nflag, FLAGS[g.c])
            # beams: polygons covering the stem x near its free end
            end = st.y0 if up else st.y1
            nbeam = 0
            seen = []
            for b in beams:
                if b.x0 - 0.6 <= st.x <= b.x1 + 0.6:
                    yb = b.y_at(min(max(st.x, b.x0), b.x1))
                    if up and end - 1.2 * h <= yb <= end + 3.2 * sp:
                        pass
                    elif not up and end - 3.2 * sp <= yb <= end + 1.2 * h:
                        pass
                    else:
                        continue
                    if all(abs(yb - s2) > 0.9 for s2 in seen):
                        seen.append(yb)
                        nbeam += 1
            n = max(nflag, nbeam)
            ev.base = F(1, 2 ** n)
        events.append(ev)

    # heads without a stem: whole notes and stemless slashes
    for i, g in enumerate(heads):
        if i in head_used:
            continue
        # merge heads of a single chord (same x)
        ev = None
        for e in events:
            if e.stem is None and abs(e.x - g.x) < 1.5:
                ev = e
                break
        if ev is None:
            kind = "whole"
            base = F(4)
            slash = False
            if g.c in HEAD_SLASH_HALF:
                kind, base, slash = "slashhalf", F(4), True
            elif g.c in HEAD_SLASH_BLACK:
                kind, base, slash = "slash", F(1), True
            elif g.c in HEAD_BLACK:
                kind, base = "black", F(1)
            elif g.c in HEAD_HALF:
                kind, base = "half", F(2)
            ev = Event(x=g.x, x1=g.x1, rest=False, head_kind=kind, base=base, slash=slash)
            ev.cue = g.size < cue_size - 1
            ev.xhead = g.c in HEAD_X
            events.append(ev)
        if not any(abs(g.y - hy) < 0.4 for hy, _ in ev.heads):
            ev.heads.append((g.y, g.c))
        ev.heads.sort(key=lambda t: t[0])
        ev.x1 = max(ev.x1, g.x1)

    # rests
    for g in gs:
        if g.c in RESTS:
            events.append(Event(x=g.x, x1=g.x1, rest=True, base=RESTS[g.c], cue=g.size < cue_size - 1))
        elif g.c in ("Ó", "î"):
            # whole rest hangs below line 4 (counting from the bottom), half rest sits on line 3
            line4 = staff.top + sp
            whole = abs(g.y - line4) < abs(g.y - staff.mid)
            events.append(Event(x=g.x, x1=g.x1, rest=True, base=F(4) if whole else F(2), measure_rest=whole))
        elif g.c == "∑":
            events.append(Event(x=g.x, x1=g.x1, rest=True, base=F(4), measure_rest=True))

    # slash strokes drawn as lines (rhythm notation)
    for p in slashes:
        if any(abs(e.x - p.x0) < 2 for e in events):
            continue
        ev = Event(x=p.x0, x1=p.x1, rest=False, head_kind="slash", base=F(1), slash=True)
        ev.heads = [(staff.mid, "/")]
        events.append(ev)

    events.sort(key=lambda e: e.x)

    # --- augmentation dots
    dots = [g for g in gs if g.c == "."]
    bar_xs = [b[0] for b in bars]
    for d in dots:
        if any(abs(d.x - bx) < 2.2 * sp for bx in bar_xs) and staff.top < d.y < staff.bottom:
            # possible repeat dot – handled separately
            near_ev = any(0 < d.x - e.x1 < 1.8 * sp for e in events)
            if not near_ev:
                continue
        best = None
        for e in events:
            if 0 <= d.x - e.x1 < 2.4 * sp:
                ys = [hy for hy, _ in e.heads] if not e.rest else [staff.mid]
                if e.rest or any(abs(d.y - hy) <= h * 1.25 for hy in ys):
                    if best is None or e.x > best.x + 0.5 or (abs(e.x - best.x) <= 0.5 and best.rest and not e.rest):
                        best = e
        if best is not None:
            # count dots (double dots)
            best.dots = min(2, best.dots + 1) if best.dots == 0 or d.x - best.x1 > 1.1 * sp else best.dots

    for e in events:
        e.dur = e.base * (F(3, 2) if e.dots == 1 else (F(7, 4) if e.dots == 2 else 1))

    # --- accidentals (attached to notes) and key signature
    accs = [g for g in gs if g.c in ACCIDENTALS and staff.top - 3 * sp < g.y < staff.bottom + 3 * sp]
    # key signature: a chain of accidentals right after the clef (or after a double barline)
    keysig = set()
    starts = [g.x1 for g in gs if g.c in CLEFS and g.x < staff.x0 + 6 * sp]
    bars_sorted = sorted(bars)
    for i in range(len(bars_sorted) - 1):
        if bars_sorted[i + 1][0] - bars_sorted[i][0] < 4.5:
            starts.append(bars_sorted[i + 1][0])
    acc_sorted = sorted(accs, key=lambda a: a.x)
    for sx in starts:
        chain = []
        for a in acc_sorted:
            if not chain:
                if 0 <= a.x - sx < 2.5 * sp:
                    chain.append(a)
            elif 0 <= a.x - chain[-1].x1 < 1.5 * sp and (a.c == chain[-1].c or chain[-1].c == "n"):
                chain.append(a)
        if chain:
            keysig.update(id(a) for a in chain)
    loose = [a for a in accs if id(a) in keysig]
    for a in accs:
        if id(a) in keysig:
            continue
        target = None
        for e in events:
            if e.rest:
                continue
            if 0 <= e.x - a.x1 < 2.6 * sp + 2:
                for hy, _ in e.heads:
                    if abs(hy - a.y) < h * 0.6:
                        target = (e, hy)
                        break
            if target:
                break
        if target:
            target[0].accs[target[1]] = ACCIDENTALS[a.c]
        else:
            loose.append(a)

    # --- time signature (stacked digits)
    digits = [g for g in gs if g.c in TIME_DIGITS and staff.top - sp < g.y < staff.bottom + sp]
    times = []
    used_d = set()
    for i, a in enumerate(digits):
        if i in used_d:
            continue
        for j, b in enumerate(digits):
            if j <= i or j in used_d:
                continue
            if abs(a.x - b.x) < 1.5 and abs(a.y - b.y) > 1.2 * sp:
                top, bot = (a, b) if a.y < b.y else (b, a)
                times.append((min(a.x, b.x), (int(top.c), int(bot.c))))
                used_d.update({i, j})
    for g in gs:
        if g.c in ("c", "C") and staff.top < g.y < staff.bottom:
            times.append((g.x, (4, 4) if g.c == "c" else (2, 2)))

    # --- dzielimy na takty
    bars.sort()
    merged = []
    for x, w in bars:
        if merged and x - merged[-1][1] < 4.5:
            merged[-1] = (merged[-1][0], x, max(merged[-1][2], w), merged[-1][3] + [w])
        else:
            merged.append((x, x, w, [w]))
    edges = [staff.x0] + [m[0] for m in merged] + [staff.x1]
    bar_info = {round(m[0], 1): m for m in merged}
    measures: list[Measure] = []
    xs = [staff.x0] + [m[1] for m in merged]
    for i in range(len(merged) + 1):
        a = staff.x0 if i == 0 else merged[i - 1][1]
        b = merged[i][0] if i < len(merged) else staff.x1
        meas = Measure(a, b, staff=staff)
        meas.events = [e for e in events if a - 0.5 <= e.x < b - 0.5]
        if i > 0:
            m = merged[i - 1]
            ws = m[3]
            if any(w > 1.8 for w in ws):
                # sprawdzamy kropki powtórki
                dots_right = [d for d in dots if 0 < d.x - m[1] < 2.2 * sp and staff.top < d.y < staff.bottom]
                if len(dots_right) >= 2:
                    meas.left_bar = "forward"
        if i < len(merged):
            m = merged[i]
            ws = m[3]
            dots_left = [d for d in dots if 0 < m[0] - d.x1 < 2.2 * sp and staff.top < d.y < staff.bottom]
            if len(dots_left) >= 2 and any(w > 1.8 for w in ws):
                meas.right_bar = "backward"
            elif len(ws) >= 2 and any(w > 1.8 for w in ws):
                meas.right_bar = "final"
            elif len(ws) >= 2:
                meas.right_bar = "double"
        measures.append(meas)

    # empty "header" segment at the system start (clef/key/time, start-repeat barline) → merge into the next one
    def is_header(m):
        if m.events:
            return False
        has_sign = any(m.x0 - 1 <= g.x <= m.x1 + 1 and (g.c in CLEFS or g.c in ACCIDENTALS or g.c in TIME_DIGITS)
                       for g in gs)
        return has_sign or (m.x1 - m.x0) < 6 * sp

    while len(measures) > 1 and is_header(measures[0]):
        lead = measures.pop(0)
        if lead.left_bar:
            measures[0].left_bar = measures[0].left_bar or lead.left_bar
        measures[0].x0 = lead.x0
    # empty segment after the last barline (staff ends at the barline)
    while len(measures) > 1 and not measures[-1].events and measures[-1].x1 - measures[-1].x0 < 3 * sp:
        measures.pop()

    # key: loose accidentals before the first event of the measure
    for meas in measures:
        first_x = min((e.x for e in meas.events), default=meas.x1)
        ks = [a for a in loose if meas.x0 - 1 <= a.x < first_x]
        if ks:
            sharps = sum(1 for a in ks if a.c == "#")
            flats = sum(1 for a in ks if a.c == "b")
            nat = sum(1 for a in ks if a.c == "n")
            if sharps and not flats:
                meas.key = sharps
            elif flats and not sharps:
                meas.key = -flats
            elif nat and not sharps and not flats:
                meas.key = 0
        for tx, t in times:
            if meas.x0 - 1 <= tx < first_x + 1:
                meas.time = t

    # pitches
    for meas in measures:
        for e in meas.events:
            if e.rest:
                continue
            if e.slash:
                e.pitches = [("B", 4, 0, None)]
                continue
            for hy, _ in e.heads:
                step, octv, d = pitch_from(staff, hy, clef)
                e.pitches.append([step, octv, None, e.accs.get(hy), d, hy])

    # ties (curves between noteheads)
    for c in curves:
        for e in events:
            if e.rest:
                continue
            if e.x - 1.5 <= c.x0 <= e.x1 + 1.6 * sp:
                for hy, _ in e.heads:
                    if abs(c.yl - hy) < 1.9 * sp and min(abs(c.y0 - hy), abs(c.y1 - hy)) < 1.6 * sp:
                        e.tie_start_ys.add((round(hy, 1), round(c.x1, 1)))

    return measures, clef


# --------------------------------------------------------------------------- tekst: słowa, akordy, oznaczenia

CHORD_RE = re.compile(r"^([A-G])(#|b|♯|♭)?([^/]*?)(?:/([A-G])(#|b|♯|♭)?)?$")

KINDS = [
    ("maj13", "major-13th"), ("maj11", "major-11th"), ("maj9", "major-ninth"), ("maj7", "major-seventh"),
    ("Maj7", "major-seventh"), ("Δ7", "major-seventh"), ("Δ", "major-seventh"), ("ma7", "major-seventh"),
    ("m7b5", "half-diminished"), ("ø", "half-diminished"), ("dim7", "diminished-seventh"), ("°7", "diminished-seventh"),
    ("dim", "diminished"), ("°", "diminished"), ("aug", "augmented"), ("+", "augmented"),
    ("mMaj7", "major-minor"), ("m13", "minor-13th"), ("m11", "minor-11th"), ("m9", "minor-ninth"),
    ("m7", "minor-seventh"), ("m6", "minor-sixth"), ("min", "minor"), ("mi", "minor"), ("m", "minor"),
    ("-7b5", "half-diminished"), ("-13", "minor-13th"), ("-11", "minor-11th"), ("-9", "minor-ninth"),
    ("-7", "minor-seventh"), ("-6", "minor-sixth"), ("-", "minor"),
    ("13", "dominant-13th"), ("11", "dominant-11th"), ("9", "dominant-ninth"), ("7", "dominant"),
    ("6", "major-sixth"), ("sus4", "suspended-fourth"), ("sus2", "suspended-second"), ("sus", "suspended-fourth"),
    ("5", "power"), ("", "major"),
]


def parse_chord(text: str) -> Chord | None:
    t = text.replace("♯", "#").replace("♭", "b").replace(" ", "")
    if t.upper() in ("N.C.", "NC", "N.C"):
        return Chord("N.C.", "C", 0, "none", "N.C.")
    m = CHORD_RE.match(t)
    if not m:
        return None
    root, acc, suf, bass, bacc = m.groups()
    alter = {"#": 1, "b": -1, None: 0}[acc]
    suf = suf or ""
    kind = None
    rest = suf
    for pre, k in KINDS:
        if suf.startswith(pre):
            kind, rest = k, suf[len(pre):]
            break
    degrees = []
    # remaining extensions: add9, 2, add4, 7sus4, b9 itp.
    for mm in re.finditer(r"(add|sus|b|#)?(\d+)", rest):
        typ, num = mm.group(1), int(mm.group(2))
        if typ == "sus":
            kind = "suspended-fourth" if num == 4 else "suspended-second"
            continue
        a = -1 if typ == "b" else (1 if typ == "#" else 0)
        if kind == "major" and not typ and num in (2, 4, 9) and not degrees:
            degrees.append((num, a, "add"))
        elif typ == "add" or not typ:
            degrees.append((num, a, "add"))
        else:
            degrees.append((num, a, "alter" if num in (5, 9, 11, 13) else "add"))
    if kind is None:
        return None
    if rest and not re.fullmatch(r"((add|sus|b|#)?\d+|\(|\)|,)*", rest):
        return None
    return Chord(t, root, alter, kind, suf, bass, {"#": 1, "b": -1, None: 0}[bacc] if bass else 0, degrees)


def cluster_text(chars: list[TextChar], gap: float, by_span: bool = False):
    """Splits the characters of one line into tokens separated by spaces or gaps."""
    chars = sorted(chars, key=lambda c: c.x0)
    tokens = []
    cur = []
    for c in chars:
        if c.c == " ":
            if cur:
                tokens.append(cur)
                cur = []
            continue
        if cur and (c.x0 - cur[-1].x1 > gap or
                    (by_span and c.span != cur[-1].span and c.x0 - cur[-1].x1 > 0.4)):
            tokens.append(cur)
            cur = []
        cur.append(c)
    if cur:
        tokens.append(cur)
    return tokens


def token_text(tok):
    return "".join(" " if c.c == "\xa0" else c.c for c in tok)


def group_lines(chars: list[TextChar], tol: float):
    lines = []
    for c in sorted(chars, key=lambda c: c.y):
        for ln in lines:
            if abs(ln[0] - c.y) <= tol:
                ln[1].append(c)
                break
        else:
            lines.append([c.y, [c]])
    return lines


# --------------------------------------------------------------------------- main conversion

def convert(pdf_path: str):
    doc = pymupdf.open(pdf_path)
    warn = Warnings()
    systems = []   # (staff, measures, texts_for_staff)
    page_data = []
    total_glyphs = 0
    meta = {"title": None, "lyricist": None, "composer": None, "tempo": None}

    for pno, page in enumerate(doc):
        glyphs, texts, hlines, vlines, polys, rects = read_page(page, pno)
        total_glyphs += len(glyphs)
        staves = build_staves(glyphs, hlines, vlines, pno)
        page_data.append((pno, page, glyphs, texts, hlines, vlines, polys, rects, staves))

    if total_glyphs < 20 or not any(pd[8] for pd in page_data):
        return None, ["Brak nut wektorowych"]

    # ---- systems: staves joined by the system's start line or a bracket
    SYSTEM_OF.clear()
    SYSTEM_TOP.clear()
    sys_list = []   # [(pno, [staves])]
    for (pno, page, glyphs, texts, hlines, vlines, polys, rects, staves) in page_data:
        for grp in group_systems(staves, vlines, glyphs):
            sys_list.append((pno, grp, glyphs, vlines, polys))
            for st in grp:
                SYSTEM_OF[id(st)] = id(grp)
            SYSTEM_TOP.add(id(grp[0]))

    # ---- assign staves to voices (parts)
    n_parts = max(len(g) for _, g, *_ in sys_list)
    clefs_of = {id(st): staff_clef(st, gl) for (_, grp, gl, *_) in sys_list for st in grp}
    profile = None
    for (_, grp, *_) in sys_list:
        if len(grp) == n_parts:
            profile = [clefs_of[id(st)] or "G" for st in grp]
            break
    part_states = [{"clef": (profile[i] if profile else "G")} for i in range(n_parts)]
    parts: list[list[Measure]] = [[] for _ in range(n_parts)]
    all_measures: list[Measure] = []
    hidden_used = False
    last_pno = -1

    for (pno, grp, glyphs, vlines, polys) in sys_list:
        idxs = assign_parts([clefs_of[id(st)] for st in grp], profile, n_parts)
        per_part = {}
        for st, pi in zip(grp, idxs):
            state = part_states[pi]
            prev_clef = state.get("last_clef")
            ms, clef = analyse_staff(st, glyphs, vlines, polys, warn, state)
            state["clef"] = clef
            if not ms:
                continue
            if prev_clef is None or clef != prev_clef:
                ms[0].clef = clef
            state["last_clef"] = clef
            per_part[pi] = ms
            all_measures.extend(ms)
        if not per_part:
            continue
        ref = max(per_part.values(), key=len)
        count = len(ref)
        for pi, ms in per_part.items():
            if len(ms) != count:
                warn.add(f"Str. {pno + 1}: pięciolinie jednego systemu mają różną liczbę taktów ({len(ms)} i {count}) — sprawdź tę linijkę")
                while len(ms) < count:
                    ms.append(Measure(ms[-1].x1, ms[-1].x1, staff=ms[-1].staff))
        new_page = pno != last_pno and last_pno >= 0
        last_pno = pno
        for pi in range(n_parts):
            ms = per_part.get(pi)
            if ms is None:
                # voice hidden in this system (MuseScore/Finale "hide empty staves") → rests
                hidden_used = True
                ms = []
                for r in ref:
                    filler = Measure(r.x0, r.x1)
                    filler.key, filler.time = r.key, r.time
                    filler.left_bar, filler.right_bar = r.left_bar, r.right_bar
                    ms.append(filler)
            ms[0].new_system = True
            ms[0].new_page = new_page
            if not parts[pi] and ms[0].clef is None:
                ms[0].clef = profile[pi] if profile else "G"
            if parts[pi] and per_part.get(pi) is not None and ms[0].clef is not None:
                # clef repeated at the start of a system — not a change, unless it differs from the previous one
                prev = next((m.clef for m in reversed(parts[pi]) if m.clef), None)
                if prev == ms[0].clef:
                    ms[0].clef = None
            parts[pi].extend(ms[:count])

    # page text → per-staff assignment
    for (pno, page, glyphs, texts, hlines, vlines, polys, rects, staves) in page_data:
        attach_text(page, pno, texts, rects, staves, all_measures, meta, warn, polys, hlines, vlines)

    names = ["Głos"] if n_parts == 1 else [f"Głos {i + 1}" for i in range(n_parts)]
    # part names from the labels next to the staves of the first full system (e.g. "Voce 1", "Sopran")
    for (pno, grp, *_r) in sys_list:
        if len(grp) == n_parts:
            labels = [staff_label(st, page_data[pno][3]) for st in grp]
            if all(labels) and len(set(labels)) == len(labels):
                names = labels
            break
    if n_parts > 1 and hidden_used:
        warn.add("Głosy ukryte w części systemów uzupełniono pauzami — przypisanie pięciolinii do głosów sprawdź na początku utworu")
    processed = []
    bad = total = 0
    for pi, ms in enumerate(parts):
        out, nbad = finish_part(ms, warn, names[pi] if n_parts > 1 else None)
        processed.append(out)
        bad += nbad
        total += len(out)
    if total == 0 or bad > max(3, total * 0.3):
        return None, ["NIEPEWNY", f"{bad} z {total} taktów ma złą długość — ten PDF wymaga rozpoznawania obrazu"]
    return write_xml(processed, names, meta, 24), warn


def staff_clef(staff: Staff, glyphs):
    for g in sorted(glyphs, key=lambda g: g.x):
        if g.c in CLEFS and g.x < staff.x0 + 6 * staff.sp and staff.top - 2 * staff.sp <= g.y <= staff.bottom + 2 * staff.sp:
            return CLEFS[g.c]
    return None


def group_systems(staves, vlines, glyphs):
    """Staves of one system are connected by a vertical line at the start (or a bracket)."""
    groups = []
    brackets = [g for g in glyphs if g.c in ("⎡", "⎣")]
    for st in sorted(staves, key=lambda s: s.top):
        if groups:
            prev = groups[-1][-1]
            x0 = min(prev.x0, st.x0)
            joined = any(x <= x0 + 2.0 and y0 <= prev.bottom + 0.6 and y1 >= st.top - 0.6
                         for (x, y0, y1, w) in vlines)
            if not joined and brackets:
                tops = [g.y for g in brackets if g.c == "⎡"]
                bots = [g.y for g in brackets if g.c == "⎣"]
                joined = any(t <= prev.top + 3 and any(b >= st.bottom - 3 and b > t for b in bots) and
                             not any(t < b2 < st.top for b2 in bots) for t in tops)
            if joined and prev.lines and st.lines:
                groups[-1].append(st)
                continue
        groups.append([st])
    return groups


def assign_parts(clefs, profile, n):
    """Order-preserving assignment of staves to voices; the clef points to the voice (e.g. tenor clef → male voice)."""
    if len(clefs) == n or profile is None:
        return list(range(len(clefs)))
    out = []
    prev = -1
    for k, c in enumerate(clefs):
        remaining = len(clefs) - k - 1
        cands = list(range(prev + 1, n - remaining))
        pick = next((j for j in cands if c is None or profile[j] == c), cands[0])
        out.append(pick)
        prev = pick
    return out


# --------------------------------------------------------------------------- text → measures

VLINES_CTX: list = []
SYSTEM_OF: dict = {}
SYSTEM_TOP: set = set()   # id() of the staves that are the topmost staff of their system


def staff_label(st, texts):
    """The text to the left of the staff (part name: "Voce 1", "S.", "Alt"…)."""
    chars = [t for t in texts if t.c.strip() and t.x1 < st.x0 - 1
             and st.top - 1.5 * st.sp <= t.y <= st.bottom + 1.5 * st.sp]
    if not chars:
        return ""
    return " ".join(token_text(tok) for tok in cluster_text(chars, chars[0].size * 0.25)).strip()


def attach_text(page, pno, texts, rects, staves, all_measures, meta, warn, polys, hlines_page=(), vlines_page=()):
    VLINES_CTX[:] = list(vlines_page)
    if not staves:
        return
    page_measures = [m for m in all_measures if m.staff is not None and m.staff.page == pno]
    if not page_measures:
        return
    sp = staves[0].sp

    def staff_of(y):
        """Returns (staff, 'above'|'below') for a text line, or None."""
        best = None
        for s in staves:
            band = 7.5 if s.lines == 0 else 5.5
            if s.top - band * s.sp <= y <= s.top + s.sp:
                d = s.top - y
                if best is None or abs(d) < best[2]:
                    best = (s, "above", abs(d))
        for s in staves:
            nxt = [t for t in staves if t.top > s.top]
            limit = (nxt[0].top - 3.2 * s.sp) if nxt else s.bottom + 12 * s.sp
            if s.bottom - s.sp <= y <= limit:
                if best is None or best[1] != "above":
                    best = (s, "below", y - s.bottom)
        return best

    # rehearsal boxes: text inside a rectangle
    boxed = []
    for (x0, y0, x1, y1) in rects:
        inside = [t for t in texts if x0 - 0.5 <= t.x0 and t.x1 <= x1 + 0.5 and y0 - 0.5 <= t.y <= y1 + 0.5]
        if inside and (y1 - y0) < 6 * sp:
            txt = " ".join(token_text(t) for t in cluster_text(inside, 1.6)).strip()
            boxed.append((x0, y0, x1, y1, txt, inside))
    boxed_ids = {id(c) for b in boxed for c in b[5]}
    for (x0, y0, x1, y1, txt, inside) in boxed:
        # nearest staff below the box
        below = [s for s in staves if s.top >= y1 - 1]
        if not below:
            continue
        s = min(below, key=lambda s: s.top - y1)
        if s.top - y1 > 12 * s.sp:
            continue
        ms = [m for m in page_measures if m.staff is s]
        if not ms:
            continue
        # box over a specific measure (e.g. ENDING on the right) – by x
        target = ms[0]
        for m in ms:
            if m.x0 - 3 * sp <= x0 <= m.x1:
                target = m
                break
        target.rehearsal.append(txt)

    free = [t for t in texts if id(t) not in boxed_ids
            and not any(t.x1 < st.x0 - 1 and st.top - 1.5 * st.sp <= t.y <= st.bottom + 1.5 * st.sp for st in staves)]

    # title, authors, tempo – page 1, above the first staff
    if pno == 0:
        first = staves[0]
        head = [t for t in free if t.y < first.top - 1.2 * sp]
        tempo_q = [t for t in head if "engraver" in t.font.lower() and t.c in "qh"]
        head_txt = "\n".join(token_text(sorted(chs, key=lambda c: c.x0))
                              for _, chs in sorted(group_lines(head, 1.5), key=lambda r: r[0]))
        m_t = re.search(r"=\s*(\d{2,3})\b", head_txt)
        if m_t and not meta.get("tempo"):
            meta["tempo"] = int(m_t.group(1))
        page_w = page.rect.width
        for ln_y, chars in group_lines(head, 1.5):
            line = token_text(sorted(chars, key=lambda c: c.x0)).strip()
            line = re.sub(r"\s+", " ", " ".join(token_text(t) for t in cluster_text(chars, 3.0)))
            sizes = [c.size for c in chars]
            if tempo_q and any(abs(c.y - tempo_q[0].y) < 4 for c in chars):
                num = re.search(r"(\d{2,3})", line)
                if num:
                    meta["tempo"] = int(num.group(1))
                continue
            low = line.lower()
            if low.startswith("sł. muz") or low.startswith("sl. muz") or low.startswith("słowa i muzyka"):
                v = re.sub(r"^(sł\.|sl\.)\s*muz\.?\s*", "", line, flags=re.I).strip()
                meta["lyricist"] = v
                meta["composer"] = v
            elif low.startswith("sł.") or low.startswith("sl.") or low.startswith("słowa"):
                meta["lyricist"] = re.sub(r"^(sł\.|sl\.|słowa:?)\s*", "", line, flags=re.I).strip()
            elif low.startswith("muz.") or low.startswith("muzyka"):
                meta["composer"] = re.sub(r"^(muz\.|muzyka:?)\s*", "", line, flags=re.I).strip()
            elif max(sizes) >= 14 and not meta["title"]:
                meta["title"] = line
            elif max(sizes) >= 12 and meta["title"] and not meta.get("subtitle"):
                meta["subtitle"] = line
            elif re.search(r"=\s*\d{2,3}", line):
                continue
            elif min(c.x0 for c in chars) > page_w * 0.6 and not meta.get("composer"):
                meta["composer"] = line   # autor wyrównany do prawej, jak w szablonach programów nutowych

    # ---- text classification by font size, not by position alone
    last_bottom = max(st.bottom for st in staves)
    first_top = min(st.top for st in staves)
    zone = [t for t in free
            if first_top - 6 * sp <= t.y <= last_bottom + 9 * sp
            and not (pno == 0 and t.y < first_top - 6 * sp)]

    def mode(vals):
        cnt = {}
        for v in vals:
            cnt[round(v, 1)] = cnt.get(round(v, 1), 0) + 1
        return max(cnt, key=cnt.get) if cnt else None

    lyric_size = mode([t.size for t in zone if t.c.isalpha() and t.c.islower()
                       and any(st.bottom + 1.5 * st.sp <= t.y <= st.bottom + 7 * st.sp for st in staves)])
    chord_size = mode([t.size for t in zone if t.c in "ABCDEFG"
                       and any(st.top - 5 * st.sp <= t.y <= st.top + 1.5 * st.sp or
                               (st.lines == 0 and st.top - 3 * st.sp <= t.y <= st.bottom + 2 * st.sp)
                               or (st.lines and t.x0 > st.xlines and st.top - 2 * st.sp <= t.y <= st.bottom + 2 * st.sp)
                               for st in staves)])

    def staff_above(y):
        cands = [st for st in staves if st.bottom - st.sp < y]
        return max(cands, key=lambda st: st.bottom) if cands else None

    def staff_below(y):
        cands = [st for st in staves if st.top - 6.5 * st.sp <= y <= st.bottom + 2 * st.sp]
        if not cands:
            return None
        return min(cands, key=lambda st: (0 if (y <= st.top + st.sp or st.lines == 0) else 1, abs(st.mid - y)))

    used = set()
    # 1) chords: a root letter in the chord font + its continuation (accidentals, superscripts, bass)
    chord_groups = []
    if chord_size:
        seeds = sorted([t for t in zone if t.c in "ABCDEFGN" and abs(t.size - chord_size) < 0.6], key=lambda t: t.x0)
        for sd in seeds:
            if id(sd) in used:
                continue
            grp = [sd]
            used.add(id(sd))
            while True:
                last = grp[-1]
                fam = sd.font.split("+")[-1]
                nxt = [t for t in zone if id(t) not in used and t.size <= chord_size + 0.6 and t.c.strip()
                       and t.font.split("+")[-1] == fam
                       and -0.5 <= t.x0 - last.x1 < 4.0 and -chord_size * 0.75 < t.y - sd.y < chord_size * 0.3
                       and not (t.c in "ABCDEFG" and abs(t.size - chord_size) < 0.6
                                and last.c not in "/." and not (grp[0].c == "N" and last.c == "."))]
                # stacked superscripts: same x, different rows → take all
                if not nxt:
                    break
                xmin = min(t.x0 for t in nxt)
                col = [t for t in nxt if t.x0 - xmin < 0.6]
                for t in col:
                    used.add(id(t))
                grp.extend(sorted(col, key=lambda t: t.y))
            chord_groups.append(grp)

        if lyric_size and abs(chord_size - lyric_size) < 0.3:
            # Chords use the same font as the lyrics (e.g. MuseScore): a word like "Chcę" or "Nic" is not a chord.
            # A group stays a chord when it is a valid chord symbol, or at least starts like one
            # (a typo in the source, e.g. "B♭?G"), and no lyric words stand in its row.
            in_groups = {id(c) for g in chord_groups for c in g}

            def row_has_words(g):
                y = g[0].y
                gx0 = min(c.x0 for c in g)
                gx1 = max(c.x1 for c in g)
                return any(t.c.isalpha() and t.c.islower() and id(t) not in in_groups and abs(t.y - y) < 1.5
                           and abs(t.size - lyric_size) < 0.3 and gx0 - 12 < t.x1 and t.x0 < gx1 + 12
                           for t in zone)

            keep = []
            for g in chord_groups:
                txt = chord_text(g)
                looks = parse_chord(txt) is not None or re.match(r"^[A-G](♭|♯|#|b)?[^a-z]*$", txt) is not None
                st_b = staff_below(g[0].y)
                over_top = st_b is not None and (id(st_b) in SYSTEM_TOP or not SYSTEM_TOP)
                if looks and over_top and not row_has_words(g):
                    keep.append(g)
                else:
                    if os.environ.get("WEKTOR_DEBUG"):
                        print("DBG released", repr(txt), looks, round(g[0].x0, 1), round(g[0].y, 1))
                    for c in g:
                        used.discard(id(c))
            chord_groups = keep

    # 2) lyrics: the lyric font, below the staff they belong to
    lyric_chars = {}
    if lyric_size:
        for t in zone:
            if id(t) in used or "oblique" in t.font.lower():
                continue
            hyphen = t.c in "-–—_" and abs(t.size - lyric_size) < 1.2
            if hyphen or (abs(t.size - lyric_size) < 0.3 and (t.c.isalpha() or t.c in "'’,.!?;:\xa0 \"„”()")):
                st = staff_above(t.y)
                if st is not None and t.y > st.bottom:
                    below = [o for o in staves if o.top > st.bottom]
                    nxt = min(below, key=lambda o: o.top) if below else None
                    if nxt is not None:
                        if t.y > nxt.top - 2.2 * st.sp:
                            continue   # an instruction above the next staff, not lyrics
                    lyric_chars.setdefault(id(st), []).append(t)
                    used.add(id(t))

        # Verse rows directly below one another; a row standing far from the previous one
        # (e.g. "sopran" above the next system) is not lyrics.
        for sid, chars in list(lyric_chars.items()):
            st = next(o for o in staves if id(o) == sid)
            rows = sorted(group_lines(chars, 2.0), key=lambda r: r[0])
            keep, last = [], None
            for ry, rc in rows:
                ok = (ry - st.bottom <= 8 * st.sp) if last is None else (ry - last <= lyric_size * 1.9)
                if ok and any(c.c.isalpha() for c in rc):
                    keep += rc
                    last = ry
                elif ok:
                    keep += rc
                else:
                    for c in rc:
                        used.discard(id(c))
            lyric_chars[sid] = keep

    # 3) the rest above the staves: words ("band in", "build up"), voltas "1."
    other = [t for t in zone if id(t) not in used and t.c.strip()]

    # --- lyrics
    if lyric_size:
        for s in staves:
            ms = [m for m in page_measures if m.staff is s]
            evs = [e for m in ms for e in m.events if not e.rest]
            chars = lyric_chars.get(id(s), [])
            if not chars or not evs:
                continue
            lines = group_lines(chars, 2.0)
            lines.sort(key=lambda l: l[0])
            verse = 0
            last_y = None
            for ln_y, lchars in lines:
                if last_y is None or ln_y - last_y > lyric_size * 0.9:
                    verse += 1
                last_y = ln_y
                toks = cluster_text(lchars, lyric_size * 0.3, by_span=True)
                xs0 = min(c.x0 for c in lchars)
                xs1 = max(c.x1 for c in lchars)
                # hyphens drawn as short lines at mid-height of the text
                drawn = [(x0, x1) for (x0, x1, y, w_) in hlines_page
                         if ln_y - lyric_size * 0.6 <= y <= ln_y - lyric_size * 0.1
                         and 0.8 < x1 - x0 < lyric_size * 1.3 and xs0 - 2 <= x0 <= xs1 + 2]
                items = [("-", x0, x1) for (x0, x1) in drawn]
                for tok in toks:
                    buf = []
                    for c in tok + [None]:
                        if c is None or c.c in "-–—_":
                            if buf:
                                items.append((token_text(buf).strip(), buf[0].x0, buf[-1].x1))
                                buf = []
                            if c is not None:
                                items.append(("-" if c.c != "_" else "_", c.x0, c.x1))
                        else:
                            buf.append(c)
                items.sort(key=lambda it: it[1])
                sylls = []
                for (txt, x0, x1) in items:
                    if txt in ("-", "_"):
                        if txt == "-" and sylls:
                            sylls[-1]["hyph_after"] = True
                        continue
                    if not txt:
                        continue
                    sylls.append({"t": txt, "x0": x0, "x1": x1, "hyph_after": False, "hyph_before": False})
                for i, sy in enumerate(sylls):
                    if i > 0 and sylls[i - 1]["hyph_after"]:
                        sy["hyph_before"] = True
                for sy in sylls:
                    b_, a_ = sy["hyph_before"], sy["hyph_after"]
                    sy["syl"] = "middle" if (b_ and a_) else ("end" if b_ else ("begin" if a_ else "single"))
                    cx = (sy["x0"] + sy["x1"]) / 2
                    cands = [e for e in evs if verse not in e.lyrics and not e.cue] or \
                            [e for e in evs if verse not in e.lyrics]
                    if not cands:
                        continue
                    e = min(cands, key=lambda e: abs((e.x + e.x1) / 2 - cx))
                    if abs((e.x + e.x1) / 2 - cx) > 6 * s.sp:
                        warn.add(f"Sylaba „{sy['t']}” bez nuty nad nią (str. {pno + 1})")
                        continue
                    e.lyrics[verse] = (sy["t"], sy["syl"])

    # --- chords
    for grp in chord_groups:
        txt = chord_text(grp)
        sd = grp[0]
        st = staff_below(sd.y)
        if st is None:
            continue
        ms = [m for m in page_measures if m.staff is st]
        if not ms:
            continue
        xc = (sd.x0 + sd.x1) / 2
        meas = next((m for m in ms if m.x0 <= xc < m.x1), None) or (ms[-1] if xc >= ms[-1].x0 else ms[0])
        chord = parse_chord(txt)
        if chord:
            attach_harmony(meas, chord, sd.x0, max(c.x1 for c in grp if c.c.strip()), st)
        else:
            meas.words.append(txt)
            warn.add(f"Nierozpoznany akord „{txt}” (str. {pno + 1}) — wstawiony jako tekst")

    # --- other text: rows → phrases
    for ln_y, lchars in group_lines(other, 2.0):
        toks = cluster_text(lchars, lchars[0].size * 0.22)
        phrases = []
        for tok in toks:
            if phrases and tok[0].x0 - phrases[-1][-1].x1 < tok[0].size * 1.2:
                phrases[-1] += [TextChar(" ", phrases[-1][-1].x1, tok[0].x0, tok[0].y, tok[0].size, tok[0].font)] + tok
            else:
                phrases.append(list(tok))
        for tok in phrases:
            txt = token_text(tok).strip()
            if not txt or re.fullmatch(r"\d+", txt):
                continue   # numery taktów
            st = staff_below(tok[0].y)
            if st is None or tok[0].y > st.bottom + 2 * st.sp or tok[0].y < st.top - 6.5 * st.sp:
                continue
            ms = [m for m in page_measures if m.staff is st]
            if not ms:
                continue
            xc = (tok[0].x0 + tok[-1].x1) / 2
            meas = next((m for m in ms if m.x0 <= xc < m.x1), None) or ms[0]
            br = has_bracket(hlines_page, tok[0], st)
            if re.fullmatch(r"\d\.", txt) and br:
                num = txt.rstrip(".")
                meas.ending_start = num
                end_x, hooked = br
                stop_m = next((m for m in ms if m.x0 - 3 <= end_x <= m.x1 + 3 and m.x1 >= end_x - 3), ms[-1])
                stop_m.ending_stop = (num, "stop" if hooked else "discontinue")
            elif meta.get("title") and txt.lower() == meta["title"].lower():
                continue   # running header with the title on later pages
            elif len(txt) > 1 and not re.fullmatch(r"[\d\W]+", txt):
                meas.words.append(txt)


def chord_text(grp):
    """Joins the characters of a chord symbol; stacked extensions, e.g. (#5 over #9), are read row by row."""
    chars = sorted([c for c in grp if c.c.strip()], key=lambda c: c.x0)
    cols = []
    for c in chars:
        if cols and c.x0 < max(o.x1 for o in cols[-1]) - 0.6:
            cols[-1].append(c)
        else:
            cols.append([c])
    out = []
    i = 0
    while i < len(cols):
        if len(cols[i]) > 1:
            j = i
            while j < len(cols) and len(cols[j]) > 1:
                j += 1
            region = [c for col in cols[i:j] for c in col]
            rows = group_lines(region, 1.2)
            for _, rc in sorted(rows, key=lambda r: r[0]):
                out += [c.c for c in sorted(rc, key=lambda c: c.x0)]
            i = j
        else:
            out.append(cols[i][0].c)
            i += 1
    return "".join(out)


def has_bracket(hlines, ch, staff):
    """Volta: a horizontal line above the digit, starting right next to it."""
    for (x0, x1, y, w) in hlines:
        if x0 - 2 <= ch.x0 <= x0 + 4 * staff.sp and 0 < ch.y - y < 4 * staff.sp and x1 - x0 > 4 * staff.sp:
            hooked = any(abs(vx - x1) < 1.0 and abs(vy0 - y) < 1.0 for (vx, vy0, vy1, vw) in VLINES_CTX)
            return (x1, hooked)
    return None


def attach_harmony(meas: Measure, chord: Chord, x: float, x1: float, staff: Staff):
    evs = meas.events
    cx = (x + x1) / 2
    if not evs:
        ev = Event(x=meas.x0, x1=meas.x0, rest=True, base=F(4), measure_rest=True)
        meas.events.append(ev)
        evs = meas.events
    rests_only = [e for e in evs if e.rest and e.measure_rest]
    if rests_only and len(evs) == len(rests_only):
        # Whole-measure rest: the chord's position is a fraction of the measure width — its length
        # is only known once the time signature is known (finish_part converts this into an offset).
        rests_only[0].harmonies.append((chord, ("pos", x, meas.x1)))
        return
    # event at or before the chord, closest by x
    # Programs align a chord either by its left edge or by its center over the note
    def score(e):
        return min(abs(e.x - x), abs((e.x + e.x1) / 2 - cx))
    best = min(evs, key=score)
    if score(best) <= 2.2 * staff.sp:
        best.harmonies.append((chord, F(0)))
        return
    before = [e for e in evs if e.x <= x]
    e = before[-1] if before else evs[0]
    idx = evs.index(e)
    nx = evs[idx + 1].x if idx + 1 < len(evs) else meas.x1
    frac = max(0.0, min(1.0, (x - e.x) / max(1.0, nx - e.x)))
    off = F(round(frac * float(e.dur) * 2), 2)
    if off >= e.dur:
        off = F(0)
    e.harmonies.append((chord, off))


# --------------------------------------------------------------------------- final processing and MusicXML

def finish_part(measures: list[Measure], warn: Warnings, label=None):
    tag = f"{label}, takt" if label else "Takt"
    nbad = 0
    # intro without a staff (rhythm only) has no key — the piece's key comes from the first staff
    if measures and measures[0].key is None:
        first_key = next((m.key for m in measures if m.key is not None), None)
        if first_key is not None:
            for m in measures:
                if m.key is not None:
                    break
                m.key = first_key
                break
    key = 0
    time = (4, 4)
    divisions = 24
    out_measures = []
    prev_ties = {}   # diatonic -> alter for notes tied across the barline
    pending_ties = []  # (step,oct,alter) z poprzedniego zdarzenia
    last_note_event = None

    for idx, m in enumerate(measures):
        if m.key is not None:
            key = m.key
        if m.time is not None:
            time = m.time
        expected = F(time[0] * 4, time[1])
        # whole-measure rest
        for e in m.events:
            if e.rest and e.measure_rest:
                e.dur = expected
                pos = sorted([h for h in e.harmonies if isinstance(h[1], tuple)], key=lambda h: h[1][1])
                fixed = [h for h in e.harmonies if not isinstance(h[1], tuple)]
                if pos:
                    # the first chord over a whole-measure rest = the start of the measure, the following ones by their distance from it
                    x_first = pos[0][1][1]
                    for k, (ch, (_, x, x_end)) in enumerate(pos):
                        if k == 0:
                            off = F(0)
                        else:
                            frac = (x - x_first) / max(1.0, x_end - x_first)
                            grid = F(4, time[1])   # beat unit of the time signature: quarter in x/4, eighth in x/8
                            off = F(round(frac * float(expected) / float(grid))) * grid
                            if off >= expected or off <= 0:
                                off = F(0)
                        fixed.append((ch, off))
                e.harmonies = sorted(fixed, key=lambda t: t[1])
        # rhythm slashes on top of rests (cue rhythm notation): the slashes take precedence
        if any(e.slash for e in m.events):
            tot = sum((e.dur for e in m.events), F(0))
            for e in sorted([e for e in m.events if e.rest], key=lambda e: -e.dur):
                if tot <= expected:
                    break
                m.events.remove(e)
                tot -= e.dur
            if tot < expected and m.events:
                pad = Event(x=m.x1 - 1, x1=m.x1, rest=True, base=expected - tot)
                pad.dur = expected - tot
                m.events.append(pad)
        # empty measure → whole-measure rest
        if not m.events:
            m.events.append(Event(x=m.x0, x1=m.x0, rest=True, base=expected, measure_rest=True))
            m.events[-1].dur = expected

        # accidentals: key + local accidentals within the measure
        key_alter = key_alters(key)
        local = {}
        for e in m.events:
            if e.rest:
                continue
            new_p = []
            for p in e.pitches:
                if len(p) == 4:   # slash
                    new_p.append(p)
                    continue
                step, octv, _, acc, d, hy = p
                if acc is not None:
                    alter = acc
                    local[d] = acc
                    show = True
                elif d in local:
                    alter = local[d]
                    show = False
                else:
                    alter = key_alter.get(step, 0)
                    show = False
                new_p.append((step, octv, alter, show, d, hy))
            e.pitches = new_p

        normal = [e for e in m.events if not e.cue]
        cues = [e for e in m.events if e.cue]
        m.two_voices = bool(normal) and bool(cues)
        if not m.two_voices:
            for e in m.events:
                e.cue = False
        total = sum((e.dur for e in (normal if m.two_voices else m.events)), F(0))
        if m.two_voices:
            t2 = sum((e.dur for e in cues), F(0))
            if t2 != expected:
                warn.add(f"{tag} {len(out_measures) + 1} (nuty instrumentalne): długość {fmt_dur(t2)} zamiast {fmt_dur(expected)}")
        if total != expected:
            if idx == 0 and total < expected:
                m.implicit = True
            else:
                warn.add(f"{tag} {len(out_measures) + 1}: długość {fmt_dur(total)} zamiast {fmt_dur(expected)} — sprawdź rytm")
                nbad += 1
        out_measures.append(m)

    # ties: tie start at a head + the next event with the same pitch
    flat = [e for m in out_measures for e in m.events]
    for i, e in enumerate(flat):
        if e.rest or not e.tie_start_ys:
            continue
        nxt = next((f for f in flat[i + 1:] if not f.rest and f.cue == e.cue), None)
        if nxt is None:
            continue
        for k, p in enumerate(e.pitches):
            if len(p) == 4:
                continue
            hy = round(p[5], 1)
            if any(abs(hy - ty) < 0.3 for ty, _ in e.tie_start_ys):
                for j, q in enumerate(nxt.pitches):
                    if len(q) != 4 and q[4] == p[4]:
                        e.ties_out.add(k)
                        nxt.ties_in.add(j)
                        # tied note across the barline keeps the alteration
                        if q[2] != p[2] and not q[3]:
                            nxt.pitches[j] = (q[0], q[1], p[2], False, q[4], q[5])

    return out_measures, nbad


def key_alters(fifths: int):
    sharps = "FCGDAEB"
    flats = "BEADGCF"
    d = {}
    if fifths > 0:
        for s in sharps[:fifths]:
            d[s] = 1
    elif fifths < 0:
        for s in flats[:-fifths]:
            d[s] = -1
    return d


def fmt_dur(q: F) -> str:
    return f"{float(q):g} ćw."


TYPES = {F(4): "whole", F(2): "half", F(1): "quarter", F(1, 2): "eighth", F(1, 4): "16th",
         F(1, 8): "32nd", F(1, 16): "64th"}


def write_xml(parts: list, names: list, meta, divisions: int) -> str:
    out = []
    w = out.append
    w('<?xml version="1.0" encoding="UTF-8"?>')
    w('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">')
    w('<score-partwise version="4.0">')
    if meta.get("title"):
        w(f'  <work><work-title>{escape(meta["title"])}</work-title></work>')
        w(f'  <movement-title>{escape(meta["title"])}</movement-title>')
    w('  <identification>')
    if meta.get("composer"):
        w(f'    <creator type="composer">{escape(meta["composer"])}</creator>')
    if meta.get("lyricist"):
        w(f'    <creator type="lyricist">{escape(meta["lyricist"])}</creator>')
    w(f'    <encoding><software>Nuty → MusicXML, czytnik wektorowy {VERSION}</software>'
      '<supports element="accidental" type="yes"/><supports element="beam" type="no"/>'
      '<supports element="stem" type="no"/></encoding>')
    w('  </identification>')
    if meta.get("subtitle"):
        w('  <credit page="1"><credit-type>subtitle</credit-type>'
          f'<credit-words justify="center" valign="top">{escape(meta["subtitle"])}</credit-words></credit>')
    w('  <part-list>')
    for i, nm in enumerate(names, 1):
        w(f'    <score-part id="P{i}"><part-name>{escape(nm)}</part-name></score-part>')
    w('  </part-list>')
    for i, measures in enumerate(parts, 1):
        w(f'  <part id="P{i}">')
        write_part(w, measures, meta if i == 1 else {}, divisions)
        w('  </part>')
    w('</score-partwise>')
    return "\n".join(out) + "\n"


def write_part(w, measures, meta, divisions):
    key = None
    time = None
    tempo_done = False
    for n, m in enumerate(measures, 1):
        implicit = ' implicit="yes"' if getattr(m, "implicit", False) else ""
        num = "0" if implicit else str(n - (1 if getattr(measures[0], "implicit", False) else 0))
        w(f'    <measure number="{num}"{implicit}>')
        if m.new_page:
            w('      <print new-page="yes"/>')
        elif m.new_system and n > 1:
            w('      <print new-system="yes"/>')
        if m.left_bar == "forward":
            w('      <barline location="left"><bar-style>heavy-light</bar-style><repeat direction="forward"/></barline>')
        if m.ending_start:
            w(f'      <barline location="left"><ending number="{m.ending_start}" type="start">{m.ending_start}.</ending></barline>')
        attrs = []
        if n == 1:
            attrs.append(f'<divisions>{divisions}</divisions>')
        if m.key is not None and m.key != key or n == 1:
            key = m.key if m.key is not None else (key or 0)
            attrs.append(f'<key><fifths>{key}</fifths></key>')
        if m.time is not None and m.time != time or n == 1:
            time = m.time or time or (4, 4)
            attrs.append(f'<time><beats>{time[0]}</beats><beat-type>{time[1]}</beat-type></time>')
        if m.clef:
            sign, line, oc = {"G": ("G", 2, 0), "G8": ("G", 2, -1), "F": ("F", 4, 0), "C": ("C", 3, 0)}[m.clef]
            attrs.append(f'<clef><sign>{sign}</sign><line>{line}</line>'
                         + (f'<clef-octave-change>{oc}</clef-octave-change>' if oc else '') + '</clef>')
        if attrs:
            w('      <attributes>' + "".join(attrs) + '</attributes>')
        for r in m.rehearsal:
            w(f'      <direction placement="above"><direction-type><rehearsal enclosure="rectangle">{escape(r)}</rehearsal></direction-type></direction>')
        if not tempo_done and meta.get("tempo"):
            t = meta["tempo"]
            w(f'      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>'
              f'<per-minute>{t}</per-minute></metronome></direction-type><sound tempo="{t}"/></direction>')
            tempo_done = True
        for wd in m.words:
            w(f'      <direction placement="above"><direction-type><words>{escape(wd)}</words></direction-type></direction>')

        if getattr(m, "two_voices", False):
            layers = [(1, [e for e in m.events if not e.cue]), (2, [e for e in m.events if e.cue])]
        else:
            layers = [(1, m.events)]
        for li, (voice, evs) in enumerate(layers):
            if li > 0:
                back = sum((e.dur for e in layers[li - 1][1]), F(0))
                w(f'      <backup><duration>{int(back * divisions)}</duration></backup>')
            for e in evs:
                write_event(w, e, voice, divisions)
        if m.right_bar == "backward":
            w('      <barline location="right"><bar-style>light-heavy</bar-style><repeat direction="backward"/></barline>')
        elif m.right_bar == "final":
            w('      <barline location="right"><bar-style>light-heavy</bar-style></barline>')
        elif m.right_bar == "double":
            w('      <barline location="right"><bar-style>light-light</bar-style></barline>')
        if m.ending_stop:
            num, typ = m.ending_stop
            w(f'      <barline location="right"><ending number="{num}" type="{typ}"/></barline>')
        w('    </measure>')


def write_event(w, e: Event, voice: int, divisions: int):
    for chord, off in e.harmonies:
        w(harmony_xml(chord, off, divisions))
    dur = int(e.dur * divisions)
    typ = TYPES.get(e.base)
    cue = e.cue
    size = ' size="cue"' if cue else ''
    if e.rest:
        mr = ' measure="yes"' if e.measure_rest else ""
        w('      <note>' + ('<cue/>' if cue else '') + f'<rest{mr}/>'
          + f'<duration>{dur}</duration><voice>{voice}</voice>'
          + (f'<type{size}>{typ}</type>' if typ and not e.measure_rest else '')
          + '<dot/>' * (e.dots if not e.measure_rest else 0) + '</note>')
        return
    for k, p in enumerate(e.pitches):
        parts = ['      <note>']
        if cue:
            parts.append('<cue/>')
        if k > 0:
            parts.append('<chord/>')
        if len(p) == 4:
            parts.append('<pitch><step>B</step><octave>4</octave></pitch>')
        else:
            step, octv, alter, show, d, hy = p
            parts.append(f'<pitch><step>{step}</step>' + (f'<alter>{alter}</alter>' if alter else '')
                         + f'<octave>{octv}</octave></pitch>')
        parts.append(f'<duration>{dur}</duration>')
        if not cue:
            if k in e.ties_in:
                parts.append('<tie type="stop"/>')
            if k in e.ties_out:
                parts.append('<tie type="start"/>')
        parts.append(f'<voice>{voice}</voice>')
        if typ:
            parts.append(f'<type{size}>{typ}</type>')
        parts.append('<dot/>' * e.dots)
        if len(p) != 4 and p[3]:
            acc = {1: "sharp", -1: "flat", 0: "natural", 2: "double-sharp", -2: "flat-flat"}[p[2]]
            parts.append(f'<accidental>{acc}</accidental>')
        if e.slash:
            parts.append('<stem>none</stem><notehead>slash</notehead>')
        elif e.xhead:
            parts.append('<notehead>x</notehead>')
        notations = []
        if k in e.ties_in:
            notations.append('<tied type="stop"/>')
        if k in e.ties_out:
            notations.append('<tied type="start"/>')
        if notations:
            parts.append('<notations>' + "".join(notations) + '</notations>')
        if k == 0:
            for v in sorted(e.lyrics):
                txt, syl = e.lyrics[v]
                parts.append(f'<lyric number="{v}"><syllabic>{syl}</syllabic><text>{escape(txt)}</text></lyric>')
        parts.append('</note>')
        w("".join(parts))


def harmony_xml(ch: Chord, off: F, divisions: int) -> str:
    s = ['      <harmony print-frame="no">']
    s.append(f'<root><root-step>{ch.root}</root-step>' + (f'<root-alter>{ch.alter}</root-alter>' if ch.alter else '') + '</root>')
    s.append(f'<kind text="{escape(ch.kind_text, {chr(34): "&quot;"})}">{ch.kind}</kind>')
    if ch.bass:
        s.append(f'<bass><bass-step>{ch.bass}</bass-step>' + (f'<bass-alter>{ch.bass_alter}</bass-alter>' if ch.bass_alter else '') + '</bass>')
    for (val, alt, typ) in ch.degrees:
        s.append(f'<degree print-object="no"><degree-value>{val}</degree-value><degree-alter>{alt}</degree-alter><degree-type>{typ}</degree-type></degree>')
    if off:
        s.append(f'<offset>{int(off * divisions)}</offset>')
    s.append('</harmony>')
    return "".join(s)


# --------------------------------------------------------------------------- CLI

def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 1
    try:
        xml, warn = convert(argv[1])
    except Exception as ex:  # noqa
        import traceback
        traceback.print_exc()
        print(f"BŁĄD: {ex}")
        return 1
    if xml is None:
        if warn and warn[0] == "NIEPEWNY":
            print("NIEPEWNY: " + warn[1])
            return 4
        print("BRAK_WEKTOROW: PDF nie zawiera nut zapisanych wektorowo (np. skan).")
        return 3
    with open(argv[2], "w", encoding="utf-8") as f:
        f.write(xml)
    for w_ in warn:
        print("UWAGA: " + w_)
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
