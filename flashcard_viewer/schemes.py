"""Custom URL schemes and the offline CDN cache.

* ``app://shell/...``      the application UI (flashcard_viewer/ui)
* ``deck://<deck-id>/...`` a deck, the web assets next to it (see netpolicy.sibling_allowed), and
                            the helper runtime under ``/__fv/`` (each deck is its own origin)
* ``cdn://<host>/<path>``   cached copy of ``https://<host>/<path>``

Deck HTML (and CSS fetched through the cache) has its ``https://`` resource URLs
rewritten to ``cdn://`` according to the network mode, so a deck that pulls
Tailwind or fonts from a CDN keeps working offline once it has been opened
online. (Redirecting requests to a custom scheme from the interceptor crashes
Chromium's renderer, so URLs are rewritten at the source instead; the
interceptor only blocks stray requests in strict offline mode.)

Decks are untrusted: app:// and deck:// replies carry no CORS header, so one origin can't read
another's files, and cdn:// only lets a deck read a response the real server allows cross-origin,
and never fetches from this machine or the local network (netpolicy.is_public_host).
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import time
from pathlib import Path
from urllib.parse import unquote

from PyQt6.QtCore import QBuffer, QByteArray, QFile, QIODevice, QObject, QUrl
from PyQt6.QtNetwork import QNetworkAccessManager, QNetworkProxyFactory, QNetworkReply, QNetworkRequest
from PyQt6.QtWebEngineCore import (QWebEngineUrlRequestInfo, QWebEngineUrlRequestInterceptor,
                                   QWebEngineUrlRequestJob, QWebEngineUrlScheme, QWebEngineUrlSchemeHandler)

from . import paths
from .netpolicy import is_public_host, reaches_public_network, sibling_allowed
from .render import render_deck

UI_DIR = Path(__file__).resolve().parent / "ui"
VENDOR_DIR = UI_DIR / "vendor"
BROWSER_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
              "Chrome/140.0.0.0 Safari/537.36")

mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/ttf", ".ttf")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("application/json", ".json")


def register_schemes() -> None:
    """Must run before QApplication is created."""
    F = QWebEngineUrlScheme.Flag
    for name, syntax, flags in (
        (b"app", QWebEngineUrlScheme.Syntax.Host, F.SecureScheme | F.CorsEnabled | F.LocalAccessAllowed | F.FetchApiAllowed
         | F.ContentSecurityPolicyIgnored),
        (b"deck", QWebEngineUrlScheme.Syntax.Host, F.SecureScheme | F.CorsEnabled | F.FetchApiAllowed
         | F.ContentSecurityPolicyIgnored),
        (b"cdn", QWebEngineUrlScheme.Syntax.Host, F.SecureScheme | F.CorsEnabled | F.FetchApiAllowed),
    ):
        s = QWebEngineUrlScheme(name)
        s.setSyntax(syntax)
        s.setFlags(flags)
        QWebEngineUrlScheme.registerScheme(s)


def _mime(path: str) -> str:
    m, _ = mimetypes.guess_type(path)
    if m and (m.startswith("text/") or m in ("application/javascript", "application/json", "image/svg+xml")):
        return m + ";charset=utf-8"
    return m or "application/octet-stream"


def _reply(job: QWebEngineUrlRequestJob, data: bytes, mime: str, cors: bool = False) -> None:
    """Answer a request. ``cors`` adds Access-Control-Allow-Origin: * so other origins may read it."""
    if cors and hasattr(job, "setAdditionalResponseHeaders"):
        try:
            from PyQt6.QtCore import QByteArray as BA
            job.setAdditionalResponseHeaders({BA(b"Access-Control-Allow-Origin"): BA(b"*")})
        except Exception:  # pragma: no cover - binding differences
            pass
    buf = QBuffer(parent=job)
    buf.setData(QByteArray(data))
    buf.open(QIODevice.OpenModeFlag.ReadOnly)
    job.reply(mime.encode(), buf)


_RESOURCE_TAG = re.compile(r"<(script|img|source|audio|video|track|link|input|image|use)\b[^>]*>", re.I)
_ATTR_URL = re.compile(r"""(\b(?:src|href|xlink:href|srcset|poster)\s*=\s*["']?\s*)https?://""", re.I)
_CSS_URL = re.compile(r"""(url\(\s*["']?|@import\s+["'])https?://""", re.I)
_JS_IMPORT = re.compile(r"""((?:\bfrom|\bimport)\s*\(?\s*["'])https?://""")
_STYLE_BLOCK = re.compile(r"(<style\b[^>]*>)(.*?)(</style\s*>)", re.I | re.S)
_MODULE_SCRIPT = re.compile(r"(<script\b[^>]*\btype\s*=\s*[\"']?module[^>]*>)(.*?)(</script\s*>)", re.I | re.S)


def rewrite_html(html: str) -> str:
    """Point http(s) sub-resources (scripts, styles, images, fonts) at the cdn:// cache.

    Only resource-loading tags are touched: <a href> links keep opening in the browser.
    """
    def tag(m):
        t = m.group(0)
        if m.group(1).lower() == "link" and re.search(r"rel\s*=\s*[\"']?(?:preconnect|dns-prefetch|canonical|alternate)", t, re.I):
            return t
        return _ATTR_URL.sub(lambda a: a.group(1) + "cdn://", t)

    html = _RESOURCE_TAG.sub(tag, html)
    html = _STYLE_BLOCK.sub(lambda m: m.group(1) + _CSS_URL.sub(lambda x: x.group(1) + "cdn://", m.group(2)) + m.group(3), html)
    html = _MODULE_SCRIPT.sub(lambda m: m.group(1) + _JS_IMPORT.sub(lambda x: x.group(1) + "cdn://", m.group(2)) + m.group(3), html)
    return re.sub(r"""(style\s*=\s*["'][^"']*url\(\s*['"]?)https?://""", r"\1cdn://", html, flags=re.I)


def rewrite_resource(data: bytes, mime: str) -> bytes:
    """Rewrite absolute URLs inside cached CSS / JS modules so their own dependencies use the cache too."""
    m = mime.lower()
    if "css" in m:
        return _CSS_URL.sub(lambda x: x.group(1) + "cdn://", data.decode("utf-8", "replace")).encode("utf-8")
    if "javascript" in m and len(data) < 4_000_000:
        txt = data.decode("utf-8", "replace")
        new = _JS_IMPORT.sub(lambda x: x.group(1) + "cdn://", txt)
        if new != txt:
            return new.encode("utf-8")
    return data


def _initiator(job: QWebEngineUrlRequestJob) -> QUrl:
    """Origin of the page that made the request (empty for the app's own navigations)."""
    try:
        return job.initiator()
    except AttributeError:  # pragma: no cover - very old Qt
        return QUrl()


def _safe_join(root: Path, rel: str) -> Path | None:
    rel = unquote(rel).lstrip("/")
    p = (root / rel).resolve()
    try:
        p.relative_to(root.resolve())
    except ValueError:
        return None
    return p


class AppSchemeHandler(QWebEngineUrlSchemeHandler):
    """Serves the UI bundle and the per-deck runtime helpers."""

    def requestStarted(self, job: QWebEngineUrlRequestJob) -> None:  # noqa: N802
        if _initiator(job).scheme() == "deck":  # decks get their runtime from deck://<id>/__fv/
            job.fail(QWebEngineUrlRequestJob.Error.RequestDenied)
            return
        path = job.requestUrl().path()
        if path == "/qwebchannel.js":
            f = QFile(":/qtwebchannel/qwebchannel.js")
            if f.open(QIODevice.OpenModeFlag.ReadOnly):
                _reply(job, bytes(f.readAll()), "application/javascript")
                return
        p = _safe_join(UI_DIR, path or "/index.html")
        if p and p.is_dir():
            p = p / "index.html"
        if not p or not p.is_file():
            job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
            return
        # Bundled third-party assets may be read cross-origin: the deck editor's sandboxed preview
        # (an opaque origin) needs the fonts. They are public files, so this exposes nothing.
        _reply(job, p.read_bytes(), _mime(str(p)), cors=path.startswith("/vendor/"))


class DeckSchemeHandler(QWebEngineUrlSchemeHandler):
    def __init__(self, library, settings, parent: QObject | None = None):
        super().__init__(parent)
        self.library = library
        self.settings = settings

    def requestStarted(self, job: QWebEngineUrlRequestJob) -> None:  # noqa: N802
        url = job.requestUrl()
        deck_id = url.host()
        origin = _initiator(job)
        if origin.scheme() == "deck" and origin.host() != deck_id:  # one deck may not read another
            job.fail(QWebEngineUrlRequestJob.Error.RequestDenied)
            return
        path = unquote(url.path())
        if path.startswith("/__fv/"):
            p = _safe_join(UI_DIR / "deck-runtime", path[len("/__fv/"):]) if not path.startswith("/__fv/vendor/") \
                else _safe_join(VENDOR_DIR, path[len("/__fv/vendor/"):])
            if p and p.is_file():
                _reply(job, p.read_bytes(), _mime(str(p)))
            else:
                job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
            return
        info = self.library.get(deck_id)
        if not info:
            job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
            return
        if path.startswith("/__source/"):
            text = self.library.text(deck_id) or ""
            _reply(job, text.encode("utf-8"), "text/plain;charset=utf-8")
            return
        if path in ("", "/", "/" + info.filename):
            text = self.library.text(deck_id)
            if text is None:
                job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)
                return
            html = render_deck(text, info.kind, info.filename, self.library.display_name(info))
            if self.settings.data["network"]["mode"] != "online":
                html = rewrite_html(html)
            _reply(job, html.encode("utf-8"), "text/html;charset=utf-8")
            return
        # Web assets (images, css, fonts...) next to the deck. A deck opened from elsewhere ("Open with",
        # e.g. from Downloads) gets none: its folder isn't one the user chose as a deck library.
        p = _safe_join(Path(info.folder), path) if not info.external and sibling_allowed(path) else None
        if p and p.is_file():
            _reply(job, p.read_bytes(), _mime(str(p)))
        else:
            job.fail(QWebEngineUrlRequestJob.Error.UrlNotFound)


