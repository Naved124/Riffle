"""Build mixed quizzes from extracted cards and grade responses.

Each card gets the question type that suits it:

* yes/no and true/false answers -> true/false
* short answers (terms, commands, numbers) -> mostly typed, sometimes MC / TF
* long, explanatory answers -> multiple choice (typing them is unfair) or TF
* cards that came with their own options (quiz artifacts) -> mostly MC

With ``vary=True`` a card can also be asked another way, built from the card's own text (no AI):

* reverse: show the answer, ask for the front ("which question has this answer?");
* cloze: blank out a rare word of the answer or explanation ("fill in the blank");
* explain: show the explanation, ask which answer it goes with.
"""

from __future__ import annotations

import math
import random
import re

from .extract import Card
from .similarity import boolean_value, grade, normalize

__all__ = ["build_quiz", "grade_response", "answer_kind"]

TYPES = ("typed", "mc", "tf")
STYLE_WEIGHTS = {"normal": 0.5, "reverse": 0.2, "cloze": 0.2, "explain": 0.1}
BLANK = "_____"
ASK = {
    "reverse": "Work backwards: which of these has this answer?",
    "reverse-typed": "Work backwards: what is on the front of this card?",
    "cloze": "Fill in the blank",
    "explain": "Which answer goes with this explanation?",
}
_STOP = frozenset("""
    about above after again against also although among another because been before being below between both
    cannot could does doing down during each either every from further have having here into itself just like
    made make makes many more most much must only other ours over same should since some such than that their
    theirs them then there these they this those though through thus under until upon very were what when where
    which while whom whose will with within without would your yours
    across always around called usually often never include includes including known mainly mostly plus minus
    something thing things using used uses kind kinds type types part parts
""".split())
_WORD_RX = re.compile(r"[^\W\d_]+(?:['’\-][^\W\d_]+)*")
# Maths, code, tags and links are never blanked (or counted as words).
_SKIP_RX = re.compile(r"\$\$.+?\$\$|\$[^$\n]+\$|`[^`]*`|<[^>]*>|https?://\S+", re.S)


def answer_kind(answer: str) -> str:
    if boolean_value(answer) is not None:
        return "boolean"
    words = len(answer.split())
    if words <= 4 and len(answer) <= 32:
        return "short"
    if words <= 12:
        return "medium"
    return "long"


def _is_numeric(s: str) -> bool:
    return bool(re.fullmatch(r"[\d\s.,%/:+\-]+[a-zA-Z²³/%°]*", s.strip()))


def _distractors(card: Card, pool: list[Card], rng: random.Random, k: int = 3) -> list[str]:
    answer_n = normalize(card.back)
    if card.choices:
        own = [c for c in card.choices if normalize(c) != answer_n]
        if len(own) >= k:
            return rng.sample(own, k)
    kind = answer_kind(card.back)
    numeric = _is_numeric(card.back)
    scored = []
    seen = {answer_n}
    for other in pool:
        b = other.back
        nb = normalize(b)
        if not nb or nb in seen or other.key == card.key:
            continue
        if boolean_value(b) is not None:
            continue
        seen.add(nb)
        score = 0.0
        if _is_numeric(b) == numeric:
            score += 2
        if answer_kind(b) == kind:
            score += 1
        if other.category and other.category == card.category:
            score += 1
        score -= abs(math.log((len(b) + 5) / (len(card.back) + 5)))
        scored.append((score + rng.random() * 0.75, b))
    scored.sort(reverse=True)
    picks = [b for _, b in scored[: k + 2]]
    rng.shuffle(picks)
    picks = picks[:k]
    if card.choices and len(picks) < k:
        picks = [c for c in card.choices if normalize(c) != answer_n][: k - len(picks)] + picks
    if numeric and len(picks) < k:
        m = re.search(r"\d+", card.back)
        if m:
            n = int(m.group(0))
            for d in (1, -1, 2, 10, -2):
                fake = card.back.replace(m.group(0), str(n + d), 1)
                if normalize(fake) not in seen and len(picks) < k:
                    picks.append(fake)
                    seen.add(normalize(fake))
    return picks


