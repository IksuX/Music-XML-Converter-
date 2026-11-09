# Nuty → MusicXML 0.5.0

Aplikacja na macOS do zamiany PDF-ów, skanów i zdjęć nut na pliki **MusicXML** (`.musicxml`). Takie pliki otworzysz w MuseScore, Sibeliusie, Finale, Dorico albo Logicu.

## Dwa sposoby odczytu

**1. PDF z programu nutowego (Finale, Sibelius, MuseScore, Dorico…) — odczyt bezpośredni.**
Taki PDF nie jest obrazkiem: każda nuta, pauza, belka i łuk są w nim zapisane z dokładnym położeniem, a tekst i akordy jako zwykły tekst. Aplikacja czyta je wprost z pliku, więc wynik jest wierny oryginałowi: rytm, wysokości, tonacja, powtórki i wolty, tekst pod nutami (z łącznikami i polskimi znakami), akordy (także z basem, np. `E/G#`), oznaczenia `ZWR`/`REF`, tytuł, autorzy i tempo. Działa automatycznie — jeśli PDF okaże się skanem, aplikacja sama przełącza się na rozpoznawanie obrazu. Po odczycie aplikacja sprawdza długość każdego taktu i zgłasza w logu te, które nie pasują do metrum.

Obsługiwane są PDF-y z Finale (czcionka Maestro, np. materiały CSM) oraz z MuseScore, Dorico i nowszego Finale/Sibeliusa (czcionki SMuFL: Leland, Bravura, Petaluma…). Działa zarówno dla pojedynczej linii melodycznej, jak i dla partytur chóralnych na kilka głosów — także gdy program ukrył puste pięciolinie w części systemów (wtedy w MusicXML są tam pauzy). Głosy nazywają się „Głos 1, 2, 3…” od góry; przypisanie pięciolinii do głosu aplikacja ustala po kolejności i kluczu (np. klucz wiolinowy z ósemką = głos męski), więc przy partyturach, które zaczynają się od jednej pięciolinii, warto rzucić okiem na początek.

Jeśli odczyt bezpośredni wyjdzie niewiarygodny (np. PDF z programu, którego znaki są nieznane), aplikacja nie zapisze błędnego pliku, tylko sama przełączy się na Audiveris. Fortepian (pięciolinia z dwoma głosami w jednej, akordy w obu rękach z różnymi rytmami) jest odczytywany, ale do sprawdzenia.

**2. Skany i zdjęcia — rozpoznawanie obrazu (OMR)** przez jeden z dwóch darmowych silników:

| Silnik | Najlepszy do | Uwagi |
|---|---|---|
| **Audiveris** | Czystych PDF-ów, dobrych skanów, partytur wielogłosowych (SATB, fortepian) | Szybki, wielostronicowy PDF traktuje jako jedną partyturę |
| **oemer** | Zdjęć z telefonu, krzywych i nierównych kartek | Sieć neuronowa, wolniejszy (ok. 1–3 min na stronę). **Nie odczytuje tekstu pod nutami.** Strony PDF łączy w jeden plik |

Tryb **„Oba”** uruchamia oba silniki dla każdego pliku i zapisuje obok siebie `…-audiveris.musicxml` i `…-oemer.musicxml`, więc możesz porównać wyniki.

## Instalacja gotowej aplikacji (z GitHuba)

Pobierz `NutyMusicXML-macOS-<wersja>.zip` z zakładki **Releases** repozytorium i rozpakuj. W Terminalu, w rozpakowanym folderze:

```bash
xattr -dr com.apple.quarantine "Nuty MusicXML.app"   # aplikacja nie jest podpisana przez Apple
mv "Nuty MusicXML.app" /Applications/
bash zainstaluj-silniki.sh                            # czytnik PDF + Audiveris + oemer (ok. 450 MB)
```

Bez polecenia `xattr` macOS powie, że aplikacja „jest uszkodzona” — to tylko blokada dla programów spoza App Store bez podpisu Apple. Aplikacja działa na Macach z Apple Silicon i z Intelem (macOS 13+).

## Aktualizacje

Przy uruchomieniu (najwyżej co 6 godzin) aplikacja sprawdza wydania na GitHubie. Gdy jest nowsza wersja, nad listą plików pojawia się pasek **Dostępna nowa wersja** — **Zaktualizuj** pobiera paczkę, sprawdza jej sumę kontrolną SHA-256, zamyka aplikację, podmienia ją i uruchamia ponownie. Ręcznie: menu *Nuty MusicXML → Sprawdź aktualizacje…* albo Ustawienia → Aktualizacje (tam też wyłączysz automatyczne sprawdzanie). Aplikacja musi leżeć w folderze, do którego masz prawo zapisu (zwykle /Applications). Silników (Audiveris, oemer) aktualizacja nie rusza.

## Budowanie ze źródeł (jednorazowo)

W Terminalu, w folderze `macos`:

```bash
chmod +x build.sh zainstaluj-silniki.sh
xcode-select --install          # tylko jeśli nie masz jeszcze Command Line Tools
./zainstaluj-silniki.sh         # czytnik PDF + Audiveris + oemer (łącznie ok. 450 MB)
./build.sh --install            # buduje aplikację i kopiuje ją do /Applications
```

