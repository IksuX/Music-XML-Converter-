"""Preparing PDF pages and images for the OMR engines (Audiveris, oemer)."""
import re
import shutil
import unicodedata
import zipfile
from pathlib import Path

import pymupdf
from PIL import Image, ImageOps

try:  # zdjęcia HEIC z iPhone'a
    from pillow_heif import register_heif_opener
    register_heif_opener()
except Exception:  # noqa
    pass

TARGET_WIDTH = 2480          # ~A4 at 300 dpi — what the OMR engines handle best
PDF_EXT = {".pdf"}
DIRECT_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp"}
CONVERT_EXT = {".heic", ".heif", ".webp", ".gif"}
ACCEPTED_EXT = PDF_EXT | DIRECT_EXT | CONVERT_EXT
MUSICXML_EXT = {".musicxml", ".mxl", ".xml"}


def is_pdf(p) -> bool:
    return Path(p).suffix.lower() in PDF_EXT


def page_count(p) -> int:
    try:
        with pymupdf.open(p) as d:
            return d.page_count
    except Exception:  # noqa
        return 0


def safe_name(p) -> str:
    """File name without the extension, free of characters that are awkward for command-line tools."""
    raw = Path(p).stem.replace("ł", "l").replace("Ł", "L")
    folded = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode()
    s = re.sub(r"[^A-Za-z0-9_-]+", "_", folded).strip("_")
    return re.sub(r"_+", "_", s) or "nuty"


def rasterize_pdf(pdf, out_dir: Path, base: str) -> list:
    """Each page → PNG with a fixed width (independent of the page size in points)."""
    out = []
    with pymupdf.open(pdf) as doc:
        for i, page in enumerate(doc):
            w = page.rect.width
            if w < 1:
                continue
            zoom = TARGET_WIDTH / w
            pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
            pix.set_dpi(300, 300)
            dest = out_dir / f"{base}-str{i + 1:02d}.png"
            pix.save(str(dest))
            out.append(dest)
    return out


def _normalized(img: Image.Image) -> Image.Image:
    if img.width < 1900 or img.width > 4200:
        h = round(img.height * TARGET_WIDTH / img.width)
        img = img.resize((TARGET_WIDTH, h), Image.LANCZOS)
    return img


def prepared_image(src, out_dir: Path, base: str) -> Path:
    """An image ready for the engine: a copy of the original (when it is fine) or a normalized PNG."""
    src = Path(src)
    ext = src.suffix.lower()
    with Image.open(src) as im:
        rotated = im.getexif().get(0x0112, 1) not in (0, 1)   # phone photos are sometimes rotated only in EXIF
        oriented = ImageOps.exif_transpose(im) if rotated else im
        img = oriented.convert("RGB") if oriented.mode not in ("RGB", "L") else oriented
        norm = _normalized(img)
        if norm is img and not rotated and ext in DIRECT_EXT:
            dest = out_dir / f"{base}{'.jpg' if ext == '.jpeg' else ext}"
            shutil.copyfile(src, dest)
            return dest
        dest = out_dir / f"{base}.png"
        norm.save(dest, dpi=(300, 300))
        return dest


def make_pdf(pngs: list, out: Path):
    """PDF with A4-width pages — Audiveris renders it at 300 dpi, so it gets ~2480 px."""
    doc = pymupdf.open()
    for png in pngs:
        with Image.open(png) as im:
            w, h = im.size
        page = doc.new_page(width=595, height=round(595 * h / w))
        page.insert_image(page.rect, filename=str(png))
    doc.save(str(out))
    doc.close()


def unpack_mxl(mxl: Path, dest: Path):
    """Compressed MusicXML (.mxl) → a plain .musicxml file."""
    with zipfile.ZipFile(mxl) as z:
        root = None
        try:
            container = z.read("META-INF/container.xml").decode("utf-8", "replace")
            m = re.search(r'full-path\s*=\s*"([^"]+)"', container)
            if m and m.group(1) in z.namelist():
                root = m.group(1)
        except KeyError:
            pass
        if root is None:
            root = next((n for n in z.namelist()
                         if not n.startswith("META-INF") and n.lower().endswith((".xml", ".musicxml"))), None)
        if root is None:
            raise ValueError(f"Nie można odczytać {mxl.name}")
        dest.write_bytes(z.read(root))
