# PyInstaller: pyinstaller nuty.spec  →  dist/NutyMusicXML/NutyMusicXML.exe
from PyInstaller.utils.hooks import collect_all

datas = [("app/ui", "ui"), ("app/Player", "Player")]
binaries, hidden = [], ["nuty.wektor_pdf"]
for pkg in ("webview", "pymupdf", "pillow_heif"):
    d, b, h = collect_all(pkg)
    datas += d; binaries += b; hidden += h

a = Analysis(["app/main.py"], pathex=["app"], datas=datas, binaries=binaries,
             hiddenimports=hidden, excludes=["tkinter", "matplotlib", "numpy.tests"])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="NutyMusicXML",
          console=False, icon="installer/AppIcon.ico", upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="NutyMusicXML", upx=False)
