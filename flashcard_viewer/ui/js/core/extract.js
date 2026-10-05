// Find question/answer pairs in flashcard HTML / React artifacts (port of flashcard_viewer/extract.py).
import { UNKNOWN, findLiteralArrays } from './jsparse.js';

export function cardKey(front) {
  const norm = String(front).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  // FNV-1a 64-bit, hex (stable, dependency-free)
  let h = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(norm);
  for (const b of bytes) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return h.toString(16).padStart(16, '0').slice(0, 12);
}

const makeCard = (front, back, extra = {}) => ({
  front, back, hint: '', explanation: '', choices: [], category: '', source: '', ...extra, key: cardKey(front),
});

export function decodeText(buf) {
  let text;
  if (typeof buf === 'string') text = buf;
  else {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8[0] === 0xff && u8[1] === 0xfe) text = new TextDecoder('utf-16le').decode(u8);
    else if (u8[0] === 0xfe && u8[1] === 0xff) text = new TextDecoder('utf-16be').decode(u8);
    else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (_) { text = new TextDecoder('latin1').decode(u8); }
    }
  }
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

const SCRIPT_EXTS = /\.(jsx|tsx|js|ts|mjs)$/i;
export function isScriptSource(filename, text) {
  if (SCRIPT_EXTS.test(filename)) return true;
  const head = text.trimStart().slice(0, 2000);
  if (head.startsWith('<')) return false;
  return /^\s*(import\s.+from\s|export\s+default\b)/m.test(text);
}

// ------------------------------------------------------------------ text cleanup
let decoderEl = null;
function decodeEntities(s) {
  if (!s.includes('&')) return s;
  decoderEl = decoderEl || document.createElement('textarea');
  decoderEl.innerHTML = s;
  return decoderEl.value;
}

export function cleanText(value) {
  value = String(value);
  if (value.includes('<') && value.includes('>')) {
    value = value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
  }
  value = decodeEntities(value).replace(/ /g, ' ');
  return value.split('\n').map((ln) => ln.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n').trim();
}
const flat = (v) => v.replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ strategy 1: script data
const PAIRS = [['question', 'answer'], ['q', 'a'], ['front', 'back'], ['term', 'definition'], ['term', 'def'], ['term', 'meaning'],
  ['word', 'meaning'], ['word', 'definition'], ['word', 'translation'], ['prompt', 'answer'], ['prompt', 'response'],
  ['question', 'solution'], ['concept', 'definition'], ['concept', 'explanation'], ['phrase', 'translation'], ['kanji', 'meaning'],
  ['character', 'reading'], ['symbol', 'name'], ['clue', 'answer'], ['title', 'description'], ['name', 'description'],
  ['question', 'explanation']];
const META_KEYS = new Set(['id', 'key', 'category', 'categories', 'tag', 'tags', 'topic', 'color', 'colour', 'emoji', 'icon', 'difficulty',
  'level', 'type', 'image', 'img', 'src', 'url', 'hint', 'note', 'notes', 'explanation', 'example', 'status', 'group', 'section', 'deck',
  'chapter', 'unit', 'points', 'subject', 'classname', 'style', 'bg', 'theme', 'lang', 'language', 'audio']);
const CHOICE_KEYS = ['options', 'choices', 'answers', 'alternatives', 'possibleanswers'];
const CORRECT_KEYS = ['correct', 'correctindex', 'correctanswer', 'answerindex', 'correct_answer', 'correctoption', 'answer', 'solution', 'right'];
const isMap = (v) => v instanceof Map;

function lowerKeys(m) {
  const out = new Map();
  for (const [k, v] of m) out.set(typeof k === 'string' ? k.toLowerCase() : k, v);
  return out;
}
function asText(v) {
  if (typeof v === 'boolean' || v == null || v === UNKNOWN) return null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') { const t = cleanText(v); return t || null; }
  return null;
}

function cardFromQuiz(ld, category) {
  let choices = null;
  for (const k of CHOICE_KEYS) {
    const v = ld.get(k);
    if (Array.isArray(v) && v.length >= 2 && v.every((x) => asText(x))) { choices = v.map(asText); break; }
  }
  if (!choices) return null;
  let question = null;
  for (const k of ['question', 'q', 'prompt', 'text', 'title', 'front', 'statement']) { question = asText(ld.get(k)); if (question) break; }
  if (!question) return null;
  let answer = null;
  for (const k of CORRECT_KEYS) {
    if (!ld.has(k)) continue;
    const v = ld.get(k);
    if (typeof v === 'boolean') continue;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < choices.length) answer = choices[v];
    else if (typeof v === 'string') {
      const s = v.trim();
      if (s.length === 1 && 'ABCDEFGH'.includes(s.toUpperCase()) && 'ABCDEFGH'.indexOf(s.toUpperCase()) < choices.length) answer = choices['ABCDEFGH'.indexOf(s.toUpperCase())];
      else if (/^\d+$/.test(s) && +s < choices.length && !choices.includes(s)) answer = choices[+s];
      else { const t = cleanText(s); if (t) answer = t; }
    }
    if (answer) break;
  }
  if (!answer) return null;
  return makeCard(question, answer, {
    hint: asText(ld.get('hint')) || '', explanation: asText(ld.get('explanation')) || asText(ld.get('rationale')) || '',
    choices, category, source: 'script',
  });
}

