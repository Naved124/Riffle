"""Study tracker backed by SQLite: study time, quiz results, weak cards, streaks."""

from __future__ import annotations

import csv
import io
import json
import sqlite3
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from . import paths

SCHEMA = """
CREATE TABLE IF NOT EXISTS deck_meta (
    deck_id TEXT PRIMARY KEY,
    title TEXT,
    path TEXT,
    open_count INTEGER DEFAULT 0,
    last_opened REAL
);
CREATE TABLE IF NOT EXISTS study_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deck_id TEXT NOT NULL,
    started_at REAL NOT NULL,
    seconds REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS quiz_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deck_id TEXT NOT NULL,
    finished_at REAL NOT NULL,
    total INTEGER NOT NULL,
    correct INTEGER NOT NULL,
    close INTEGER NOT NULL,
    wrong INTEGER NOT NULL,
    score REAL NOT NULL,
    seconds REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS card_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deck_id TEXT NOT NULL,
    attempt_id INTEGER,
    card_key TEXT NOT NULL,
    front TEXT,
    ts REAL NOT NULL,
    qtype TEXT,
    verdict TEXT NOT NULL,
    score REAL
);
CREATE INDEX IF NOT EXISTS idx_sessions_deck ON study_sessions(deck_id);
CREATE INDEX IF NOT EXISTS idx_attempts_deck ON quiz_attempts(deck_id);
CREATE INDEX IF NOT EXISTS idx_results_card ON card_results(deck_id, card_key);
"""

VERDICT_WEIGHT = {"correct": 0.0, "close": 0.5, "wrong": 1.0}


def _day(ts: float) -> date:
    return datetime.fromtimestamp(ts).date()



def _csv_cell(v):
    """Card text and deck titles come from decks: stop spreadsheets reading them as formulas."""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v


