"""File list, conversion and log — the same order of steps as in the Mac version (Converter.swift)."""
import shutil
import tempfile
import threading
import time
import traceback
import uuid
from datetime import datetime
from pathlib import Path

from . import engines, imaging, merge, wektor_pdf
from .proc import Runner
from .settings import Settings


class Job:
    def __init__(self, source: Path):
        self.id = uuid.uuid4().hex[:12]
        self.source = source
        self.status = "waiting"      # waiting / working / done / partial / failed
        self.text = "Czeka"
        self.outputs = []
        self.pages = imaging.page_count(source) if imaging.is_pdf(source) else 1

    def to_dict(self):
        return {"id": self.id, "name": self.source.name, "path": str(self.source),
                "pdf": imaging.is_pdf(self.source), "pages": self.pages,
                "status": self.status, "text": self.text,
                "outputs": [{"path": str(o), "name": o.name, "label": self._label(o)} for o in self.outputs]}

    def _label(self, o: Path):
        rest = o.stem[len(self.source.stem):] if o.stem.startswith(self.source.stem) else o.stem
        rest = rest.strip("-_ ")
        return rest or "Odtwórz"


class Converter:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.jobs: list = []
        self._log: list = []
        self._log_base = 0             # ile linii usunięto z początku (żeby indeksy dla UI były stałe)
        self._lock = threading.RLock()
        self.running = False
        self.installing = False
        self._runner = Runner()
        self._thread = None
        self.engines = {}
        self.refresh_engines()

    # ------------------------------------------------------------------ log
    def log(self, line: str):
        with self._lock:
            self._log.append(line)
            if len(self._log) > 4000:
                drop = len(self._log) - 3000
                del self._log[:drop]
                self._log_base += drop

    def log_since(self, idx: int):
        with self._lock:
            start = max(0, idx - self._log_base)
            if idx < self._log_base:
                start = 0
            return self._log_base + len(self._log), self._log[start:], idx < self._log_base

    def clear_log(self):
        with self._lock:
            self._log_base += len(self._log)
            self._log.clear()

    def log_text(self) -> str:
        from . import __version__
        import platform
        with self._lock:
            lines = list(self._log)
        head = (f"Nuty → MusicXML {__version__} (Windows) · log z {datetime.now():%Y-%m-%d %H:%M:%S}\n"
                f"{platform.platform()}\n\n")
        return head + "\n".join(lines) + "\n"

    # ------------------------------------------------------------------ silniki
    def refresh_engines(self):
        s = self.settings
        self.engines = {
            "audiveris": engines.resolve(s.get("custom_audiveris"), engines.audiveris_candidates()),
            "oemer": engines.resolve(s.get("custom_oemer"), engines.oemer_candidates()),
            "vector": True,   # czytnik jest wbudowany w aplikację
            "ocr_missing": engines.missing_languages(s.languages),
        }
        return self.engines

    def missing_engine_message(self):
        waiting = [j for j in self.jobs if j.status == "waiting"]
        if self.settings.get("use_vector") and waiting and all(imaging.is_pdf(j.source) for j in waiting):
            return None
        eng = self.settings.get("engine")
        missing = []
        if eng in ("audiveris", "both") and not self.engines["audiveris"]:
            missing.append("Audiveris")
        if eng in ("oemer", "both") and not self.engines["oemer"]:
            missing.append("oemer")
        if not missing:
            return None
        return f"Brak silnika: {', '.join(missing)}. Zainstaluj go w Ustawieniach."

    # ------------------------------------------------------------------ lista
    def add(self, paths, from_folder=False) -> list:
        """Adds files to the list; returns MusicXML files to open in the player."""
        to_play = []
        with self._lock:
            for p in paths:
                p = Path(p)
                if p.is_dir():
                    items = sorted(p.iterdir(), key=lambda x: x.name.lower())
                    self.add(items, from_folder=True)
                    continue
                ext = p.suffix.lower()
                if ext in imaging.MUSICXML_EXT:
                    if not from_folder:
                        to_play.append(str(p))
                    continue
                if ext not in imaging.ACCEPTED_EXT or not p.is_file():
                    continue
                if any(j.source == p for j in self.jobs):
                    continue
                self.jobs.append(Job(p))
        return to_play

    def remove(self, ids):
        with self._lock:
            if not self.running:
                self.jobs = [j for j in self.jobs if j.id not in set(ids)]

    def clear_list(self):
        with self._lock:
            if not self.running:
                self.jobs.clear()

    def reset_finished(self):
        with self._lock:
            if not self.running:
                for j in self.jobs:
                    j.status, j.text, j.outputs = "waiting", "Czeka", []

    def can_start(self):
        out_ok = self.settings.get("output_location") == "next" or bool(self.settings.get("output_folder"))
        return (not self.running and not self.installing and any(j.status == "waiting" for j in self.jobs)
                and self.missing_engine_message() is None and out_ok)

    # ------------------------------------------------------------------ konwersja
    def start(self):
        if not self.can_start():
            return False
        self.running = True
        self._runner = Runner()
        self._thread = threading.Thread(target=self._run_all, daemon=True)
        self._thread.start()
        return True

    def cancel(self):
        self._runner.cancel()
        self.log("Przerwano przez użytkownika.")

    def _run_all(self):
        try:
            for job in list(self.jobs):
                if self._runner.cancelled:
                    break
                if job.status != "waiting":
                    continue
                try:
                    self._process(job)
                except Exception as ex:  # noqa
                    job.status, job.text = "failed", f"Błąd: {ex}"
                    self.log(f"⚠︎ {job.source.name}: {ex}")
                    self.log(traceback.format_exc().strip().splitlines()[-1])
            for j in self.jobs:
                if j.status == "working":
                    j.status, j.text = "failed", "Przerwano"
            self.log("— Zakończono —")
        finally:
            self.running = False

    def _dest_dir(self, src: Path) -> Path:
        if self.settings.get("output_location") == "folder" and self.settings.get("output_folder"):
            return Path(self.settings.get("output_folder"))
        return src.parent

    @staticmethod
    def _unique(p: Path) -> Path:
        if not p.exists():
            return p
        n = 2
        while True:
            c = p.with_name(f"{p.stem} ({n}){p.suffix}")
            if not c.exists():
                return c
            n += 1

    def _process(self, job: Job):
        s = self.settings
        src = job.source
        engine = s.get("engine")
        out_dir = self._dest_dir(src)
        out_dir.mkdir(parents=True, exist_ok=True)
        base_out = src.stem
        safe = imaging.safe_name(src)
        errors, outputs, notes = [], [], []
        vector_done = False
        suffixed = engine == "both"
        self.log(f"▶︎ {datetime.now():%H:%M:%S}  {src.name}")
        scratch = Path(tempfile.mkdtemp(prefix="NutyMusicXML-"))
        try:
            # --- vector read: a PDF from a notation program, exact, no recognition
            if s.get("use_vector") and imaging.is_pdf(src) and not self._runner.cancelled:
                job.status, job.text = "working", "Czytam nuty bezpośrednio z PDF…"
                try:
                    xml, warn = wektor_pdf.convert(str(src))
                except Exception as ex:  # noqa
                    xml, warn = None, ["BŁĄD", str(ex)]
                    self.log(f"⚠︎ Czytnik wektorowy: {ex} — używam rozpoznawania obrazu.")
                if xml:
                    dest = self._unique(out_dir / f"{base_out}.musicxml")
                    dest.write_text(xml, encoding="utf-8")
                    outputs.append(dest)
                    vector_done = True
                    notes = list(warn)
                    for n in notes:
                        self.log(f"[PDF] UWAGA: {n}")
                elif warn and warn[0] == "NIEPEWNY":
                    self.log(f"ℹ︎ {src.name}: odczyt bezpośredni niepewny ({warn[1]}) — używam rozpoznawania obrazu.")
                elif warn and warn[0] != "BŁĄD":
                    self.log(f"ℹ︎ {src.name}: PDF bez nut wektorowych (skan) — używam rozpoznawania obrazu.")
            if vector_done:
                suffixed = False

            if not vector_done and not any(
                    self.engines.get(e) for e in (["audiveris"] if engine == "audiveris" else
                                                  ["oemer"] if engine == "oemer" else ["audiveris", "oemer"])):
                errors.append("To jest skan/obraz, a silnik rozpoznawania nut nie jest zainstalowany — "
                              "zainstaluj Audiveris w Ustawieniach")

            # --- Audiveris
            exe = self.engines.get("audiveris")
            if not vector_done and engine in ("audiveris", "both") and exe and not self._runner.cancelled:
                job.status, job.text = "working", "Audiveris rozpoznaje…"
                try:
                    files = self._audiveris(exe, src, safe, scratch)
                    for n, mxl in enumerate(files):
                        mv = f"-cz{n + 1}" if len(files) > 1 else ""
                        name = base_out + ("-audiveris" if suffixed else "") + mv
                        dest = self._unique(out_dir / f"{name}.musicxml")
                        imaging.unpack_mxl(mxl, dest)
                        outputs.append(dest)
                        if s.get("keep_mxl"):
                            shutil.copyfile(mxl, self._unique(out_dir / f"{name}.mxl"))
                    if not files:
                        errors.append("Audiveris nie rozpoznał żadnej partytury")
                except Exception as ex:  # noqa
                    errors.append(f"Audiveris: {ex}")

            # --- oemer
            exe = self.engines.get("oemer")
            if not vector_done and engine in ("oemer", "both") and exe and not self._runner.cancelled:
                try:
                    if imaging.is_pdf(src):
                        job.status, job.text = "working", "Przygotowuję strony PDF…"
                        images = imaging.rasterize_pdf(src, scratch, safe)
                    else:
                        images = [imaging.prepared_image(src, scratch, safe)]
                    pages = []
                    for n, img in enumerate(images):
                        if self._runner.cancelled:
                            break
                        job.status = "working"
                        job.text = (f"oemer: strona {n + 1} z {len(images)}…" if len(images) > 1
                                    else "oemer rozpoznaje… (może potrwać kilka minut)")
                        tmp_out = scratch / f"oemer-{n + 1}.musicxml"
                        args = [exe, img, "-o", tmp_out]
                        if not s.get("oemer_deskew"):
                            args.append("--without-deskew")
                        code, _ = self._runner.run(args, cwd=scratch, on_line=lambda l: self.log(f"[oemer] {l}"))
                        if code == 0 and tmp_out.is_file():
                            if s.get("merge_oemer_pages") and len(images) > 1:
                                pages.append(tmp_out)
                            else:
                                tag = f"-str{n + 1:02d}" if len(images) > 1 else ""
                                dest = self._unique(out_dir / f"{base_out}{'-oemer' if suffixed else ''}{tag}.musicxml")
                                shutil.copyfile(tmp_out, dest)
                                outputs.append(dest)
                        else:
                            errors.append(f"oemer{f' (strona {n + 1})' if len(images) > 1 else ''}: kod błędu {code}")
                    if pages and not self._runner.cancelled:
                        job.text = f"Łączę {len(pages)} stron w jeden plik…"
                        dest = self._unique(out_dir / f"{base_out}{'-oemer' if suffixed else ''}.musicxml")
                        for w in merge.merge(pages, dest):
                            self.log(f"⚠︎ {w}")
                        outputs.append(dest)
                except Exception as ex:  # noqa
                    errors.append(f"oemer: {ex}")
        finally:
            shutil.rmtree(scratch, ignore_errors=True)

        job.outputs = outputs
        if self._runner.cancelled:
            job.status, job.text = "failed", "Przerwano"
        elif vector_done and notes:
            job.status = "partial"
            job.text = "Odczytane z PDF · do sprawdzenia: " + (notes[0] if len(notes) == 1 else f"{len(notes)} uwag (log)")
        elif vector_done or not errors:
            if not outputs:
                job.status, job.text = "failed", "Brak wyniku — sprawdź log"
            else:
                job.status, job.text = "done", "Gotowe"
        elif not outputs:
            job.status, job.text = "failed", "; ".join(errors)
        else:
            job.status, job.text = "partial", "; ".join(errors)
        for e in errors:
            self.log(f"⚠︎ {e}")
        for o in outputs:
            self.log(f"✓ {o.name}")

    def _audiveris(self, exe, src: Path, safe: str, scratch: Path) -> list:
        inp = scratch / "audiveris-in"
        out = scratch / "audiveris-out"
        inp.mkdir()
        out.mkdir()
        if imaging.is_pdf(src):
            pages = imaging.rasterize_pdf(src, inp, safe)
            prepared = inp / f"{safe}.pdf"
            imaging.make_pdf(pages, prepared)
            for p in pages:
                p.unlink(missing_ok=True)
        else:
            prepared = imaging.prepared_image(src, inp, safe)
        args = [exe, "-batch", "-export", "-output", out]
        langs = self.settings.languages
        env = {}
        if langs:
            args += ["-constant", f"org.audiveris.omr.text.Language.defaultSpecification={langs}"]
            missing = engines.missing_languages(langs)
            if missing:
                self.log(f"⚠︎ Brak plików OCR dla: {', '.join(missing)} — tekst pod nutami nie zostanie odczytany. "
                         "Zainstaluj języki w Ustawieniach.")
            # Audiveris checks TESSDATA_PREFIX first — so it uses the languages downloaded by the app.
            env["TESSDATA_PREFIX"] = str(engines.tessdata_dir())
        args += ["--", prepared]
        code, _ = self._runner.run(args, cwd=scratch, env_extra=env, on_line=lambda l: self.log(f"[Audiveris] {l}"))
        found = sorted(out.rglob("*.mxl"), key=lambda p: p.name.lower())
        if not found and code != 0:
            raise RuntimeError(f"zakończył się kodem {code} — szczegóły w logu")
        return found

    # ------------------------------------------------------------------ instalacja silników
    def install(self, what: str):
        if self.running or self.installing:
            return False
        self.installing = True

        def work():
            r = Runner()
            try:
                if what in ("ocr", "all"):
                    engines.install_ocr(self.log)
                if what in ("audiveris", "all"):
                    engines.install_audiveris(self.log, r)
                if what in ("oemer", "all"):
                    engines.install_oemer(self.log, r)
            except Exception as ex:  # noqa
                self.log(f"⚠︎ Instalacja: {ex}")
            finally:
                self.refresh_engines()
                self.installing = False
        threading.Thread(target=work, daemon=True).start()
        return True
