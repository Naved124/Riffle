"""Find question/answer pairs inside arbitrary flashcard HTML / React artifacts.

No single format exists for AI-made decks, so several strategies run and
their results are merged:

1. **Script data** - array literals of objects in ``<script>`` blocks (or the
   whole file for .jsx/.tsx), including JSON blobs, quiz formats with
   ``options`` + ``correct`` index, and nested category objects.
2. **DOM structure** - ``.front``/``.back`` style class pairs, ``data-front``
   attributes, ``<details>/<summary>``, ``<dl>``, two-column tables.
3. **Plain text** - ``Q: ... A: ...`` lines and ``term — definition`` lists.

If script data yields cards they win (the DOM is then usually just a render
template); otherwise DOM and text results are combined.
"""

from __future__ import annotations

import hashlib
import html as htmlmod
import re
import unicodedata
from dataclasses import asdict, dataclass, field

from bs4 import BeautifulSoup, NavigableString, Tag

from .customdeck import deck_cards, parse_custom_deck
from .jsparse import UNKNOWN, find_literal_arrays

__all__ = ["Card", "Extraction", "extract_cards", "card_key", "decode_bytes", "is_script_source"]


@dataclass
class Card:
    front: str
    back: str
    hint: str = ""
    explanation: str = ""
    choices: list[str] = field(default_factory=list)
    category: str = ""
    source: str = ""

    @property
    def key(self) -> str:
        return card_key(self.front)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["key"] = self.key
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Card":
        return cls(
            front=str(d.get("front", "")),
            back=str(d.get("back", "")),
            hint=str(d.get("hint", "") or ""),
            explanation=str(d.get("explanation", "") or ""),
            choices=[str(c) for c in d.get("choices", []) or []],
            category=str(d.get("category", "") or ""),
            source=str(d.get("source", "manual") or "manual"),
        )


@dataclass
class Extraction:
    cards: list[Card]
    methods: list[str]

    def to_dict(self) -> dict:
        return {"cards": [c.to_dict() for c in self.cards], "methods": self.methods}


def card_key(front: str) -> str:
    norm = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", front).casefold()).strip()
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:12]


def decode_bytes(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-16"):
        try:
            text = data.decode(enc)
            if enc == "utf-16" and not data[:2] in (b"\xff\xfe", b"\xfe\xff"):
                continue
            return text.replace("\r\n", "\n").replace("\r", "\n")
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1").replace("\r\n", "\n")


SCRIPT_EXTS = (".jsx", ".tsx", ".js", ".ts", ".mjs")


def is_script_source(filename: str, text: str) -> bool:
    """True for React/JS modules (as opposed to HTML documents)."""
    if filename.lower().endswith(SCRIPT_EXTS):
        return True
    head = text.lstrip()[:2000]
    if head.startswith("<"):
        return False
    return bool(re.search(r"^\s*(import\s.+from\s|export\s+default\b)", text, re.M))


# --------------------------------------------------------------------------
# Text cleanup
# --------------------------------------------------------------------------

_TAG = re.compile(r"<[^>]+>")


def clean_text(value: str) -> str:
    if "<" in value and ">" in value:
        value = re.sub(r"<br\s*/?>", "\n", value, flags=re.I)
        value = _TAG.sub("", value)
    value = htmlmod.unescape(value)
    value = value.replace(" ", " ")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in value.split("\n")]
    return "\n".join(ln for ln in lines if ln).strip()