class Stats:
    def __init__(self, path: Path | None = None):
        self.path = path or paths.data_dir() / "stats.db"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path))
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    # -- recording --------------------------------------------------------------
    def record_open(self, deck_id: str, title: str, path: str, ts: float | None = None) -> None:
        ts = ts or time.time()
        self.db.execute(
            """INSERT INTO deck_meta(deck_id, title, path, open_count, last_opened) VALUES(?,?,?,1,?)
               ON CONFLICT(deck_id) DO UPDATE SET title=excluded.title, path=excluded.path,
               open_count=open_count+1, last_opened=excluded.last_opened""",
            (deck_id, title, path, ts),
        )
        self.db.commit()

    def record_study(self, deck_id: str, seconds: float, started_at: float | None = None) -> None:
        if seconds < 3:  # ignore accidental clicks
            return
        started_at = started_at or (time.time() - seconds)
        self.db.execute("INSERT INTO study_sessions(deck_id, started_at, seconds) VALUES(?,?,?)",
                        (deck_id, started_at, min(seconds, 6 * 3600)))
        self.db.commit()

    def record_quiz(self, deck_id: str, results: list[dict], seconds: float = 0, ts: float | None = None) -> int:
        ts = ts or time.time()
        total = len(results)
        correct = sum(1 for r in results if r.get("verdict") == "correct")
        close = sum(1 for r in results if r.get("verdict") == "close")
        wrong = total - correct - close
        score = (correct + 0.5 * close) / total if total else 0.0
        cur = self.db.execute(
            "INSERT INTO quiz_attempts(deck_id, finished_at, total, correct, close, wrong, score, seconds) VALUES(?,?,?,?,?,?,?,?)",
            (deck_id, ts, total, correct, close, wrong, score, seconds),
        )
        attempt = cur.lastrowid
        self.db.executemany(
            "INSERT INTO card_results(deck_id, attempt_id, card_key, front, ts, qtype, verdict, score) VALUES(?,?,?,?,?,?,?,?)",
            [(deck_id, attempt, r.get("key", ""), r.get("front", ""), ts, r.get("type", ""), r.get("verdict", "wrong"),
              float(r.get("score", 0) or 0)) for r in results],
        )
        self.db.commit()
        return attempt

    # -- queries ----------------------------------------------------------------
    def deck_summary(self, deck_id: str, card_keys: list[str] | None = None) -> dict:
        meta = self.db.execute("SELECT * FROM deck_meta WHERE deck_id=?", (deck_id,)).fetchone()
        st = self.db.execute("SELECT COUNT(*) n, COALESCE(SUM(seconds),0) s FROM study_sessions WHERE deck_id=?",
                             (deck_id,)).fetchone()
        q = self.db.execute(
            "SELECT COUNT(*) n, MAX(score) best FROM quiz_attempts WHERE deck_id=?", (deck_id,)).fetchone()
        last = self.db.execute(
            "SELECT score, finished_at FROM quiz_attempts WHERE deck_id=? ORDER BY finished_at DESC LIMIT 1",
            (deck_id,)).fetchone()
        mastered = 0
        if card_keys:
            latest = self._latest_verdicts(deck_id)
            mastered = sum(1 for k in card_keys if latest.get(k) == "correct")
        return {
            "openCount": meta["open_count"] if meta else 0,
            "lastOpened": meta["last_opened"] if meta else None,
            "sessions": st["n"],
            "seconds": st["s"],
            "quizzes": q["n"],
            "bestScore": q["best"],
            "lastScore": last["score"] if last else None,
            "lastQuiz": last["finished_at"] if last else None,
            "mastered": mastered,
            "progress": (mastered / len(card_keys)) if card_keys else 0.0,
            "weakCount": len(self.weak_cards(deck_id)),
        }

    def _latest_verdicts(self, deck_id: str) -> dict:
        rows = self.db.execute(
            """SELECT card_key, verdict FROM card_results r WHERE deck_id=? AND ts = (
                   SELECT MAX(ts) FROM card_results r2 WHERE r2.deck_id=r.deck_id AND r2.card_key=r.card_key)""",
            (deck_id,)).fetchall()
        return {r["card_key"]: r["verdict"] for r in rows}

    def weak_cards(self, deck_id: str, window: int = 5, min_weakness: float = 0.34) -> list[dict]:
        rows = self.db.execute(
            "SELECT card_key, front, verdict, ts FROM card_results WHERE deck_id=? ORDER BY ts DESC", (deck_id,)
        ).fetchall()
        hist: dict[str, list] = {}
        fronts: dict[str, str] = {}
        for r in rows:
            h = hist.setdefault(r["card_key"], [])
            if len(h) < window:
                h.append(VERDICT_WEIGHT.get(r["verdict"], 1.0))
            fronts.setdefault(r["card_key"], r["front"])
        out = []
        for key, h in hist.items():
            # Recent answers count more.
            weights = [1.0 / (i + 1) for i in range(len(h))]
            weakness = sum(w * v for w, v in zip(weights, h)) / sum(weights)
            if weakness >= min_weakness:
                out.append({"key": key, "front": fronts[key], "weakness": round(weakness, 3), "attempts": len(h)})
        out.sort(key=lambda x: -x["weakness"])
        return out

    def score_history(self, deck_id: str | None = None, limit: int = 200) -> list[dict]:
        if deck_id:
            rows = self.db.execute(
                "SELECT * FROM quiz_attempts WHERE deck_id=? ORDER BY finished_at DESC LIMIT ?", (deck_id, limit))
        else:
            rows = self.db.execute("SELECT * FROM quiz_attempts ORDER BY finished_at DESC LIMIT ?", (limit,))
        return [dict(r) for r in rows.fetchall()][::-1]

    def activity(self, days: int = 371, today: date | None = None) -> list[dict]:
        today = today or date.today()
        start = today - timedelta(days=days - 1)
        start_ts = datetime.combine(start, datetime.min.time()).timestamp()
        acc: dict[date, dict] = {}
        for r in self.db.execute("SELECT started_at, seconds FROM study_sessions WHERE started_at>=?", (start_ts,)):
            d = acc.setdefault(_day(r["started_at"]), {"seconds": 0.0, "quizzes": 0, "cards": 0})
            d["seconds"] += r["seconds"]
        for r in self.db.execute("SELECT finished_at, total FROM quiz_attempts WHERE finished_at>=?", (start_ts,)):
            d = acc.setdefault(_day(r["finished_at"]), {"seconds": 0.0, "quizzes": 0, "cards": 0})
            d["quizzes"] += 1
            d["cards"] += r["total"]
        return [{"date": (start + timedelta(days=i)).isoformat(), **acc.get(start + timedelta(days=i),
                 {"seconds": 0.0, "quizzes": 0, "cards": 0})} for i in range(days)]

    def active_days(self) -> set[date]:
        days = {_day(r[0]) for r in self.db.execute("SELECT started_at FROM study_sessions WHERE seconds >= 30")}
        days |= {_day(r[0]) for r in self.db.execute("SELECT finished_at FROM quiz_attempts")}
        return days

    def streak(self, today: date | None = None) -> dict:
        today = today or date.today()
        days = self.active_days()
        current = 0
        d = today if today in days else today - timedelta(days=1)  # today not done yet keeps the streak
        while d in days:
            current += 1
            d -= timedelta(days=1)
        longest, run, prev = 0, 0, None
        for d in sorted(days):
            run = run + 1 if prev and d - prev == timedelta(days=1) else 1
            longest = max(longest, run)
            prev = d
        return {"current": current, "longest": longest, "studiedToday": today in days, "totalDays": len(days)}

    def overview(self) -> dict:
        tot = self.db.execute("SELECT COALESCE(SUM(seconds),0) FROM study_sessions").fetchone()[0]
        q = self.db.execute("SELECT COUNT(*), COALESCE(AVG(score),0), COALESCE(SUM(total),0) FROM quiz_attempts").fetchone()
        per_deck = [dict(r) for r in self.db.execute(
            """SELECT m.deck_id, m.title, m.open_count, m.last_opened,
                      (SELECT COALESCE(SUM(seconds),0) FROM study_sessions s WHERE s.deck_id=m.deck_id) seconds,
                      (SELECT COUNT(*) FROM quiz_attempts a WHERE a.deck_id=m.deck_id) quizzes,
                      (SELECT MAX(score) FROM quiz_attempts a WHERE a.deck_id=m.deck_id) best,
                      (SELECT AVG(score) FROM quiz_attempts a WHERE a.deck_id=m.deck_id) avg
               FROM deck_meta m ORDER BY m.last_opened DESC""")]
        return {"totalSeconds": tot, "quizzes": q[0], "avgScore": q[1], "questionsAnswered": q[2],
                "streak": self.streak(), "decks": per_deck}

    # -- maintenance ----------------------------------------------------------------
    def reset_deck(self, deck_id: str) -> None:
        for t in ("study_sessions", "quiz_attempts", "card_results", "deck_meta"):
            self.db.execute(f"DELETE FROM {t} WHERE deck_id=?", (deck_id,))
        self.db.commit()

    def reset_all(self) -> None:
        for t in ("study_sessions", "quiz_attempts", "card_results", "deck_meta"):
            self.db.execute(f"DELETE FROM {t}")
        self.db.commit()

    def dump(self) -> dict:
        return {t: [dict(r) for r in self.db.execute(f"SELECT * FROM {t}")]
                for t in ("deck_meta", "study_sessions", "quiz_attempts", "card_results")}

    def load(self, data: dict, replace: bool = True) -> None:
        if replace:
            self.reset_all()
        for t in ("deck_meta", "study_sessions", "quiz_attempts", "card_results"):
            rows = [r for r in (data.get(t) or []) if isinstance(r, dict)]
            if not rows:
                continue
            # Backups may come from someone else: only this table's own columns go into the SQL.
            known = {r[1] for r in self.db.execute(f"PRAGMA table_info({t})")}
            cols = [c for c in rows[0].keys() if c in known and (c != "id" or t == "deck_meta")]
            if not cols:
                continue
            q = f"INSERT OR REPLACE INTO {t}({','.join(cols)}) VALUES({','.join('?' * len(cols))})"
            self.db.executemany(q, [tuple(r.get(c) for c in cols) for r in rows])
        self.db.commit()

    def export_json(self) -> str:
        return json.dumps({"version": 1, "exported": time.time(), **self.dump()}, indent=2, ensure_ascii=False)

    def export_csv(self) -> dict[str, str]:
        """Return {filename: csv text} for quiz attempts, card results and study sessions."""
        titles = {r["deck_id"]: r["title"] for r in self.db.execute("SELECT deck_id, title FROM deck_meta")}
        out = {}
        for t, cols in (("quiz_attempts", ["finished_at", "deck_id", "total", "correct", "close", "wrong", "score", "seconds"]),
                        ("card_results", ["ts", "deck_id", "card_key", "front", "qtype", "verdict", "score"]),
                        ("study_sessions", ["started_at", "deck_id", "seconds"])):
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["datetime", "deck"] + cols[1:])
            for r in self.db.execute(f"SELECT {','.join(cols)} FROM {t} ORDER BY {cols[0]}"):
                row = list(r)
                w.writerow([_csv_cell(v) for v in [datetime.fromtimestamp(row[0]).isoformat(timespec="seconds"),
                                                   titles.get(row[1], row[1])] + row[1:]])
            out[f"{t}.csv"] = buf.getvalue()
        return out
