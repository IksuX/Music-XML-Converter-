"""Nuty → MusicXML (Windows) — the start of the app.

    python app/main.py                 # uruchamia okno
    python app/main.py plik.musicxml   # od razu otwiera odtwarzacz
    python app/main.py --selftest      # sprawdzenie instalacji (używane przy budowaniu)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def selftest() -> int:
    import urllib.request
    import pymupdf  # noqa
    import PIL  # noqa
    from nuty import __version__, player_server, wektor_pdf  # noqa
    from nuty.paths import resource_dir
    from nuty.settings import Settings
    from nuty.converter import Converter
    root = resource_dir()
    for need in ("ui/index.html", "ui/app.js", "Player/index.html", "Player/player.js",
                 "Player/vendor/opensheetmusicdisplay.min.js"):
        if not (root / need).is_file():
            print("BRAK", need)
            return 2
    # vector reader on a tiny PDF with no notes → it must say "no vectors", not crash
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "test")
    tmp = Path(__import__("tempfile").mkdtemp()) / "t.pdf"
    doc.save(str(tmp))
    xml, warn = wektor_pdf.convert(str(tmp))
    assert xml is None, "czytnik wektorowy"
    port = player_server.start()
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/player/vendor/jszip.min.js", timeout=10) as r:
        assert r.status == 200
    Converter(Settings())
    try:
        import webview  # noqa
    except Exception as ex:  # noqa
        print("pywebview:", ex)
        return 3
    print(f"selftest OK {__version__}")
    return 0


def main():
    # Windowed .exe (PyInstaller --windowed) has no console: stdout/stderr are None
    if sys.stdout is None or sys.stderr is None:
        import tempfile
        f = open(Path(tempfile.gettempdir()) / "NutyMusicXML-out.txt", "w", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or f
        sys.stderr = sys.stderr or f
    if "--selftest" in sys.argv:
        sys.exit(selftest())

    import webview
    from webview.dom import DOMEventHandler
    from nuty import __version__, player_server
    from nuty.api import Api
    from nuty.converter import Converter
    from nuty.paths import data_dir
    from nuty.settings import Settings

    conv = Converter(Settings())
    port = player_server.start()
    api = Api(conv, port)
    window = webview.create_window(f"Nuty → MusicXML {__version__}", f"http://127.0.0.1:{port}/ui/index.html",
                                   js_api=api, width=1000, height=720, min_size=(760, 540))
    api._set_window(window)

    def on_drop(e):
        files = (e.get("dataTransfer") or {}).get("files") or []
        paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
        if paths:
            api.add_paths(paths)

    def on_start():
        window.events.loaded.wait(15)
        try:
            window.dom.document.events.dragover += DOMEventHandler(lambda e: None, True, True)
            window.dom.document.events.drop += DOMEventHandler(on_drop, True, True)
        except Exception as ex:  # noqa
            conv.log(f"⚠︎ Przeciąganie plików niedostępne: {ex}")
        # pliki podane przy uruchomieniu (np. „Otwórz za pomocą…” w Eksploratorze)
        args = [a for a in sys.argv[1:] if not a.startswith("--")]
        if args:
            api.add_paths(args)
        api._check_update_on_start()

    webview.start(on_start, private_mode=False, storage_path=str(data_dir() / "webview"),
                  debug="--debug" in sys.argv)


if __name__ == "__main__":
    main()
