"""Automatic updates from GitHub Releases.

Checks https://api.github.com/repos/<REPO>/releases, picks the newest release that has
the Windows installer (NutyMusicXML-Setup-<version>.exe), downloads it, verifies SHA-256
(when GitHub provides "digest") and runs it silently. The app then closes and the installer
launches it again (see the [Run] entry with WizardSilent in installer/NutyMusicXML.iss).
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from . import __version__

REPO = "IksuX/Music-XML-Converter-"
API = f"https://api.github.com/repos/{REPO}/releases?per_page=15"
ASSET_RE = re.compile(r"^NutyMusicXML-Setup-([\d.]+)\.exe$")
CHECK_EVERY = 6 * 3600


def parse_version(v: str):
    v = v.strip().lstrip("vV")
    out = []
    for part in v.split("."):
        m = re.match(r"\d+", part)
        out.append(int(m.group()) if m else 0)
    while len(out) < 3:
        out.append(0)
    return tuple(out)


def newer(a: str, b: str) -> bool:
    return parse_version(a) > parse_version(b)


def _request(url, accept="application/vnd.github+json"):
    return urllib.request.Request(url, headers={"Accept": accept, "User-Agent": f"NutyMusicXML/{__version__}"})


def pick_release(releases):
    """From the GitHub API list, returns the newest release that has a Windows installer."""
    best = None
    for r in releases or []:
        if r.get("draft") or r.get("prerelease"):
            continue
        version = (r.get("tag_name") or "").lstrip("vV")
        for a in r.get("assets") or []:
            if ASSET_RE.match(a.get("name") or ""):
                info = {
                    "version": version,
                    "notes": r.get("body") or "",
                    "page": r.get("html_url") or f"https://github.com/{REPO}/releases",
                    "url": a.get("browser_download_url"),
                    "name": a.get("name"),
                    "size": a.get("size") or 0,
                    "digest": a.get("digest") or "",
                }
                if best is None or newer(version, best["version"]):
                    best = info
                break
    return best


class Updater:
    def __init__(self, settings, log, can_install=lambda: True):
        self._settings = settings
        self._log = log
        self._can_install = can_install
        self._lock = threading.Lock()
        self.available = None      # dict from pick_release
        self.status = ""           # tekst dla UI
        self.busy = False
        self.progress = 0.0        # 0..1 przy pobieraniu
        self.dismissed = False

    # ------------------------------------------------------------- stan dla UI
    def state(self):
        return {"current": __version__, "available": self.available, "status": self.status,
                "busy": self.busy, "progress": self.progress, "dismissed": self.dismissed,
                "auto": self._settings.get("auto_update")}

    def dismiss(self):
        self.dismissed = True

    # ------------------------------------------------------------- sprawdzanie
    def check_on_start(self):
        if not self._settings.get("auto_update"):
            return
        last = self._settings.get("last_update_check")
        if time.time() - last < CHECK_EVERY:
            return
        threading.Thread(target=self.check, kwargs={"manual": False}, daemon=True).start()

    def check(self, manual=True):
        with self._lock:
            if self.busy:
                return self.state()
            self.busy = True
        if manual:
            self.status = "Sprawdzam aktualizacje…"
        try:
            with urllib.request.urlopen(_request(API), timeout=20) as r:
                releases = json.load(r)
            self._settings.set("last_update_check", float(time.time()))
            info = pick_release(releases)
            if info and newer(info["version"], __version__):
                self.available = info
                self.dismissed = False
                self.status = ""
                self._log(f"ℹ︎ Dostępna nowa wersja {info['version']} (masz {__version__}).")
            else:
                self.available = None
                self.status = f"Masz najnowszą wersję ({__version__})." if manual else ""
        except Exception as ex:  # noqa — brak sieci, limit API itp.
            self.status = f"Nie udało się sprawdzić aktualizacji: {ex}" if manual else ""
        finally:
            self.busy = False
        return self.state()

    # ------------------------------------------------------------- instalacja
    def install(self, on_quit):
        info = self.available
        if not info:
            return {"ok": False, "error": "Brak aktualizacji do zainstalowania."}
        if not self._can_install():
            return {"ok": False, "error": "Poczekaj, aż skończy się konwersja albo instalacja silników."}
        if not getattr(sys, "frozen", False):
            return {"ok": False, "error": "Aktualizacja działa tylko w zainstalowanej aplikacji — pobierz instalator ze strony wydania."}
        with self._lock:
            if self.busy:
                return {"ok": False, "error": "Trwa już inna operacja aktualizacji."}
            self.busy = True
        threading.Thread(target=self._install, args=(info, on_quit), daemon=True).start()
        return {"ok": True}

    def _install(self, info, on_quit):
        try:
            work = Path(tempfile.mkdtemp(prefix="NutyMusicXML-update-"))
            dest = work / info["name"]
            self.status = f"Pobieram {info['name']}…"
            self._log(f"▶︎ Aktualizacja do {info['version']}: pobieram {info['url']}")
            h = hashlib.sha256()
            with urllib.request.urlopen(_request(info["url"], "application/octet-stream"), timeout=60) as r, \
                    open(dest, "wb") as f:
                total = int(r.headers.get("Content-Length") or info["size"] or 0)
                done = 0
                while True:
                    chunk = r.read(1 << 16)
                    if not chunk:
                        break
                    f.write(chunk)
                    h.update(chunk)
                    done += len(chunk)
                    if total:
                        self.progress = done / total
            digest = info.get("digest") or ""
            if digest.startswith("sha256:"):
                if h.hexdigest() != digest.split(":", 1)[1].lower():
                    raise RuntimeError("suma kontrolna pobranego pliku się nie zgadza — plik uszkodzony, spróbuj ponownie")
                self._log("✓ Suma kontrolna SHA-256 zgodna")
            self.status = "Uruchamiam instalator…"
            self._log("ℹ︎ Aplikacja zamknie się na chwilę i uruchomi ponownie po aktualizacji.")
            flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
            subprocess.Popen([str(dest), "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS",
                              f"/LOG={work / 'instalacja.log'}"], creationflags=flags, close_fds=True,
                             cwd=str(work))
            time.sleep(0.5)
            on_quit()
        except Exception as ex:  # noqa
            self.status = f"Aktualizacja nie powiodła się: {ex}"
            self._log(f"⚠︎ {self.status}")
            self.busy = False
            self.progress = 0.0


def open_page(url):
    if sys.platform == "win32":
        os.startfile(url)  # noqa
    else:
        import webbrowser
        webbrowser.open(url)
