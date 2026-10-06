"""Decks made with the deck editor.

The editor (``ui/js/editor.js``) writes a self-contained HTML file whose cards are JSON in
``<script type="application/json" id="fv-deck-data">``; ``ui/js/core/deckgen.js`` builds it. This module
reads that data back on the desktop, turns its Markdown into plain text for quizzes and search, and
checks a file really is such a deck before the app agrees to overwrite it.
"""

from __future__ import annotations

import json
import re

FORMAT = "flashcard-viewer-deck"
_DATA = re.compile(r"""<script\b[^>]*\bid=["']fv-deck-data["'][^>]*>(.*?)</script\s*>""", re.I | re.S)
IMAGE_RX = re.compile(r"^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$")
MAX_CARDS = 5000
MAX_FIELD = 20000


def _str(v, limit: int = MAX_FIELD) -> str:
    s = v if isinstance(v, str) else "" if v is None else str(v)
    return s.replace("\r\n", "\n").replace("\r", "\n")[:limit]


def normalize_deck(raw) -> dict:
    """Same rules as normalizeDeck() in deckgen.js."""
    d = raw if isinstance(raw, dict) else {}
    cards = []
    for c in (d.get("cards") if isinstance(d.get("cards"), list) else [])[:MAX_CARDS]:
        if not isinstance(c, dict):
            continue
        card = {"type": "mcq" if c.get("type") == "mcq" else "basic", "front": _str(c.get("front")), "back": "",
                "hint": _str(c.get("hint")), "explanation": _str(c.get("explanation")),
                "category": _str(c.get("category"), 200)}
        if card["type"] == "mcq":
            choices = c.get("choices") if isinstance(c.get("choices"), list) else []
            card["choices"] = [_str(x, 2000) for x in choices[:8]]
            n = c.get("correct")
            card["correct"] = n if isinstance(n, int) and not isinstance(n, bool) and 0 <= n < len(card["choices"]) else 0
        else:
            card["back"] = _str(c.get("back"))
        cards.append(card)
    images = {}
    src = d.get("images") if isinstance(d.get("images"), dict) else {}
    for k, v in src.items():
        if isinstance(k, str) and re.fullmatch(r"[\w-]{1,40}", k, re.A) and isinstance(v, str) and IMAGE_RX.match(v):
            images[k] = v
    return {
        "format": FORMAT, "version": 1,
        "title": re.sub(r"\s+", " ", _str(d.get("title"), 200)).strip(),
        "emoji": _str(d.get("emoji"), 16).strip(),
        "description": _str(d.get("description"), 2000),
        "cards": cards,
        "images": images,
    }


def parse_custom_deck(text: str) -> dict | None:
    """Deck data of a file made by the deck editor, or None for any other deck."""
    if not isinstance(text, str) or "fv-deck-data" not in text:
        return None
    m = _DATA.search(text)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("format") != FORMAT:
        return None
    return normalize_deck(data)


# --------------------------------------------------------------------------- plain text
# Must match toPlain() in deckgen.js; tests run both on the same cases.
_FENCE = re.compile(r"^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$", re.M)
_PROTECT = re.compile(r"(`+)([\s\S]*?[^`])\1(?!`)|(?<!\\)\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)"
                      r"|(?<![\\$])\$(?=\S)(?:\\.|[^$\\\n])+?(?<=\S)\$(?![\d$])")
_SUBS = [
    (re.compile(r"!\[([^\]\n]*)\]\([^)\s]*\)"), r"\1"),
    (re.compile(r"\[([^\]\n]+)\]\((?:https?:|mailto:)[^)\s]*\)"), r"\1"),
    (re.compile(r"^[ \t]*#{1,6}[ \t]+", re.M), ""),
    (re.compile(r"^[ \t]*>[ \t]?", re.M), ""),
    (re.compile(r"\*\*(?=\S)([\s\S]*?\S)\*\*"), r"\1"),
    (re.compile(r"__(?=\S)([\s\S]*?\S)__"), r"\1"),
    (re.compile(r"~~(?=\S)([\s\S]*?\S)~~"), r"\1"),
    (re.compile(r"(?<![A-Za-z0-9_*\\])\*(?=\S)([^*\n]*?\S)\*(?![A-Za-z0-9_*])"), r"\1"),
    (re.compile(r"(?<![A-Za-z0-9_\\])_(?=\S)([^_\n]*?\S)_(?![A-Za-z0-9_])"), r"\1"),
    (re.compile(r"\\([\\`*_{}\[\]()#+\-.!~>|$])"), r"\1"),
]


def to_plain(md) -> str:
    """Markdown card text -> plain text: formatting marks removed, `code` and maths kept as written."""
    s = _str(md)
    kept: list[str] = []

    def keep(t: str) -> str:
        kept.append(t)
        return f"\0{len(kept) - 1}\0"

    s = _FENCE.sub(lambda m: keep(re.sub(r"\n$", "", m.group(1))), s)
    s = _PROTECT.sub(lambda m: keep(m.group(0)), s)
    for rx, rep in _SUBS:
        s = rx.sub(rep, s)
    s = re.sub(r"\0(\d+)\0", lambda m: kept[int(m.group(1))], s)
    lines = (re.sub(r"[ \t]+", " ", ln).strip() for ln in s.split("\n"))
    return "\n".join(ln for ln in lines if ln)


def card_complete(c: dict) -> bool:
    if not to_plain(c["front"]):
        return False
    if c["type"] == "mcq":
        choices = c.get("choices", [])
        return sum(1 for x in choices if to_plain(x)) >= 2 and bool(to_plain(choices[c["correct"]] if choices else ""))
    return bool(to_plain(c["back"]))


def deck_cards(deck: dict) -> list[dict]:
    """Cards as the extractor produces them (front/back/hint/explanation/choices/category)."""
    out = []
    for c in deck["cards"]:
        if not card_complete(c):
            continue
        base = {"hint": to_plain(c["hint"]), "explanation": to_plain(c["explanation"]),
                "category": c["category"].strip(), "source": "deck-editor"}
        if c["type"] == "mcq":
            choices = [t for t in (to_plain(x) for x in c["choices"]) if t]
            out.append({"front": to_plain(c["front"]), "back": to_plain(c["choices"][c["correct"]]), "choices": choices, **base})
        else:
            out.append({"front": to_plain(c["front"]), "back": to_plain(c["back"]), "choices": [], **base})
    return out


def deck_search_text(deck: dict) -> str:
    parts = [deck["title"], deck["description"]]
    for c in deck["cards"]:
        parts += [c["front"], c["back"], c["hint"], c["explanation"], c["category"], *c.get("choices", [])]
    return " ".join(t for t in (to_plain(p) for p in parts) if t)
