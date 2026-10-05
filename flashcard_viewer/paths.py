"""XDG-compliant locations for settings, data and caches."""

from __future__ import annotations

import os
from pathlib import Path

APP_ID = "flashcard-viewer"


def _xdg(var: str, fallback: str) -> Path:
    base = os.environ.get(var)
    return Path(base) if base else Path.home() / fallback


def config_dir() -> Path:
    return _xdg("XDG_CONFIG_HOME", ".config") / APP_ID


def data_dir() -> Path:
    return _xdg("XDG_DATA_HOME", ".local/share") / APP_ID


def cache_dir() -> Path:
    return _xdg("XDG_CACHE_HOME", ".cache") / APP_ID


def default_deck_folder() -> Path:
    return Path.home() / "Flashcards"


def ensure_dirs() -> None:
    for d in (config_dir(), data_dir(), cache_dir(), data_dir() / "overrides", cache_dir() / "cdn"):
        d.mkdir(parents=True, exist_ok=True)
