"""Deck discovery in watched folders, titles, search, and cached card extraction."""

from __future__ import annotations

import hashlib
import html as htmlmod
import json
import os
import re
import shutil
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from . import paths
from .config import LibraryState, Settings, atomic_write_json
from .extract import Card, decode_bytes, extract_cards, is_script_source

DECK_EXTS = (".html", ".htm", ".xhtml", ".jsx", ".tsx")
SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".cache", "vendor", "dist", "build"}
MAX_DECK_BYTES = 25 * 1024 * 1024


def deck_id_for(path: str | Path) -> str:
    real = os.path.realpath(str(path))
    return hashlib.sha1(real.encode("utf-8")).hexdigest()[:16]


def is_deck_file(path: str | Path) -> bool:
    p = Path(path)
    return p.suffix.lower() in DECK_EXTS and not p.name.startswith(".")


def _prettify_filename(name: str) -> str:
    stem = re.sub(r"\.(html?|xhtml|jsx|tsx)$", "", name, flags=re.I)
    stem = re.sub(r"^\d+[\s._-]+", "", stem)  # leading "01-"
    stem = re.sub(r"[_-]+", " ", stem).strip()
    return stem[:1].upper() + stem[1:] if stem else name


def guess_title(text: str, filename: str) -> str:
    if not is_script_source(filename, text):
        m = re.search(r"<title[^>]*>(.*?)</title>", text, re.S | re.I)
        if m:
            t = re.sub(r"\s+", " ", htmlmod.unescape(m.group(1))).strip()
            if t:
                return t[:120]
    m = re.search(r"<h1[^>]*>([^<{]+)", text, re.I) or re.search(r"<h2[^>]*>([^<{]+)", text, re.I)
    if m:
        t = re.sub(r"\s+", " ", htmlmod.unescape(m.group(1))).strip()
        t = re.sub(r"^[^\w]+", "", t).strip()  # drop leading emoji
        if len(t) >= 3:
            return t[:120]
    return _prettify_filename(filename)


def _emoji(text: str) -> str:
    """Leading emoji of the deck's first heading or title (e.g. "🐧 Linux Commands")."""
    for m in re.finditer(r"<(h1|h2|title)\b[^>]*>\s*([^<]{1,12})", text[:200000], re.I):
        head = m.group(2).strip()
        if not head:
            continue
        out = ""
        for ch in head:
            cat = unicodedata.category(ch)
            if cat == "So" or "\U0001F1E6" <= ch <= "\U0001F1FF" or (out and ch in "\uFE0F\u200D") or (out and cat == "Sk"):
                out += ch
            else:
                break
        if out:
            return out
    return ""


def plain_text(text: str) -> str:
    t = re.sub(r"<(script|style)\b[^>]*>.*?</\1\s*>", " ", text, flags=re.S | re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    return re.sub(r"\s+", " ", htmlmod.unescape(t)).strip()


def fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s.casefold())
    return "".join(c for c in s if not unicodedata.combining(c))


@dataclass
class DeckInfo:
    id: str
    path: str
    filename: str
    folder: str
    title: str
    emoji: str
    kind: str          # html | fragment | react
    size: int
    mtime: float
    card_count: int
    methods: list[str]
    external: bool = False

    def to_dict(self) -> dict:
        return dict(self.__dict__)


def deck_kind(text: str, filename: str) -> str:
    if is_script_source(filename, text):
        return "react"
    head = re.sub(r"<!--.*?-->", "", text[:20000], flags=re.S).lstrip("\ufeff \n\r\t")[:4000].lower()
    if re.search(r"<!doctype|<html|<head|<body", head):
        return "html"
    return "fragment"


