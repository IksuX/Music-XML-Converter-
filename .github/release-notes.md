## Nowości w 0.5.0
- **Automatyczne aktualizacje:** aplikacja sama sprawdza GitHub przy uruchomieniu, pokazuje pasek „Dostępna nowa wersja” i po kliknięciu **Zaktualizuj** pobiera, sprawdza sumę kontrolną, instaluje i uruchamia się ponownie. Można to wyłączyć w Ustawieniach; jest też „Sprawdź teraz” (na Macu również w menu aplikacji).
- Wersje 0.4.x nie mają tej funkcji — tę jedną aktualizację trzeba zainstalować ręcznie (jak niżej).

## Windows 10/11 (64-bit)
Pobierz **NutyMusicXML-Setup-….exe** i uruchom. Windows może pokazać „System Windows ochronił ten komputer” (instalator nie jest podpisany) — kliknij **Więcej informacji → Uruchom mimo to**. Silniki do skanów (Audiveris, oemer) instalujesz potem jednym kliknięciem w ⚙ Ustawieniach.

## macOS 13+ (Apple Silicon i Intel)
Pobierz **NutyMusicXML-macOS-….zip** i rozpakuj. Potem w Terminalu, w rozpakowanym folderze:

```bash
xattr -dr com.apple.quarantine "Nuty MusicXML.app"   # aplikacja nie jest podpisana przez Apple
mv "Nuty MusicXML.app" /Applications/
bash zainstaluj-silniki.sh                            # czytnik PDF + Audiveris + oemer
```

Szczegóły: `macos/README.md` i `windows/README.md` w repozytorium.
