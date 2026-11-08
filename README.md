# Nuty → MusicXML

Zamiana PDF-ów, skanów i zdjęć nut na pliki **MusicXML** — z bezpośrednim odczytem PDF-ów z programów nutowych (Finale, MuseScore, Sibelius, Dorico), rozpoznawaniem skanów (Audiveris, oemer) i odtwarzaczem z mikserem głosów.

**Pobieranie:** zakładka [Releases](../../releases) — instalator `.exe` dla Windows i `.zip` z aplikacją dla macOS.

| Folder | Co jest w środku |
|---|---|
| [`macos/`](macos) | aplikacja SwiftUI na macOS 13+ — [README](macos/README.md) |
| [`windows/`](windows) | aplikacja na Windows 10/11 (Python + WebView2) — [README](windows/README.md) |

Obie wersje używają tego samego czytnika PDF (`wektor_pdf.py`) i odtwarzacza z wtyczki chor-repertuar. GitHub Actions buduje każdą z nich przy zmianie w jej folderze i dokłada plik do wydania `v<wersja>`.

Audiveris: AGPL-3.0, oemer: MIT, PyMuPDF: AGPL-3.0. Silniki są uruchamiane jako osobne programy.
