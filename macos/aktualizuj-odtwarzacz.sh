#!/bin/bash
# Copies the player from the chor-repertuar plugin into the app, so that both always play the same way.
#   bash aktualizuj-odtwarzacz.sh "/ścieżka/do/chor-repertuar"
#   bash build.sh --install
set -euo pipefail
SRC="${1:-}"
if [[ -z "$SRC" || ! -f "$SRC/assets/js/player.js" ]]; then
  echo "Podaj folder wtyczki chor-repertuar (ten, w którym jest assets/js/player.js), np.:"
  echo "  bash aktualizuj-odtwarzacz.sh \"$HOME/Downloads/chor-repertuar - wtyczka wp/chor-repertuar\""
  exit 1
fi
DST="$(cd "$(dirname "$0")" && pwd)/Resources/Player"
cp "$SRC/assets/js/player.js" "$SRC/assets/js/sf2-player.js" "$DST/"
cp "$SRC/assets/css/player.css" "$DST/"
VER="$(grep -m1 -o "CNR_PLUGIN_VERSION', '[^']*" "$SRC/chor-repertuar.php" | sed "s/.*'//" || true)"
echo "✓ Odtwarzacz skopiowany z wtyczki ${VER:-?}"
# The library versions are set in the plugin in includes/class-frontend.php — warn if they changed.
if grep -q "OSMD_VERSION       = '2.1.2'" "$SRC/includes/class-frontend.php" 2>/dev/null; then
  :
else
  echo "⚠︎ Wtyczka używa innej wersji OpenSheetMusicDisplay niż 2.1.2 dołączona do aplikacji — daj znać, podmienię bibliotekę."
fi
echo "Teraz: bash build.sh --install"
