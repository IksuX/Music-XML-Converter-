#!/bin/bash
# Instaluje silniki rozpoznawania nut dla aplikacji Nuty → MusicXML.
#   ./zainstaluj-silniki.sh              → oba silniki
#   ./zainstaluj-silniki.sh audiveris    → tylko Audiveris
#   ./zainstaluj-silniki.sh oemer        → tylko oemer
#   ./zainstaluj-silniki.sh ocr          → tylko języki tekstu pod nutami dla Audiverisa
#   ./zainstaluj-silniki.sh narzedzia    → tylko czytnik PDF z programów nutowych (PyMuPDF)
#   dodaj --force, aby przeinstalować
set -euo pipefail

WHAT="all"; FORCE=0
for a in "$@"; do
  case "$a" in
    audiveris|oemer|ocr|narzedzia) WHAT="$a" ;;
    --force) FORCE=1 ;;
    *) echo "Nieznany argument: $a"; exit 1 ;;
  esac
done

SUPPORT="$HOME/Library/Application Support/NutyMusicXML"
VENV="$SUPPORT/oemer-venv"
ARCH="$(uname -m)"           # arm64 albo x86_64
mkdir -p "$SUPPORT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Uruchomiony z aplikacji (bez terminala): bez kolorów i bez paska postępu curla, który zaśmieca log.
if [[ -t 1 && -z "${NUTY_GUI:-}" ]]; then
  say() { printf '\n\033[1m→ %s\033[0m\n' "$*"; }
  ok()  { printf '\033[32m✓ %s\033[0m\n' "$*"; }
  PROGRESS="--progress-bar"
else
  say() { printf '→ %s\n' "$*"; }
  ok()  { printf '✓ %s\n' "$*"; }
  PROGRESS="-sS"
fi