function cardFromDict(d, category, shared) {
  const ld = lowerKeys(d);
  const quiz = cardFromQuiz(ld, category);
  if (quiz) return quiz;
  const cat = asText(ld.get('category')) || asText(ld.get('topic')) || category;
  for (const [fk, bk] of PAIRS) {
    const f = asText(ld.get(fk)), b = asText(ld.get(bk));
    if (f && b) {
      const explanation = bk !== 'explanation' ? asText(ld.get('explanation')) : '';
      return makeCard(f, b, { hint: asText(ld.get('hint')) || '', explanation: explanation || '', category: cat || '', source: 'script' });
    }
  }
  if (shared) {
    const vals = shared.map((k) => asText(d.get(k)));
    if (vals.length >= 2 && vals[0] && vals[1]) return makeCard(vals[0], vals[1], { hint: asText(ld.get('hint')) || '', category: cat || '', source: 'script' });
  }
  return null;
}

function contentKeys(dicts) {
  if (dicts.length < 2) return null;
  let keys = [...dicts[0].keys()].filter((k) => typeof k === 'string' && !META_KEYS.has(k.toLowerCase()));
  keys = keys.filter((k) => dicts.every((d) => asText(d.get(k))));
  if (keys.length < 2) return null;
  for (const k of keys.slice(0, 2)) {
    if (new Set(dicts.map((d) => asText(d.get(k)))).size < Math.max(2, Math.floor(dicts.length / 2))) return null;
  }
  return keys.slice(0, 2);
}

// Rows like ["Topic", "question", "answer", "note"]: arrays of strings with the same length.
// A short leading column whose values repeat is the category; the next two filled columns are
// front and back, and a further column becomes the explanation.
function cardsFromRows(rows, category) {
  if (rows.length < 2 || !rows.every(Array.isArray)) return null;
  const width = rows[0].length;
  if (width < 2 || width > 8 || rows.some((r) => r.length !== width)) return null;
  if (!rows.every((r) => r.every((v) => typeof v === 'string' || v == null))) return null;
  const cols = [];
  for (let i = 0; i < width; i++) cols.push(rows.map((r) => asText(r[i])));
  const range = [...Array(width).keys()];
  const filled = range.filter((i) => cols[i].every(Boolean));
  let catCol = null;
  if (width >= 3 && filled.includes(0) && new Set(cols[0]).size < rows.length
      && cols[0].every((v) => v.length <= 40) && filled.length >= 3) catCol = 0;
  const content = filled.filter((i) => i !== catCol);
  if (content.length < 2) return null;
  const [front, back] = content;
  // Config-like data (["sm", "small"] repeated) is not a deck.
  if (new Set(cols[front]).size < Math.max(2, Math.floor(rows.length / 2))) return null;
  const extra = range.find((i) => i !== catCol && i !== front && i !== back && cols[i].some(Boolean));
  return rows.map((_, n) => makeCard(cols[front][n], cols[back][n], {
    explanation: extra !== undefined ? cols[extra][n] || '' : '',
    category: (catCol !== null ? cols[catCol][n] : category) || '', source: 'script',
  }));
}

function walk(value, category, out) {
  if (Array.isArray(value)) {
    const rows = cardsFromRows(value, category);
    if (rows) { out.push(...rows); return; }
    const dicts = value.filter(isMap);
    const shared = contentKeys(dicts);
    for (const v of value) {
      if (isMap(v)) {
        const card = cardFromDict(v, category, shared);
        if (card) { out.push(card); continue; }
        walk(v, category, out);
      } else if (Array.isArray(v)) walk(v, category, out);
    }
  } else if (isMap(value)) {
    for (const [k, v] of value) {
      if (Array.isArray(v)) walk(v, typeof k === 'string' ? k : category, out);
      else if (isMap(v)) walk(v, category, out);
    }
  }
}

