import json
from pathlib import Path

import pytest

from flashcard_viewer.config import LibraryState, Settings
from flashcard_viewer.customdeck import normalize_deck, parse_custom_deck, to_plain
from flashcard_viewer.extract import extract_cards
from flashcard_viewer.library import Library, deck_id_for

SAMPLE = "13-deck-editor-chemistry.html"
PLAIN_CASES = json.loads((Path(__file__).parent / "plain_cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("md,plain", PLAIN_CASES)
def test_to_plain(md, plain):
    # tests/js/deckgen.test.mjs runs the same cases against toPlain() in deckgen.js
    assert to_plain(md) == plain


def test_sample_deck_cards(samples):
    text = (samples / SAMPLE).read_text(encoding="utf-8")
    result = extract_cards(text, SAMPLE)
    assert result.methods == ["deck-editor"]
    cards = {c.front: c for c in result.cards}
    assert len(result.cards) == 8  # the unfinished card is skipped
    water = cards["Chemical formula of water?"]
    assert (water.back, water.hint, water.category) == ("$H_2O$", "Two hydrogens", "Molecules")
    assert water.explanation == "One oxygen atom bonded to two hydrogen atoms."
    gas = cards["Which gas do plants absorb for photosynthesis?"]
    assert gas.back == "Carbon dioxide"
    assert gas.choices == ["Oxygen", "Carbon dioxide", "Nitrogen", "Helium"]
    assert cards["What does this flask hold?\ngreen liquid"].back == "A green solution"
    # "</script>" in a card can't break out of the data block
    assert cards["Text that tries to close the script"].back == "</script><b>bold?</b> <!-- stays text -->"
    assert "</script><b>" not in text


def test_sample_deck_drops_unused_images(samples):
    deck = parse_custom_deck((samples / SAMPLE).read_text(encoding="utf-8"))
    assert list(deck["images"]) == ["flask01"]


def test_parse_rejects_other_decks(samples):
    assert parse_custom_deck((samples / "05-calculus-json-cdn.html").read_text(encoding="utf-8")) is None
    assert parse_custom_deck('<script id="fv-deck-data" type="application/json">{"format": "other"}</script>') is None
    assert parse_custom_deck('<script id="fv-deck-data" type="application/json">{broken</script>') is None


def test_normalize_sanitizes():
    d = normalize_deck({
        "title": "  A \n title ", "cards": [
            {"type": "mcq", "front": "q", "choices": ["a", "b"], "correct": 5},
            {"type": "mcq", "front": "q", "choices": ["a", "b"], "correct": True},
            {"type": "weird", "front": "f", "back": "b", "extra": "dropped"},
            "not a card",
        ],
        "images": {"ok": "data:image/png;base64,AAAA", "svg": "data:image/svg+xml;base64,AAAA",
                   "js": "javascript:alert(1)", "bad id!": "data:image/png;base64,AAAA"},
    })
    assert d["title"] == "A title"
    assert [c["correct"] for c in d["cards"][:2]] == [0, 0]
    assert d["cards"][2] == {"type": "basic", "front": "f", "back": "b", "hint": "", "explanation": "", "category": ""}
    assert len(d["cards"]) == 3
    assert list(d["images"]) == ["ok"]


def _library(tmp_path, samples=None):
    folder = tmp_path / "decks"
    folder.mkdir()
    if samples:
        for name in (SAMPLE, "01-linux-commands-flip.html"):
            (folder / name).write_bytes((samples / name).read_bytes())
    settings = Settings(tmp_path / "settings.json")
    settings.update({"library": {"folders": [str(folder)], "mainFolder": str(folder)}})
    lib = Library(settings, LibraryState(tmp_path / "lib.json"))
    lib.scan()
    return lib, folder


def test_library_reads_editor_decks(tmp_path, samples):
    lib, folder = _library(tmp_path, samples)
    info = lib.get(deck_id_for(folder / SAMPLE))
    assert info.custom and info.title == "Chemistry basics" and info.emoji == "🧪"
    assert info.card_count == 8 and info.methods == ["deck-editor"]
    assert not lib.get(deck_id_for(folder / "01-linux-commands-flip.html")).custom
    # card text is searchable even though the page renders it with JavaScript
    assert {h["id"] for h in lib.search("photosynthesis")} == {info.id}
    assert lib.custom_deck(info.id)["cards"][0]["front"] == "Chemical formula of **water**?"


def test_create_and_save_editor_deck(tmp_path, samples):
    lib, folder = _library(tmp_path, samples)
    html = (samples / SAMPLE).read_text(encoding="utf-8")
    with pytest.raises(ValueError):
        lib.create_custom_deck("x.html", "<html><body>Q: a A: b</body></html>")
    path = lib.create_custom_deck("Chemistry basics.html", html)
    assert path.parent == folder and path.name == "Chemistry basics.html"
    lib.scan()
    did = deck_id_for(path)
    lib.save_cards(did, [{"front": "override", "back": "x"}])
    assert lib.has_override(did)

    edited = html.replace("Chemistry basics", "Chemistry 101")
    info = lib.save_custom_deck(did, edited)
    assert info.id == did and info.title == "Chemistry 101"
    assert path.read_text(encoding="utf-8") == edited
    assert not lib.has_override(did)  # the file holds the cards now
    assert not list(folder.glob(".tmp-*"))


def test_save_refuses_other_decks(tmp_path, samples):
    lib, folder = _library(tmp_path, samples)
    html = (samples / SAMPLE).read_text(encoding="utf-8")
    other = folder / "01-linux-commands-flip.html"
    before = other.read_bytes()
    with pytest.raises(PermissionError):
        lib.save_custom_deck(deck_id_for(other), html)
    with pytest.raises(ValueError):
        lib.save_custom_deck(deck_id_for(folder / SAMPLE), "<p>not an editor deck</p>")
    with pytest.raises(KeyError):
        lib.save_custom_deck("nope", html)
    assert other.read_bytes() == before
