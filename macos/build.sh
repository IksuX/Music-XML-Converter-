#!/bin/bash
# Buduje aplikację "Nuty MusicXML.app" bez Xcode — wystarczą Command Line Tools.
#   ./build.sh            → buduje do folderu build/
#   ./build.sh --install  → buduje i kopiuje do /Applications
set -euo pipefail

VERSION="0.5.2"
APP_NAME="Nuty MusicXML"
EXE="NutyMusicXML"
ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD="$ROOT/build"
APP="$BUILD/$APP_NAME.app"

if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "Brak kompilatora Swift. Zainstaluj Command Line Tools:  xcode-select --install"
  exit 1
fi

ARCH="$(uname -m)"
SDK="$(xcrun --show-sdk-path --sdk macosx)"

echo "→ Kompiluję $APP_NAME $VERSION ($ARCH)…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

if [[ "${UNIVERSAL:-0}" == "1" ]]; then
  # dla Apple Silicon i Intela w jednym pliku (używane przy budowaniu na GitHubie)
  for A in arm64 x86_64; do
    xcrun swiftc -O -parse-as-library -target "$A-apple-macos13.0" -sdk "$SDK" \
      "$ROOT"/Sources/*.swift -o "$BUILD/$EXE-$A"
  done
  lipo -create "$BUILD/$EXE-arm64" "$BUILD/$EXE-x86_64" -output "$APP/Contents/MacOS/$EXE"
  rm -f "$BUILD/$EXE-arm64" "$BUILD/$EXE-x86_64"
else
  xcrun swiftc -O -parse-as-library \
    -target "$ARCH-apple-macos13.0" \
    -sdk "$SDK" \
    "$ROOT"/Sources/*.swift \
    -o "$APP/Contents/MacOS/$EXE"
fi

sed "s/__VERSION__/$VERSION/g" "$ROOT/Resources/Info.plist" > "$APP/Contents/Info.plist"
cp "$ROOT/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/Resources/wektor_pdf.py" "$APP/Contents/Resources/wektor_pdf.py"
cp "$ROOT/zainstaluj-silniki.sh" "$APP/Contents/Resources/zainstaluj-silniki.sh"
cp -R "$ROOT/Resources/Player" "$APP/Contents/Resources/Player"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# Podpis ad-hoc — wystarczy do uruchamiania na własnym Macu.
codesign --force --deep --sign - "$APP" >/dev/null
echo "✓ Gotowe: $APP"

if [[ "${1:-}" == "--install" ]]; then
  DEST="/Applications/$APP_NAME.app"
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  echo "✓ Skopiowano do $DEST"
  open "$DEST"
fi
