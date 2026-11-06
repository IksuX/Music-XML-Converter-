"""A local server (127.0.0.1 only) for the player from the choir plugin.

player.js and OSMD fetch the score file with fetch()/XHR, just like on the website — so the window
loads the page from http://127.0.0.1:<port>/ and the server serves the files from Player/ and the scores.
"""
import hashlib
import html
import mimetypes
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .paths import resource_dir

_files: dict = {}
_lock = threading.Lock()

APPBAR = '''
<div class="nuty-appbar">
  <button type="button" onclick="location.reload()" title="Wczytaj plik ponownie z dysku (F5)">⟳ Odśwież</button>
  <button type="button" onclick="window.pywebview && pywebview.api.open_external(NUTY_FILE)" title="Otwórz w domyślnym programie do nut (np. MuseScore)">✎ Otwórz w edytorze</button>
  <button type="button" onclick="window.pywebview && pywebview.api.reveal(NUTY_FILE)">📁 Pokaż w folderze</button>
  <span class="nuty-appbar__name">{name}</span>
</div>
<script>var NUTY_FILE = {path_js};
document.addEventListener("keydown", function (e) {{ if (e.key === "F5") {{ e.preventDefault(); location.reload(); }} }});</script>
<style>
.nuty-appbar {{ display:flex; gap:8px; align-items:center; padding:8px 16px; background:#fff; border-bottom:1px solid #ddd; font:13px -apple-system,"Segoe UI",sans-serif; }}
.nuty-appbar button {{ font:inherit; padding:4px 10px; border:1px solid #c8c8c8; border-radius:6px; background:#fafafa; cursor:pointer; }}
.nuty-appbar button:hover {{ background:#eee; }}
.nuty-appbar__name {{ margin-left:auto; color:#666; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
@media print {{ .nuty-appbar {{ display:none; }} }}
</style>
'''


def register(path) -> str:
    p = str(Path(path).resolve())
    token = hashlib.sha1(p.encode("utf-8")).hexdigest()[:12]
    with _lock:
        _files[token] = Path(p)
    return token


def lookup(token):
    with _lock:
        return _files.get(token)


class _Handler(BaseHTTPRequestHandler):
    server_version = "NutyMusicXML"

    def log_message(self, *a):  # cicho
        pass

    def _send(self, data: bytes, ctype: str, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(u.path)
        player = resource_dir() / "Player"
        ui = resource_dir() / "ui"
        try:
            if path in ("/player/", "/player/index.html"):
                token = urllib.parse.parse_qs(u.query).get("t", [""])[0]
                f = lookup(token)
                if not f:
                    return self._send(b"Nie znaleziono pliku", "text/plain; charset=utf-8", 404)
                page = (player / "index.html").read_text(encoding="utf-8")
                ext = f.suffix.lower()
                file_url = f"/score/{token}/{urllib.parse.quote(f.name)}"
                page = (page.replace("{{FILE_URL}}", file_url)
                        .replace("{{FORMAT}}", "mxl" if ext == ".mxl" else "musicxml")
                        .replace("{{TITLE}}", html.escape(f.stem)))
                import json
                bar = APPBAR.format(name=html.escape(f.name), path_js=json.dumps(str(f)))
                page = page.replace("<body>", "<body>" + bar, 1)
                return self._send(page.encode("utf-8"), "text/html; charset=utf-8")
            if path.startswith("/score/"):
                parts = path.split("/")
                f = lookup(parts[2]) if len(parts) > 2 else None
                if not f or not f.is_file():
                    return self._send(b"", "text/plain", 404)
                ctype = ("application/vnd.recordare.musicxml" if f.suffix.lower() == ".mxl"
                         else "application/vnd.recordare.musicxml+xml")
                return self._send(f.read_bytes(), ctype)   # zawsze świeża wersja z dysku
            for prefix, root in (("/player/", player), ("/ui/", ui)):
                if path.startswith(prefix):
                    target = (root / path[len(prefix):]).resolve()
                    if root.resolve() not in target.parents or not target.is_file():
                        return self._send(b"", "text/plain", 404)
                    ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                    if target.suffix in (".js", ".css", ".html"):
                        ctype = {".js": "text/javascript", ".css": "text/css", ".html": "text/html"}[target.suffix] + "; charset=utf-8"
                    return self._send(target.read_bytes(), ctype)
            self._send(b"", "text/plain", 404)
        except Exception as ex:  # noqa
            self._send(str(ex).encode("utf-8"), "text/plain; charset=utf-8", 500)


def start() -> int:
    """Starts the server; tries a fixed port first (so the player's settings in localStorage persist)."""
    for port in list(range(47613, 47623)) + [0]:
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), _Handler)
            break
        except OSError:
            continue
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv.server_address[1]
