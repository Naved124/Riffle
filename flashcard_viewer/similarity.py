"""Fuzzy answer grading without ML.

The score (0..1) is the best of a few cheap signals, computed against every
acceptable variant of the expected answer:

* character similarity (Levenshtein ratio), which forgives typos
* keyword overlap with per-token fuzzy matching and light stemming, which
  forgives word order, filler words and partial phrasing
* containment, for when the user wrote the answer plus a bit more

Guards stop "port 22" ≈ "port 23" or "is" ≈ "is not" from passing as correct.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

__all__ = ["normalize", "answer_variants", "similarity", "grade", "Grade", "is_boolean_answer", "boolean_value"]

STOPWORDS = {
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "it", "its", "it's", "of", "to", "in",
    "on", "at", "by", "for", "and", "or", "that", "this", "these", "those", "with", "as", "from", "into",
    "which", "what", "who", "whom", "do", "does", "did", "you", "they", "we", "he", "she", "their",
    "there", "then", "so", "also", "just", "very", "can", "will", "would", "should", "could", "has", "have",
    "had", "um", "uh", "basically", "like", "called", "known", "el", "la", "los", "las", "le", "les", "der",
    "die", "das",
}
# Words that commonly prefix an answer but carry no meaning for grading.
OPTIONAL = {"amazon", "aws", "service", "command", "function", "process", "approximately", "about", "around"}
NEGATIONS = {"not", "no", "never", "none", "nothing", "cannot", "cant", "isnt", "arent", "doesnt", "dont",
             "wont", "wasnt", "werent", "without", "false", "incorrect"}
NUMBER_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7",
    "eight": "8", "nine": "9", "ten": "10", "eleven": "11", "twelve": "12", "thirteen": "13", "fourteen": "14",
    "fifteen": "15", "sixteen": "16", "seventeen": "17", "eighteen": "18", "nineteen": "19", "twenty": "20",
    "thirty": "30", "forty": "40", "fifty": "50", "sixty": "60", "seventy": "70", "eighty": "80",
    "ninety": "90", "hundred": "100", "thousand": "1000", "first": "1", "second": "2", "third": "3",
}
TRUE_WORDS = {"true", "yes", "y", "t", "correct", "right", "yeah", "yep", "si", "sí"}
FALSE_WORDS = {"false", "no", "n", "f", "incorrect", "wrong", "nope"}


def _strip_accents(s: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.combining(ch))


def normalize(s: str, strip_accents: bool = True) -> str:
    s = unicodedata.normalize("NFKC", s).casefold()
    if strip_accents:
        s = _strip_accents(s)
    s = s.replace("’", "'").replace("‘", "'")
    s = re.sub(r"\\(?:frac|left|right|mathrm|text|,|;|!)", " ", s)  # light LaTeX cleanup
    s = re.sub(r"(?<=\w)'(?=\w)", "", s)  # don't -> dont
    # keep characters meaningful in technical answers: . / - + = < > & | ~ # % _ ^ *
    s = re.sub(r"[^\w\s./+\-=<>&|~#%^*]", " ", s)
    s = re.sub(r"[.\-/]+(?!\w)", " ", s)  # trailing punctuation and lone dashes; keeps -la, /var, .5
    return re.sub(r"\s+", " ", s).strip()


def _stem(w: str) -> str:
    if len(w) <= 4 or not w.isalpha():
        return w
    for suf in ("ations", "ation", "ingly", "ings", "ing", "edly", "ies", "ied", "ers", "est", "ed", "es", "ly", "er", "s"):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            w = w[: -len(suf)]
            break
    return w


def _tokens(norm: str) -> list[str]:
    toks = [NUMBER_WORDS.get(t, t) for t in norm.split()]
    return toks


def _keywords(toks: list[str]) -> list[str]:
    kw = [_stem(t) for t in toks if t not in STOPWORDS and t not in OPTIONAL]
    if not kw:
        kw = [_stem(t) for t in toks if t not in STOPWORDS] or [_stem(t) for t in toks]
    return kw


def _lev(a: str, b: str) -> int:
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _ratio(a: str, b: str) -> float:
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    if len(a) + len(b) > 400:
        return SequenceMatcher(None, a, b).ratio()
    return 1 - _lev(a, b) / max(len(a), len(b))


def _tok_sim(a: str, b: str) -> float:
    if a == b:
        return 1.0
    # Short CLI flags: -la == -al
    if a.startswith("-") and b.startswith("-") and not a.startswith("--") and sorted(a) == sorted(b):
        return 1.0
    if a.isdigit() or b.isdigit():
        return 0.0
    r = _ratio(a, b)
    # Short words need to be (almost) exact: "cat" vs "car" is wrong.
    if min(len(a), len(b)) <= 3:
        return r if r >= 0.99 else 0.0
    return r if r >= 0.75 else 0.0


def _coverage(src: list[str], dst: list[str]) -> float:
    if not src:
        return 0.0
    total = 0.0
    for t in src:
        total += max((_tok_sim(t, u) for u in dst), default=0.0)
    return total / len(src)


_NUM = re.compile(r"\d+(?:[.,]\d+)?")
_ROMAN = re.compile(r"(?<![\w'])(II|III|IV|VI|VII|VIII|IX|XI|XII|I|V|X)(?![\w'])")


def answer_variants(answer: str) -> list[str]:
    """All acceptable phrasings: 'SIGTERM (15)' -> full, 'SIGTERM', '15'."""
    a = answer.strip()
    out = [a]
    # alternatives separated by " / ", " or ", ";" or newline
    parts = re.split(r"\s+/\s+|\s+or\s+|\s*;\s*|\n", a)
    if len(parts) > 1:
        out.extend(p for p in parts if p.strip())
    for p in list(out):
        m = re.match(r"^(.*?)\s*\(([^)]+)\)\s*(.*)$", p)
        if m:
            outside = (m.group(1) + " " + m.group(3)).strip()
            if outside:
                out.append(outside)
            out.append(m.group(2).strip())
        # "No — osmosis is passive" -> "No"
        m = re.match(r"^(yes|no|true|false)\b\s*[—–\-,:.]", p, re.I)
        if m:
            out.append(m.group(1))
        # "Differentiation and integration — they are inverse operations." -> leading clause
        m = re.match(r"^(.{3,}?)\s+[—–]\s+.+$", p)
        if m:
            out.append(m.group(1))
    seen, uniq = set(), []
    for v in out:
        k = v.strip().casefold()
        if k and k not in seen:
            seen.add(k)
            uniq.append(v.strip())
    return uniq


def is_boolean_answer(answer: str) -> bool:
    return boolean_value(answer) is not None


def boolean_value(answer: str) -> bool | None:
    m = re.match(r"^\s*(true|false|yes|no)\b\s*(?:$|[—–\-,:.!])", answer, re.I)
    if not m:
        return None
    return m.group(1).lower() in ("true", "yes")


def _score_one(expected: str, given: str, strip_accents: bool) -> float:
    en, gn = normalize(expected, strip_accents), normalize(given, strip_accents)
    if not gn:
        return 0.0
    if en == gn:
        return 1.0
    et, gt = _tokens(en), _tokens(gn)
    if " ".join(et) == " ".join(gt):
        return 1.0
    ek, gk = _keywords(et), _keywords(gt)
    if ek == gk:
        return 0.98
    char = _ratio(" ".join(ek).replace(" ", ""), " ".join(gk).replace(" ", ""))
    char_full = _ratio(en.replace(" ", ""), gn.replace(" ", ""))
    if max(len(en), len(gn)) <= 4:  # one wrong letter in a tiny answer is a different answer
        char, char_full = (char if char >= 0.99 else 0.0), (char_full if char_full >= 0.99 else 0.0)
    recall = _coverage(ek, gk)
    precision = _coverage(gk, ek)
    tok = 0.7 * recall + 0.3 * precision
    if sorted(ek) == sorted(gk):
        tok = max(tok, 0.97)
    score = max(char, 0.85 * char_full, tok)
    # Containment: the full expected answer is present, with a bit of extra text.
    if len(en) >= 3 and re.search(r"(?<!\w)" + re.escape(en) + r"(?!\w)", gn) and len(gn) <= 3 * len(en) + 15:
        score = max(score, 0.93)
    elif recall >= 0.999 and len(gk) <= 2 * len(ek) + 4:
        score = max(score, 0.9)
    return min(score, 1.0)


@dataclass
class Grade:
    score: float
    verdict: str  # "correct" | "close" | "wrong"
    matched: str
    note: str = ""

    def to_dict(self) -> dict:
        return {"score": round(self.score, 3), "verdict": self.verdict, "matched": self.matched, "note": self.note}


def similarity(expected: str, given: str, strip_accents: bool = True) -> tuple[float, str]:
    best, best_v = 0.0, expected
    for v in answer_variants(expected):
        s = _score_one(v, given, strip_accents)
        if s > best:
            best, best_v = s, v
    return best, best_v


def grade(expected: str, given: str, threshold: float = 0.75, strip_accents: bool = True,
          extra_answers: list[str] | None = None) -> Grade:
    given = (given or "").strip()
    if not given:
        return Grade(0.0, "wrong", expected, "No answer given")
    threshold = min(max(threshold, 0.3), 1.0)

    # Yes/no style answers are judged on polarity only.
    eb = boolean_value(expected)
    if eb is not None and normalize(expected) in {"true", "false", "yes", "no"}:
        gw = normalize(given).split()
        gb = True if gw and gw[0] in TRUE_WORDS else False if gw and gw[0] in FALSE_WORDS else None
        if gb is not None:
            return Grade(1.0 if gb == eb else 0.0, "correct" if gb == eb else "wrong", expected)

    candidates = [expected] + list(extra_answers or [])
    score, matched = 0.0, expected
    for c in candidates:
        s, m = similarity(c, given, strip_accents)
        if s > score:
            score, matched = s, m

    note = ""
    # Numbers must match exactly (years, ports, signal numbers...).
    exp_nums = set(_NUM.findall(normalize(matched)))
    giv_nums = set(_NUM.findall(" ".join(_tokens(normalize(given)))))
    if exp_nums and not exp_nums <= giv_nums:
        if score >= threshold:
            score = min(score, threshold - 0.01)
            note = "Check the numbers"
        if giv_nums and not (exp_nums & giv_nums) and len(exp_nums) == 1 and len(normalize(matched).split()) == 1:
            score = min(score, 0.2)  # a bare number that's simply wrong
    # Roman numerals in names (Elizabeth I vs Elizabeth II).
    exp_rom = set(_ROMAN.findall(matched.strip()[1:] if matched.strip().startswith("I ") else matched))
    giv_rom = set(_ROMAN.findall(given.upper()))
    if exp_rom and giv_rom and exp_rom != giv_rom and score >= threshold:
        score = min(score, threshold - 0.01)
        note = "Check the numeral"
    # Polarity: one side negated, the other not.
    en = set(_tokens(normalize(matched)))
    gn = set(_tokens(normalize(given)))
    if bool(en & NEGATIONS) != bool(gn & NEGATIONS) and score >= threshold:
        score = min(score, threshold - 0.01)
        note = note or "Watch the negation"
    # Without accent stripping, flag accent-only differences.
    if not note and score >= threshold and strip_accents and normalize(matched, False) != normalize(given, False) \
            and normalize(matched) == normalize(given):
        note = "Mind the accents"

    close_floor = max(threshold - 0.25, 0.35)
    verdict = "correct" if score >= threshold else "close" if score >= close_floor else "wrong"
    return Grade(score, verdict, matched, note)
