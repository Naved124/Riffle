"""QWebChannel object exposed to the UI as ``backend``.

Every slot takes/returns JSON strings so the JS side stays simple
(``await api.call('listDecks')``).
"""

from __future__ import annotations

import json
import os
import time
import traceback
import zipfile
from pathlib import Path

from PyQt6.QtCore import QFile, QObject, QUrl, pyqtSignal, pyqtSlot
from PyQt6.QtGui import QDesktopServices, QFontDatabase, QGuiApplication
from PyQt6.QtWidgets import QFileDialog

from . import __version__, paths
from .config import DEFAULTS, deep_merge
from .library import DECK_EXTS, deck_id_for
from .quiz import build_quiz, grade_response


def _j(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


def _safe(fn):
    """Slots must never raise into Qt; return {"error": ...} instead."""
    def wrapper(self, *args):
        try:
            return fn(self, *args)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return _j({"error": f"{type(e).__name__}: {e}"})
    wrapper.__name__ = fn.__name__
    return wrapper


class Bridge(QObject):
    decksChanged = pyqtSignal()
    deckFileChanged = pyqtSignal(str)
    openDeckRequested = pyqtSignal(str)
    windowStateChanged = pyqtSignal(str)
    systemThemeChanged = pyqtSignal(str)
    notify = pyqtSignal(str)

    def __init__(self, app_ctx, parent=None):
        super().__init__(parent)
        self.ctx = app_ctx
        self.settings = app_ctx.settings
        self.library = app_ctx.library
        self.stats = app_ctx.stats
        self.cache = app_ctx.cache
        self._study: dict[str, float] = {}

    @property
    def window(self):
        return self.ctx.window

    # -- app / settings ---------------------------------------------------------
    @pyqtSlot(result=str)
    @_safe
    def getInitialState(self) -> str:
        hints = QGuiApplication.styleHints()
        scheme = "dark" if hints.colorScheme().name == "Dark" else "light"
        return _j({
            "settings": self.settings.data,
            "defaults": DEFAULTS,
            "systemScheme": scheme,
            "version": __version__,
            "dataDir": str(paths.data_dir()),
            "configDir": str(paths.config_dir()),
            "pendingOpen": self.ctx.take_pending_open(),
            "maximized": self.window.isMaximized() if self.window else False,
            "platform": "desktop",
        })

    @pyqtSlot(str, result=str)
    @_safe
    def updateSettings(self, patch_json: str) -> str:
        patch = json.loads(patch_json)
        old_folders = list(self.settings.data["library"]["folders"])
        old_recursive = self.settings.data["library"]["recursive"]
        data = self.settings.update(patch)
        if "library" in patch and (old_folders != data["library"]["folders"] or old_recursive != data["library"]["recursive"]):
            self.ctx.rescan()
        if "window" in patch and "customTitlebar" in patch["window"]:
            self.ctx.apply_titlebar()
        return _j(data)

    @pyqtSlot(str, result=str)
    @_safe
    def resetSettings(self, section: str) -> str:
        return _j(self.settings.reset(section or None))

    @pyqtSlot(result=str)
    @_safe
    def systemFonts(self) -> str:
        fams = sorted({f for f in QFontDatabase.families() if not f.startswith(".")}, key=str.casefold)
        mono = [f for f in fams if QFontDatabase.isFixedPitch(f)]
        return _j({"all": fams, "mono": mono})

    # -- library ------------------------------------------------------------------
    def _deck_dict(self, info) -> dict:
        d = info.to_dict()
        lib_state = self.library.state.data
        d["name"] = self.library.display_name(info)
        d["favourite"] = info.id in lib_state["favourites"]
        d["renamed"] = info.id in lib_state["renames"]
        try:
            d["recentIndex"] = lib_state["recent"].index(info.id)
        except ValueError:
            d["recentIndex"] = None
        cards = self.library.cards(info.id)
        d["stats"] = self.stats.deck_summary(info.id, [c.key for c in cards])
        d["manualCards"] = self.library.has_override(info.id)
        return d

    @pyqtSlot(result=str)
    @_safe
    def listDecks(self) -> str:
        return _j([self._deck_dict(i) for i in self.library.list()])

    @pyqtSlot(result=str)
    @_safe
    def rescan(self) -> str:
        self.ctx.rescan(emit=False)
        return self.listDecks()

    @pyqtSlot(str, result=str)
    @_safe
    def getDeck(self, deck_id: str) -> str:
        info = self.library.refresh(deck_id) or self.library.get(deck_id)
        return _j(self._deck_dict(info) if info else None)

    @pyqtSlot(str, result=str)
    @_safe
    def search(self, query: str) -> str:
        return _j(self.library.search(query))

    @pyqtSlot(str, result=str)
    @_safe
    def toggleFavourite(self, deck_id: str) -> str:
        return _j(self.library.state.toggle_favourite(deck_id))

    @pyqtSlot(str, str, result=str)
    @_safe
    def renameDeck(self, deck_id: str, name: str) -> str:
        self.library.state.rename(deck_id, name)
        return _j(True)

    @pyqtSlot(str, result=str)
    @_safe
    def openDeck(self, deck_id: str) -> str:
        info = self.library.get(deck_id)
        if not info:
            return _j(None)
        self.library.state.touch_recent(deck_id)
        self.stats.record_open(deck_id, self.library.display_name(info), info.path)
        self.settings.data["general"]["lastDeck"] = deck_id
        self.settings.save()
        self.ctx.watch_deck(info.path)
        self._study[deck_id] = time.time()
        return _j({"url": f"deck://{deck_id}/{QUrl.toPercentEncoding(info.filename).data().decode()}",
                   "deck": self._deck_dict(info)})

    @pyqtSlot(str, float, result=str)
    @_safe
    def recordStudy(self, deck_id: str, seconds: float) -> str:
        self.stats.record_study(deck_id, seconds)
        return _j(True)

    @pyqtSlot(str, result=str)
    @_safe
    def revealDeck(self, deck_id: str) -> str:
        info = self.library.get(deck_id)
        if info:
            QDesktopServices.openUrl(QUrl.fromLocalFile(info.folder))
        return _j(bool(info))

    @pyqtSlot(str, result=str)
    @_safe
    def deleteDeck(self, deck_id: str) -> str:
        info = self.library.get(deck_id)
        if not info:
            return _j(False)
        if info.external:
            self.library.delete_deck(deck_id)
        else:
            ok = QFile.moveToTrash(info.path)
            if not (ok if isinstance(ok, bool) else ok[0]):
                self.library.delete_deck(deck_id)
            else:
                self.library.decks.pop(deck_id, None)
        self.decksChanged.emit()
        return _j(True)

    @pyqtSlot(result=str)
    @_safe
    def openFilesDialog(self) -> str:
        pattern = " ".join(f"*{e}" for e in DECK_EXTS)
        files, _ = QFileDialog.getOpenFileNames(self.window, "Add flashcard decks", str(Path.home()),
                                                f"Flashcard decks ({pattern});;All files (*)")
        ids = []
        for f in files:
            target = self.library.import_path(f)
            ids.append(deck_id_for(target))
        if files:
            self.ctx.rescan(emit=False)
        return _j(ids)

    @pyqtSlot(str, str, result=str)
    @_safe
    def importDropped(self, name: str, content: str) -> str:
        target = self.library.import_file(name, content.encode("utf-8"))
        self.ctx.rescan(emit=False)
        return _j(deck_id_for(target))

    @pyqtSlot(result=str)
    @_safe
    def chooseFolder(self) -> str:
        d = QFileDialog.getExistingDirectory(self.window, "Choose a folder with flashcards", str(Path.home()))
        return _j(d or None)

    @pyqtSlot(str, result=str)
    @_safe
    def openPath(self, path: str) -> str:
        Path(os.path.expanduser(path)).mkdir(parents=True, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(os.path.expanduser(path)))
        return _j(True)

    # -- cards & quiz ----------------------------------------------------------------
    @pyqtSlot(str, result=str)
    @_safe
    def getCards(self, deck_id: str) -> str:
        info = self.library.get(deck_id)
        cards = self.library.cards(deck_id)
        return _j({"cards": [c.to_dict() for c in cards], "manual": self.library.has_override(deck_id),
                   "methods": info.methods if info else []})

    @pyqtSlot(str, str, result=str)
    @_safe
    def saveCards(self, deck_id: str, cards_json: str) -> str:
        self.library.save_cards(deck_id, json.loads(cards_json))
        return self.getCards(deck_id)

    @pyqtSlot(str, result=str)
    @_safe
    def resetCards(self, deck_id: str) -> str:
        self.library.reset_cards(deck_id)
        return self.getCards(deck_id)

    @pyqtSlot(str, str, result=str)
    @_safe
    def buildQuiz(self, deck_id: str, options_json: str) -> str:
        opts = json.loads(options_json or "{}")
        qs = self.settings.data["quiz"]
        cards = self.library.cards(deck_id)
        weak = [w["key"] for w in self.stats.weak_cards(deck_id)] if qs.get("weakFirst", True) or opts.get("onlyWeak") else []
        types = [t for t, on in qs["types"].items() if on]
        questions = build_quiz(cards, count=int(opts.get("count", qs["questions"])), types=types, weak_keys=weak,
                               only_weak=bool(opts.get("onlyWeak")), shuffle=qs.get("shuffle", True))
        return _j({"questions": questions, "cardCount": len(cards)})

    @pyqtSlot(str, str, result=str)
    @_safe
    def gradeAnswer(self, question_json: str, response_json: str) -> str:
        qs = self.settings.data["quiz"]
        return _j(grade_response(json.loads(question_json), json.loads(response_json),
                                 threshold=float(qs["threshold"]), strip_accents=bool(qs["stripAccents"])))

    @pyqtSlot(str, str, float, result=str)
    @_safe
    def recordQuiz(self, deck_id: str, results_json: str, seconds: float) -> str:
        attempt = self.stats.record_quiz(deck_id, json.loads(results_json), seconds)
        return _j(attempt)

    # -- stats --------------------------------------------------------------------
    @pyqtSlot(result=str)
    @_safe
    def getOverview(self) -> str:
        ov = self.stats.overview()
        ov["activity"] = self.stats.activity()
        ov["history"] = self.stats.score_history()
        return _j(ov)

    @pyqtSlot(str, result=str)
    @_safe
    def getDeckStats(self, deck_id: str) -> str:
        cards = self.library.cards(deck_id)
        return _j({"summary": self.stats.deck_summary(deck_id, [c.key for c in cards]),
                   "weak": self.stats.weak_cards(deck_id),
                   "history": self.stats.score_history(deck_id)})

    @pyqtSlot(str, result=str)
    @_safe
    def resetStats(self, deck_id: str) -> str:
        if deck_id:
            self.stats.reset_deck(deck_id)
        else:
            self.stats.reset_all()
        return _j(True)

    @pyqtSlot(str, result=str)
    @_safe
    def exportStats(self, fmt: str) -> str:
        stamp = time.strftime("%Y-%m-%d")
        if fmt == "csv":
            d = QFileDialog.getExistingDirectory(self.window, "Export CSV files to…", str(Path.home()))
            if not d:
                return _j(None)
            for name, text in self.stats.export_csv().items():
                Path(d, f"flashcards-{stamp}-{name}").write_text(text, encoding="utf-8")
            return _j(d)
        f, _ = QFileDialog.getSaveFileName(self.window, "Export stats", str(Path.home() / f"flashcard-stats-{stamp}.json"),
                                           "JSON (*.json)")
        if not f:
            return _j(None)
        Path(f).write_text(self.stats.export_json(), encoding="utf-8")
        return _j(f)

    # -- backup ----------------------------------------------------------------------
    @pyqtSlot(result=str)
    @_safe
    def exportBackup(self) -> str:
        stamp = time.strftime("%Y-%m-%d")
        f, _ = QFileDialog.getSaveFileName(self.window, "Save backup", str(Path.home() / f"flashcard-viewer-backup-{stamp}.zip"),
                                           "Zip archive (*.zip)")
        if not f:
            return _j(None)
        with zipfile.ZipFile(f, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("settings.json", json.dumps(self.settings.data, indent=2, ensure_ascii=False))
            z.writestr("library.json", json.dumps(self.library.state.data, indent=2, ensure_ascii=False))
            z.writestr("stats.json", self.stats.export_json())
            od = paths.data_dir() / "overrides"
            for p in od.glob("*.json"):
                z.write(p, f"overrides/{p.name}")
        return _j(f)

    @pyqtSlot(result=str)
    @_safe
    def importBackup(self) -> str:
        f, _ = QFileDialog.getOpenFileName(self.window, "Restore backup", str(Path.home()), "Zip archive (*.zip)")
        if not f:
            return _j(None)
        with zipfile.ZipFile(f) as z:
            names = set(z.namelist())
            if "settings.json" in names:
                self.settings.data = deep_merge(DEFAULTS, json.loads(z.read("settings.json")))
                self.settings.save()
            if "library.json" in names:
                self.library.state.data.update(json.loads(z.read("library.json")))
                self.library.state.save()
            if "stats.json" in names:
                self.stats.load(json.loads(z.read("stats.json")))
            od = paths.data_dir() / "overrides"
            od.mkdir(parents=True, exist_ok=True)
            for n in names:
                if n.startswith("overrides/") and n.endswith(".json") and "/" not in n[len("overrides/"):]:
                    (od / n[len("overrides/"):]).write_bytes(z.read(n))
        self.ctx.rescan()
        return _j({"settings": self.settings.data})

    @pyqtSlot(result=str)
    @_safe
    def cacheInfo(self) -> str:
        n, size = self.cache.size()
        return _j({"files": n, "bytes": size})

    @pyqtSlot(result=str)
    @_safe
    def clearCache(self) -> str:
        self.cache.clear()
        self.ctx.profile.clearHttpCache()
        return self.cacheInfo()

    # -- window ---------------------------------------------------------------------
    @pyqtSlot()
    def minimize(self) -> None:
        self.window.showMinimized()

    @pyqtSlot()
    def toggleMaximize(self) -> None:
        w = self.window
        if w.isFullScreen():
            return
        w.showNormal() if w.isMaximized() else w.showMaximized()

    @pyqtSlot(result=bool)
    def toggleFullscreen(self) -> bool:
        w = self.window
        if w.isFullScreen():
            w.showMaximized() if w.was_maximized else w.showNormal()
            return False
        w.was_maximized = w.isMaximized()
        w.showFullScreen()
        return True

    @pyqtSlot()
    def closeWindow(self) -> None:
        self.window.close()

    @pyqtSlot()
    def startMove(self) -> None:
        h = self.window.windowHandle()
        if h:
            h.startSystemMove()

    @pyqtSlot(str)
    def startResize(self, edge: str) -> None:
        from PyQt6.QtCore import Qt
        E = Qt.Edge
        m = {"left": E.LeftEdge, "right": E.RightEdge, "top": E.TopEdge, "bottom": E.BottomEdge}
        edges = Qt.Edge(0)
        for part in edge.split("-"):
            if part in m:
                edges |= m[part]
        h = self.window.windowHandle()
        if h and edges:
            h.startSystemResize(edges)

    @pyqtSlot(str)
    def openExternal(self, url: str) -> None:
        if url.startswith(("http://", "https://", "mailto:")):
            QDesktopServices.openUrl(QUrl(url))

    @pyqtSlot(float)
    def setUiZoom(self, factor: float) -> None:
        self.ctx.view.setZoomFactor(max(0.5, min(2.5, factor)))
