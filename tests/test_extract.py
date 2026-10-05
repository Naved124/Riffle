import pytest

from flashcard_viewer.extract import card_key, decode_bytes, extract_cards, is_script_source
from flashcard_viewer.jsparse import UNKNOWN, find_literal_arrays, parse_literal_at

# filename -> (expected card count, a (front, back) pair that must be present)
EXPECTED = {
    "01-linux-commands-flip.html": (10, ("Redirect stdin from a file into sort", "sort < input.txt")),
    "02-biology-js-array.html": (12, ('Which organelle is called the cell\'s "post office"?', "The Golgi apparatus")),
    "03-spanish-vocab-react.jsx": (11, ("la piña", "the pineapple")),
    "04-aws-fragment.html": (10, ("Managed Kubernetes", "Amazon EKS")),
    "05-calculus-json-cdn.html": (8, ("Derivative of $\\sin x$", "$\\cos x$")),
    "06-history-table-dl.html": (10, ("Fall of the Berlin Wall", "1989")),
    "07 networking Q&A notes.html": (10, ("Command to test reachability of a host?", "ping")),
    "08-signals-quiz-typescript.tsx": (8, ("Default signal sent by `kill` with no options?", "SIGTERM (15)")),
    "09-pomodoro-no-cards.html": (0, None),
    "10-日本語-kana.HTM": (10, ("ふ", "fu (hu)")),
    "11-docker-mcq-quiz.html": (5, ("What file is used to define multi-container applications?", "docker-compose.yml")),
    "12-git-tuple-rows.html": (6, ("Which command stages file.txt?", "git add file.txt")),
}


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_samples(samples, name):
    count, pair = EXPECTED[name]
    path = samples / name
    result = extract_cards(decode_bytes(path.read_bytes()), path.name)
    assert len(result.cards) == count, [(c.front, c.back) for c in result.cards]
    if pair:
        assert pair in [(c.front, c.back) for c in result.cards]
    for c in result.cards:
        assert c.front.strip() and c.back.strip()
        assert "<" not in c.front or "$" in c.front or "<" in pair[0] if pair else True


def test_every_sample_has_an_expectation(samples):
    assert {p.name for p in samples.iterdir() if p.suffix != ".md"} == set(EXPECTED)


def test_quiz_artifact_keeps_choices_and_explanation(samples):
    p = samples / "11-docker-mcq-quiz.html"
    cards = extract_cards(p.read_text(), p.name).cards
    first = cards[0]
    assert first.back == "CMD"
    assert first.choices == ["RUN", "CMD", "COPY", "EXPOSE"]
    assert "CMD provides defaults" in first.explanation
    assert cards[4].back == "Final image size"  # correctIndex


def test_hints_and_categories(samples):
    p = samples / "02-biology-js-array.html"
    cards = extract_cards(p.read_text(), p.name).cards
    assert cards[0].hint == "It makes ATP"
    assert {c.category for c in cards} == {"Structure", "Genetics", "Processes"}
    assert cards[6].front == "What is a codon?"  # <b> stripped
    assert "\n" in cards[2].back  # template literal keeps its line break


def test_jsx_categories_from_object_keys(samples):
    p = samples / "03-spanish-vocab-react.jsx"
    cards = extract_cards(p.read_text(), p.name).cards
    assert {c.category for c in cards} == {"animals", "food", "phrases"}


def test_labels_are_not_part_of_card_text(samples):
    p = samples / "01-linux-commands-flip.html"
    cards = extract_cards(p.read_text(), p.name).cards
    assert not any(c.front.startswith("Question") or c.back.startswith("Answer") for c in cards)


def test_bom_and_crlf_decoding(samples):
    raw = (samples / "07 networking Q&A notes.html").read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf") and b"\r\n" in raw
    text = decode_bytes(raw)
    assert not text.startswith("﻿") and "\r" not in text


def test_script_source_detection():
    assert is_script_source("a.jsx", "")
    assert is_script_source("a.txt", "import React from 'react'\nexport default function A(){}")
    assert not is_script_source("a.html", "<!doctype html><script>import x from 'y'</script>")


def test_card_key_is_stable_and_normalised():
    assert card_key("  What is DNA? ") == card_key("what is dna?")
    assert card_key("a") != card_key("b")


def test_jsparse_tolerates_odd_values():
    src = """const x = [
      { q: 'It\\'s', a: "say \\"hi\\"", icon: <Brain size={4} />, fn: () => { return [1, 2]; }, n: -1.5e3, h: 0x1f },
      // comment
      { q: `multi
line ${name}`, a: 'b', ...rest, short, },
    ];"""
    (value, start, end, label), = list(find_literal_arrays(src))
    assert label == "x"
    assert value[0]["q"] == "It's" and value[0]["a"] == 'say "hi"'
    assert value[0]["icon"] is UNKNOWN and value[0]["fn"] is UNKNOWN
    assert value[0]["n"] == -1500 and value[0]["h"] == 31
    assert value[1]["q"] == "multi\nline ${name}"
    assert value[1]["short"] is UNKNOWN


def test_jsparse_json_compat():
    v, _ = parse_literal_at('{"a": [1, 2.5, true, null, "\\u00e9"]}', 0)
    assert v == {"a": [1, 2.5, True, None, "é"]}


def test_unrelated_arrays_are_ignored():
    html = """<script>
      const colors = [{name: 'red', hex: '#f00'}, {name: 'red', hex: '#f00'}];
      const settings = [{id: 1, enabled: true}, {id: 2, enabled: false}];
    </script><p>Hello</p>"""
    assert extract_cards(html, "x.html").cards == []


def test_generic_two_field_schema():
    html = "<script>const words = [{fr: 'chat', en: 'cat'}, {fr: 'chien', en: 'dog'}, {fr: 'oiseau', en: 'bird'}];</script>"
    cards = extract_cards(html, "x.html").cards
    assert [(c.front, c.back) for c in cards] == [("chat", "cat"), ("chien", "dog"), ("oiseau", "bird")]


def test_tuple_rows_use_topic_and_note_columns(samples):
    cards = extract_cards((samples / "12-git-tuple-rows.html").read_text(encoding="utf-8")).cards
    by_front = {c.front: c for c in cards}
    c = by_front["Create and switch to a branch called dev?"]
    assert c.category == "Branches"
    assert c.explanation == "Older form: git checkout -b dev"
    assert by_front["Which command stages file.txt?"].explanation == ""


def test_tuple_rows_need_varied_columns():
    # Config-like rows where no two columns vary are not a deck.
    src = '<script>const SIZES = [["sm", "small"], ["sm", "small"], ["sm", "small"]];</script>'
    assert extract_cards(src).cards == []
