"""Turn a deck file into something the embedded browser can render.

* Full HTML documents get the deck helper script injected into <head>.
* Fragments (no <html>/<body>) are wrapped in a minimal document.
* React / TSX components get a wrapper page that loads the bundled React,
  Babel, Tailwind and lucide runtimes and mounts the default export.

Helper and vendor files are served from ``/__fv/`` on the deck's own origin.
"""

from __future__ import annotations

import html as htmlmod
import json
import re
from urllib.parse import quote

HELPER_TAG = '<script src="/__fv/deck-helper.js"></script>'


def _inject_head(text: str, extra: str) -> str:
    m = re.search(r"<head\b[^>]*>", text, re.I)
    if m:
        return text[: m.end()] + extra + text[m.end():]
    m = re.search(r"<html\b[^>]*>", text, re.I)
    if m:
        return text[: m.end()] + "<head>" + extra + "</head>" + text[m.end():]
    m = re.search(r"<!doctype[^>]*>", text, re.I)
    if m:
        return text[: m.end()] + extra + text[m.end():]
    return extra + text


def render_html(text: str, kind: str, title: str = "") -> str:
    text = text.lstrip("\ufeff")
    if kind == "fragment":
        return (
            "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            f"<title>{htmlmod.escape(title)}</title>{HELPER_TAG}</head>\n<body>\n{text}\n</body></html>"
        )
    extra = HELPER_TAG
    if not re.search(r"<meta[^>]+charset", text[:3000], re.I):
        extra = '<meta charset="utf-8">' + extra
    return _inject_head(text, extra)


def render_react(filename: str, title: str = "") -> str:
    src = "/__source/" + quote(filename)
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{htmlmod.escape(title)}</title>
{HELPER_TAG}
<script src="/__fv/vendor/react/react.production.min.js"></script>
<script src="/__fv/vendor/react/react-dom.production.min.js"></script>
<script src="/__fv/vendor/react/lucide-react.min.js"></script>
<script src="/__fv/vendor/react/tailwind.js"></script>
<script src="/__fv/vendor/react/babel.min.js"></script>
<style>html,body{{margin:0;min-height:100%}}</style>
</head><body><div id="root"></div>
<script src="/__fv/react-runner.js" data-src={json.dumps(src)} data-name={json.dumps(filename)}></script>
</body></html>"""


def render_deck(text: str, kind: str, filename: str, title: str = "") -> str:
    if kind == "react":
        return render_react(filename, title)
    return render_html(text, kind, title)
