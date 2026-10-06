import pytest

from flashcard_viewer.similarity import answer_variants, grade

CORRECT = [
    ("The mitochondria", "mitochondria"),
    ("The mitochondria", "mitocondria"),       # typo
    ("Amazon S3", "s3"),                       # brand prefix optional
    ("SIGTERM (15)", "sigterm"),               # parenthetical alternative
    ("SIGTERM (15)", "15"),
    ("ls -la", "ls -al"),                      # flag order
    ("127.0.0.1 / localhost", "localhost"),    # slash alternatives
    ("Translates domain names into IP addresses", "it translates domain names to ip addresses"),
    ("False", "no"),
    ("No — osmosis is passive transport.", "no"),
    ("Niccolò Machiavelli", "niccolo machiavelli"),  # accents
    ("$\\cos x$", "cos x"),                    # LaTeX
    ("Chloroplast", "chloroplasts"),
    ("1", "one"),
    ("grep -r \"TODO\" .", "grep -r TODO ."),
]
NOT_CORRECT = [
    ("22", "23"),
    ("1989", "1988"),
    ("the dog", "the cat"),
    ("ls -la", "ls"),
    ("Elizabeth I", "Elizabeth II"),
    ("Is safe", "is not safe"),
    ("-p", "-v"),
    ("CMD", "RUN"),
    ("Stateful", "stateless"),
    ("False", "true"),
    ("The mitochondria", ""),
]


@pytest.mark.parametrize("expected,given", CORRECT)
def test_correct(expected, given):
    assert grade(expected, given).verdict == "correct"


@pytest.mark.parametrize("expected,given", NOT_CORRECT)
def test_not_correct(expected, given):
    assert grade(expected, given).verdict != "correct"


def test_threshold_controls_strictness():
    assert grade("Thymine", "thiamine", threshold=0.95).verdict != "correct"
    assert grade("Thymine", "thiamine", threshold=0.6).verdict == "correct"


def test_close_band():
    g = grade("Layer 3 (Network layer)", "layer 4")
    assert g.verdict == "close" and g.note


def test_variants():
    assert answer_variants("SIGTERM (15)") == ["SIGTERM (15)", "SIGTERM", "15"]
    assert "hu" in answer_variants("fu (hu)")
