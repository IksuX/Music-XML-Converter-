"""Settings saved between runs (JSON in the user's folder)."""
import json
import threading

from .paths import data_dir

DEFAULTS = {
    "engine": "audiveris",          # audiveris / oemer / both
    "output_location": "next",      # next / folder
    "output_folder": "",
    "keep_mxl": False,
    "use_vector": True,
    "oemer_deskew": True,
    "merge_oemer_pages": True,
    "ocr_languages": "pol+eng",
    "custom_audiveris": "",
    "custom_oemer": "",
    "auto_update": True,            # sprawdzaj aktualizacje na GitHubie przy starcie
    "last_update_check": 0.0,
}


class Settings:
    def __init__(self):
        self._path = data_dir() / "settings.json"
        self._lock = threading.Lock()
        self._data = dict(DEFAULTS)
        try:
            with open(self._path, encoding="utf-8") as f:
                saved = json.load(f)
            for k, v in saved.items():
                if isinstance(v, int) and isinstance(DEFAULTS.get(k), float):
                    v = float(v)
                if k in DEFAULTS and isinstance(v, type(DEFAULTS[k])):
                    self._data[k] = v
        except (OSError, ValueError):
            pass

    def get(self, key):
        with self._lock:
            return self._data.get(key, DEFAULTS.get(key))

    def all(self) -> dict:
        with self._lock:
            return dict(self._data)

    def set(self, key, value):
        if isinstance(value, int) and not isinstance(value, bool) and isinstance(DEFAULTS.get(key), float):
            value = float(value)
        if key not in DEFAULTS:
            raise KeyError(key)
        if not isinstance(value, type(DEFAULTS[key])):
            raise TypeError(f"{key}: zły typ")
        with self._lock:
            self._data[key] = value
            try:
                with open(self._path, "w", encoding="utf-8") as f:
                    json.dump(self._data, f, ensure_ascii=False, indent=2)
            except OSError:
                pass

    @property
    def languages(self) -> str:
        raw = self.get("ocr_languages")
        parts = [p.strip().lower() for p in raw.replace(",", "+").replace(" ", "+").split("+")]
        return "+".join(p for p in parts if p)