# ---------------------------------------------------------------- Audiveris
install_audiveris() {
  local existing=""
  for p in "/Applications/Audiveris.app" "$HOME/Applications/Audiveris.app"; do
    [[ -x "$p/Contents/MacOS/Audiveris" ]] && existing="$p"
  done
  if [[ -n "$existing" && $FORCE -eq 0 ]]; then
    ok "Audiveris już jest: $existing (użyj --force, aby zaktualizować)"
    return
  fi

  say "Szukam najnowszego wydania Audiverisa dla macOS ($ARCH)…"
  local url
  url="$(curl -fsSL https://api.github.com/repos/Audiveris/audiveris/releases/latest \
        | grep -o '"browser_download_url": *"[^"]*macosx-'"$ARCH"'\.dmg"' \
        | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
  if [[ -z "$url" ]]; then
    echo "Nie znalazłem instalatora .dmg. Pobierz go ręcznie: https://github.com/Audiveris/audiveris/releases"
    exit 1
  fi
  echo "   $url"
  echo "   pobieram (ok. 200 MB, to chwilę potrwa)…"
  curl -fL $PROGRESS "$url" -o "$TMP/audiveris.dmg"

  say "Instaluję Audiverisa…"
  local mnt="$TMP/mnt"
  mkdir -p "$mnt"
  hdiutil attach -nobrowse -quiet -mountpoint "$mnt" "$TMP/audiveris.dmg"
  local dest="/Applications"
  [[ -w "$dest" ]] || dest="$HOME/Applications"
  mkdir -p "$dest"
  rm -rf "$dest/Audiveris.app"
  cp -R "$mnt/Audiveris.app" "$dest/"
  hdiutil detach -quiet "$mnt"
  # Aplikacja nie jest podpisana przez Apple — zdejmujemy kwarantannę, żeby dało się ją uruchomić z naszej apki.
  xattr -dr com.apple.quarantine "$dest/Audiveris.app" 2>/dev/null || true
  ok "Audiveris zainstalowany w $dest/Audiveris.app"
}

# ---------------------------------------------------------------- uv (menedżer Pythona)
find_uv() {
  local UV
  UV="$(command -v uv || true)"
  [[ -z "$UV" && -x "$HOME/.local/bin/uv" ]] && UV="$HOME/.local/bin/uv"
  if [[ -z "$UV" ]]; then
    say "Instaluję uv (menedżer Pythona, pojedynczy plik w ~/.local/bin)…" >&2
    curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh >&2
    UV="$HOME/.local/bin/uv"
  fi
  echo "$UV"
}

# ---------------------------------------------------------------- czytnik PDF z programów nutowych
TOOLS="$SUPPORT/tools-venv"
install_tools() {
  if [[ -x "$TOOLS/bin/python3" && $FORCE -eq 0 ]] && "$TOOLS/bin/python3" -c "import pymupdf, sys; sys.exit(tuple(map(int, pymupdf.VersionBind.split('.')[:2])) < (1, 28))" 2>/dev/null; then
    ok "Czytnik PDF już jest: $TOOLS"
    return
  fi
  local UV
  UV="$(find_uv)"
  say "Instaluję czytnik PDF z programów nutowych (PyMuPDF)…"
  rm -rf "$TOOLS"
  "$UV" venv --python 3.11 "$TOOLS"
  # Tylko gotowe paczki: PyMuPDF 2.x nie ma wersji dla Maców z Intelem (kompilacja ze źródeł się nie udaje),
  # więc tam instaluje się najnowsza 1.x — wyniki czytnika są takie same (sprawdzone od 1.28).
  "$UV" pip install --python "$TOOLS/bin/python" --only-binary pymupdf "pymupdf>=1.28"
  "$TOOLS/bin/python3" -c "import pymupdf; print('   PyMuPDF', pymupdf.__version__)"
  ok "Czytnik PDF gotowy"
}

# ---------------------------------------------------------------- języki OCR
# Audiveris czyta tekst pod nutami Tesseractem — bez tych plików pomija słowa.
OCR_LANGS="pol eng lat deu"
install_ocr() {
  local dir="$HOME/Library/Application Support/AudiverisLtd/audiveris/tessdata"
  mkdir -p "$dir"
  say "Pobieram języki OCR dla Audiverisa ($OCR_LANGS)…"
  for l in $OCR_LANGS; do
    if [[ -s "$dir/$l.traineddata" && $FORCE -eq 0 ]]; then
      echo "   jest: $l"; continue
    fi
    echo "   $l"
    curl -fL $PROGRESS "https://github.com/tesseract-ocr/tessdata/raw/main/$l.traineddata" -o "$dir/$l.traineddata.part"
    mv "$dir/$l.traineddata.part" "$dir/$l.traineddata"
  done
  ok "Języki OCR w $dir"
}

# ---------------------------------------------------------------- oemer
install_oemer() {
  if [[ -x "$VENV/bin/oemer" && $FORCE -eq 0 ]]; then
    ok "oemer już jest: $VENV (użyj --force, aby przeinstalować)"
    return
  fi

  local UV
  UV="$(find_uv)"

  say "Tworzę osobne środowisko Python 3.11 dla oemera…"
  rm -rf "$VENV"
  "$UV" venv --python 3.11 "$VENV"

  say "Instaluję oemer i zależności (sprawdzone wersje)…"
  # oemer 0.1.8 wymaga onnxruntime-gpu, którego nie ma na Macu — instalujemy bez zależności,
  # a te dokładamy ręcznie w wersjach, które z nim działają:
  #  - onnxruntime 1.19.x  (nowsze odrzucają model oemera)
  #  - opencv 4.10.0.84    (nowsze zmieniły HoughLinesP)
  #  - scikit-learn 1.2.x  (modele oemera zapisano w 1.2)
  "$UV" pip install --python "$VENV/bin/python" --no-deps "oemer==0.1.8"
  "$UV" pip install --python "$VENV/bin/python" \
      "onnxruntime==1.19.2" \
      "opencv-python-headless==4.10.0.84" \
      "numpy==1.26.4" \
      "scipy==1.11.4" \
      "scikit-learn==1.2.2" \
      "matplotlib==3.8.4" \
      "pillow" \
      "typing-extensions"

  say "Pobieram modele sieci neuronowej (~100 MB, jednorazowo)…"
  "$VENV/bin/python" - <<'PY'
import os
from oemer import ete
for title, url in ete.CHECKPOINTS_URL.items():
    sub = "unet_big" if title.startswith("1st") else "seg_net"
    path = os.path.join(ete.MODULE_PATH, "checkpoints", sub, title.split("_")[1])
    if os.path.exists(path) and os.path.getsize(path) > 0:
        print("  jest:", title); continue
    ete.download_file(title, url, path)
PY

  "$VENV/bin/oemer" -h >/dev/null
  ok "oemer zainstalowany: $VENV/bin/oemer"
}

case "$WHAT" in
  audiveris) install_audiveris ;;
  oemer) install_oemer ;;
  ocr) install_ocr ;;
  narzedzia) install_tools ;;
  all) install_tools; install_audiveris; install_ocr; install_oemer ;;
esac

if [[ -n "${NUTY_GUI:-}" ]]; then ok "Gotowe"; else printf '\n\033[32mGotowe. Uruchom aplikację „Nuty → MusicXML”.\033[0m\n'; fi