class CdnCache:
    def __init__(self, root: Path | None = None):
        self.root = root or paths.cache_dir() / "cdn"
        self.root.mkdir(parents=True, exist_ok=True)

    def _key(self, url: str) -> Path:
        return self.root / hashlib.sha256(url.encode()).hexdigest()

    def get(self, url: str) -> tuple[bytes, str, bool] | None:
        """(data, mime, cors) where cors says whether the origin server allowed cross-origin reads."""
        base = self._key(url)
        try:
            meta = json.loads((base.with_suffix(".json")).read_text())
            cors = meta.get("cors", is_public_host(QUrl(url).host()))  # entries from older versions
            return base.with_suffix(".bin").read_bytes(), meta["mime"], bool(cors)
        except (OSError, ValueError, KeyError):
            return None

    def has(self, url: str) -> bool:
        return self._key(url).with_suffix(".bin").exists()

    def put(self, url: str, data: bytes, mime: str, cors: bool = False) -> None:
        base = self._key(url)
        base.with_suffix(".bin").write_bytes(data)
        base.with_suffix(".json").write_text(json.dumps({"url": url, "mime": mime, "cors": cors, "ts": time.time()}))

    def size(self) -> tuple[int, int]:
        files = list(self.root.glob("*.bin"))
        return len(files), sum(f.stat().st_size for f in files)

    def clear(self) -> None:
        for f in self.root.iterdir():
            try:
                f.unlink()
            except OSError:
                pass


