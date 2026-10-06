// Study tracker over in-memory tables (port of flashcard_viewer/stats.py; persisted by backend.js).

const VERDICT_WEIGHT = { correct: 0, close: 0.5, wrong: 1 };
const dayKey = (ts) => {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const now = () => Date.now() / 1000;
const addDays = (key, n) => {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return dayKey(dt.getTime() / 1000);
};

export class Stats {
  constructor(data) {
    this.load(data || {});
  }

  load(data) {
    this.meta = data.deck_meta || [];
    this.sessions = data.study_sessions || [];
    this.attempts = data.quiz_attempts || [];
    this.results = data.card_results || [];
    this.nextId = Math.max(0, ...this.attempts.map((a) => a.id || 0)) + 1;
  }

  dump() {
    return { deck_meta: this.meta, study_sessions: this.sessions, quiz_attempts: this.attempts, card_results: this.results };
  }

  recordOpen(deckId, title, path, ts = now()) {
    const m = this.meta.find((x) => x.deck_id === deckId);
    if (m) Object.assign(m, { title, path, open_count: m.open_count + 1, last_opened: ts });
    else this.meta.push({ deck_id: deckId, title, path, open_count: 1, last_opened: ts });
  }

  recordStudy(deckId, seconds, startedAt = null) {
    if (seconds < 3) return;
    this.sessions.push({ deck_id: deckId, started_at: startedAt ?? now() - seconds, seconds: Math.min(seconds, 6 * 3600) });
  }

  recordQuiz(deckId, results, seconds = 0, ts = now()) {
    const total = results.length;
    const correct = results.filter((r) => r.verdict === 'correct').length;
    const close = results.filter((r) => r.verdict === 'close').length;
    const wrong = total - correct - close;
    const score = total ? (correct + 0.5 * close) / total : 0;
    const id = this.nextId++;
    this.attempts.push({ id, deck_id: deckId, finished_at: ts, total, correct, close, wrong, score, seconds });
    for (const r of results) {
      this.results.push({ deck_id: deckId, attempt_id: id, card_key: r.key || '', front: r.front || '', ts, qtype: r.type || '', verdict: r.verdict || 'wrong', score: Number(r.score || 0) });
    }
    return id;
  }

  latestVerdicts(deckId) {
    const out = new Map();
    const best = new Map();
    for (const r of this.results) {
      if (r.deck_id !== deckId) continue;
      if (!best.has(r.card_key) || r.ts >= best.get(r.card_key)) { best.set(r.card_key, r.ts); out.set(r.card_key, r.verdict); }
    }
    return out;
  }

  weakCards(deckId, windowSize = 5, minWeakness = 0.34) {
    const rows = this.results.filter((r) => r.deck_id === deckId).sort((a, b) => b.ts - a.ts);
    const hist = new Map(), fronts = new Map();
    for (const r of rows) {
      const h = hist.get(r.card_key) || [];
      if (h.length < windowSize) h.push(VERDICT_WEIGHT[r.verdict] ?? 1);
      hist.set(r.card_key, h);
      if (!fronts.has(r.card_key)) fronts.set(r.card_key, r.front);
    }
    const out = [];
    for (const [key, h] of hist) {
      const w = h.map((_, i) => 1 / (i + 1));
      const weakness = h.reduce((s, v, i) => s + w[i] * v, 0) / w.reduce((a, b) => a + b, 0);
      if (weakness >= minWeakness) out.push({ key, front: fronts.get(key), weakness: Math.round(weakness * 1000) / 1000, attempts: h.length });
    }
    return out.sort((a, b) => b.weakness - a.weakness);
  }

  deckSummary(deckId, cardKeys = null) {
    const meta = this.meta.find((m) => m.deck_id === deckId);
    const sess = this.sessions.filter((s) => s.deck_id === deckId);
    const att = this.attempts.filter((a) => a.deck_id === deckId).sort((a, b) => a.finished_at - b.finished_at);
    const last = att[att.length - 1];
    let mastered = 0;
    if (cardKeys && cardKeys.length) {
      const latest = this.latestVerdicts(deckId);
      mastered = cardKeys.filter((k) => latest.get(k) === 'correct').length;
    }
    return {
      openCount: meta ? meta.open_count : 0,
      lastOpened: meta ? meta.last_opened : null,
      sessions: sess.length,
      seconds: sess.reduce((s, x) => s + x.seconds, 0),
      quizzes: att.length,
      bestScore: att.length ? Math.max(...att.map((a) => a.score)) : null,
      lastScore: last ? last.score : null,
      lastQuiz: last ? last.finished_at : null,
      mastered,
      progress: cardKeys && cardKeys.length ? mastered / cardKeys.length : 0,
      weakCount: this.weakCards(deckId).length,
    };
  }

  scoreHistory(deckId = null, limit = 200) {
    return this.attempts.filter((a) => !deckId || a.deck_id === deckId).sort((a, b) => a.finished_at - b.finished_at).slice(-limit);
  }

  activity(days = 371) {
    const today = dayKey(now());
    const start = addDays(today, -(days - 1));
    const acc = new Map();
    const get = (k) => { if (!acc.has(k)) acc.set(k, { seconds: 0, quizzes: 0, cards: 0 }); return acc.get(k); };
    for (const s of this.sessions) { const k = dayKey(s.started_at); if (k >= start) get(k).seconds += s.seconds; }
    for (const a of this.attempts) { const k = dayKey(a.finished_at); if (k >= start) { const d = get(k); d.quizzes += 1; d.cards += a.total; } }
    const out = [];
    for (let i = 0; i < days; i++) {
      const k = addDays(start, i);
      out.push({ date: k, ...(acc.get(k) || { seconds: 0, quizzes: 0, cards: 0 }) });
    }
    return out;
  }

  activeDays() {
    const days = new Set();
    for (const s of this.sessions) if (s.seconds >= 30) days.add(dayKey(s.started_at));
    for (const a of this.attempts) days.add(dayKey(a.finished_at));
    return days;
  }

  streak() {
    const today = dayKey(now());
    const days = this.activeDays();
    let current = 0;
    let d = days.has(today) ? today : addDays(today, -1);
    while (days.has(d)) { current++; d = addDays(d, -1); }
    let longest = 0, run = 0, prev = null;
    for (const k of [...days].sort()) {
      run = prev && addDays(prev, 1) === k ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = k;
    }
    return { current, longest, studiedToday: days.has(today), totalDays: days.size };
  }

  overview() {
    const decks = this.meta.map((m) => {
      const att = this.attempts.filter((a) => a.deck_id === m.deck_id);
      return {
        deck_id: m.deck_id, title: m.title, open_count: m.open_count, last_opened: m.last_opened,
        seconds: this.sessions.filter((s) => s.deck_id === m.deck_id).reduce((s, x) => s + x.seconds, 0),
        quizzes: att.length, best: att.length ? Math.max(...att.map((a) => a.score)) : null,
        avg: att.length ? att.reduce((s, a) => s + a.score, 0) / att.length : null,
      };
    }).sort((a, b) => (b.last_opened || 0) - (a.last_opened || 0));
    return {
      totalSeconds: this.sessions.reduce((s, x) => s + x.seconds, 0),
      quizzes: this.attempts.length,
      avgScore: this.attempts.length ? this.attempts.reduce((s, a) => s + a.score, 0) / this.attempts.length : 0,
      questionsAnswered: this.attempts.reduce((s, a) => s + a.total, 0),
      streak: this.streak(),
      decks,
    };
  }

  resetDeck(deckId) {
    const keep = (x) => x.deck_id !== deckId;
    this.meta = this.meta.filter(keep);
    this.sessions = this.sessions.filter(keep);
    this.attempts = this.attempts.filter(keep);
    this.results = this.results.filter(keep);
  }

  resetAll() { this.load({}); }

  exportCsv(titles = {}) {
    // Card text and deck titles come from decks: stop spreadsheets reading them as formulas.
    const esc = (v) => {
      let s = String(v ?? '');
      if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const iso = (ts) => new Date(ts * 1000).toISOString().slice(0, 19);
    const block = (name, cols, rows, tsCol) => [
      `# ${name}`,
      ['datetime', 'deck', ...cols.filter((c) => c !== tsCol)].join(','),
      ...rows.map((r) => [iso(r[tsCol]), esc(titles[r.deck_id] || r.deck_id), ...cols.filter((c) => c !== tsCol).map((c) => esc(r[c]))].join(',')),
    ].join('\n');
    return [
      block('quiz_attempts', ['finished_at', 'deck_id', 'total', 'correct', 'close', 'wrong', 'score', 'seconds'], this.attempts, 'finished_at'),
      block('card_results', ['ts', 'deck_id', 'card_key', 'front', 'qtype', 'verdict', 'score'], this.results, 'ts'),
      block('study_sessions', ['started_at', 'deck_id', 'seconds'], this.sessions, 'started_at'),
    ].join('\n\n') + '\n';
  }
}