const GENERIC_LABELS = new Set(['flashcards', 'cards', 'deck', 'data', 'questions', 'quizquestions', 'items', 'vocabulary', 'vocab', 'words', 'terms']);
export function fromScripts(text, isScript) {
  const sources = isScript ? [text] : [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((m) => m[1]);
  const cards = [];
  for (const src of sources) {
    for (const [value, , , label] of findLiteralArrays(src)) {
      const found = [];
      walk(value, label && label !== label.toUpperCase() ? label : '', found);
      if (found.length >= 2) cards.push(...found);
    }
  }
  for (const c of cards) if (GENERIC_LABELS.has(c.category.toLowerCase())) c.category = '';
  return cards;
}

// ------------------------------------------------------------------ strategy 2: DOM
const FRONT_CLASS = /(^|[-_])(front|question|q|term|prompt|clue)$|^(front|question|q|term|prompt)([-_]|$)/i;
const BACK_CLASS = /(^|[-_])(back|answer|a|definition|meaning|solution)$|^(back|answer|a|definition|meaning)([-_]|$)/i;
const LABEL_TEXT = /^(q|a|question|answer|front|back|term|definition)\s*[:.#]?\s*\d*$/i;
const NON_CONTENT = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'NAV', 'INPUT', 'SELECT', 'TEXTAREA']);
const BLOCKS = new Set(['P', 'DIV', 'LI', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'SECTION']);
const tagOf = (el) => el.tagName.toUpperCase();
const classes = (el) => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);

function nodeText(el) {
  const parts = [];
  const rec = (node) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) parts.push(ch.nodeValue);
      else if (ch.nodeType === 1) {
        const t = tagOf(ch);
        if (NON_CONTENT.has(t)) continue;
        const cls = classes(ch).join(' ').toLowerCase();
        const own = flat(ch.textContent || '');
        if (/\b(label|badge|tag|chip|hint|counter|number|num|icon)\b/.test(cls) && (LABEL_TEXT.test(own) || own.length < 14)) continue;
        if (t === 'BR') { parts.push('\n'); continue; }
        const block = BLOCKS.has(t);
        if (block) parts.push('\n');
        rec(ch);
        if (block) parts.push('\n');
      }
    }
  };
  rec(el);
  const lines = cleanText(parts.join('')).split('\n');
  while (lines.length && LABEL_TEXT.test(lines[0].trim())) lines.shift();
  return lines.join('\n').trim();
}

function matches(el, rx) {
  const t = tagOf(el);
  if (NON_CONTENT.has(t)) return false;
  if ((t === 'A' || t === 'LABEL' || t === 'SPAN') && !classes(el).length) return false;
  return classes(el).some((c) => rx.test(c));
}

function domClassPairs(doc) {
  const all = [...doc.querySelectorAll('*')];
  let fronts = all.filter((el) => matches(el, FRONT_CLASS) && !matches(el, BACK_CLASS));
  const fset = new Set(fronts);
  const hasAncestorIn = (el, set) => { for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return true; return false; };
  fronts = fronts.filter((f) => !hasAncestorIn(f, fset));
  const used = new Set();
  const cards = [];
  for (const f of fronts) {
    let anc = f.parentElement;
    for (let i = 0; i < 4; i++) {
      if (!anc || ['BODY', 'HTML'].includes(tagOf(anc))) break;
      let backs = [...anc.querySelectorAll('*')].filter((b) => matches(b, BACK_CLASS) && !matches(b, FRONT_CLASS) && !f.contains(b) && !b.contains(f));
      const bset = new Set(backs);
      backs = backs.filter((b) => !hasAncestorIn(b, bset));
      if (backs.length) {
        const frontsHere = [...anc.querySelectorAll('*')].filter((x) => fset.has(x));
        if (backs.length === 1 && frontsHere.length === 1 && !used.has(backs[0])) {
          const ft = nodeText(f), bt = nodeText(backs[0]);
          if (ft && bt) { cards.push(makeCard(ft, bt, { source: 'dom' })); used.add(backs[0]); }
        }
        break;
      }
      anc = anc.parentElement;
    }
  }
  return cards;
}

const DATA_ATTR_PAIRS = [['data-front', 'data-back'], ['data-question', 'data-answer'], ['data-q', 'data-a'], ['data-term', 'data-definition'], ['data-word', 'data-meaning']];
function domDataAttrs(doc) {
  const cards = [];
  for (const [fa, ba] of DATA_ATTR_PAIRS) {
    for (const el of doc.querySelectorAll(`[${fa}][${ba}]`)) {
      const f = cleanText(el.getAttribute(fa) || ''), b = cleanText(el.getAttribute(ba) || '');
      if (f && b) cards.push(makeCard(f, b, { hint: cleanText(el.getAttribute('data-hint') || ''), source: 'dom' }));
    }
  }
  return cards;
}

