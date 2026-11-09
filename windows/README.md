# Nuty → MusicXML 0.5.0 — Windows

Wersja na Windows 10/11 (64-bit) aplikacji do zamiany PDF-ów, skanów i zdjęć nut na **MusicXML**. Umie to samo co wersja na Maca:

- **bezpośredni odczyt PDF-ów z programów nutowych** (Finale, MuseScore, Sibelius, Dorico): rytm, wysokości, tekst pod nutami, akordy, partytury chóralne;
- **Audiveris** i **oemer** do skanów i zdjęć (do wyboru albo oba naraz do porównania);
- **odtwarzacz** taki sam jak we wtyczce chóralnej (chor-repertuar 1.15.3) — mikser głosów, tempo, metronom, drukowanie;
- **log** z kopiowaniem, zapisem do pliku i czyszczeniem.

## Dla użytkownika

1. Uruchom `NutyMusicXML-Setup-0.5.0.exe`. Instalator nie wymaga uprawnień administratora (instaluje dla bieżącego użytkownika; można wybrać „dla wszystkich”).
2. Windows może pokazać „System Windows ochronił ten komputer” — instalator nie jest podpisany certyfikatem. Kliknij **Więcej informacji → Uruchom mimo to**.
3. PDF-y z programów nutowych działają od razu. Do skanów i zdjęć otwórz **⚙ Ustawienia** i kliknij **Zainstaluj** przy Audiverisie (ok. 200 MB, z językami tekstu pod nutami) i/lub oemerze (ok. 250 MB). Aplikacja pobiera je sama.

Używanie: przeciągnij pliki do okna (albo **＋ Dodaj**), wybierz silnik, **Konwertuj** (Ctrl+Enter). Przy gotowym pliku: **▶ Odtwórz**, ✎ otwiera w domyślnym programie do nut, 📁 pokazuje w folderze. Gotowy `.musicxml` możesz od razu odtworzyć przez **▶ Odtwórz plik…** (Ctrl+Shift+O).

Skróty: Ctrl+O dodaj, Ctrl+Enter konwertuj, Ctrl+Shift+S zapisz log, Ctrl+K wyczyść log, Delete usuń zaznaczony plik; w odtwarzaczu F5 = odśwież z dysku.

Dane aplikacji (ustawienia, silniki, języki OCR) są w `%LOCALAPPDATA%\NutyMusicXML`. Odinstalowanie: *Ustawienia → Aplikacje*.

Brzmienia w odtwarzaczu pobierają się z internetu przy pierwszym odtworzeniu, tak jak na stronie. Aplikacja korzysta z Microsoft Edge WebView2, który jest w Windows 11 i aktualnym Windows 10; jeśli go brak, instalator poda link.

## Aktualizacje

Przy uruchomieniu (najwyżej co 6 godzin) aplikacja sprawdza wydania na GitHubie. Gdy jest nowsza wersja, u góry okna pojawia się pasek **Dostępna nowa wersja** — **Zaktualizuj** pobiera instalator, sprawdza jego sumę kontrolną SHA-256, zamyka aplikację, instaluje nową wersję bez pytań i uruchamia ją ponownie. Ręcznie: ⚙ Ustawienia → Aktualizacje → **Sprawdź teraz** (tam też wyłączysz automatyczne sprawdzanie). Ustawienia i zainstalowane silniki zostają.

## Budowanie instalatora

**Automatycznie (GitHub Actions):** wrzuć ten folder do repozytorium na GitHubie. Przy każdym pushu na `main` workflow `.github/workflows/windows.yml` testuje, buduje i publikuje instalator w zakładce **Releases** (wydanie `v<wersja>` z `app/nuty/__init__.py`; ponowny push tej samej wersji podmienia plik). Nowa wersja = zmiana `__version__` i push.

```
git init && git add . && git commit -m "Nuty MusicXML 0.5.0"
git branch -M main
git remote add origin https://github.com/<konto>/nuty-musicxml-windows.git
git push -u origin main
```

**Na własnym komputerze z Windows:** zainstaluj Python 3.11 (python.org) i Inno Setup 6, potem dwuklik `build.bat`. Wynik: `dist\NutyMusicXML-Setup-0.5.0.exe`.

**Do testów bez budowania:** `pip install -r requirements.txt` i `python app\main.py`.

## Pliki

- `app/main.py` — start aplikacji (okno pywebview/WebView2), `--selftest`
- `app/nuty/` — konwersja: `wektor_pdf.py` (ten sam czytnik co na Macu), `converter.py`, `engines.py` (wyszukiwanie i instalacja Audiveris/oemer/OCR), `imaging.py`, `merge.py`, `player_server.py` (lokalny serwer odtwarzacza na 127.0.0.1)
- `app/ui/` — interfejs, `app/Player/` — odtwarzacz z wtyczki
- `nuty.spec` — PyInstaller, `installer/NutyMusicXML.iss` — Inno Setup, `build.bat`
- `tests/` — testy backendu (`test_backend.py`) i interfejsu w Chromium (`ui_smoke.py`, lokalnie)

Audiveris: AGPL-3.0, oemer: MIT, PyMuPDF: AGPL-3.0, pywebview: BSD. Aplikacja uruchamia silniki jako osobne programy.
