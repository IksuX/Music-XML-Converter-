"""Merges separate MusicXML files (oemer: one per page) into one score."""
import xml.etree.ElementTree as ET
from pathlib import Path

HEADER = ('<?xml version="1.0" encoding="UTF-8"?>\n'
          '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" '
          '"http://www.musicxml.org/dtds/partwise.dtd">\n')


def merge(files: list, dest: Path) -> list:
    warnings = []
    if not files:
        return warnings
    base = ET.parse(files[0])
    root = base.getroot()
    if root.tag != "score-partwise":
        raise ValueError(f"{Path(files[0]).name}: to nie jest MusicXML (score-partwise)")
    parts = root.findall("part")
    if not parts:
        raise ValueError(f"{Path(files[0]).name}: brak nut")

    def max_measures(ps):
        return max((len(p.findall("measure")) for p in ps), default=0)

    def pad(ps, n):
        for p in ps:
            for _ in range(n - len(p.findall("measure"))):
                ET.SubElement(p, "measure")

    pad(parts, max_measures(parts))
    for k, f in enumerate(files[1:], start=2):
        try:
            other = ET.parse(f).getroot().findall("part")
        except ET.ParseError:
            warnings.append(f"Strona {k} pominięta — nieczytelny wynik oemera")
            continue
        if not other:
            warnings.append(f"Strona {k}: brak rozpoznanych nut")
            continue
        if len(other) != len(parts):
            warnings.append(f"Strona {k}: oemer rozpoznał {len(other)} pięciolinii zamiast {len(parts)} — sprawdź tę stronę")
        page_max = max_measures(other)
        for i, target in enumerate(parts):
            ms = other[i].findall("measure") if i < len(other) else []
            if ms:
                pr = ET.Element("print", {"new-system": "yes"})
                ms[0].insert(0, pr)
            for m in ms:
                target.append(m)
            for _ in range(page_max - len(ms)):
                ET.SubElement(target, "measure")
    for p in parts:
        for n, m in enumerate(p.findall("measure"), start=1):
            m.set("number", str(n))
    ET.indent(base, space="  ")
    dest.write_text(HEADER + ET.tostring(root, encoding="unicode") + "\n", encoding="utf-8")
    return warnings
