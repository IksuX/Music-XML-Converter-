"""Backend tests without a window — they run on Linux and in GitHub Actions (Windows)."""
import sys
import tempfile
import time
from pathlib import Path

import pymupdf
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "app"))

from nuty import imaging, merge  # noqa: E402

PAGE = '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1">{m}</part></score-partwise>'''


def _measures(n, pitch):
    return "".join(f'<measure number="{i + 1}"><note><pitch><step>{pitch}</step><octave>4</octave></pitch>'
                   f'<duration>4</duration><type>whole</type></note></measure>' for i in range(n))


def test_merge_pages():
    d = Path(tempfile.mkdtemp())
    a, b = d / "a.musicxml", d / "b.musicxml"
    a.write_text(PAGE.format(m=_measures(3, "C")), encoding="utf-8")
    b.write_text(PAGE.format(m=_measures(2, "D")), encoding="utf-8")
    out = d / "out.musicxml"
    warn = merge.merge([a, b], out)
    txt = out.read_text(encoding="utf-8")
    assert warn == []
    assert txt.startswith("<?xml") and "<!DOCTYPE score-partwise" in txt
    assert txt.count("<measure ") == 5
    assert 'number="5"' in txt and 'new-system="yes"' in txt


def test_rasterize_and_make_pdf():
    d = Path(tempfile.mkdtemp())
    doc = pymupdf.open()
    doc.new_page(width=1450, height=2048).insert_text((100, 100), "duza strona jak zrzut z iPada")
    src = d / "duza.pdf"
    doc.save(str(src))
    pngs = imaging.rasterize_pdf(src, d, "x")
    with Image.open(pngs[0]) as im:
        assert im.width == imaging.TARGET_WIDTH          # nie 6000 px jak przy stałych 300 dpi
    out = d / "dla-audiverisa.pdf"
    imaging.make_pdf(pngs, out)
    with pymupdf.open(out) as p:
        assert round(p[0].rect.width) == 595


def test_prepared_image_small_is_upscaled():
    d = Path(tempfile.mkdtemp())
    src = d / "maly.jpg"
    Image.new("RGB", (800, 1100), "white").save(src)
    out = imaging.prepared_image(src, d, "m")
    with Image.open(out) as im:
        assert im.width == imaging.TARGET_WIDTH


def test_safe_name():
    assert imaging.safe_name(Path("Chwal Króla dziś – chór (11.05).pdf")) == "Chwal_Krola_dzis_chor_11_05"


def test_vector_reader_rejects_scan():
    from nuty import wektor_pdf
    d = Path(tempfile.mkdtemp())
    doc = pymupdf.open()
    page = doc.new_page()
    img = d / "skan.png"
    Image.new("RGB", (600, 800), "white").save(img)
    page.insert_image(page.rect, filename=str(img))
    pdf = d / "skan.pdf"
    doc.save(str(pdf))
    xml, warn = wektor_pdf.convert(str(pdf))
    assert xml is None


def test_converter_scan_without_engines(monkeypatch=None):
    import os
    os.environ.setdefault("XDG_DATA_HOME", tempfile.mkdtemp())
    os.environ.setdefault("LOCALAPPDATA", tempfile.mkdtemp())
    from nuty.converter import Converter
    from nuty.settings import Settings
    d = Path(tempfile.mkdtemp())
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "brak nut")
    pdf = d / "skan.pdf"
    doc.save(str(pdf))
    c = Converter(Settings())
    c.engines["audiveris"] = c.engines["oemer"] = None
    c.add([pdf])
    assert c.start()
    for _ in range(100):
        if not c.running:
            break
        time.sleep(0.1)
    j = c.jobs[0]
    assert j.status == "failed" and "silnik" in j.text


def test_updater_versions_and_release_pick():
    from nuty import updater
    assert updater.newer("0.5.0", "0.4.1") and updater.newer("0.10.0", "0.9.9")
    assert not updater.newer("0.4.1", "0.4.1") and not updater.newer("v0.4.1", "0.4.2")
    rel = [
        {"tag_name": "v0.6.0", "draft": False, "prerelease": False, "body": "mac only",
         "assets": [{"name": "NutyMusicXML-macOS-0.6.0.zip"}]},
        {"tag_name": "v0.7.0", "draft": True, "assets": [{"name": "NutyMusicXML-Setup-0.7.0.exe"}]},
        {"tag_name": "v0.5.0", "draft": False, "prerelease": False, "body": "zmiany", "html_url": "https://x/r",
         "assets": [{"name": "NutyMusicXML-Setup-0.5.0.exe", "browser_download_url": "https://x/a.exe",
                     "size": 10, "digest": "sha256:ab"}]},
    ]
    info = updater.pick_release(rel)
    assert info["version"] == "0.5.0" and info["url"] == "https://x/a.exe" and info["digest"] == "sha256:ab"
    assert updater.pick_release([]) is None


def test_settings_float_roundtrip():
    from nuty.settings import Settings
    s = Settings()
    s.set("last_update_check", 1700000000)   # int → float
    assert isinstance(s.get("last_update_check"), float)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("OK", name)
