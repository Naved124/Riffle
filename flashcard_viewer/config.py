"""Settings (settings.json) and library state (library.json) persistence."""

from __future__ import annotations

import copy
import json
import os
import tempfile
from pathlib import Path

from . import paths

DEFAULT_SHORTCUTS = {
    "search": "Ctrl+K",
    "fullscreen": "F11",
    "focusMode": "Ctrl+Shift+F",
    "quiz": "Ctrl+Q",
    "nextDeck": "Ctrl+ArrowDown",
    "prevDeck": "Ctrl+ArrowUp",
    "zoomIn": "Ctrl+=",
    "zoomOut": "Ctrl+-",
    "zoomReset": "Ctrl+0",
    "reload": "Ctrl+R",
    "favourite": "Ctrl+D",
    "library": "Ctrl+1",
    "quizPage": "Ctrl+2",
    "stats": "Ctrl+3",
    "settings": "Ctrl+,",
    "toggleSidebar": "Ctrl+B",
    "openFile": "Ctrl+O",
    "newDeck": "Ctrl+N",
    "cheatsheet": "Ctrl+/",
}

DEFAULTS: dict = {
    "appearance": {
        "mode": "system",            # system | light | dark
        "theme": "baseline",         # theme id (see ui/js/themes.js)
        "seed": "#6750A4",           # custom seed colour
        "variant": "tonalSpot",      # MCU scheme variant for seed-based themes
        "contrast": "standard",      # standard | medium | high
        "amoled": False,
        "glass": False,              # frosted translucent surfaces for any theme
        "glassBlur": 24,
        "glassOpacity": 0.62,
        "catppuccinDark": "mocha",   # frappe | macchiato | mocha (light = latte)
        "catppuccinAccent": "mauve",
        "gruvboxContrast": "medium",  # soft | medium | hard
        "font": "Roboto Flex",
        "headingFont": "",           # empty = same as font
        "monoFont": "Maple Mono",
        "fontScale": 1.0,
        "uiScale": 1.0,
        "corner": 1.0,               # multiplier on M3 shape tokens
        "iconStyle": "rounded",      # outlined | rounded | sharp
        "iconFill": False,
        "iconWeight": 400,
        "density": "comfortable",    # comfortable | compact
    },
    "motion": {
        "enabled": True,
        "speed": 1.0,
        "reduce": False,
        "rippleEffects": True,
    },
    "decks": {
        "applyAppFont": False,
        "applyTheme": "off",         # off | auto | invert
        "zoom": 1.0,
        "autoReload": True,
        "rememberPosition": True,
    },
    "library": {
        "folders": [],               # filled on first run
        "mainFolder": "",
        "recursive": True,
        "sort": "name",              # name | recent | modified | studied
        "favouritesFirst": True,
        "showCardCount": True,
        "view": "list",              # list | compact
    },
    "network": {
        "mode": "offline-first",     # offline-first | online | offline
    },
    "quiz": {
        "questions": 10,
        "types": {"typed": True, "mc": True, "tf": True},
        "threshold": 0.75,
        "stripAccents": True,
        "shuffle": True,
        "vary": True,                # also ask cards backwards, as fill-in-the-blank or from the explanation
        "timer": 0,                  # seconds per question, 0 = off
        "sounds": True,
        "showExplanations": True,
        "promptOnFinish": True,
        "promptAfterMinutes": 0,     # 0 = off
        "weakFirst": True,
        "autoAdvance": False,
    },
    "window": {
        "customTitlebar": True,
        "width": 1280,
        "height": 820,
        "maximized": False,
        "sidebarWidth": 300,
        "sidebarCollapsed": False,
    },
    "shortcuts": DEFAULT_SHORTCUTS,
    "general": {
        "startPage": "library",      # library | lastDeck | stats
        "lastDeck": "",
        "confirmDelete": True,
        "singleInstance": True,
        "checkUpdates": True,        # look for a new release on startup (at most every 6 hours)
        "lastUpdateCheck": 0,        # epoch ms
        "skippedVersion": "",
    },
}

DEFAULT_LIBRARY = {"favourites": [], "renames": {}, "recent": [], "external": [], "positions": {}}


def deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def atomic_write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_json(path: Path) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


class Settings:
    def __init__(self, path: Path | None = None):
        self.path = path or paths.config_dir() / "settings.json"
        self.data = deep_merge(DEFAULTS, _read_json(self.path))
        if not self.data["library"]["folders"]:
            main = str(paths.default_deck_folder())
            self.data["library"]["folders"] = [main]
            self.data["library"]["mainFolder"] = main
        if not self.data["library"]["mainFolder"]:
            self.data["library"]["mainFolder"] = self.data["library"]["folders"][0]

    def save(self) -> None:
        atomic_write_json(self.path, self.data)

    def update(self, patch: dict) -> dict:
        self.data = deep_merge(self.data, patch)
        self.save()
        return self.data

    def reset(self, section: str | None = None) -> dict:
        folders = self.data["library"]["folders"], self.data["library"]["mainFolder"]
        if section and section in DEFAULTS:
            self.data[section] = copy.deepcopy(DEFAULTS[section])
        else:
            self.data = copy.deepcopy(DEFAULTS)
        self.data["library"]["folders"], self.data["library"]["mainFolder"] = folders
        self.save()
        return self.data

    def get(self, section: str, key: str):
        return self.data.get(section, {}).get(key, DEFAULTS.get(section, {}).get(key))


class LibraryState:
    """Favourites, display names, recents and per-deck UI state."""

    def __init__(self, path: Path | None = None):
        self.path = path or paths.data_dir() / "library.json"
        self.data = deep_merge(DEFAULT_LIBRARY, _read_json(self.path))

    def save(self) -> None:
        atomic_write_json(self.path, self.data)

    def toggle_favourite(self, deck_id: str) -> bool:
        favs = self.data["favourites"]
        if deck_id in favs:
            favs.remove(deck_id)
            fav = False
        else:
            favs.append(deck_id)
            fav = True
        self.save()
        return fav

    def rename(self, deck_id: str, name: str) -> None:
        name = name.strip()
        if name:
            self.data["renames"][deck_id] = name
        else:
            self.data["renames"].pop(deck_id, None)
        self.save()

    def touch_recent(self, deck_id: str, limit: int = 20) -> None:
        rec = [d for d in self.data["recent"] if d != deck_id]
        rec.insert(0, deck_id)
        self.data["recent"] = rec[:limit]
        self.save()

    def add_external(self, path: str) -> None:
        if path not in self.data["external"]:
            self.data["external"].append(path)
            self.save()

    def remove_external(self, path: str) -> None:
        if path in self.data["external"]:
            self.data["external"].remove(path)
            self.save()