function domDetails(doc) {
  const cards = [];
  for (const d of doc.querySelectorAll('details')) {
    const s = d.querySelector('summary');
    if (!s) continue;
    const front = nodeText(s);
    const copy = d.cloneNode(true);
    copy.querySelector('summary').remove();
    const back = nodeText(copy);
    if (front && back) cards.push(makeCard(front, back, { source: 'dom' }));
  }
  return cards;
}

function domDl(doc) {
  const cards = [];
  for (const dl of doc.querySelectorAll('dl')) {
    let term = null;
    for (const ch of dl.querySelectorAll('dt, dd')) {
      if (tagOf(ch) === 'DT') term = nodeText(ch);
      else if (term) { const d = nodeText(ch); if (d) cards.push(makeCard(term, d, { source: 'dom' })); term = null; }
    }
  }
  return cards;
}

function domTables(doc) {
  const cards = [];
  for (const table of doc.querySelectorAll('table')) {
    const rows = [];
    for (const tr of table.querySelectorAll('tr')) {
      const cells = [...tr.children].filter((c) => ['TD', 'TH'].includes(tagOf(c)));
      if (!cells.length || cells.every((c) => tagOf(c) === 'TH')) continue;
      rows.push(cells.map(nodeText));
    }
    if (rows.length < 2) continue;
    const width = Math.max(...rows.map((r) => r.length));
    if (width < 2 || width > 3) continue;
    for (const r of rows) if (r.length >= 2 && r[0] && r[1]) cards.push(makeCard(r[0], r[1], { explanation: r[2] || '', source: 'dom' }));
  }
  return cards;
}

// ------------------------------------------------------------------ strategy 3: text
const QA = /(?:^|\n)[ \t]*(?:Q|Question|Ques)\s*\d*\s*[:.)-]\s*([\s\S]+?)\s*\n[ \t]*(?:A|Ans|Answer)\s*[:.)-]\s*([\s\S]+?)(?=\n\s*\n|\n[ \t]*(?:Q|Question|Ques)\s*\d*\s*[:.)-]|(?![\s\S]))/gi;
const DASH = /^(.{3,}?)\s+(?:—|–|--|-|→|=>|::)\s+(.+)$/;

function visibleTextBlocks(doc) {
  const body = (doc.body || doc.documentElement).cloneNode(true);
  body.querySelectorAll('script, style, noscript, template').forEach((e) => e.remove());
  body.querySelectorAll('br').forEach((br) => br.replaceWith(doc.createTextNode('\n')));
  body.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, section, article, tr, dd, dt').forEach((b) => {
    b.before(doc.createTextNode('\n\n'));
    b.after(doc.createTextNode('\n\n'));
  });
  let text = decodeEntities(body.textContent || '');
  text = text.replace(/[ \t ]+/g, ' ').replace(/\n[ \t]+/g, '\n');
  return text.replace(/\n{3,}/g, '\n\n');
}

function textQA(doc) {
  const cards = [];
  for (const m of visibleTextBlocks(doc).matchAll(QA)) {
    const q = cleanText(m[1]), a = cleanText(m[2]);
    if (q && a && q.length < 600) cards.push(makeCard(q, a, { source: 'text' }));
  }
  return cards;
}

function textDashLists(doc) {
  const cards = [];
  for (const lst of doc.querySelectorAll('ul, ol')) {
    const items = [...lst.children].filter((c) => tagOf(c) === 'LI');
    if (items.length < 2) continue;
    const found = [];
    for (const li of items) {
      const m = DASH.exec(flat(nodeText(li)));
      if (m) found.push(makeCard(m[1].replace(/^[ :]+|[ :]+$/g, ''), m[2].trim(), { source: 'text' }));
    }
    if (found.length >= 2 && found.length >= 0.6 * items.length) cards.push(...found);
  }
  return cards;
}

function dedupe(cards) {
  const seen = new Set();
  return cards.filter((c) => {
    const k = c.key + '|' + cardKey(c.back);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function extractCards(text, filename = 'deck.html', parser = null) {
  const script = isScriptSource(filename, text);
  const scriptCards = fromScripts(text, script);
  if (scriptCards.length >= 2 || script) return { cards: dedupe(scriptCards), methods: scriptCards.length ? ['script'] : [] };
  const doc = (parser || new DOMParser()).parseFromString(text, 'text/html');
  const methods = [];
  let cards = [];
  for (const [name, fn] of [['dom-classes', domClassPairs], ['data-attributes', domDataAttrs], ['details', domDetails],
    ['definition-list', domDl], ['table', domTables], ['qa-text', textQA], ['dash-list', textDashLists]]) {
    const found = fn(doc);
    if (found.length) { methods.push(name); cards = cards.concat(found); }
  }
  if (!cards.length && scriptCards.length) return { cards: scriptCards, methods: ['script'] };
  return { cards: dedupe(cards), methods };
}