def _choose_type(card: Card, enabled: set[str], rng: random.Random, n_distractors: int) -> str:
    kind = answer_kind(card.back)
    if kind == "boolean":
        weights = {"tf": 1.0, "typed": 0.15}
    elif card.choices:
        weights = {"mc": 0.75, "typed": 0.25 if kind == "short" else 0.0, "tf": 0.1}
    elif kind == "short":
        weights = {"typed": 0.6, "mc": 0.25, "tf": 0.15}
    elif kind == "medium":
        weights = {"typed": 0.3, "mc": 0.45, "tf": 0.25}
    else:
        weights = {"mc": 0.7, "tf": 0.3}
    if n_distractors < 2:
        weights.pop("mc", None)
    if n_distractors < 1 and kind != "boolean":
        weights.pop("tf", None)
    weights = {t: w for t, w in weights.items() if t in enabled and w > 0}
    if not weights:
        # Fall back to whatever is enabled and feasible.
        for t in ("typed", "mc", "tf"):
            if t in enabled and (t != "mc" or n_distractors >= 2) and (t != "tf" or n_distractors or kind == "boolean"):
                return t
        return "typed"
    r = rng.random() * sum(weights.values())
    for t, w in weights.items():
        r -= w
        if r <= 0:
            return t
    return next(iter(weights))


# -- other ways to ask a card ---------------------------------------------------------------------
def _masked(text: str) -> str:
    """``text`` with maths, code, tags and links blanked to spaces (same length, so offsets match)."""
    return _SKIP_RX.sub(lambda m: " " * len(m.group(0)), text)


def _words(text: str) -> list[re.Match]:
    return list(_WORD_RX.finditer(_masked(text)))


def _content_words(text: str) -> set[str]:
    return {m.group(0).casefold() for m in _words(text) if len(m.group(0)) >= 4 and m.group(0).casefold() not in _STOP}


def _cloze(card: Card, df: dict[str, int], rng: random.Random):
    """Blank a rare, longer word in the card's answer (or else its explanation): (sentence, word, source)
    or None. Rare words are the subject-specific ones ("pyruvate", "nucleotides"), not filler."""
    front_words = _content_words(card.front)
    for source in (card.back, card.explanation):
        if len(source.split()) < 5:
            continue
        cands = {}
        for m in _words(source):
            w = m.group(0)
            f = w.casefold()
            if len(w) < 5 or f in _STOP or f in front_words or f in cands:
                continue
            cands[f] = w
        if not cands:
            continue
        ranked = sorted(cands, key=lambda f: (df.get(f, 0), -len(f), rng.random()))
        word = cands[ranked[1] if len(ranked) > 1 and rng.random() < 0.3 else ranked[0]]  # mostly the best word
        # Blank every occurrence, so a second one doesn't give the answer away.
        out, last = [], 0
        for m in _words(source):
            if m.group(0).casefold() == word.casefold():
                out += [source[last:m.start()], BLANK]
                last = m.end()
        out.append(source[last:])
        return "".join(out), word, source
    return None


def _shape_like(word: str, like: str) -> str:
    """Match a distractor's capitalisation to the answer's, so case doesn't give the answer away."""
    if word.isupper() or like.isupper():
        return word
    return word[:1].upper() + word[1:] if like[:1].isupper() else word.lower()


def _cloze_distractors(word: str, source: str, vocab: dict[str, str], rng: random.Random, k: int = 3) -> list[str]:
    ans = word.casefold()
    used = _content_words(source)
    scored = []
    for f, w in vocab.items():
        if f in used or f[:5] == ans[:5]:
            continue
        score = -abs(len(f) - len(ans)) / 3 + (1.0 if w.isupper() == word.isupper() else 0.0)
        scored.append((score + rng.random() * 0.75, _shape_like(w, word)))
    scored.sort(reverse=True)
    picks = [w for _, w in scored[: k + 2]]
    rng.shuffle(picks)
    return picks[:k]