def _flat(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


# --------------------------------------------------------------------------
# Strategy 1: data in scripts
# --------------------------------------------------------------------------

FRONT_KEYS = ["question", "q", "front", "term", "prompt", "word", "concept", "phrase", "kanji",
              "character", "symbol", "title", "name", "clue", "text", "statement"]
BACK_KEYS = ["answer", "a", "back", "definition", "def", "meaning", "translation", "response",
             "solution", "reading", "romaji", "description", "explanation", "value", "result"]
PAIRS = [("question", "answer"), ("q", "a"), ("front", "back"), ("term", "definition"),
         ("term", "def"), ("term", "meaning"), ("word", "meaning"), ("word", "definition"),
         ("word", "translation"), ("prompt", "answer"), ("prompt", "response"), ("question", "solution"),
         ("concept", "definition"), ("concept", "explanation"), ("phrase", "translation"),
         ("kanji", "meaning"), ("character", "reading"), ("symbol", "name"), ("clue", "answer"),
         ("title", "description"), ("name", "description"), ("question", "explanation")]
META_KEYS = {"id", "key", "category", "categories", "tag", "tags", "topic", "color", "colour", "emoji",
             "icon", "difficulty", "level", "type", "image", "img", "src", "url", "hint", "note", "notes",
             "explanation", "example", "status", "group", "section", "deck", "chapter", "unit", "points",
             "subject", "className", "style", "bg", "theme", "lang", "language", "audio"}
CHOICE_KEYS = ["options", "choices", "answers", "alternatives", "possibleAnswers"]
CORRECT_KEYS = ["correct", "correctIndex", "correctAnswer", "answerIndex", "correct_answer",
                "correctOption", "answer", "solution", "right"]


def _lower_keys(d: dict) -> dict:
    return {k.lower() if isinstance(k, str) else k: v for k, v in d.items()}


def _as_text(v) -> str | None:
    if isinstance(v, bool) or v is None or v is UNKNOWN:
        return None
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        t = clean_text(v)
        return t or None
    return None


def _card_from_quiz(d: dict, ld: dict, category: str) -> Card | None:
    """{question, options[], correct: 1 | 'B' | 'text'} style entries."""
    choices = None
    for k in CHOICE_KEYS:
        v = ld.get(k.lower())
        if isinstance(v, list) and len(v) >= 2 and all(_as_text(x) for x in v):
            choices = [_as_text(x) for x in v]
            break
    if not choices:
        return None
    question = None
    for k in ("question", "q", "prompt", "text", "title", "front", "statement"):
        question = _as_text(ld.get(k))
        if question:
            break
    if not question:
        return None
    answer = None
    for k in CORRECT_KEYS:
        if k.lower() not in ld:
            continue
        v = ld[k.lower()]
        if isinstance(v, bool):
            continue
        if isinstance(v, int) and 0 <= v < len(choices):
            answer = choices[v]
        elif isinstance(v, str):
            s = v.strip()
            if len(s) == 1 and s.upper() in "ABCDEFGH" and "ABCDEFGH".index(s.upper()) < len(choices):
                answer = choices["ABCDEFGH".index(s.upper())]
            elif s.isdigit() and int(s) < len(choices) and not any(c == s for c in choices):
                answer = choices[int(s)]
            else:
                t = clean_text(s)
                if t:
                    answer = t
        if answer:
            break
    if not answer:
        return None
    explanation = _as_text(ld.get("explanation")) or _as_text(ld.get("rationale")) or ""
    return Card(question, answer, hint=_as_text(ld.get("hint")) or "", explanation=explanation,
                choices=choices, category=category, source="script")


def _card_from_dict(d: dict, category: str, shared_keys: list[str] | None) -> Card | None:
    ld = _lower_keys(d)
    quiz = _card_from_quiz(d, ld, category)
    if quiz:
        return quiz
    cat = _as_text(ld.get("category")) or _as_text(ld.get("topic")) or category
    for fk, bk in PAIRS:
        f, b = _as_text(ld.get(fk)), _as_text(ld.get(bk))
        if f and b:
            explanation = _as_text(ld.get("explanation")) if bk != "explanation" else ""
            return Card(f, b, hint=_as_text(ld.get("hint")) or "", explanation=explanation or "",
                        category=cat or "", source="script")
    if shared_keys:
        # Unknown schema (e.g. {spanish, english}): first two content fields.
        vals = [_as_text(d.get(k)) for k in shared_keys]
        if len(vals) >= 2 and vals[0] and vals[1]:
            return Card(vals[0], vals[1], hint=_as_text(ld.get("hint")) or "", category=cat or "", source="script")
    return None


def _content_keys(dicts: list[dict]) -> list[str] | None:
    """Keys shared by every dict that hold strings and aren't metadata."""
    if len(dicts) < 2:
        return None
    first = dicts[0]
    keys = [k for k in first if isinstance(k, str) and k.lower() not in META_KEYS]
    keys = [k for k in keys if all(_as_text(d.get(k)) for d in dicts)]
    if len(keys) < 2:
        return None
    # Skip arrays that look like config/UI data: values identical across items etc.
    for k in keys[:2]:
        if len({_as_text(d.get(k)) for d in dicts}) < max(2, len(dicts) // 2):
            return None
    return keys[:2]


def _cards_from_rows(rows: list, category: str) -> list[Card] | None:
    """Rows like ["Topic", "question", "answer", "note"]: arrays of strings with the same length.
    A short leading column whose values repeat is the category; the next two filled columns are
    front and back, and a further column becomes the explanation."""
    if len(rows) < 2 or not all(isinstance(r, list) for r in rows):
        return None
    width = len(rows[0])
    if width < 2 or width > 8 or any(len(r) != width for r in rows):
        return None
    if not all(isinstance(v, str) or v is None for r in rows for v in r):
        return None
    cols = [[_as_text(r[i]) for r in rows] for i in range(width)]
    filled = [i for i in range(width) if all(cols[i])]
    cat_col = None
    if (width >= 3 and 0 in filled and len(set(cols[0])) < len(rows)
            and all(len(v) <= 40 for v in cols[0]) and len(filled) >= 3):
        cat_col = 0
    content = [i for i in filled if i != cat_col]
    if len(content) < 2:
        return None
    front, back = content[0], content[1]
    # Config-like data (["sm", "small"] repeated) is not a deck.
    if len(set(cols[front])) < max(2, len(rows) // 2):
        return None
    extra = next((i for i in range(width) if i not in (cat_col, front, back) and any(cols[i])), None)
    cards = []
    for n in range(len(rows)):
        cat = cols[cat_col][n] if cat_col is not None else category
        cards.append(Card(cols[front][n], cols[back][n], explanation=(cols[extra][n] or "") if extra is not None else "",
                          category=cat or "", source="script"))
    return cards


def _walk(value, category: str, out: list[Card]) -> None:
    if isinstance(value, list):
        rows = _cards_from_rows(value, category)
        if rows:
            out.extend(rows)
            return
        dicts = [v for v in value if isinstance(v, dict)]
        shared = _content_keys(dicts)
        for v in value:
            if isinstance(v, dict):
                card = _card_from_dict(v, category, shared)
                if card:
                    out.append(card)
                    continue
                _walk(v, category, out)
            elif isinstance(v, list):
                _walk(v, category, out)
    elif isinstance(value, dict):
        for k, v in value.items():
            if isinstance(v, (list, dict)):
                label = k if isinstance(k, str) and not isinstance(v, dict) else category
                _walk(v, label if isinstance(v, list) else category, out)


def _scripts(text: str, is_script: bool) -> list[str]:
    if is_script:
        return [text]
    return [m.group(1) for m in re.finditer(r"<script\b[^>]*>(.*?)</script\s*>", text, re.S | re.I)]


def from_scripts(text: str, is_script: bool) -> list[Card]:
    cards: list[Card] = []
    for src in _scripts(text, is_script):
        for value, _s, _e, label in find_literal_arrays(src):
            found: list[Card] = []
            _walk(value, label if label and not label.isupper() else "", found)
            # A real deck has at least two cards in an array
            if len(found) >= 2:
                cards.extend(found)
    # Tidy categories that are just variable names like "flashcards"
    for c in cards:
        if c.category.lower() in {"flashcards", "cards", "deck", "data", "questions", "quizquestions", "items",
                                  "vocabulary", "vocab", "words", "terms"}:
            c.category = ""
    return cards


# --------------------------------------------------------------------------
# Strategy 2: DOM structure
# --------------------------------------------------------------------------

FRONT_CLASS = re.compile(r"(^|[-_])(front|question|q|term|prompt|clue)$|^(front|question|q|term|prompt)([-_]|$)", re.I)
BACK_CLASS = re.compile(r"(^|[-_])(back|answer|a|definition|meaning|solution)$|^(back|answer|a|definition|meaning)([-_]|$)", re.I)
LABEL_TEXT = re.compile(r"^(q|a|question|answer|front|back|term|definition)\s*[:.#]?\s*\d*$", re.I)
NON_CONTENT_TAGS = {"script", "style", "button", "noscript", "template", "svg", "nav", "input", "select", "textarea"}


def _node_text(el: Tag) -> str:
    parts: list[str] = []

    def rec(node):
        for ch in node.children:
            if isinstance(ch, NavigableString):
                if ch.__class__.__name__ in ("Comment", "Doctype", "Declaration", "ProcessingInstruction"):
                    continue
                parts.append(str(ch))
            elif isinstance(ch, Tag):
                if ch.name in NON_CONTENT_TAGS:
                    continue
                classes = " ".join(ch.get("class", []) or []).lower()
                own = _flat(ch.get_text(" "))
                if re.search(r"\b(label|badge|tag|chip|hint|counter|number|num|icon)\b", classes) and (
                        LABEL_TEXT.match(own) or len(own) < 14):
                    continue
                if ch.name == "br":
                    parts.append("\n")
                    continue
                block = ch.name in ("p", "div", "li", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section")
                if block:
                    parts.append("\n")
                rec(ch)
                if block:
                    parts.append("\n")

    rec(el)
    txt = clean_text("".join(parts))
    # Drop a leading visual label like "Question" / "A:".
    lines = txt.split("\n")
    while lines and LABEL_TEXT.match(lines[0].strip()):
        lines.pop(0)
    return "\n".join(lines).strip()


def _classes(el: Tag) -> list[str]:
    return [c for c in (el.get("class") or []) if isinstance(c, str)]


def _matches(el: Tag, rx: re.Pattern) -> bool:
    if el.name in NON_CONTENT_TAGS or el.name in ("a", "label", "span") and not _classes(el):
        return False
    return any(rx.search(c) for c in _classes(el))


def _dom_class_pairs(soup: BeautifulSoup) -> list[Card]:
    cards: list[Card] = []
    fronts = [el for el in soup.find_all(True) if _matches(el, FRONT_CLASS) and not _matches(el, BACK_CLASS)]
    # keep only outermost front elements
    fset = set(map(id, fronts))
    fronts = [f for f in fronts if not any(id(p) in fset for p in f.parents)]
    used_backs: set[int] = set()
    for f in fronts:
        anc = f.parent
        for _ in range(4):
            if anc is None or anc.name in ("body", "html", "[document]"):
                break
            backs = [b for b in anc.find_all(True) if _matches(b, BACK_CLASS) and not _matches(b, FRONT_CLASS)
                     and f not in b.parents and b not in f.parents and b is not f]
            bset = set(map(id, backs))
            backs = [b for b in backs if not any(id(p) in bset for p in b.parents)]
            if backs:
                fronts_here = [x for x in anc.find_all(True) if id(x) in fset]
                if len(backs) == 1 and len(fronts_here) == 1 and id(backs[0]) not in used_backs:
                    ft, bt = _node_text(f), _node_text(backs[0])
                    if ft and bt:
                        cards.append(Card(ft, bt, source="dom"))
                        used_backs.add(id(backs[0]))
                break
            anc = anc.parent
    return cards


DATA_ATTR_PAIRS = [("data-front", "data-back"), ("data-question", "data-answer"), ("data-q", "data-a"),
                   ("data-term", "data-definition"), ("data-word", "data-meaning")]


def _dom_data_attrs(soup: BeautifulSoup) -> list[Card]:
    cards = []
    for fa, ba in DATA_ATTR_PAIRS:
        for el in soup.find_all(attrs={fa: True, ba: True}):
            f, b = clean_text(el.get(fa, "")), clean_text(el.get(ba, ""))
            if f and b:
                cards.append(Card(f, b, hint=clean_text(el.get("data-hint", "")), source="dom"))
    return cards


def _dom_details(soup: BeautifulSoup) -> list[Card]:
    cards = []
    for d in soup.find_all("details"):
        s = d.find("summary")
        if not s:
            continue
        front = _node_text(s)
        s_copy = BeautifulSoup(str(d), "html.parser").find("details")
        s_copy.find("summary").decompose()
        back = _node_text(s_copy)
        if front and back:
            cards.append(Card(front, back, source="dom"))
    return cards


def _dom_dl(soup: BeautifulSoup) -> list[Card]:
    cards = []
    for dl in soup.find_all("dl"):
        term = None
        for ch in dl.find_all(["dt", "dd"]):
            if ch.name == "dt":
                term = _node_text(ch)
            elif term:
                d = _node_text(ch)
                if d:
                    cards.append(Card(term, d, source="dom"))
                term = None
    return cards


def _dom_tables(soup: BeautifulSoup) -> list[Card]:
    cards = []
    for table in soup.find_all("table"):
        rows = []
        for tr in table.find_all("tr"):
            cells = tr.find_all(["td", "th"], recursive=False)
            if not cells or all(c.name == "th" for c in cells):
                continue
            rows.append([_node_text(c) for c in cells])
        if len(rows) < 2:
            continue
        width = max(len(r) for r in rows)
        if width < 2 or width > 3:
            continue
        for r in rows:
            if len(r) >= 2 and r[0] and r[1]:
                cards.append(Card(r[0], r[1], explanation=r[2] if len(r) > 2 else "", source="dom"))
    return cards


# --------------------------------------------------------------------------
# Strategy 3: plain text
# --------------------------------------------------------------------------

_QA = re.compile(
    r"(?:^|\n)[ \t]*(?:Q|Question|Ques)\s*\d*\s*[:.)\-]\s*(?P<q>.+?)\s*\n[ \t]*(?:A|Ans|Answer)\s*[:.)\-]\s*(?P<a>.+?)(?=\n\s*\n|\n[ \t]*(?:Q|Question|Ques)\s*\d*\s*[:.)\-]|\Z)",
    re.S | re.I,
)
_DASH = re.compile(r"^(?P<f>.{3,}?)\s+(?:—|–|--|-|→|=>|::)\s+(?P<b>.+)$")


def _visible_text_blocks(soup: BeautifulSoup) -> str:
    body = soup.body or soup
    copy = BeautifulSoup(str(body), "html.parser")
    for t in copy.find_all(["script", "style", "noscript", "template"]):
        t.decompose()
    for br in copy.find_all("br"):
        br.replace_with("\n")
    for blk in copy.find_all(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "tr", "dd", "dt"]):
        blk.insert_before("\n\n")
        blk.insert_after("\n\n")
    text = htmlmod.unescape(copy.get_text())
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text)


def _text_qa(soup: BeautifulSoup) -> list[Card]:
    text = _visible_text_blocks(soup)
    cards = []
    for m in _QA.finditer(text):
        q, a = clean_text(m.group("q")), clean_text(m.group("a"))
        if q and a and len(q) < 600:
            cards.append(Card(q, a, source="text"))
    return cards


def _text_dash_lists(soup: BeautifulSoup) -> list[Card]:
    cards = []
    for lst in soup.find_all(["ul", "ol"]):
        items = lst.find_all("li", recursive=False)
        if len(items) < 2:
            continue
        found = []
        for li in items:
            m = _DASH.match(_flat(_node_text(li)))
            if m:
                found.append(Card(m.group("f").strip(" :"), m.group("b").strip(), source="text"))
        if len(found) >= 2 and len(found) >= 0.6 * len(items):
            cards.extend(found)
    return cards


# --------------------------------------------------------------------------

def _dedupe(cards: list[Card]) -> list[Card]:
    seen: set[tuple[str, str]] = set()
    out = []
    for c in cards:
        k = (c.key, card_key(c.back))
        if k in seen:
            continue
        seen.add(k)
        out.append(c)
    return out


def extract_cards(text: str, filename: str = "deck.html") -> Extraction:
    custom = parse_custom_deck(text)
    if custom is not None:  # made with the deck editor: its cards are exact
        return Extraction(_dedupe([Card(**c) for c in deck_cards(custom)]), ["deck-editor"])
    script = is_script_source(filename, text)
    script_cards = from_scripts(text, script)
    if len(script_cards) >= 2 or script:
        return Extraction(_dedupe(script_cards), ["script"] if script_cards else [])

    soup = BeautifulSoup(text, "html.parser")
    methods: list[str] = []
    cards: list[Card] = []
    for name, fn in (("dom-classes", _dom_class_pairs), ("data-attributes", _dom_data_attrs),
                     ("details", _dom_details), ("definition-list", _dom_dl), ("table", _dom_tables),
                     ("qa-text", _text_qa), ("dash-list", _text_dash_lists)):
        found = fn(soup)
        if found:
            methods.append(name)
            cards.extend(found)
    if not cards and script_cards:
        return Extraction(script_cards, ["script"])
    return Extraction(_dedupe(cards), methods)
