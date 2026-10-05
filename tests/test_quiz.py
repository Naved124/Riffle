from collections import Counter

from flashcard_viewer.extract import Card, extract_cards
from flashcard_viewer.quiz import answer_kind, build_quiz, grade_response


def _cards(samples, name):
    p = samples / name
    return extract_cards(p.read_text(encoding="utf-8-sig"), p.name).cards


def test_kinds():
    assert answer_kind("Yes") == "boolean"
    assert answer_kind("No — it is passive") == "boolean"
    assert answer_kind("chmod") == "short"
    assert answer_kind("A process that has finished executing but still has an entry in the table") == "long"


def test_mixed_types_are_suitable(samples):
    cards = _cards(samples, "08-signals-quiz-typescript.tsx")
    seen = Counter()
    for seed in range(40):
        for q in build_quiz(cards, count=0, seed=seed):
            seen[q["type"]] += 1
            if q["type"] == "mc":
                assert len(q["choices"]) == 4 and q["choices"][q["correctIndex"]] == q["answer"]
                assert len({c.casefold() for c in q["choices"]}) == 4
            if q["type"] == "tf":
                assert isinstance(q["truth"], bool)
            if q["answer"].startswith("A process that has finished"):
                assert q["type"] in ("mc", "tf")  # never ask to type a paragraph
            if q["answer"] in ("Yes", "False"):
                assert q["type"] in ("tf", "typed")
    assert set(seen) == {"typed", "mc", "tf"}


def test_quiz_artifact_uses_its_own_options(samples):
    cards = _cards(samples, "11-docker-mcq-quiz.html")
    for seed in range(10):
        for q in build_quiz(cards, count=0, types=("mc",), seed=seed):
            card = next(c for c in cards if c.front == q["prompt"])
            assert set(q["choices"]) == set(card.choices)


def test_respects_enabled_types_and_count(samples):
    cards = _cards(samples, "01-linux-commands-flip.html")
    qs = build_quiz(cards, count=5, types=("typed",), seed=1)
    assert len(qs) == 5 and {q["type"] for q in qs} == {"typed"}


def test_weak_cards_first(samples):
    cards = _cards(samples, "01-linux-commands-flip.html")
    weak = [cards[7].key, cards[3].key]
    qs = build_quiz(cards, count=3, weak_keys=weak, seed=3)
    assert [q["key"] for q in qs[:2]] == weak
    only = build_quiz(cards, weak_keys=weak, only_weak=True, seed=3)
    assert {q["key"] for q in only} == set(weak)


def test_tiny_deck_falls_back_to_typed():
    qs = build_quiz([Card("2+2", "4")], types=("mc",), seed=0)
    assert qs[0]["type"] in ("typed", "mc")
    if qs[0]["type"] == "mc":  # numeric answers get generated distractors
        assert qs[0]["choices"][qs[0]["correctIndex"]] == "4"


def test_empty_deck():
    assert build_quiz([]) == []


def test_grade_response():
    mc = {"type": "mc", "correctIndex": 2, "answer": "x"}
    assert grade_response(mc, 2)["verdict"] == "correct"
    assert grade_response(mc, 1)["verdict"] == "wrong"
    tf = {"type": "tf", "truth": False, "answer": "x"}
    assert grade_response(tf, False)["verdict"] == "correct"
    assert grade_response(tf, "true")["verdict"] == "wrong"
    typed = {"type": "typed", "answer": "The mitochondria"}
    assert grade_response(typed, "mitochondria")["verdict"] == "correct"
