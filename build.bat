@echo off
rem Builds the installer on your own Windows PC (needs Python 3.11 and Inno Setup 6).
setlocal
cd /d "%~dp0"
py -3.11 -m venv .venv || goto :err
call .venv\Scripts\activate.bat
pip install -r requirements.txt pyinstaller==6.22.3 || goto :err
python tests\test_backend.py || goto :err
pyinstaller --noconfirm nuty.spec || goto :err
for /f %%v in ('python -c "import sys; sys.path.insert(0,'app'); import nuty; print(nuty.__version__)"') do set VER=%%v
"%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" /DAppVersion=%VER% installer\NutyMusicXML.iss || goto :err
echo.
echo Gotowe: dist\NutyMusicXML-Setup-%VER%.exe
exit /b 0
:err
echo Blad budowania.
exit /b 1
