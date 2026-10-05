import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_js_defaults_in_sync():
    spec = importlib.util.spec_from_file_location("gen", ROOT / "tools" / "gen_js_defaults.py")
    gen = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gen)
    assert gen.OUT.read_text(encoding="utf-8") == gen.render(), "run: python3 tools/gen_js_defaults.py"
