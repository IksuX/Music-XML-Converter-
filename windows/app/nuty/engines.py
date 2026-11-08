"""Finding and installing the OMR engines (Audiveris, oemer) and the OCR languages."""
import json
import os
import shutil
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from .paths import IS_WINDOWS, data_dir, tessdata_dir, tools_dir

UA = {"User-Agent": "NutyMusicXML"}

# The same versions as on the Mac — oemer 0.1.8 does not work with newer ones (see zainstaluj-silniki.sh).
OEMER_DEPS = [
    "onnxruntime==1.19.2",
    "opencv-python-headless==4.10.0.84",
    "numpy==1.26.4",
    "scipy==1.11.4",
    "scikit-learn==1.2.2",
    "matplotlib==3.8.4",
    "pillow",
    "typing-extensions",
]

OCR_LANGS = ["pol", "eng", "lat", "deu"]

DOWNLOAD_CHECKPOINTS = r'''
import os
from oemer import ete
for title, url in ete.CHECKPOINTS_URL.items():
    sub = "unet_big" if title.startswith("1st") else "seg_net"
    path = os.path.join(ete.MODULE_PATH, "checkpoints", sub, title.split("_")[1])
    if os.path.exists(path) and os.path.getsize(path) > 0:
        print("  jest:", title); continue
    ete.download_file(title, url, path)
print("modele OK")
'''


# --------------------------------------------------------------------------- znajdowanie

def _expand(p: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(p.strip().strip('"'))))