- Audiveris trafia do `/Applications/Audiveris.app` (oficjalny instalator, z wbudowaną Javą).
- oemer trafia do osobnego środowiska Pythona w `~/Library/Application Support/NutyMusicXML/oemer-venv`. Nie rusza systemowego Pythona ani Homebrew.
- Czytnik PDF (PyMuPDF) trafia do `~/Library/Application Support/NutyMusicXML/tools-venv`.
- Jeśli chcesz tylko jedną część: `./zainstaluj-silniki.sh narzedzia` (czytnik PDF), `audiveris`, `ocr` albo `oemer`.
- Przy aktualizacji z 0.1.x wystarczy: `./zainstaluj-silniki.sh narzedzia` i `./build.sh --install`.

## Użycie

1. Przeciągnij do okna pliki PDF/JPG/PNG/HEIC (albo cały folder). Możesz też użyć „Otwórz za pomocą…” w Finderze.
2. Wybierz silnik i miejsce zapisu (domyślnie obok pliku źródłowego).
3. **Konwertuj** (⌘↩). Po zakończeniu przycisk przy pliku otwiera wynik w domyślnym programie do nut.

## Odtwarzacz

Przy każdym gotowym pliku jest przycisk **▶ Odtwórz** — otwiera okno z tym samym odtwarzaczem co we wtyczce chóralnej (chor-repertuar 1.15.3): nuty z kursorem, mikser głosów (brzmienie, głośność, M/S), tempo, metronom, odliczanie, drukowanie. Nie trzeba wgrywać pliku na stronę, żeby go sprawdzić.

- Gotowy plik .musicxml/.mxl można też przeciągnąć na okno aplikacji albo otworzyć przez *Plik → Odtwórz plik MusicXML…* (⇧⌘O).
- **Odśwież** (⌘R) w oknie odtwarzacza wczytuje plik ponownie z dysku — wygodne, gdy poprawiasz go równolegle w MuseScore.
- Nuty rysują się bez internetu (biblioteki są w aplikacji), ale **brzmienia** (chór, fortepian) pobierają się z sieci przy pierwszym odtworzeniu — tak jak na stronie.
- Gdy wtyczka dostanie nową wersję odtwarzacza: `bash aktualizuj-odtwarzacz.sh "<folder wtyczki chor-repertuar>"`, potem `bash build.sh --install`.

**Log** (przycisk „Log” na dole okna albo menu *Log*) pokazuje przebieg konwersji. Można go skopiować, zapisać do pliku .txt (⇧⌘S) i wyczyścić (⌘K). Zapisany log przydaje się przy zgłaszaniu problemu z konkretnym plikiem.

**Zrzuty ekranu i zdjęcia:** jeśli nuty pochodzą z aplikacji (MuseScore, forScore, Newzik, Finale…), zamiast zrzutu ekranu wyeksportuj z niej PDF — wtedy odczyt jest dokładny. Zrzut ekranu wklejony do PDF to tylko obrazek i idzie przez rozpoznawanie obrazu; do takich plików lepszy jest Audiveris (odczytuje też tekst i akordy), oemer nie czyta tekstu.

Kropki w prawym górnym rogu pokazują, czy silniki zostały znalezione. Własne ścieżki ustawisz w Ustawieniach (⌘,).

## Czego się spodziewać po skanach i zdjęciach (OMR)

Rozpoznawanie obrazu nigdy nie działa w 100%. Typowo:

- PDF z programu nutowego, gdy odczyt bezpośredni jest wyłączony: 90–98%,
- dobre skany 300 dpi: 85–95%,
- zdjęcia z telefonu: zależy od światła i tego, jak płasko leży kartka,
- rękopisy: praktycznie nie działają w żadnym silniku.

Przed użyciem otwórz plik w MuseScore i sprawdź rytmy, znaki przykluczowe i tekst.

**Tekst pod nutami** odczytuje tylko Audiveris, i to wyłącznie, gdy ma pliki językowe OCR. Instaluje je `./zainstaluj-silniki.sh ocr` (polski, angielski, łaciński, niemiecki). Języki dla danego materiału ustawisz w Ustawieniach (domyślnie `pol+eng`; dla łaciny dopisz `lat`).

**Wskazówki do skanowania:** 300 dpi, skala szarości, kartka jak najprościej, bez cienia od grzbietu książki.

## Gdy coś nie działa

- **Audiveris zainstalowany ręcznie z .dmg nie startuje z aplikacji:** zdejmij blokadę Gatekeepera poleceniem
  `xattr -dr com.apple.quarantine /Applications/Audiveris.app`.
- **Plik się nie skonwertował:** rozwiń „Log” na dole okna. Widać tam pełne wyjście silnika.
- **oemer trwa bardzo długo:** to normalne przy dużych zdjęciach. Dla czystych PDF-ów wyłącz „deskew” w Ustawieniach.

## Pliki

- `Sources/` — kod aplikacji SwiftUI (macOS 13+)
- `Resources/` — Info.plist i ikona
- `build.sh` — budowanie bez Xcode (wystarczy `swiftc`)
- `zainstaluj-silniki.sh` — instalacja silników
- `aktualizuj-odtwarzacz.sh` — przeniesienie odtwarzacza z nowej wersji wtyczki chóralnej
- `Resources/Player/` — odtwarzacz: `player.js`, `sf2-player.js`, `player.css` z wtyczki (bez zmian) + OpenSheetMusicDisplay 2.1.2, soundfont-player 0.12.0, JSZip 3.10.1 (licencje w `vendor/`)

Audiveris jest na licencji AGPL-3.0, oemer na MIT. Aplikacja uruchamia je jako osobne programy.
