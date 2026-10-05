#!/usr/bin/env bash
# Remove Flashcard Viewer. Your decks (~/Flashcards), settings and stats are kept unless you pass --purge.
set -euo pipefail
APP=flashcard-viewer
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
rm -rf "$DATA/$APP/venv"
rm -f "$HOME/.local/bin/$APP" "$DATA/applications/$APP.desktop" "$DATA/icons/hicolor/scalable/apps/$APP.svg"
command -v update-desktop-database >/dev/null && update-desktop-database -q "$DATA/applications" || true
if [[ "${1:-}" == "--purge" ]]; then
  rm -rf "$DATA/$APP" "${XDG_CONFIG_HOME:-$HOME/.config}/$APP" "${XDG_CACHE_HOME:-$HOME/.cache}/$APP"
  echo "Removed app, settings, stats and caches. Your deck files were not touched."
else
  echo "Removed the app. Settings and stats are kept (use --purge to delete them)."
fi
