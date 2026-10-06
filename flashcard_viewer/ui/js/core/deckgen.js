// Decks made with the deck editor: a self-contained HTML page with the cards as JSON in
// <script type="application/json" id="fv-deck-data"> and a small runtime (deck-runtime/custom-deck.*)
// inlined, so the file works in any browser and can be shared. flashcard_viewer/customdeck.py reads
// the same format on the desktop.
//
// Card text is a small Markdown dialect: **bold**, *italic*, ~~strike~~, `code`, ``` blocks,
// lists, > quotes, # headings, [links](https://...), images ![alt](img:<id>) whose data lives in
// deck.images, and maths with $...$, $$...$$, \(...\) and \[...\] (rendered with KaTeX).

export const FORMAT = 'flashcard-viewer-deck';
export const FORMAT_VERSION = 1;
export const GENERATOR = 'Flashcard Viewer deck editor';
const DATA_RX = /<script\b[^>]*\bid=["']fv-deck-data["'][^>]*>([\s\S]*?)<\/script\s*>/i;
export const IMAGE_RX = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_CARDS = 5000;
const MAX_FIELD = 20000;

const str = (v, max = MAX_FIELD) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\r\n?/g, '\n').slice(0, max);

/** Clean up deck data from the editor or from a file: known fields only, sane types and sizes. */
export function normalizeDeck(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const cards = [];
  for (const c of Array.isArray(d.cards) ? d.cards.slice(0, MAX_CARDS) : []) {
    if (!c || typeof c !== 'object') continue;
    const card = { type: c.type === 'mcq' ? 'mcq' : 'basic', front: str(c.front), back: '', hint: str(c.hint), explanation: str(c.explanation), category: str(c.category, 200) };
    if (card.type === 'mcq') {
      card.choices = (Array.isArray(c.choices) ? c.choices : []).slice(0, 8).map((x) => str(x, 2000));
      const n = c.correct;
      card.correct = Number.isInteger(n) && n >= 0 && n < card.choices.length ? n : 0;
    } else {
      card.back = str(c.back);
    }
    cards.push(card);
  }
  const images = {};
  const src = d.images && typeof d.images === 'object' ? d.images : {};
  for (const [id, uri] of Object.entries(src)) {
    if (/^[\w-]{1,40}$/.test(id) && typeof uri === 'string' && IMAGE_RX.test(uri)) images[id] = uri;
  }
  return {
    format: FORMAT, version: FORMAT_VERSION,
    title: str(d.title, 200).replace(/\s+/g, ' ').trim(),
    emoji: str(d.emoji, 16).trim(),
    description: str(d.description, 2000),
    cards,
    images,
  };
}

/** Is this card worth keeping (and quizzing)? */
export function cardComplete(c) {
  if (!toPlain(c.front)) return false;
  if (c.type === 'mcq') return c.choices.filter((x) => toPlain(x)).length >= 2 && !!toPlain(c.choices[c.correct] || '');
  return !!toPlain(c.back);
}

/** Drop images no card refers to. */
export function pruneImages(deck) {
  const used = new Set();
  const scan = (s) => { for (const m of String(s || '').matchAll(/\(img:([\w-]+)/g)) used.add(m[1]); };
  scan(deck.description);
  for (const c of deck.cards) { scan(c.front); scan(c.back); scan(c.hint); scan(c.explanation); (c.choices || []).forEach(scan); }
  deck.images = Object.fromEntries(Object.entries(deck.images).filter(([id]) => used.has(id)));
  return deck;
}

// JSON inside <script>: escape "<" so "</script>" or "<!--" in a card can't end the block.
const scriptJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** The complete deck file. `runtime` is {css, js} (see loadRuntime). */
export function buildDeckHtml(rawDeck, runtime) {
  const deck = pruneImages(normalizeDeck(rawDeck));
  const title = deck.title || 'Untitled deck';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${GENERATOR}">
<meta name="fv-theme" content="app">
<title>${escHtml(title)}</title>
<style>
${runtime.css.trim()}
</style>
</head>
<body>
<div id="fv-app" class="fv-app"><noscript>This flashcard deck needs JavaScript.</noscript></div>
<script type="application/json" id="fv-deck-data">${scriptJson(deck)}</script>
<script>
${runtime.js.trim()}
</script>
</body>
</html>
`;
}

/** Deck data of a file made by the deck editor, or null for any other deck. */
export function parseDeckHtml(text) {
  if (typeof text !== 'string' || !text.includes('fv-deck-data')) return null;
  const m = DATA_RX.exec(text);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch (_) { return null; }
  if (!data || data.format !== FORMAT) return null;
  return normalizeDeck(data);
}

export const isCustomDeck = (text) => parseDeckHtml(text) !== null;

// ---------------------------------------------------------------- plain text (for quizzes and search)
// Must match customdeck.to_plain in Python (tests check both on the same cases) and PROTECT_RX in
// deck-runtime/custom-deck.js.
const PROTECT_RX = /(`+)([\s\S]*?[^`])\1(?!`)|(?<!\\)\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$])\$(?=\S)(?:\\.|[^$\\\n])+?(?<=\S)\$(?![\d$])/g;

