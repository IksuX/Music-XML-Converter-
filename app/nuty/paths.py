"""Where the app keeps its data and where it finds its own files."""
import os
import sys
from pathlib import Path

APP_NAME = "NutyMusicXML"
IS_WINDOWS = sys.platform == "win32"


def data_dir() -> Path:
    """Engines, OCR languages, settings — the user's folder, no administrator rights needed."""
    if IS_WINDOWS:
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    d = base / APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def resource_dir() -> Path:
    """The app's folder with ui/ and Player/ (inside the .exe it is the PyInstaller folder)."""
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def tessdata_dir() -> Path:
    d = data_dir() / "tessdata"
    d.mkdir(parents=True, exist_ok=True)
    return d


def tools_dir() -> Path:
    d = data_dir() / "tools"
    d.mkdir(parents=True, exist_ok=True)
    return d
