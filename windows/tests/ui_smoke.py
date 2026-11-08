"""UI check in Chromium (Playwright) with the real backend in place of pywebview — local only."""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))
from nuty import player_server  # noqa: E402
from nuty.api import Api  # noqa: E402
from nuty.converter import Converter  # noqa: E402
from nuty.settings import Settings  # noqa: E402

pdfs = sys.argv[1:-1]
shots = Path(sys.argv[-1])
conv = Converter(Settings())
port = player_server.start()
api = Api(conv, port)

BRIDGE = """
window.pywebview = { api: new Proxy({}, { get: function (_, name) {
  return function () { return window.__call(name, JSON.stringify(Array.prototype.slice.call(arguments)))
    .then(function (r) { return JSON.parse(r); }); }; } }) };
window.addEventListener('DOMContentLoaded', function () { window.dispatchEvent(new Event('pywebviewready')); });
"""


def call(name, args):
    fn = getattr(api, name)
    try:
        r = fn(*json.loads(args))
    except Exception as ex:  # noqa
        r = {"error": str(ex)}
    return json.dumps(r, default=str)


with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1000, "height": 720})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    pg.expose_function("__call", call)
    pg.add_init_script(BRIDGE)
    pg.goto(f"http://127.0.0.1:{port}/ui/index.html")
    pg.wait_for_timeout(800)
    pg.screenshot(path=str(shots / "ui-empty.png"))
    api.add_paths(pdfs)
    pg.wait_for_timeout(600)
    pg.click("#btn-log")
    pg.click("#btn-start")
    t0 = time.time()
    while conv.running and time.time() - t0 < 120:
        time.sleep(0.3)
    pg.wait_for_timeout(900)
    pg.screenshot(path=str(shots / "ui-done.png"))
    print("jobs:", [(j["name"], j["status"], j["text"][:50]) for j in api.get_state()["jobs"]])
    print("log lines in UI:", pg.locator("#log-lines > div").count())
    pg.click("[data-act=open-settings]")
    pg.wait_for_timeout(600)
    pg.screenshot(path=str(shots / "ui-settings.png"))
    # odtwarzacz przez serwer
    out = api.get_state()["jobs"][0]["outputs"][0]["path"]
    tok = player_server.register(out)
    pp = b.new_page(viewport={"width": 1000, "height": 800})
    pp.on("pageerror", lambda e: errs.append("player: " + str(e)))
    pp.goto(f"http://127.0.0.1:{port}/player/index.html?t={tok}")
    pp.wait_for_timeout(5000)
    print("player svg:", pp.locator(".cnr-player__score svg").count(),
          "voices:", pp.locator(".cnr-player__voices select").count())
    pp.screenshot(path=str(shots / "ui-player.png"))
    print("JS errors:", errs)
    b.close()