/** Markdown card text -> plain text: formatting marks removed, `code` and maths kept as written. */
export function toPlain(md) {
  let s = str(md);
  const kept = [];
  const keep = (t) => `\u0000${kept.push(t) - 1}\u0000`;
  // Fenced code blocks: keep the code, drop the fences.
  s = s.replace(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm, (_, code) => keep(code.replace(/\n$/, '')));
  s = s.replace(PROTECT_RX, (m) => keep(m));
  s = s.replace(/!\[([^\]\n]*)\]\([^)\s]*\)/g, '$1');
  s = s.replace(/\[([^\]\n]+)\]\((?:https?:|mailto:)[^)\s]*\)/g, '$1');
  s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, '').replace(/^[ \t]*>[ \t]?/gm, '');
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1').replace(/__(?=\S)([\s\S]*?\S)__/g, '$1').replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  s = s.replace(/(?<![A-Za-z0-9_*\\])\*(?=\S)([^*\n]*?\S)\*(?![A-Za-z0-9_*])/g, '$1').replace(/(?<![A-Za-z0-9_\\])_(?=\S)([^_\n]*?\S)_(?![A-Za-z0-9_])/g, '$1');
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!~>|$])/g, '$1');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[+i]);
  return s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** Cards in the shape the extractor produces, for quizzes and stats. */
export function deckCards(deck) {
  const out = [];
  for (const c of deck.cards) {
    if (!cardComplete(c)) continue;
    const front = toPlain(c.front);
    const base = { hint: toPlain(c.hint), explanation: toPlain(c.explanation), category: c.category.trim(), source: 'deck-editor' };
    if (c.type === 'mcq') {
      const choices = c.choices.map(toPlain).filter(Boolean);
      out.push({ front, back: toPlain(c.choices[c.correct]), choices, ...base });
    } else {
      out.push({ front, back: toPlain(c.back), choices: [], ...base });
    }
  }
  return out;
}

/** Searchable text of a deck. */
export function deckSearchText(deck) {
  const parts = [deck.title, deck.description];
  for (const c of deck.cards) parts.push(c.front, c.back, c.hint, c.explanation, c.category, ...(c.choices || []));
  return parts.map(toPlain).filter(Boolean).join(' ');
}

/** A file name for a new deck: "Spanish verbs" -> "Spanish verbs.html". */
export function deckFilename(title) {
  const base = String(title || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80).trim();
  return (base || 'My deck') + '.html';
}

let runtimeCache = null;
/** Fetch the deck runtime (CSS + JS) that gets inlined into every deck file. Browser only. */
export async function loadRuntime(base) {
  if (runtimeCache) return runtimeCache;
  const root = new URL('deck-runtime/', base || new URL('.', document.baseURI)).href;
  const get = async (f) => {
    const r = await fetch(root + f, { cache: 'no-store' });
    if (!r.ok) throw new Error(`couldn't load ${f} (${r.status})`);
    return r.text();
  };
  const [css, js] = await Promise.all([get('custom-deck.css'), get('custom-deck.js')]);
  runtimeCache = { css, js };
  return runtimeCache;
}
