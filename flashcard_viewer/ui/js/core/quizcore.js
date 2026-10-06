// Build mixed quizzes and grade responses (port of flashcard_viewer/quiz.py).
import { booleanValue, grade, normalize } from './similarity.js';

const TYPES = ['typed', 'mc', 'tf'];

// Small seedable PRNG (mulberry32) so tests are deterministic.
export function makeRng(seed) {
  let a = seed == null ? Math.floor(Math.random() * 2 ** 32) : seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rnd.shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  rnd.choice = (arr) => arr[Math.floor(rnd() * arr.length)];
  rnd.sample = (arr, k) => rnd.shuffle([...arr]).slice(0, k);
  return rnd;
}

export function answerKind(answer) {
  if (booleanValue(answer) !== null) return 'boolean';
  const words = answer.split(/\s+/).filter(Boolean).length;
  if (words <= 4 && answer.length <= 32) return 'short';
  if (words <= 12) return 'medium';
  return 'long';
}
const isNumeric = (s) => /^[\d\s.,%/:+-]+[a-zA-Z²³/%°]*$/.test(s.trim());

function distractors(card, pool, rng, k = 3) {
  const answerN = normalize(card.back);
  if (card.choices && card.choices.length) {
    const own = card.choices.filter((c) => normalize(c) !== answerN);
    if (own.length >= k) return rng.sample(own, k);
  }
  const kind = answerKind(card.back);
  const numeric = isNumeric(card.back);
  const scored = [];
  const seen = new Set([answerN]);
  for (const other of pool) {
    const b = other.back;
    const nb = normalize(b);
    if (!nb || seen.has(nb) || other.key === card.key) continue;
    if (booleanValue(b) !== null) continue;
    seen.add(nb);
    let score = 0;
    if (isNumeric(b) === numeric) score += 2;
    if (answerKind(b) === kind) score += 1;
    if (other.category && other.category === card.category) score += 1;
    score -= Math.abs(Math.log((b.length + 5) / (card.back.length + 5)));
    scored.push([score + rng() * 0.75, b]);
  }
  scored.sort((x, y) => y[0] - x[0]);
  let picks = rng.shuffle(scored.slice(0, k + 2).map((x) => x[1])).slice(0, k);
  if (card.choices && card.choices.length && picks.length < k) {
    picks = card.choices.filter((c) => normalize(c) !== answerN).slice(0, k - picks.length).concat(picks);
  }
  if (numeric && picks.length < k) {
    const m = /\d+/.exec(card.back);
    if (m) {
      const n = parseInt(m[0], 10);
      for (const d of [1, -1, 2, 10, -2]) {
        const fake = card.back.replace(m[0], String(n + d));
        if (!seen.has(normalize(fake)) && picks.length < k) { picks.push(fake); seen.add(normalize(fake)); }
      }
    }
  }
  return picks;
}

function chooseType(card, enabled, rng, nd) {
  const kind = answerKind(card.back);
  let w;
  if (kind === 'boolean') w = { tf: 1.0, typed: 0.15 };
  else if (card.choices && card.choices.length) w = { mc: 0.75, typed: kind === 'short' ? 0.25 : 0, tf: 0.1 };
  else if (kind === 'short') w = { typed: 0.6, mc: 0.25, tf: 0.15 };
  else if (kind === 'medium') w = { typed: 0.3, mc: 0.45, tf: 0.25 };
  else w = { mc: 0.7, tf: 0.3 };
  if (nd < 2) delete w.mc;
  if (nd < 1 && kind !== 'boolean') delete w.tf;
  const entries = Object.entries(w).filter(([t, v]) => enabled.has(t) && v > 0);
  if (!entries.length) {
    for (const t of TYPES) {
      if (enabled.has(t) && (t !== 'mc' || nd >= 2) && (t !== 'tf' || nd || kind === 'boolean')) return t;
    }
    return 'typed';
  }
  let r = rng() * entries.reduce((s, [, v]) => s + v, 0);
  for (const [t, v] of entries) { r -= v; if (r <= 0) return t; }
  return entries[0][0];
}

export function buildQuiz(cards, { count = 10, types = TYPES, weakKeys = [], onlyWeak = false, shuffle = true, seed = null } = {}) {
  const rng = makeRng(seed);
  const enabled = new Set(types.filter((t) => TYPES.includes(t)));
  if (!enabled.size) enabled.add('typed');
  const pool = cards.filter((c) => c.front.trim() && c.back.trim());
  if (!pool.length) return [];
  let chosen;
  if (onlyWeak && weakKeys.length) {
    const ws = new Set(weakKeys);
    chosen = pool.filter((c) => ws.has(c.key));
    if (!chosen.length) chosen = [...pool];
  } else chosen = [...pool];
  if (shuffle) {
    rng.shuffle(chosen);
    if (weakKeys.length) {
      const order = new Map(weakKeys.map((k, i) => [k, i]));
      chosen.sort((a, b) => (order.get(a.key) ?? order.size) - (order.get(b.key) ?? order.size));
    }
  }
  if (count && count > 0) chosen = chosen.slice(0, count);

  return chosen.map((card, i) => {
    const ds = distractors(card, pool, rng, 3);
    const type = chooseType(card, enabled, rng, ds.length);
    const q = { id: i, key: card.key, type, prompt: card.front, answer: card.back, hint: card.hint || '', explanation: card.explanation || '', category: card.category || '' };
    if (type === 'mc') {
      const opts = rng.shuffle(ds.slice(0, 3).concat([card.back]));
      q.choices = opts;
      q.correctIndex = opts.indexOf(card.back);
    } else if (type === 'tf') {
      const b = booleanValue(card.back);
      if (b !== null) {
        q.choices = /^\s*(yes|no)\b/i.test(card.back) ? ['Yes', 'No'] : ['True', 'False'];
        q.statement = '';
        q.truth = b;
      } else {
        const truthful = rng() < 0.5 || !ds.length;
        q.choices = ['True', 'False'];
        q.statement = truthful ? card.back : rng.choice(ds);
        q.truth = truthful;
      }
    }
    return q;
  });
}

export function gradeResponse(question, response, threshold = 0.75, strip = true) {
  if (question.type === 'mc') {
    const ok = Number(response) === Number(question.correctIndex) && response !== null && response !== '';
    return { verdict: ok ? 'correct' : 'wrong', score: ok ? 1 : 0, matched: question.answer, note: '' };
  }
  if (question.type === 'tf') {
    let val = null;
    if (typeof response === 'string') {
      const r = response.trim().toLowerCase();
      val = ['true', 'yes', 't', 'y'].includes(r) ? true : ['false', 'no', 'f', 'n'].includes(r) ? false : null;
    } else if (response !== null && response !== undefined) val = !!response;
    const ok = val !== null && val === !!question.truth;
    return { verdict: ok ? 'correct' : 'wrong', score: ok ? 1 : 0, matched: question.answer, note: '' };
  }
  return grade(question.answer, String(response ?? ''), threshold, strip);
}
