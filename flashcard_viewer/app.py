"""Application entry point: window, web view, file watching, single instance."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from PyQt6.QtCore import QByteArray, QFileSystemWatcher, QObject, Qt, QTimer, QUrl
from PyQt6.QtGui import QColor, QGuiApplication, QIcon
from PyQt6.QtNetwork import QLocalServer, QLocalSocket
from PyQt6.QtWebChannel import QWebChannel
from PyQt6.QtWebEngineCore import QWebEnginePage, QWebEngineProfile, QWebEngineSettings
from PyQt6.QtWebEngineWidgets import QWebEngineView
from PyQt6.QtWidgets import QApplication, QMainWindow

from . import __version__, paths
from .bridge import Bridge
from .config import Settings
from .library import Library, deck_id_for, is_deck_file
from .schemes import (UI_DIR, AppSchemeHandler, CdnCache, CdnSchemeHandler, DeckSchemeHandler, Interceptor,
                      register_schemes)
from .stats import Stats

def _user_tag() -> str:
    if hasattr(os, "getuid"):
        return str(os.getuid())
    import getpass
    try:
        return "".join(c for c in getpass.getuser() if c.isalnum()) or "user"
    except Exception:  # noqa: BLE001
        return "user"


SERVER_NAME = f"flashcard-viewer-{_user_tag()}"
ICON_PATH = UI_DIR / "icon.png"


class Page(QWebEnginePage):
    """Opens web links from decks in the system browser instead of in-app."""

    def acceptNavigationRequest(self, url: QUrl, nav_type, is_main_frame: bool) -> bool:  # noqa: N802
        if url.scheme() in ("http", "https", "mailto"):
            from PyQt6.QtGui import QDesktopServices
            if nav_type == QWebEnginePage.NavigationType.NavigationTypeLinkClicked or is_main_frame:
                QDesktopServices.openUrl(url)
                return False
            # Sub-frame (e.g. an embedded YouTube video) is allowed when online.
            return True
        if is_main_frame and url.scheme() != "app":
            return False  # the shell never navigates away
        return True

    def createWindow(self, _type):  # noqa: N802 - target=_blank links
        tmp = QWebEnginePage(self.profile(), self)
        tmp.urlChanged.connect(lambda u, t=tmp: (self._open_external(u), t.deleteLater()))
        return tmp

    @staticmethod
    def _open_external(url: QUrl) -> None:
        from PyQt6.QtGui import QDesktopServices
        if url.scheme() in ("http", "https", "mailto"):
            QDesktopServices.openUrl(url)

    def javaScriptConsoleMessage(self, level, message, line, source):  # noqa: N802
        if os.environ.get("FLASHCARD_VIEWER_DEBUG"):
            print(f"[js:{level.name}] {source}:{line} {message}", file=sys.stderr)


class MainWindow(QMainWindow):
    def __init__(self, ctx):
        super().__init__()
        self.ctx = ctx
        self.was_maximized = False
        self.setWindowTitle("Riffle")
        if ICON_PATH.exists():
            self.setWindowIcon(QIcon(str(ICON_PATH)))
        self.setMinimumSize(560, 420)
        w = ctx.settings.data["window"]
        self.resize(int(w.get("width", 1280)), int(w.get("height", 820)))

    def changeEvent(self, e):  # noqa: N802
        super().changeEvent(e)
        if e.type() == e.Type.WindowStateChange:
            st = "fullscreen" if self.isFullScreen() else "maximized" if self.isMaximized() else "normal"
            if self.ctx.bridge:
                self.ctx.bridge.windowStateChanged.emit(st)

    def closeEvent(self, e):  # noqa: N802
        w = self.ctx.settings.data["window"]
        w["maximized"] = self.isMaximized()
        if not self.isMaximized() and not self.isFullScreen():
            w["width"], w["height"] = self.width(), self.height()
        self.ctx.settings.save()
        # Let the UI flush the running study session.
        self.ctx.view.page().runJavaScript("window.__fvBeforeClose && window.__fvBeforeClose()")
        QApplication.processEvents()
        super().closeEvent(e)


class AppContext(QObject):
    def __init__(self, app: QApplication, open_paths: list[str]):
        super().__init__()
        paths.ensure_dirs()
        self.app = app
        self.settings = Settings()
        for f in self.settings.data["library"]["folders"]:
            if f == self.settings.data["library"]["mainFolder"]:
                Path(os.path.expanduser(f)).mkdir(parents=True, exist_ok=True)
        self.library = Library(self.settings)
        self.stats = Stats()
        self.cache = CdnCache()
        self.window: MainWindow | None = None
        self.bridge: Bridge | None = None
        self._pending_open: list[str] = []
        self._watched_deck: str | None = None

        self.library.scan()
        for p in open_paths:
            self.queue_open(p, emit=False)

        # Web engine profile (persistent localStorage for decks).
        self.profile = QWebEngineProfile("flashcard-viewer", self)
        self.profile.setPersistentStoragePath(str(paths.data_dir() / "webengine"))
        self.profile.setCachePath(str(paths.cache_dir() / "webengine"))
        self.profile.setHttpUserAgent(self.profile.httpUserAgent() + f" Riffle/{__version__}")
        self.app_handler = AppSchemeHandler(self)
        self.deck_handler = DeckSchemeHandler(self.library, self.settings, self)
        self.cdn_handler = CdnSchemeHandler(self.cache, self.settings, self)
        self.profile.installUrlSchemeHandler(QByteArray(b"app"), self.app_handler)
        self.profile.installUrlSchemeHandler(QByteArray(b"deck"), self.deck_handler)
        self.profile.installUrlSchemeHandler(QByteArray(b"cdn"), self.cdn_handler)
        self.interceptor = Interceptor(self.settings, self.cache, self)
        self.profile.setUrlRequestInterceptor(self.interceptor)
        s = self.profile.settings()
        A = QWebEngineSettings.WebAttribute
        s.setAttribute(A.LocalStorageEnabled, True)
        s.setAttribute(A.JavascriptCanAccessClipboard, True)
        s.setAttribute(A.FullScreenSupportEnabled, True)
        s.setAttribute(A.ScrollAnimatorEnabled, True)
        s.setAttribute(A.PlaybackRequiresUserGesture, False)

        self.window = MainWindow(self)
        self.view = QWebEngineView(self.window)
        self.page = Page(self.profile, self.view)
        self.page.setBackgroundColor(QColor("#1c1b1f"))
        self.view.setPage(self.page)
        self.view.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu
                                       if not os.environ.get("FLASHCARD_VIEWER_DEBUG") else Qt.ContextMenuPolicy.DefaultContextMenu)
        self.window.setCentralWidget(self.view)
        self.page.fullScreenRequested.connect(lambda req: req.accept())
        self.page.renderProcessTerminated.connect(self._render_crashed)

        self.bridge = Bridge(self)
        self.channel = QWebChannel(self.page)
        self.channel.registerObject("backend", self.bridge)
        self.page.setWebChannel(self.channel)
        self.view.setZoomFactor(float(self.settings.data["appearance"].get("uiScale", 1.0)))

        hints = QGuiApplication.styleHints()
        hints.colorSchemeChanged.connect(
            lambda scheme: self.bridge.systemThemeChanged.emit("dark" if scheme == Qt.ColorScheme.Dark else "light"))

        # File watching
        self.watcher = QFileSystemWatcher(self)
        self.watcher.directoryChanged.connect(self._dir_changed)
        self.watcher.fileChanged.connect(self._file_changed)
        self._rescan_timer = QTimer(self, singleShot=True, interval=400, timeout=self.rescan)
        self._file_timer = QTimer(self, singleShot=True, interval=300, timeout=self._emit_deck_changed)
        self._watch_folders()

        self.apply_titlebar()
        self.view.load(QUrl("app://shell/index.html"))
        if self.settings.data["window"].get("maximized"):
            self.window.showMaximized()
        else:
            self.window.show()

    def _render_crashed(self, status, code) -> None:
        print(f"renderer terminated: {status.name} ({code}); reloading UI", file=sys.stderr)
        if status != QWebEnginePage.RenderProcessTerminationStatus.NormalTerminationStatus:
            QTimer.singleShot(500, lambda: self.view.load(QUrl("app://shell/index.html")))

    # -- titlebar ------------------------------------------------------------
    def apply_titlebar(self) -> None:
        custom = bool(self.settings.data["window"].get("customTitlebar", True))
        visible = self.window.isVisible()
        self.window.setWindowFlag(Qt.WindowType.FramelessWindowHint, custom)
        if visible:
            self.window.show()

    # -- watching -----------------------------------------------------------------
    def _watch_folders(self) -> None:
        dirs = self.watcher.directories()
        if dirs:
            self.watcher.removePaths(dirs)
        want = set()
        recursive = self.settings.data["library"].get("recursive", True)
        for folder in self.library.folders():
            root = Path(os.path.expanduser(folder))
            if not root.is_dir():
                continue
            want.add(str(root))
            if recursive:
                for dirpath, dirnames, _ in os.walk(root):
                    dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "node_modules"]
                    want.add(dirpath)
                    if len(want) > 2000:
                        break
        for ext in self.library.state.data.get("external", []):
            want.add(str(Path(ext).parent))
        if want:
            self.watcher.addPaths(sorted(want))

    def _dir_changed(self, _path: str) -> None:
        self._rescan_timer.start()

    def rescan(self, emit: bool = True) -> None:
        self.library.scan()
        self._watch_folders()
        if emit and self.bridge:
            self.bridge.decksChanged.emit()

    def watch_deck(self, path: str) -> None:
        if self._watched_deck and self._watched_deck in self.watcher.files():
            self.watcher.removePath(self._watched_deck)
        self._watched_deck = path
        if os.path.exists(path):
            self.watcher.addPath(path)

    def _file_changed(self, path: str) -> None:
        if path != self._watched_deck:
            return
        self._file_timer.start()

    def _emit_deck_changed(self) -> None:
        path = self._watched_deck
        if not path:
            return
        # Editors often replace the file (new inode): watch it again.
        if os.path.exists(path) and path not in self.watcher.files():
            self.watcher.addPath(path)
        did = deck_id_for(path)
        self.library.refresh(did)
        if self.settings.data["decks"].get("autoReload", True) and self.bridge:
            self.bridge.deckFileChanged.emit(did)

    # -- opening files from the command line / other instances --------------------
    def queue_open(self, path: str, emit: bool = True) -> None:
        p = os.path.abspath(os.path.expanduser(path))
        if not (os.path.isfile(p) and is_deck_file(p)):
            return
        did = self.library.add_external(p)
        self.library.scan()
        self._pending_open.append(did)
        if emit and self.bridge:
            self.bridge.decksChanged.emit()
            self.bridge.openDeckRequested.emit(did)

    def take_pending_open(self) -> list[str]:
        out, self._pending_open = self._pending_open, []
        return out


def _send_to_running_instance(files: list[str]) -> bool:
    sock = QLocalSocket()
    sock.connectToServer(SERVER_NAME)
    if not sock.waitForConnected(400):
        return False
    sock.write(json.dumps({"open": [os.path.abspath(f) for f in files]}).encode() + b"\n")
    sock.flush()
    sock.waitForBytesWritten(1000)
    sock.disconnectFromServer()
    return True


def _start_server(ctx: AppContext) -> QLocalServer:
    QLocalServer.removeServer(SERVER_NAME)
    server = QLocalServer(ctx)
    server.listen(SERVER_NAME)

    def on_conn():
        conn = server.nextPendingConnection()

        def read():
            try:
                msg = json.loads(bytes(conn.readAll()).decode() or "{}")
            except ValueError:
                return
            for f in msg.get("open", []):
                ctx.queue_open(f)
            w = ctx.window
            if w.isMinimized():
                w.showNormal()
            w.raise_()
            w.activateWindow()
        conn.readyRead.connect(read)

    server.newConnection.connect(on_conn)
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="flashcard-viewer", description="View and study HTML flashcard decks.")
    parser.add_argument("files", nargs="*", help="deck files to open")
    parser.add_argument("--new-instance", action="store_true", help="don't hand files to a running window")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    args, qt_args = parser.parse_known_args(argv if argv is not None else sys.argv[1:])

    # Chromium inside QtWebEngine refuses to run as root with the sandbox on.
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        os.environ.setdefault("QTWEBENGINE_DISABLE_SANDBOX", "1")
    os.environ.setdefault("QT_ENABLE_HIGHDPI_SCALING", "1")

    register_schemes()
    QApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts)
    app = QApplication([sys.argv[0], *qt_args])
    app.setApplicationName("flashcard-viewer")
    app.setApplicationDisplayName("Riffle")
    app.setDesktopFileName("flashcard-viewer")
    app.setApplicationVersion(__version__)
    if ICON_PATH.exists():
        app.setWindowIcon(QIcon(str(ICON_PATH)))

    single = Settings().data["general"].get("singleInstance", True) and not args.new_instance
    if single and _send_to_running_instance(args.files):
        return 0

    ctx = AppContext(app, args.files)
    ctx.server = _start_server(ctx) if single else None
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
