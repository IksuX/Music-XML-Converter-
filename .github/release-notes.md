## Nowości w 0.5.2 (macOS i Windows) — czytnik PDF
- **PDF-y z Logic Pro** czytane bezpośrednio (wcześniej szły do rozpoznawania obrazu).
- **Triole** (i inne grupy: kwintole, sekstole) — rozpoznawane i zapisywane jako triole w MusicXML.
- **Dwa głosy na jednej pięciolinii** (np. sopran i alt razem) — rozdzielane na głos 1 i 2, także unisono i głos zaczynający się w połowie taktu.
- Kreski taktowe łączące pięciolinie (MuseScore 3/4, Logic), zmiana metrum przed znakiem powtórki, pauzy półnutowe w MuseScore, szesnastki z Logica, tempo zmieniane w trakcie utworu.
- Tekst pod nutami zepchnięty przez dynamikę, napis „REF.” między zwrotkami, numery zwrotek („1.Tej” → „Tej”), tytuł/podtytuł/aranżer z nagłówka.

## Nowości w 0.5.1 (macOS)
- **Silniki instalują się z aplikacji:** czytnik PDF instaluje się sam przy pierwszym uruchomieniu, a Audiveris, języki OCR i oemer — przyciskiem **Zainstaluj silniki** (pasek w oknie) albo w Ustawieniach. Postęp widać w logu. Terminal nie jest już potrzebny.
- Przy starcie aplikacja sama aktualizuje czytnik PDF, jeśli jest zbyt stary.

## Nowości w 0.5.0
- **Automatyczne aktualizacje** z GitHuba (macOS i Windows): pasek „Dostępna nowa wersja” → **Zaktualizuj**. Wersje 0.4.x trzeba raz zaktualizować ręcznie.

## Windows 10/11 (64-bit)
Pobierz **NutyMusicXML-Setup-….exe** i uruchom. Windows może pokazać „System Windows ochronił ten komputer” (instalator nie jest podpisany) — kliknij **Więcej informacji → Uruchom mimo to**. Silniki do skanów (Audiveris, oemer) instalujesz potem jednym kliknięciem w ⚙ Ustawieniach.

## macOS 13+ (Apple Silicon i Intel)
Pobierz **NutyMusicXML-macOS-….zip** i rozpakuj. Potem jednorazowo w Terminalu, w rozpakowanym folderze:

```bash
xattr -dr com.apple.quarantine "Nuty MusicXML.app"   # aplikacja nie jest podpisana przez Apple
mv "Nuty MusicXML.app" /Applications/
```

Przy pierwszym uruchomieniu aplikacja sama zainstaluje czytnik PDF; silniki do skanów doinstalujesz przyciskiem **Zainstaluj silniki**.

Szczegóły: `macos/README.md` i `windows/README.md` w repozytorium.
