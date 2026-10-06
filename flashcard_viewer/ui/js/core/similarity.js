// Fuzzy answer grading without ML (port of flashcard_viewer/similarity.py).

const set = (s) => new Set(s.split(' '));
const STOPWORDS = set('a an the is are was were be been it its it\'s of to in on at by for and or that this these those with as from into '
  + 'which what who whom do does did you they we he she their there then so also just very can will would should could has have '
  + 'had um uh basically like called known el la los las le les der die das');
const OPTIONAL = set('amazon aws service command function process approximately about around');
const NEGATIONS = set('not no never none nothing cannot cant isnt arent doesnt dont wont wasnt werent without false incorrect');
const NUMBER_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90',
  hundred: '100', thousand: '1000', first: '1', second: '2', third: '3',
};
const TRUE_WORDS = set('true yes y t correct right yeah yep si sí');
const FALSE_WORDS = set('false no n f incorrect wrong nope');
const W = '\\p{L}\\p{N}\\p{M}_';

const stripAccents = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '');

export function normalize(s, strip = true) {
  s = String(s).normalize('NFKC').toLowerCase();
  if (strip) s = stripAccents(s);
  s = s.replace(/[’‘]/g, "'");
  s = s.replace(/\\(?:frac|left|right|mathrm|text|,|;|!)/g, ' ');
  s = s.replace(new RegExp(`(?<=[${W}])'(?=[${W}])`, 'gu'), '');
  s = s.replace(new RegExp(`[^${W}\\s./+\\-=<>&|~#%^*]`, 'gu'), ' ');
  s = s.replace(new RegExp(`[.\\-/]+(?![${W}])`, 'gu'), ' ');
  return s.replace(/\s+/g, ' ').trim();
}

const SUFFIXES = ['ations', 'ation', 'ingly', 'ings', 'ing', 'edly', 'ies', 'ied', 'ers', 'est', 'ed', 'es', 'ly', 'er', 's'];
function stem(w) {
  if (w.length <= 4 || !/^\p{L}+$/u.test(w)) return w;
  for (const suf of SUFFIXES) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length);
  }
  return w;
}
const tokens = (norm) => (norm ? norm.split(' ').map((t) => NUMBER_WORDS[t] || t) : []);
function keywords(toks) {
  let kw = toks.filter((t) => !STOPWORDS.has(t) && !OPTIONAL.has(t)).map(stem);
  if (!kw.length) {
    kw = toks.filter((t) => !STOPWORDS.has(t)).map(stem);
    if (!kw.length) kw = toks.map(stem);
  }
  return kw;
}

function lev(a, b) {
  if (a === b) return 0;
  const A = [...a], B = [...b];
  if (A.length < B.length) return lev(b, a);
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] !== B[j - 1] ? 1 : 0)));
    prev = cur;
  }
  return prev[B.length];
}
function ratio(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const la = [...a].length, lb = [...b].length;
  if (la + lb > 3000) { // very long answers: cheap bigram overlap
    const bg = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) || 0) + 1); return m; };
    const x = bg(a), y = bg(b);
    let inter = 0;
    for (const [k, v] of x) inter += Math.min(v, y.get(k) || 0);
    return (2 * inter) / (a.length + b.length - 2);
  }
  return 1 - lev(a, b) / Math.max(la, lb);
}
function tokSim(a, b) {
  if (a === b) return 1;
  if (a.startsWith('-') && b.startsWith('-') && !a.startsWith('--') && [...a].sort().join('') === [...b].sort().join('')) return 1;
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) return 0;
  const r = ratio(a, b);
  if (Math.min(a.length, b.length) <= 3) return r >= 0.99 ? r : 0;
  return r >= 0.75 ? r : 0;
}
function coverage(src, dst) {
  if (!src.length) return 0;
  let total = 0;
  for (const t of src) total += Math.max(0, ...dst.map((u) => tokSim(t, u)));
  return total / src.length;
}

const NUM = /\d+(?:[.,]\d+)?/g;
const ROMAN = /(?<![\p{L}\p{N}_'])(II|III|IV|VI|VII|VIII|IX|XI|XII|I|V|X)(?![\p{L}\p{N}_'])/gu;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function answerVariants(answer) {
  const a = String(answer).trim();
  const out = [a];
  const parts = a.split(/\s+\/\s+|\s+or\s+|\s*;\s*|\n/);
  if (parts.length > 1) out.push(...parts.filter((p) => p.trim()));
  for (const p of [...out]) {
    let m = /^(.*?)\s*\(([^)]+)\)\s*(.*)$/s.exec(p);
    if (m) {
      const outside = `${m[1]} ${m[3]}`.trim();
      if (outside) out.push(outside);
      out.push(m[2].trim());
    }
    m = /^(yes|no|true|false)\b\s*[—–\-,:.]/i.exec(p);
    if (m) out.push(m[1]);
    m = /^(.{3,}?)\s+[—–]\s+.+$/s.exec(p);
    if (m) out.push(m[1]);
  }
  const seen = new Set();
  const uniq = [];
  for (const v of out) {
    const k = v.trim().toLowerCase();
    if (k && !seen.has(k)) { seen.add(k); uniq.push(v.trim()); }
  }
  return uniq;
}