def audiveris_candidates() -> list:
    if IS_WINDOWS:
        pf = [os.environ.get("ProgramFiles", r"C:\Program Files"),
              os.environ.get("ProgramW6432", r"C:\Program Files"),
              os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")]
        local = os.environ.get("LOCALAPPDATA", "")
        c = [Path(x) / "Audiveris" / "Audiveris.exe" for x in pf]
        c += [Path(local) / "Programs" / "Audiveris" / "Audiveris.exe",
              Path.home() / "scoop" / "apps" / "audiveris" / "current" / "Audiveris.exe"]
        return c
    if sys.platform == "darwin":
        return [Path("/Applications/Audiveris.app/Contents/MacOS/Audiveris"),
                Path.home() / "Applications/Audiveris.app/Contents/MacOS/Audiveris"]
    w = shutil.which("audiveris") or shutil.which("Audiveris")
    return ([Path(w)] if w else []) + [Path("/opt/audiveris/bin/Audiveris")]


def oemer_venv() -> Path:
    return data_dir() / "oemer-venv"


def oemer_candidates() -> list:
    v = oemer_venv()
    return [v / "Scripts" / "oemer.exe"] if IS_WINDOWS else [v / "bin" / "oemer"]


def resolve(custom: str, candidates: list):
    if custom and custom.strip():
        p = _expand(custom)
        if p.suffix.lower() == ".app":
            p = p / "Contents" / "MacOS" / p.stem
        return str(p) if p.is_file() else None
    for c in candidates:
        if c.is_file():
            return str(c)
    return None


def missing_languages(spec: str) -> list:
    d = tessdata_dir()
    return [l for l in spec.split("+") if l and not (d / f"{l}.traineddata").is_file()]


# --------------------------------------------------------------------------- instalacja

def _download(url: str, dest: Path, log):
    log(f"   pobieram {url.rsplit('/', 1)[-1]}…")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        got, last = 0, -1
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
            got += len(chunk)
            if total:
                pct = got * 100 // total
                if pct // 10 != last:
                    last = pct // 10
                    log(f"   {pct}% ({got // (1 << 20)} z {total // (1 << 20)} MB)")


def install_ocr(log, force=False):
    d = tessdata_dir()
    log(f"→ Języki tekstu pod nutami (OCR): {', '.join(OCR_LANGS)}")
    for lang in OCR_LANGS:
        dest = d / f"{lang}.traineddata"
        if dest.is_file() and dest.stat().st_size > 0 and not force:
            log(f"   jest: {lang}")
            continue
        tmp = dest.with_suffix(".part")
        # Audiveris needs the "legacy" models — they are in the main tessdata repository (not _fast/_best).
        _download(f"https://github.com/tesseract-ocr/tessdata/raw/main/{lang}.traineddata", tmp, log)
        tmp.replace(dest)
    log(f"✓ Języki OCR gotowe ({d})")


def install_audiveris(log, runner):
    log("→ Szukam najnowszego Audiverisa…")
    req = urllib.request.Request("https://api.github.com/repos/Audiveris/audiveris/releases/latest", headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        rel = json.load(r)
    assets = [a["browser_download_url"] for a in rel.get("assets", [])]
    if IS_WINDOWS:
        # The "windowsConsole" variant writes messages to the console — the app captures them into the log.
        url = next((a for a in assets if a.endswith("windowsConsole-x86_64.msi")), None) \
            or next((a for a in assets if a.endswith("windows-x86_64.msi")), None)
    else:
        url = None
    if not url:
        raise RuntimeError("Nie znalazłem instalatora Audiverisa dla tego systemu — pobierz go ręcznie: "
                           "https://github.com/Audiveris/audiveris/releases")
    log(f"   wersja {rel.get('tag_name', '?')}")
    tmp = Path(tempfile.mkdtemp()) / url.rsplit("/", 1)[-1]
    _download(url, tmp, log)
    log("→ Instaluję Audiverisa — Windows zapyta o zgodę (okno „Kontrola konta użytkownika”).")
    code, _ = runner.run(["msiexec", "/i", str(tmp), "/passive", "/norestart"], on_line=log)
    if code not in (0, 3010):
        raise RuntimeError(f"Instalator Audiverisa zakończył się kodem {code}")
    log("✓ Audiveris zainstalowany")


def _uv(log) -> Path:
    found = shutil.which("uv")
    if found:
        return Path(found)
    exe = tools_dir() / ("uv.exe" if IS_WINDOWS else "uv")
    if exe.is_file():
        return exe
    log("→ Pobieram uv (menedżer Pythona, jeden plik)…")
    if IS_WINDOWS:
        asset = "uv-x86_64-pc-windows-msvc.zip"
    elif sys.platform == "darwin":
        asset = "uv-aarch64-apple-darwin.tar.gz"
    else:
        asset = "uv-x86_64-unknown-linux-gnu.tar.gz"
    tmpdir = Path(tempfile.mkdtemp())
    arch = tmpdir / asset
    _download(f"https://github.com/astral-sh/uv/releases/latest/download/{asset}", arch, log)
    if asset.endswith(".zip"):
        with zipfile.ZipFile(arch) as z:
            z.extractall(tmpdir)
    else:
        import tarfile
        with tarfile.open(arch) as t:
            t.extractall(tmpdir, filter="data")
    src = next(p for p in tmpdir.rglob(exe.name) if p.is_file())
    shutil.copyfile(src, exe)
    exe.chmod(0o755)
    return exe


def install_oemer(log, runner):
    uv = _uv(log)
    venv = oemer_venv()
    py = venv / ("Scripts/python.exe" if IS_WINDOWS else "bin/python")
    log("→ Tworzę osobne środowisko Python 3.11 dla oemera…")
    if venv.exists():
        shutil.rmtree(venv, ignore_errors=True)
    for cmd in ([uv, "venv", "--python", "3.11", venv],
                [uv, "pip", "install", "--python", py, "--no-deps", "oemer==0.1.8"],
                [uv, "pip", "install", "--python", py, *OEMER_DEPS]):
        code, _ = runner.run(cmd, on_line=lambda s: log("   " + s))
        if code != 0:
            raise RuntimeError(f"Instalacja oemera nie powiodła się (kod {code})")
    log("→ Pobieram modele sieci neuronowej (~100 MB, jednorazowo)…")
    code, _ = runner.run([py, "-c", DOWNLOAD_CHECKPOINTS], on_line=lambda s: log("   " + s))
    if code != 0:
        raise RuntimeError("Nie udało się pobrać modeli oemera")
    log("✓ oemer zainstalowany")