def _front_distractors(card: Card, pool: list[Card], rng: random.Random, k: int = 3) -> list[str]:
    seen = {normalize(card.front)}
    scored = []
    for other in pool:
        nf = normalize(other.front)
        if not nf or nf in seen:
            continue
        seen.add(nf)
        score = 1.0 if other.category and other.category == card.category else 0.0
        score -= abs(math.log((len(other.front) + 5) / (len(card.front) + 5)))
        scored.append((score + rng.random() * 0.75, other.front))
    scored.sort(reverse=True)
    picks = [f for _, f in scored[: k + 2]]
    rng.shuffle(picks)
    return picks[:k]


def _pick(weights: dict[str, float], rng: random.Random) -> str:
    r = rng.random() * sum(weights.values())
    for t, w in weights.items():
        r -= w
        if r <= 0:
            return t
    return next(iter(weights))


def _varied(card: Card, pool: list[Card], enabled: set[str], rng: random.Random, ctx: dict) -> dict | None:
    """Ask ``card`` another way, or None to ask it normally."""
    kind = answer_kind(card.back)
    options: dict[str, float] = {"normal": STYLE_WEIGHTS["normal"]}
    unique_back = ctx["backs"].get(normalize(card.back), 0) == 1
    if kind != "boolean" and unique_back and ({"mc", "typed"} & enabled):
        options["reverse"] = STYLE_WEIGHTS["reverse"]
    if {"mc", "typed"} & enabled and (len(card.back.split()) >= 5 or len(card.explanation.split()) >= 5):
        options["cloze"] = STYLE_WEIGHTS["cloze"]
    if kind != "boolean" and len(card.explanation.split()) >= 4:
        back_words = {w for w in _content_words(card.back)} | ({normalize(card.back)} if len(card.back) >= 2 else set())
        expl = normalize(card.explanation)
        if not any(w in expl for w in back_words):
            options["explain"] = STYLE_WEIGHTS["explain"]
    style = _pick(options, rng)
    if style == "normal":
        return None

    q = {"style": style, "front": card.front, "hint": card.hint, "category": card.category, "explanation": card.explanation}
    if style == "reverse":
        ds = _front_distractors(card, pool, rng)
        weights = {}
        if "mc" in enabled and len(ds) >= 2:
            weights["mc"] = 0.7
        if "typed" in enabled and answer_kind(card.front) == "short" and "?" not in card.front:
            weights["typed"] = 0.3
        if not weights:
            return None
        qtype = _pick(weights, rng)
        q.update(type=qtype, prompt=card.back, answer=card.front, ask=ASK["reverse" if qtype == "mc" else "reverse-typed"])
        if qtype == "mc":
            q["choices"] = ds[:3] + [card.front]
            rng.shuffle(q["choices"])
            q["correctIndex"] = q["choices"].index(card.front)
        return q
    if style == "cloze":
        made = _cloze(card, ctx["df"], rng)
        if not made:
            return None
        sentence, word, source = made
        ds = _cloze_distractors(word, source, ctx["vocab"], rng)
        weights = {}
        if "typed" in enabled:
            weights["typed"] = 0.6
        if "mc" in enabled and len(ds) >= 3:
            weights["mc"] = 0.4
        if not weights:
            return None
        qtype = _pick(weights, rng)
        # The card's question stays visible as context; the full sentence is shown after answering.
        q.update(type=qtype, prompt=sentence, answer=word, ask=ASK["cloze"], context=card.front,
                 explanation=source if source == card.explanation else " ".join(x for x in (source, card.explanation) if x))
        if qtype == "mc":
            q["choices"] = ds[:3] + [word]
            rng.shuffle(q["choices"])
            q["correctIndex"] = q["choices"].index(word)
        return q
    # explain: the explanation is the clue; the card's question is shown after answering.
    q.update(prompt=card.explanation, answer=card.back, ask=ASK["explain"], explanation=card.front)
    return q


