"""Functions available to the window's JavaScript (window.pywebview.api.*).

Internal objects are kept in attributes starting with "_" — pywebview does not expose those to the page.
"""
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

from . import __version__, imaging, player_server, updater


def _open_external(path):
    if sys.platform == "win32":
        os.startfile(path)  # noqa
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


def _reveal(path):
    if sys.platform == "win32":
        subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", path])
    else:
        subprocess.Popen(["xdg-open", str(Path(path).parent)])


class PlayerApi:
    """For the player window: the "Open in editor" and "Show in folder" buttons."""

    def open_external(self, path):
        _open_external(path)

    def reveal(self, path):
        _reveal(path)


class Api:
    def __init__(self, converter, port):
        self._conv = converter
        self._port = port
        self._window = None
        self._player_windows = {}
        self._updater = updater.Updater(converter.settings, converter.log,
                                        can_install=lambda: not (converter.running or converter.installing))

    def _set_window(self, w):
        self._window = w

    # ------------------------------------------------------------- stan dla UI
    def get_state(self, since=0):
        c = self._conv
        total, lines, reset = c.log_since(int(since or 0))
        return {
            "version": __version__,
            "jobs": [j.to_dict() for j in c.jobs],
            "running": c.running,
            "installing": c.installing,
            "can_start": c.can_start(),
            "missing": c.missing_engine_message(),
            "engines": {"audiveris": c.engines["audiveris"], "oemer": c.engines["oemer"],
                        "ocr_missing": c.engines["ocr_missing"]},
            "settings": c.settings.all(),
            "log_total": total,
            "log_lines": lines,
            "log_reset": reset,
            "update": self._updater.state(),
        }

    # ------------------------------------------------------------- pliki
    def add_files(self):
        import webview
        types = ("Nuty (*.pdf;*.jpg;*.jpeg;*.png;*.tif;*.tiff;*.bmp;*.heic;*.heif;*.webp)", "Wszystkie pliki (*.*)")
        paths = self._window.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=True, file_types=types)
        if paths:
            self.add_paths(list(paths))

    def add_paths(self, paths):
        for p in self._conv.add(paths):
            self.play(p)

    def remove(self, ids):
        self._conv.remove(ids)

    def clear_list(self):
        self._conv.clear_list()

    def reset_finished(self):
        self._conv.reset_finished()

    def start(self):
        return self._conv.start()

    def cancel(self):
        self._conv.cancel()

    def open_external(self, path):
        _open_external(path)

    def reveal(self, path):
        _reveal(path)

    # ------------------------------------------------------------- ustawienia
    def set_setting(self, key, value):
        self._conv.settings.set(key, value)
        if key in ("custom_audiveris", "custom_oemer", "ocr_languages"):
            self._conv.refresh_engines()
        return self._conv.settings.all()

    def choose_output_folder(self):
        import webview
        r = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        if r:
            self._conv.settings.set("output_folder", r[0])
            self._conv.settings.set("output_location", "folder")
        return self._conv.settings.all()

    def choose_engine_file(self, key):
        import webview
        r = self._window.create_file_dialog(webview.OPEN_DIALOG, file_types=("Program (*.exe;*.bat)", "Wszystkie pliki (*.*)"))
        if r:
            self.set_setting(key, r[0])
        return self._conv.settings.all()

    def refresh_engines(self):
        self._conv.refresh_engines()

    def install(self, what):
        return self._conv.install(what)

    # ------------------------------------------------------------- aktualizacje
    def check_update(self):
        return self._updater.check(manual=True)

    def install_update(self):
        return self._updater.install(on_quit=self._quit_for_update)

    def dismiss_update(self):
        self._updater.dismiss()

    def open_update_page(self):
        info = self._updater.available
        updater.open_page(info["page"] if info else f"https://github.com/{updater.REPO}/releases")

    def _check_update_on_start(self):
        self._updater.check_on_start()

    def _quit_for_update(self):
        self._conv.cancel()
        import webview
        for w in list(webview.windows):
            try:
                w.destroy()
            except Exception:  # noqa
                pass

    # ------------------------------------------------------------- log
    def log_text(self):
        return self._conv.log_text()

    def log_clear(self):
        self._conv.clear_log()

    def log_save(self):
        import webview
        name = f"Nuty-MusicXML-log-{datetime.now():%Y-%m-%d-%H%M}.txt"
        r = self._window.create_file_dialog(webview.SAVE_DIALOG, save_filename=name,
                                            file_types=("Plik tekstowy (*.txt)",))
        if not r:
            return False
        dest = r if isinstance(r, str) else r[0]
        Path(dest).write_text(self._conv.log_text(), encoding="utf-8")
        return True

    # ------------------------------------------------------------- odtwarzacz
    def choose_player_file(self):
        import webview
        r = self._window.create_file_dialog(webview.OPEN_DIALOG, file_types=("MusicXML (*.musicxml;*.mxl;*.xml)",))
        if r:
            self.play(r[0])

    def play(self, path):
        import webview
        token = player_server.register(path)
        existing = self._player_windows.get(token)
        if existing is not None:
            try:
                existing.load_url(self._player_url(token))
                existing.restore()
                existing.show()
                return
            except Exception:  # noqa — okno zostało zamknięte
                pass
        w = webview.create_window(Path(path).stem, self._player_url(token), js_api=PlayerApi(),
                                  width=1050, height=860, min_size=(700, 500))
        self._player_windows[token] = w
        w.events.closed += lambda: self._player_windows.pop(token, None)

    def _player_url(self, token):
        return f"http://127.0.0.1:{self._port}/player/index.html?t={token}"
