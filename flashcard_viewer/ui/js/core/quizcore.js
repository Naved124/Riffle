// Build mixed quizzes and grade responses (port of flashcard_viewer/quiz.py).
import { booleanValue, grade, normalize } from './similarity.js';

const TYPES = ['typed', 'mc', 'tf'];
const STYLE_WEIGHTS = { normal: 0.5, reverse: 0.2, cloze: 0.2, explain: 0.1 };
export const BLANK = '_____';
const ASK = {
  reverse: 'Work backwards: which of these has this answer?',
  'reverse-typed': 'Work backwards: what is on the front of this card?',
  cloze: 'Fill in the blank',
  explain: 'Which answer goes with this explanation?',
};
const STOP = new Set(`
  about above after again against also although among another because been before being below between both
  cannot could does doing down during each either every from further have having here into itself just like
  made make makes many more most much must only other ours over same should since some such than that their
  theirs them then there these they this those though through thus under until upon very were what when where
  which while whom whose will with within without would your yours
  across always around called usually often never include includes including known mainly mostly plus minus
  something thing things using used uses kind kinds type types part parts`.split(/\s+/).filter(Boolean));
const WORD_RX = /\p{L}[\p{L}\p{M}]*(?:['’-]\p{L}[\p{L}\p{M}]*)*/gu;
// Maths, code, tags and links are never blanked (or counted as words).
const SKIP_RX = /\$\$[\s\S]+?\$\$|\$[^$\n]+\$|`[^`]*`|<[^>]*>|https?:\/\/\S+/g;

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

// ------------------------------------------------------------------ other ways to ask a card
// (port of the same section of quiz.py)
const nWords = (s) => String(s || '').split(/\s+/).filter(Boolean).length;
const isUpper = (w) => w === w.toUpperCase() && w !== w.toLowerCase();
const words = (text) => [...String(text || '').replace(SKIP_RX, (m) => ' '.repeat(m.length)).matchAll(WORD_RX)];
const contentWords = (text) => new Set(words(text).map((m) => m[0]).filter((w) => w.length >= 4 && !STOP.has(w.toLowerCase())).map((w) => w.toLowerCase()));

function cloze(card, df, rng) {
  const frontWords = contentWords(card.front);
  for (const source of [card.back, card.explanation || '']) {
    if (nWords(source) < 5) continue;
    const cands = new Map();
    for (const m of words(source)) {
      const w = m[0], f = w.toLowerCase();
      if (w.length < 5 || STOP.has(f) || frontWords.has(f) || cands.has(f)) continue;
      cands.set(f, w);
    }
    if (!cands.size) continue;
    const ranked = [...cands.keys()].map((f) => [df.get(f) || 0, -f.length, rng(), f]).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).map((x) => x[3]);
    const word = cands.get(ranked.length > 1 && rng() < 0.3 ? ranked[1] : ranked[0]); // mostly the best word
    // Blank every occurrence, so a second one doesn't give the answer away.
    let out = '', last = 0;
    for (const m of words(source)) {
      if (m[0].toLowerCase() === word.toLowerCase()) { out += source.slice(last, m.index) + BLANK; last = m.index + m[0].length; }
    }
    return [out + source.slice(last), word, source];
  }
  return null;
}

// Match a distractor's capitalisation to the answer's, so case doesn't give the answer away.
function shapeLike(word, like) {
  if (isUpper(word) || isUpper(like)) return word;
  return /^\p{Lu}/u.test(like) ? word[0].toUpperCase() + word.slice(1) : word.toLowerCase();
}

function clozeDistractors(word, source, vocab, rng, k = 3) {
  const ans = word.toLowerCase();
  const used = contentWords(source);
  const scored = [];
  for (const [f, w] of vocab) {
    if (used.has(f) || f.slice(0, 5) === ans.slice(0, 5)) continue;
    const score = -Math.abs(f.length - ans.length) / 3 + (isUpper(w) === isUpper(word) ? 1 : 0);
    scored.push([score + rng() * 0.75, shapeLike(w, word)]);
  }
  scored.sort((x, y) => y[0] - x[0]);
  return rng.shuffle(scored.slice(0, k + 2).map((x) => x[1])).slice(0, k);
}

function frontDistractors(card, pool, rng, k = 3) {
  const seen = new Set([normalize(card.front)]);
  const scored = [];
  for (const other of pool) {
    const nf = normalize(other.front);
    if (!nf || seen.has(nf)) continue;
    seen.add(nf);
    let score = other.category && other.category === card.category ? 1 : 0;
    score -= Math.abs(Math.log((other.front.length + 5) / (card.front.length + 5)));
    scored.push([score + rng() * 0.75, other.front]);
  }
  scored.sort((x, y) => y[0] - x[0]);
  return rng.shuffle(scored.slice(0, k + 2).map((x) => x[1])).slice(0, k);
}

function pick(weights, rng) {
  const entries = Object.entries(weights);
  let r = rng() * entries.reduce((s, [, v]) => s + v, 0);
  for (const [t, v] of entries) { r -= v; if (r <= 0) return t; }
  return entries[0][0];
}

// Ask `card` another way, or null to ask it normally.
function varied(card, pool, enabled, rng, ctx) {
  const kind = answerKind(card.back);
  const expl = card.explanation || '';
  const options = { normal: STYLE_WEIGHTS.normal };
  const askable = enabled.has('mc') || enabled.has('typed');
  if (kind !== 'boolean' && ctx.backs.get(normalize(card.back)) === 1 && askable) options.reverse = STYLE_WEIGHTS.reverse;
  if (askable && (nWords(card.back) >= 5 || nWords(expl) >= 5)) options.cloze = STYLE_WEIGHTS.cloze;
  if (kind !== 'boolean' && nWords(expl) >= 4) {
    const backWords = contentWords(card.back);
    if (card.back.length >= 2) backWords.add(normalize(card.back));
    const ne = normalize(expl);
    if (![...backWords].some((w) => ne.includes(w))) options.explain = STYLE_WEIGHTS.explain;
  }
  const style = pick(options, rng);
  if (style === 'normal') return null;

  const q = { style, front: card.front, hint: card.hint || '', category: card.category || '', explanation: expl };
  if (style === 'reverse') {
    const ds = frontDistractors(card, pool, rng);
    const w = {};
    if (enabled.has('mc') && ds.length >= 2) w.mc = 0.7;
    if (enabled.has('typed') && answerKind(card.front) === 'short' && !card.front.includes('?')) w.typed = 0.3;
    if (!Object.keys(w).length) return null;
    const type = pick(w, rng);
    Object.assign(q, { type, prompt: card.back, answer: card.front, ask: ASK[type === 'mc' ? 'reverse' : 'reverse-typed'] });
    if (type === 'mc') {
      q.choices = rng.shuffle(ds.slice(0, 3).concat([card.front]));
      q.correctIndex = q.choices.indexOf(card.front);
    }
    return q;
  }
  if (style === 'cloze') {
    const made = cloze(card, ctx.df, rng);
    if (!made) return null;
    const [sentence, word, source] = made;
    const ds = clozeDistractors(word, source, ctx.vocab, rng);
    const w = {};
    if (enabled.has('typed')) w.typed = 0.6;
    if (enabled.has('mc') && ds.length >= 3) w.mc = 0.4;
    if (!Object.keys(w).length) return null;
    const type = pick(w, rng);
    // The card's question stays visible as context; the full sentence is shown after answering.
    Object.assign(q, { type, prompt: sentence, answer: word, ask: ASK.cloze, context: card.front,
      explanation: source === expl ? source : [source, expl].filter(Boolean).join(' ') });
    if (type === 'mc') {
      q.choices = rng.shuffle(ds.slice(0, 3).concat([word]));
      q.correctIndex = q.choices.indexOf(word);
    }
    return q;
  }
  // explain: the explanation is the clue; the card's question is shown after answering.
  return Object.assign(q, { prompt: expl, answer: card.back, ask: ASK.explain, explanation: card.front });
}

export function buildQuiz(cards, { count = 10, types = TYPES, weakKeys = [], onlyWeak = false, shuffle = true, seed = null, vary = false } = {}) {
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

  let ctx = null;
  if (vary) {
    ctx = { backs: new Map(), df: new Map(), vocab: new Map() };
    for (const c of pool) {
      const nb = normalize(c.back);
      ctx.backs.set(nb, (ctx.backs.get(nb) || 0) + 1);
      for (const text of [c.front, c.back, c.explanation || '']) {
        for (const m of words(text)) {
          const w = m[0];
          if (w.length >= 4 && !STOP.has(w.toLowerCase()) && !ctx.vocab.has(w.toLowerCase())) ctx.vocab.set(w.toLowerCase(), w);
        }
      }
      for (const f of contentWords(`${c.front} ${c.back} ${c.explanation || ''}`)) ctx.df.set(f, (ctx.df.get(f) || 0) + 1);
    }
  }

  return chosen.map((card, i) => {
    const ds = distractors(card, pool, rng, 3);
    const v = vary ? varied(card, pool, enabled, rng, ctx) : null;
    if (v && v.type) return { id: i, key: card.key, ...v };
    const type = chooseType(card, enabled, rng, ds.length);
    const q = { id: i, key: card.key, front: card.front, type, prompt: card.front, answer: card.back, hint: card.hint || '', explanation: card.explanation || '', category: card.category || '' };
    if (v) Object.assign(q, v); // "explain": same answer and question types as usual, different clue
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