def build_quiz(cards: list[Card], count: int = 10, types=TYPES, weak_keys: list[str] | None = None,
               only_weak: bool = False, shuffle: bool = True, seed: int | None = None, vary: bool = False) -> list[dict]:
    """Return a list of question dicts ready for the UI (JSON-serialisable)."""
    rng = random.Random(seed)
    enabled = {t for t in types if t in TYPES} or {"typed"}
    pool = [c for c in cards if c.front.strip() and c.back.strip()]
    if not pool:
        return []
    weak_keys = weak_keys or []
    if only_weak and weak_keys:
        chosen = [c for c in pool if c.key in set(weak_keys)] or pool
    else:
        chosen = list(pool)
    if shuffle:
        rng.shuffle(chosen)
        # Weak cards first so a short quiz still covers them.
        if weak_keys:
            order = {k: i for i, k in enumerate(weak_keys)}
            chosen.sort(key=lambda c: order.get(c.key, len(order)))
    if count and count > 0:
        chosen = chosen[:count]

    ctx: dict = {}
    if vary:
        backs: dict[str, int] = {}
        df: dict[str, int] = {}
        vocab: dict[str, str] = {}
        for c in pool:
            backs[normalize(c.back)] = backs.get(normalize(c.back), 0) + 1
            for text in (c.front, c.back, c.explanation):
                for m in _words(text):
                    w = m.group(0)
                    if len(w) >= 4 and w.casefold() not in _STOP:
                        vocab.setdefault(w.casefold(), w)
            for f in _content_words(f"{c.front} {c.back} {c.explanation}"):
                df[f] = df.get(f, 0) + 1
        ctx = {"backs": backs, "df": df, "vocab": vocab}

    questions = []
    for i, card in enumerate(chosen):
        distractors = _distractors(card, pool, rng, 3)
        varied = _varied(card, pool, enabled, rng, ctx) if vary else None
        if varied and varied.get("type"):
            questions.append({"id": i, "key": card.key, **varied})
            continue
        qtype = _choose_type(card, enabled, rng, len(distractors))
        q = {
            "id": i,
            "key": card.key,
            "front": card.front,
            "type": qtype,
            "prompt": card.front,
            "answer": card.back,
            "hint": card.hint,
            "explanation": card.explanation,
            "category": card.category,
        }
        if varied:  # "explain": same answer and question types as usual, different clue
            q.update(varied)
        if qtype == "mc":
            opts = distractors[:3] + [card.back]
            rng.shuffle(opts)
            q["choices"] = opts
            q["correctIndex"] = opts.index(card.back)
        elif qtype == "tf":
            b = boolean_value(card.back)
            if b is not None:
                # The card itself is a yes/no question.
                yes_no = re.match(r"\s*(yes|no)\b", card.back, re.I) is not None
                q["choices"] = ["Yes", "No"] if yes_no else ["True", "False"]
                q["statement"] = ""
                q["truth"] = b
            else:
                truthful = rng.random() < 0.5 or not distractors
                shown = card.back if truthful else rng.choice(distractors)
                q["choices"] = ["True", "False"]
                q["statement"] = shown
                q["truth"] = truthful
        questions.append(q)
    return questions


def grade_response(question: dict, response, threshold: float = 0.75, strip_accents: bool = True) -> dict:
    qtype = question.get("type")
    if qtype == "mc":
        try:
            ok = int(response) == int(question["correctIndex"])
        except (TypeError, ValueError):
            ok = False
        return {"verdict": "correct" if ok else "wrong", "score": 1.0 if ok else 0.0, "matched": question["answer"], "note": ""}
    if qtype == "tf":
        if isinstance(response, str):
            r = response.strip().lower()
            val = True if r in ("true", "yes", "t", "y") else False if r in ("false", "no", "f", "n") else None
        else:
            val = bool(response) if response is not None else None
        ok = val is not None and val == bool(question["truth"])
        return {"verdict": "correct" if ok else "wrong", "score": 1.0 if ok else 0.0, "matched": question["answer"], "note": ""}
    g = grade(question["answer"], str(response or ""), threshold=threshold, strip_accents=strip_accents)
    return g.to_dict()
