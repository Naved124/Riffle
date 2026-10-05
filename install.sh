#!/usr/bin/env bash
# Install Flashcard Viewer for the current user (no root needed).
#   ./install.sh            install / update
#   ./install.sh --system-deps   also print the distro packages Qt may need
set -euo pipefail

APP=flashcard-viewer
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
VENV="$DATA/$APP/venv"
BIN="$HOME/.local/bin"

say() { printf '\033[1;35m==>\033[0m %s\n' "$*"; }

if [[ "${1:-}" == "--system-deps" ]]; then
  cat <<'DEPS'
Qt WebEngine wheels are self-contained, but a few X11/GL libraries come from your distro:
  Debian/Ubuntu/Mint : sudo apt install python3-venv libxcb-cursor0 libegl1 libnss3 libxkbcommon-x11-0
  Fedora             : sudo dnf install xcb-util-cursor mesa-libEGL nss libxkbcommon-x11
  Arch/Manjaro       : sudo pacman -S xcb-util-cursor libglvnd nss libxkbcommon-x11
DEPS
  exit 0
fi

command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }
PYV=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "Python 3.9+ required (found $PYV)"; exit 1; }

say "Creating virtual environment in $VENV"
python3 -m venv "$VENV" || { echo "python3-venv is missing. Run: $0 --system-deps"; exit 1; }
"$VENV/bin/python" -m pip install --upgrade --quiet pip
say "Installing Flashcard Viewer and its dependencies (PyQt6 + Qt WebEngine, ~200 MB the first time)"
"$VENV/bin/python" -m pip install --upgrade --quiet "$SRC"

say "Creating launcher $BIN/$APP"
mkdir -p "$BIN"
cat > "$BIN/$APP" <<LAUNCH
#!/usr/bin/env bash
exec "$VENV/bin/flashcard-viewer" "\$@"
LAUNCH
chmod +x "$BIN/$APP"

say "Adding the app-menu entry and icon"
mkdir -p "$DATA/applications" "$DATA/icons/hicolor/scalable/apps"
sed "s|@EXEC@|$BIN/$APP|" "$SRC/packaging/$APP.desktop" > "$DATA/applications/$APP.desktop"
cp "$SRC/flashcard_viewer/ui/icon.svg" "$DATA/icons/hicolor/scalable/apps/$APP.svg"
command -v update-desktop-database >/dev/null && update-desktop-database -q "$DATA/applications" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$DATA/icons/hicolor" 2>/dev/null || true

mkdir -p "$HOME/Flashcards"
say "Done! Launch “Flashcard Viewer” from your app menu, or run: $APP"
say "Put your flashcard .html / .jsx files in ~/Flashcards (or add folders in Settings)."
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Note: $BIN is not on your PATH — add it to run '$APP' from a terminal.";; esac
if ! "$VENV/bin/python" -c "from PyQt6.QtWidgets import QApplication" 2>/dev/null; then
  echo "Qt could not load some system libraries. See: $0 --system-deps"
fi
