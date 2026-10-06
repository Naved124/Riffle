"""Drive the real app headlessly (under xvfb) and take screenshots — for development checks.

    xvfb-run -a -s "-screen 0 1440x900x24" python3 tools/ui_driver.py OUT_DIR steps.json

steps.json is a list of {"js" | "frame_js": "...", "wait": ms, "shot": "name", "eval": "expr"} objects
("frame_js" runs inside the deck iframe; "py" runs Python with `work` = the decks folder).
The app runs with throwaway XDG dirs and watches the folder in $FV_DECKS (default: samples/).
"""

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

out_dir = Path(sys.argv[1])
steps = json.loads(Path(sys.argv[2]).read_text())
out_dir.mkdir(parents=True, exist_ok=True)

tmp = Path(os.environ.get("FV_HOME") or tempfile.mkdtemp(prefix="fv-ui-"))
for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"):
    os.environ[var] = str(tmp / var.lower())
decks = Path(os.environ.get("FV_DECKS", ROOT / "samples"))
work = tmp / "decks"
if not work.exists():
    shutil.copytree(decks, work)
cfg = tmp / "xdg_config_home" / "flashcard-viewer"
cfg.mkdir(parents=True, exist_ok=True)
settings_path = cfg / "settings.json"
base = json.loads(settings_path.read_text()) if settings_path.exists() else {}
base.setdefault("library", {}).update({"folders": [str(work)], "mainFolder": str(work)})
base.update(json.loads(os.environ.get("FV_SETTINGS", "{}")))
settings_path.write_text(json.dumps(base))
os.environ["FLASHCARD_VIEWER_DEBUG"] = "1"
os.environ.setdefault("QTWEBENGINE_CHROMIUM_FLAGS", "--disable-gpu")

from PyQt6.QtCore import QTimer  # noqa: E402
from PyQt6.QtWidgets import QApplication  # noqa: E402

from flashcard_viewer import app as appmod  # noqa: E402

orig_ctx = appmod.AppContext
holder = {}


class Ctx(orig_ctx):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        holder["ctx"] = self
        self.window.resize(int(os.environ.get("FV_W", 1440)), int(os.environ.get("FV_H", 900)))
        QTimer.singleShot(int(os.environ.get("FV_BOOT_MS", 3500)), run_steps)


appmod.AppContext = Ctx
results = {}


def run_steps(i=0):
    ctx = holder["ctx"]
    if i >= len(steps):
        Path(out_dir / "results.json").write_text(json.dumps(results, indent=2))
        QApplication.instance().quit()
        return
    st = steps[i]

    def after_js(_=None):
        def snap():
            if st.get("eval"):
                ctx.page.runJavaScript(st["eval"], 0, lambda v: (results.__setitem__(st.get("shot") or f"step{i}", v),
                                                                  finish()))
            else:
                finish()

        def finish():
            if st.get("shot"):
                ctx.window.grab().save(str(out_dir / f"{st['shot']}.png"))
                print("shot", st["shot"], flush=True)
            run_steps(i + 1)

        QTimer.singleShot(int(st.get("wait", 600)), snap)

    if st.get("py"):
        exec(st["py"], {"work": work, "Path": Path, "ctx": ctx})
    if st.get("frame_js"):
        frames = ctx.page.mainFrame().children()
        if frames:
            frames[0].runJavaScript(st["frame_js"], 0, lambda v: (results.__setitem__(f"frame{i}", v), after_js()))
        else:
            print("no child frame", flush=True)
            after_js()
    elif st.get("js"):
        ctx.page.runJavaScript(st["js"], 0, after_js)
    else:
        after_js()


sys.exit(appmod.main(["--new-instance"]))