export function booleanValue(answer) {
  const m = /^\s*(true|false|yes|no)\b\s*(?:$|[—–\-,:.!])/i.exec(String(answer));
  if (!m) return null;
  return ['true', 'yes'].includes(m[1].toLowerCase());
}

function scoreOne(expected, given, strip) {
  const en = normalize(expected, strip), gn = normalize(given, strip);
  if (!gn) return 0;
  if (en === gn) return 1;
  const et = tokens(en), gt = tokens(gn);
  if (et.join(' ') === gt.join(' ')) return 1;
  const ek = keywords(et), gk = keywords(gt);
  if (ek.join(' ') === gk.join(' ')) return 0.98;
  let char = ratio(ek.join(''), gk.join(''));
  let charFull = ratio(en.replace(/ /g, ''), gn.replace(/ /g, ''));
  if (Math.max(en.length, gn.length) <= 4) {
    char = char >= 0.99 ? char : 0;
    charFull = charFull >= 0.99 ? charFull : 0;
  }
  const recall = coverage(ek, gk);
  const precision = coverage(gk, ek);
  let tok = 0.7 * recall + 0.3 * precision;
  if ([...ek].sort().join(' ') === [...gk].sort().join(' ')) tok = Math.max(tok, 0.97);
  let score = Math.max(char, 0.85 * charFull, tok);
  if (en.length >= 3 && new RegExp(`(?<![${W}])${escapeRe(en)}(?![${W}])`, 'u').test(gn) && gn.length <= 3 * en.length + 15) {
    score = Math.max(score, 0.93);
  } else if (recall >= 0.999 && gk.length <= 2 * ek.length + 4) {
    score = Math.max(score, 0.9);
  }
  return Math.min(score, 1);
}

export function similarity(expected, given, strip = true) {
  let best = 0, bestV = expected;
  for (const v of answerVariants(expected)) {
    const s = scoreOne(v, given, strip);
    if (s > best) { best = s; bestV = v; }
  }
  return [best, bestV];
}

const r3 = (x) => Math.round(x * 1000) / 1000;

export function grade(expected, given, threshold = 0.75, strip = true, extraAnswers = []) {
  given = String(given ?? '').trim();
  if (!given) return { score: 0, verdict: 'wrong', matched: expected, note: 'No answer given' };
  threshold = Math.min(Math.max(threshold, 0.3), 1);

  const eb = booleanValue(expected);
  if (eb !== null && ['true', 'false', 'yes', 'no'].includes(normalize(expected))) {
    const gw = normalize(given).split(' ');
    const gb = gw[0] && TRUE_WORDS.has(gw[0]) ? true : gw[0] && FALSE_WORDS.has(gw[0]) ? false : null;
    if (gb !== null) return { score: gb === eb ? 1 : 0, verdict: gb === eb ? 'correct' : 'wrong', matched: expected, note: '' };
  }

  let score = 0, matched = expected;
  for (const c of [expected, ...extraAnswers]) {
    const [s, m] = similarity(c, given, strip);
    if (s > score) { score = s; matched = m; }
  }
  let note = '';
  const expNums = new Set(normalize(matched).match(NUM) || []);
  const givNums = new Set(tokens(normalize(given)).join(' ').match(NUM) || []);
  if (expNums.size && ![...expNums].every((n) => givNums.has(n))) {
    if (score >= threshold) { score = Math.min(score, threshold - 0.01); note = 'Check the numbers'; }
    if (givNums.size && ![...expNums].some((n) => givNums.has(n)) && expNums.size === 1 && normalize(matched).split(' ').length === 1) {
      score = Math.min(score, 0.2);
    }
  }
  const romanSrc = matched.trim().startsWith('I ') ? matched.trim().slice(1) : matched;
  const expRom = new Set([...romanSrc.matchAll(ROMAN)].map((m) => m[1]));
  const givRom = new Set([...given.toUpperCase().matchAll(ROMAN)].map((m) => m[1]));
  const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  if (expRom.size && givRom.size && !sameSet(expRom, givRom) && score >= threshold) {
    score = Math.min(score, threshold - 0.01);
    note = 'Check the numeral';
  }
  const enT = new Set(tokens(normalize(matched)));
  const gnT = new Set(tokens(normalize(given)));
  const neg = (s) => [...s].some((t) => NEGATIONS.has(t));
  if (neg(enT) !== neg(gnT) && score >= threshold) {
    score = Math.min(score, threshold - 0.01);
    note = note || 'Watch the negation';
  }
  if (!note && score >= threshold && strip && normalize(matched, false) !== normalize(given, false) && normalize(matched) === normalize(given)) {
    note = 'Mind the accents';
  }
  const closeFloor = Math.max(threshold - 0.25, 0.35);
  const verdict = score >= threshold ? 'correct' : score >= closeFloor ? 'close' : 'wrong';
  return { score: r3(score), verdict, matched, note };
}
