import shutil
from datetime import date, datetime, timedelta

from flashcard_viewer.config import LibraryState, Settings
from flashcard_viewer.library import Library, deck_id_for, guess_title
from flashcard_viewer.render import render_deck
from flashcard_viewer.stats import Stats


def _ts(d: date, hour=12):
    return datetime.combine(d, datetime.min.time()).timestamp() + hour * 3600


def test_streak_and_activity(tmp_path):
    s = Stats(tmp_path / "s.db")
    today = date(2026, 3, 10)
    for back in (0, 1, 2, 5, 6):
        s.record_study("d", 120, started_at=_ts(today - timedelta(days=back)))
    st = s.streak(today)
    assert st["current"] == 3 and st["longest"] == 3 and st["studiedToday"]
    act = s.activity(days=7, today=today)
    assert len(act) == 7 and act[-1]["seconds"] == 120 and act[-4]["seconds"] == 0


def test_streak_survives_until_end_of_today(tmp_path):
    s = Stats(tmp_path / "s.db")
    today = date(2026, 3, 10)
    s.record_study("d", 120, started_at=_ts(today - timedelta(days=1)))
    assert s.streak(today)["current"] == 1


def test_quiz_and_weak_cards(tmp_path):
    s = Stats(tmp_path / "s.db")
    s.record_quiz("d", [{"key": "a", "front": "A?", "verdict": "wrong"}, {"key": "b", "front": "B?", "verdict": "correct"},
                        {"key": "c", "front": "C?", "verdict": "close"}], 30)
    s.record_quiz("d", [{"key": "a", "front": "A?", "verdict": "wrong"}, {"key": "b", "front": "B?", "verdict": "correct"}])
    weak = s.weak_cards("d")
    assert [w["key"] for w in weak] == ["a", "c"]
    summ = s.deck_summary("d", ["a", "b", "c", "x"])
    assert summ["quizzes"] == 2 and summ["mastered"] == 1 and summ["progress"] == 0.25
    assert abs(summ["bestScore"] - 0.5) < 1e-9
    csvs = s.export_csv()
    assert csvs["card_results.csv"].count("\n") == 6
    dump = s.dump()
    s2 = Stats(tmp_path / "s2.db")
    s2.load(dump)
    assert len(s2.weak_cards("d")) == 2
    s.reset_deck("d")
    assert s.deck_summary("d")["quizzes"] == 0


def test_library_scan_import_search(tmp_path, samples):
    folder = tmp_path / "decks"
    shutil.copytree(samples, folder)
    (folder / "sub").mkdir()
    (folder / "node_modules").mkdir()
    (folder / "node_modules" / "junk.html").write_text("<p>x</p>")
    settings = Settings(tmp_path / "settings.json")
    settings.update({"library": {"folders": [str(folder)], "mainFolder": str(folder)}})
    lib = Library(settings, LibraryState(tmp_path / "lib.json"))
    decks = lib.scan()
    assert len(decks) == 13
    by_name = {d.filename: d for d in decks}
    assert by_name["04-aws-fragment.html"].kind == "fragment"
    assert by_name["03-spanish-vocab-react.jsx"].kind == "react"
    assert by_name["01-linux-commands-flip.html"].title == "Linux Commands Flashcards"
    assert by_name["03-spanish-vocab-react.jsx"].title == "Spanish Vocabulary"
    assert by_name["03-spanish-vocab-react.jsx"].emoji == "🇪🇸"
    # search by name and by content (accent-insensitive)
    hits = {h["id"] for h in lib.search("pina")}
    assert by_name["03-spanish-vocab-react.jsx"].id in hits
    hits = {h["id"] for h in lib.search("magna carta")}
    assert hits == {by_name["06-history-table-dl.html"].id}
    # import + duplicate naming
    p1 = lib.import_file("new deck.html", b"<p>Q: a?<br>A: b</p>")
    p2 = lib.import_file("new deck.html", b"<p>different</p>")
    assert p1.name == "new deck.html" and p2.name == "new deck (2).html"
    assert len(lib.scan()) == 15
    # manual card override
    did = by_name["09-pomodoro-no-cards.html"].id
    lib.save_cards(did, [{"front": "Work minutes?", "back": "25"}])
    assert [c.back for c in lib.cards(did)] == ["25"] and lib.get(did).card_count == 1
    lib.reset_cards(did)
    assert lib.cards(did) == []


def test_render_wraps(samples):
    frag = render_deck((samples / "04-aws-fragment.html").read_text(), "fragment", "04-aws-fragment.html", "AWS")
    assert frag.startswith("<!DOCTYPE html>") and "/__fv/deck-helper.js" in frag and "<title>AWS</title>" in frag
    full = render_deck((samples / "01-linux-commands-flip.html").read_text(), "html", "01.html")
    assert full.index("deck-helper.js") < full.index("<title>")
    react = render_deck("", "react", "03 x.jsx")
    assert "/__source/03%20x.jsx" in react


def test_deck_id_stable(tmp_path):
    f = tmp_path / "a.html"
    f.write_text("x")
    assert deck_id_for(f) == deck_id_for(str(f))
    assert guess_title("<html><title> Hi &amp; bye </title>", "x.html") == "Hi & bye"
    assert guess_title("<p>none</p>", "02-my_deck.html") == "My deck"