class Library:
    def __init__(self, settings: Settings, state: LibraryState | None = None):
        self.settings = settings
        self.state = state or LibraryState()
        self.decks: dict[str, DeckInfo] = {}
        self._cache: dict[str, tuple[float, int, dict]] = {}  # id -> (mtime, size, {text, cards, ...})

    # -- scanning ---------------------------------------------------------------
    def folders(self) -> list[str]:
        return list(self.settings.data["library"]["folders"])

    def iter_files(self):
        recursive = self.settings.data["library"].get("recursive", True)
        seen = set()
        for folder in self.folders():
            root = Path(os.path.expanduser(folder))
            if not root.is_dir():
                continue
            if recursive:
                for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
                    dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
                    for fn in sorted(filenames):
                        p = Path(dirpath) / fn
                        if is_deck_file(p) and str(p) not in seen:
                            seen.add(str(p))
                            yield p, False
            else:
                for p in sorted(root.iterdir()):
                    if p.is_file() and is_deck_file(p) and str(p) not in seen:
                        seen.add(str(p))
                        yield p, False
        for ext in list(self.state.data.get("external", [])):
            p = Path(ext)
            if p.is_file() and str(p) not in seen:
                seen.add(str(p))
                yield p, True

    def scan(self) -> list[DeckInfo]:
        decks = {}
        for p, external in self.iter_files():
            try:
                info = self._info(p, external)
            except OSError:
                continue
            if info:
                decks[info.id] = info
        self.decks = decks
        return self.list()

    def _load(self, p: Path) -> dict | None:
        st = p.stat()
        if st.st_size > MAX_DECK_BYTES:
            return None
        did = deck_id_for(p)
        cached = self._cache.get(did)
        if cached and cached[0] == st.st_mtime and cached[1] == st.st_size:
            return cached[2]
        text = decode_bytes(p.read_bytes())
        ex = extract_cards(text, p.name)
        entry = {
            "text": text,
            "plain": fold(plain_text(text)) if not is_script_source(p.name, text) else fold(text),
            "cards": ex.cards,
            "methods": ex.methods,
            "title": guess_title(text, p.name),
            "emoji": _emoji(text),
            "kind": deck_kind(text, p.name),
        }
        self._cache[did] = (st.st_mtime, st.st_size, entry)
        return entry

    def _info(self, p: Path, external: bool) -> DeckInfo | None:
        entry = self._load(p)
        if entry is None:
            return None
        st = p.stat()
        did = deck_id_for(p)
        cards = self.cards(did, entry=entry)
        return DeckInfo(
            id=did, path=str(p), filename=p.name, folder=str(p.parent), title=entry["title"],
            emoji=entry["emoji"], kind=entry["kind"], size=st.st_size, mtime=st.st_mtime,
            card_count=len(cards), methods=entry["methods"] if not self._override_path(did).exists() else ["manual"],
            external=external,
        )

    def refresh(self, deck_id: str) -> DeckInfo | None:
        info = self.decks.get(deck_id)
        if not info:
            return None
        p = Path(info.path)
        if not p.exists():
            self.decks.pop(deck_id, None)
            return None
        new = self._info(p, info.external)
        if new:
            self.decks[deck_id] = new
        return new

    def list(self) -> list[DeckInfo]:
        return list(self.decks.values())

    def get(self, deck_id: str) -> DeckInfo | None:
        return self.decks.get(deck_id)

    def text(self, deck_id: str) -> str | None:
        info = self.decks.get(deck_id)
        if not info:
            return None
        entry = self._load(Path(info.path))
        return entry["text"] if entry else None

    def display_name(self, info: DeckInfo) -> str:
        return self.state.data["renames"].get(info.id) or info.title

    # -- cards -----------------------------------------------------------------
    def _override_path(self, deck_id: str) -> Path:
        return paths.data_dir() / "overrides" / f"{deck_id}.json"

    def cards(self, deck_id: str, entry: dict | None = None) -> list[Card]:
        op = self._override_path(deck_id)
        if op.exists():
            try:
                data = json.loads(op.read_text(encoding="utf-8"))
                return [Card.from_dict(c) for c in data.get("cards", [])]
            except (OSError, ValueError):
                pass
        if entry is None:
            info = self.decks.get(deck_id)
            if not info:
                return []
            entry = self._load(Path(info.path))
            if not entry:
                return []
        return list(entry["cards"])

    def has_override(self, deck_id: str) -> bool:
        return self._override_path(deck_id).exists()

    def save_cards(self, deck_id: str, cards: list[dict]) -> None:
        atomic_write_json(self._override_path(deck_id), {"cards": [Card.from_dict(c).to_dict() for c in cards]})
        self.refresh(deck_id)

    def reset_cards(self, deck_id: str) -> None:
        try:
            self._override_path(deck_id).unlink()
        except FileNotFoundError:
            pass
        self.refresh(deck_id)

    # -- search ------------------------------------------------------------------
    def search(self, query: str) -> list[dict]:
        q = fold(query.strip())
        if not q:
            return []
        terms = q.split()
        out = []
        for info in self.decks.values():
            name = fold(self.display_name(info) + " " + info.filename)
            entry = self._cache.get(info.id, (0, 0, {}))[2]
            body = entry.get("plain", "")
            in_name = all(t in name for t in terms)
            in_body = all(t in body or t in name for t in terms)
            if not (in_name or in_body):
                continue
            snippet = ""
            if not in_name and body:
                i = body.find(terms[0])
                if i >= 0:
                    s = max(0, i - 40)
                    snippet = ("…" if s else "") + body[s:i + 80].strip() + "…"
            out.append({"id": info.id, "inName": in_name, "snippet": snippet})
        out.sort(key=lambda r: (not r["inName"],))
        return out

    # -- import ------------------------------------------------------------------
    def import_file(self, name: str, data: bytes, folder: str | None = None) -> Path:
        folder_p = Path(os.path.expanduser(folder or self.settings.data["library"]["mainFolder"]))
        folder_p.mkdir(parents=True, exist_ok=True)
        name = os.path.basename(name).strip() or "deck.html"
        if not is_deck_file(name):
            name += ".html"
        target = folder_p / name
        if target.exists():
            if target.read_bytes() == data:
                return target
            stem, suffix = target.stem, target.suffix
            n = 2
            while (folder_p / f"{stem} ({n}){suffix}").exists():
                n += 1
            target = folder_p / f"{stem} ({n}){suffix}"
        target.write_bytes(data)
        return target

    def import_path(self, src: str, folder: str | None = None) -> Path:
        p = Path(src)
        return self.import_file(p.name, p.read_bytes(), folder)

    def add_external(self, path: str) -> str:
        p = os.path.realpath(path)
        for folder in self.folders():
            f = os.path.realpath(os.path.expanduser(folder))
            if p.startswith(f + os.sep):
                return deck_id_for(p)  # already inside a watched folder
        self.state.add_external(p)
        return deck_id_for(p)

    def delete_deck(self, deck_id: str) -> bool:
        info = self.decks.get(deck_id)
        if not info:
            return False
        if info.external:
            self.state.remove_external(info.path)
        else:
            trash = paths.data_dir() / "trash"
            trash.mkdir(parents=True, exist_ok=True)
            shutil.move(info.path, trash / f"{deck_id}-{info.filename}")
        self.decks.pop(deck_id, None)
        return True
