"""Build mixed quizzes from extracted cards and grade responses.

Each card gets the question type that suits it:

* yes/no and true/false answers -> true/false
* short answers (terms, commands, numbers) -> mostly typed, sometimes MC / TF
* long, explanatory answers -> multiple choice (typing them is unfair) or TF
* cards that came with their own options (quiz artifacts) -> mostly MC
"""

from __future__ import annotations

import math
import random
import re

from .extract import Card
from .similarity import boolean_value, grade, normalize

__all__ = ["build_quiz", "grade_response", "answer_kind"]

TYPES = ("typed", "mc", "tf")


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


def build_quiz(cards: list[Card], count: int = 10, types=TYPES, weak_keys: list[str] | None = None,
               only_weak: bool = False, shuffle: bool = True, seed: int | None = None) -> list[dict]:
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

    questions = []
    for i, card in enumerate(chosen):
        distractors = _distractors(card, pool, rng, 3)
        qtype = _choose_type(card, enabled, rng, len(distractors))
        q = {
            "id": i,
            "key": card.key,
            "type": qtype,
            "prompt": card.front,
            "answer": card.back,
            "hint": card.hint,
            "explanation": card.explanation,
            "category": card.category,
        }
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
