"""Per-platform locations for settings, data and caches.

Linux follows XDG (~/.config, ~/.local/share, ~/.cache); Windows uses
%APPDATA% / %LOCALAPPDATA%; macOS uses ~/Library.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_ID = "flashcard-viewer"
APP_NAME = "Flashcard Viewer"


def _env(var: str, fallback: Path) -> Path:
    base = os.environ.get(var)
    return Path(base) if base else fallback


def config_dir() -> Path:
    if sys.platform == "win32" and not os.environ.get("XDG_CONFIG_HOME"):
        return _env("APPDATA", Path.home() / "AppData" / "Roaming") / APP_NAME
    if sys.platform == "darwin" and not os.environ.get("XDG_CONFIG_HOME"):
        return Path.home() / "Library" / "Application Support" / APP_NAME
    return _env("XDG_CONFIG_HOME", Path.home() / ".config") / APP_ID


def data_dir() -> Path:
    if sys.platform == "win32" and not os.environ.get("XDG_DATA_HOME"):
        return _env("APPDATA", Path.home() / "AppData" / "Roaming") / APP_NAME / "data"
    if sys.platform == "darwin" and not os.environ.get("XDG_DATA_HOME"):
        return Path.home() / "Library" / "Application Support" / APP_NAME / "data"
    return _env("XDG_DATA_HOME", Path.home() / ".local" / "share") / APP_ID


def cache_dir() -> Path:
    if sys.platform == "win32" and not os.environ.get("XDG_CACHE_HOME"):
        return _env("LOCALAPPDATA", Path.home() / "AppData" / "Local") / APP_NAME / "cache"
    if sys.platform == "darwin" and not os.environ.get("XDG_CACHE_HOME"):
        return Path.home() / "Library" / "Caches" / APP_NAME
    return _env("XDG_CACHE_HOME", Path.home() / ".cache") / APP_ID


def default_deck_folder() -> Path:
    return Path.home() / "Flashcards"


def ensure_dirs() -> None:
    for d in (config_dir(), data_dir(), cache_dir(), data_dir() / "overrides", cache_dir() / "cdn"):
        d.mkdir(parents=True, exist_ok=True)