def cdn_to_https(url: QUrl) -> str:
    u = QUrl(url)
    u.setScheme("https")
    return u.toString(QUrl.ComponentFormattingOption.FullyEncoded)


class CdnSchemeHandler(QWebEngineUrlSchemeHandler):
    def __init__(self, cache: CdnCache, settings, parent: QObject | None = None):
        super().__init__(parent)
        self.cache = cache
        self.settings = settings
        QNetworkProxyFactory.setUseSystemConfiguration(True)  # honour http(s)_proxy
        self.nam = QNetworkAccessManager(self)
        self._pending: dict[str, list[QWebEngineUrlRequestJob]] = {}

    def requestStarted(self, job: QWebEngineUrlRequestJob) -> None:  # noqa: N802
        url = cdn_to_https(job.requestUrl())
        if not reaches_public_network(job.requestUrl().host()):
            job.fail(QWebEngineUrlRequestJob.Error.RequestDenied)
            return
        hit = self.cache.get(url)
        if hit:
            _reply(job, rewrite_resource(hit[0], hit[1]), hit[1], cors=hit[2])
            return
        if self.settings.data["network"]["mode"] == "offline":
            job.fail(QWebEngineUrlRequestJob.Error.RequestFailed)
            return
        waiting = self._pending.setdefault(url, [])
        waiting.append(job)
        job.destroyed.connect(lambda *_: waiting.remove(job) if job in waiting else None)
        if len(waiting) > 1:
            return
        req = QNetworkRequest(QUrl(url))
        req.setHeader(QNetworkRequest.KnownHeaders.UserAgentHeader, BROWSER_UA)
        req.setAttribute(QNetworkRequest.Attribute.RedirectPolicyAttribute,
                         QNetworkRequest.RedirectPolicy.NoLessSafeRedirectPolicy)
        req.setTransferTimeout(20000)
        reply = self.nam.get(req)
        reply.finished.connect(lambda r=reply, u=url: self._done(r, u))

    def _done(self, reply: QNetworkReply, url: str) -> None:
        jobs = self._pending.pop(url, [])
        status = reply.attribute(QNetworkRequest.Attribute.HttpStatusCodeAttribute)
        ok = reply.error() == QNetworkReply.NetworkError.NoError and (status or 200) < 400
        if ok and not is_public_host(reply.url().host()):  # redirected onto the local network
            ok = False
        # Mirror the origin's CORS policy, like a browser would.
        cors = bool(bytes(reply.rawHeader(b"Access-Control-Allow-Origin")).strip())
        data = bytes(reply.readAll()) if ok else b""
        mime = str(reply.header(QNetworkRequest.KnownHeaders.ContentTypeHeader) or "") or _mime(url.split("?")[0])
        if not ok and os.environ.get("FLASHCARD_VIEWER_DEBUG"):
            print(f"[cdn] failed {url}: {reply.errorString()} (HTTP {status})", flush=True)
        reply.deleteLater()
        if ok:
            try:
                self.cache.put(url, data, mime, cors)
            except OSError:
                pass
        for job in jobs:
            try:
                if ok:
                    _reply(job, rewrite_resource(data, mime), mime, cors=cors)
                else:
                    job.fail(QWebEngineUrlRequestJob.Error.RequestFailed)
            except RuntimeError:  # job already deleted (page navigated away)
                pass


class Interceptor(QWebEngineUrlRequestInterceptor):
    def __init__(self, settings, cache: CdnCache, parent: QObject | None = None):
        super().__init__(parent)
        self.settings = settings
        self.cache = cache

    def interceptRequest(self, info: QWebEngineUrlRequestInfo) -> None:  # noqa: N802
        url = info.requestUrl()
        if url.scheme() not in ("http", "https", "ws", "wss"):
            return
        rt = info.resourceType()
        R = QWebEngineUrlRequestInfo.ResourceType
        if rt in (R.ResourceTypeMainFrame, R.ResourceTypeNavigationPreloadMainFrame):
            return  # the page opens these in the system browser
        # Nothing in the app needs this machine or the local network, and decks must not reach it
        # (a router page, a local service), not even with requests whose answer they can't read.
        if not reaches_public_network(url.host()):
            info.block(True)
            return
        if rt in (R.ResourceTypeSubFrame, R.ResourceTypeNavigationPreloadSubFrame):
            return  # embedded pages (e.g. a video) follow the network mode of the page
        if self.settings.data["network"]["mode"] == "offline":
            info.block(True)
