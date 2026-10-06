// Deck editor: create your own decks, or edit ones made here. Saves a self-contained HTML deck
// (js/core/deckgen.js) into the library, with a live preview that uses the app's theme.
import { call } from './api.js';
import { store, subscribe, emit } from './store.js';
import { $, h, icon, snackbar, dialog, confirmDialog, debounce, fmtBytes } from './util.js';
import { deckThemeVars } from './themes.js';
import {
  buildDeckHtml, loadRuntime, normalizeDeck, cardComplete, deckFilename, IMAGE_RX,
} from './core/deckgen.js';
import { cardsFromCsv, cardsFromText } from './core/csv.js';

const MAX_DECK_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_SIDE = 1600;
const LETTERS = 'ABCDEFGH';
const btnIcon = (name) => h('md-icon', { slot: 'icon' }, name);

let st = null;          // editor state while open
let onSaved = null;     // callback(id) after a successful save
let unsubscribe = null;

const uid = () => Math.random().toString(36).slice(2, 10);
const blankCard = (type = 'basic') => ({ uid: uid(), type, front: '', back: '', choices: type === 'mcq' ? ['', '', ''] : [], correct: 0, hint: '', explanation: '', category: '', more: false });

function fromDeckCard(c) {
  const card = { ...blankCard(c.type), ...c, uid: uid(), more: !!(c.hint || c.explanation || c.category) };
  if (card.type === 'mcq') { card.choices = [...(c.choices || [])]; while (card.choices.length < 2) card.choices.push(''); }
  return card;
}

/** The deck as stored (editor-only fields removed). */
function deckData() {
  return normalizeDeck({
    title: st.title, emoji: st.emoji, description: st.description, images: st.images,
    cards: st.cards.map(({ uid: _u, more: _m, ...c }) => c),
  });
}
const snapshot = () => JSON.stringify(deckData());
export const editorOpen = () => !!st;

// ------------------------------------------------------------------ open / close
/**
 * Open the editor. `id` edits an existing editor-made deck; otherwise a new deck, optionally
 * prefilled from `seed` ({title, emoji, description, cards}).
 */
export async function openDeckEditor({ id = null, seed = null, saved = null } = {}) {
  if (st) return;
  document.querySelectorAll('md-menu[open]').forEach((m) => { m.open = false; });
  let data = seed || { title: '', emoji: '', description: '', cards: [] };
  if (id) {
    data = await call('getCustomDeck', id);
    if (!data) { snackbar('This deck can’t be edited here'); return; }
  }
  const deck = normalizeDeck(data);
  st = {
    id, title: deck.title, emoji: deck.emoji, description: deck.description, images: { ...deck.images },
    cards: deck.cards.map(fromDeckCard), focus: 0, back: false, saving: false,
    showPreview: matchMedia('(min-width: 1100px)').matches,
  };
  if (!st.cards.length) st.cards.push(blankCard());
  st.initial = snapshot();
  onSaved = saved;
  render();
  unsubscribe = subscribe((ev) => { if (ev === 'settings') postPreview(); });
  document.body.classList.add('editor-open');
  if (!id && !seed) setTimeout(() => { const t = $('#de-title'); if (t) t.focus(); }, 120);
}

export async function closeDeckEditor({ force = false } = {}) {
  if (!st) return true;
  if (!force && snapshot() !== st.initial && !(await confirmDialog('Discard changes?', 'Your changes to this deck haven’t been saved.', 'Discard', 'delete'))) return false;
  st = null;
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  const el = $('#deck-editor');
  if (el) el.remove();
  document.body.classList.remove('editor-open');
  return true;
}

/** Keyboard handling while the editor is open; returns true when the key was used. */
export function editorKey(e) {
  if (!st || $('md-dialog[open]')) return false;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 's') { save(); return true; }
  if (e.key === 'Escape') { closeDeckEditor(); return true; }
  const ta = e.target && e.target.closest && e.target.closest('textarea.de-text');
  if (ta && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    if (k === 'b') { wrap(ta, '**', '**'); return true; }
    if (k === 'i') { wrap(ta, '*', '*'); return true; }
    if (k === 'e') { wrap(ta, '`', '`'); return true; }
    if (k === 'm') { wrap(ta, '$', '$'); return true; }
  }
  return false;
}

// ------------------------------------------------------------------ rendering
function render() {
  let root = $('#deck-editor');
  if (!root) {
    root = h('section.deck-editor#deck-editor', { role: 'dialog', 'aria-label': 'Deck editor' });
    $('#app').append(root);
    root.addEventListener('dragover', (e) => { if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); e.stopPropagation(); } });
    root.addEventListener('drop', onDrop);
  }
  const bar = h('div.de-bar',
    h('md-icon-button', { title: 'Close (Esc)', on: { click: () => closeDeckEditor() } }, icon('close')),
    h('div.de-heading', h('div.title-large', st.id ? 'Edit deck' : 'New deck'), h('div.body-small.muted#de-summary')),
    h('span.spacer'),
    h('md-text-button', { title: 'Import cards from CSV, Anki / Quizlet exports or pasted text', on: { click: importDialog } }, btnIcon('upload_file'), h('span.de-hide-narrow', 'Import')),
    h('md-icon-button#de-preview-toggle', { toggle: true, '.selected': st.showPreview, title: 'Show / hide preview', on: { change: (e) => { st.showPreview = e.target.selected; root.classList.toggle('no-preview', !st.showPreview); postPreview(); } } },
      icon('preview'), h('md-icon', { slot: 'selected' }, 'preview')),
    h('md-filled-button#de-save', { title: 'Save (Ctrl+S)', on: { click: save } }, btnIcon('save'), 'Save'));

  const meta = h('div.de-meta',
    h('label.de-emoji', { title: 'Deck emoji' },
      h('input#de-emoji', { type: 'text', maxlength: 16, placeholder: '🙂', '.value': st.emoji, 'aria-label': 'Deck emoji', on: { input: (e) => { st.emoji = e.target.value.trim(); changed(); } } })),
    h('div.de-meta-fields',
      h('md-outlined-text-field#de-title', { label: 'Deck title', required: true, '.value': st.title, maxlength: 200, on: { input: (e) => { st.title = e.target.value; e.target.error = false; changed(); } } }),
      textField('Description', st.description, (v) => { st.description = v; }, { rows: 1, cls: 'de-desc', placeholder: 'Description (optional)' })));

  const list = h('div.de-cards#de-cards');
  const main = h('div.de-main',
    h('div.de-inner', meta,
      h('div.de-section', h('span.title-medium', 'Cards'), h('span.de-count#de-count'), h('span.spacer'),
        h('span.body-small.muted.de-hide-narrow', 'Markdown: **bold**, *italic*, `code`, $maths$')),
      list,
      h('div.de-add',
        h('md-filled-tonal-button', { on: { click: () => addCard('basic') } }, btnIcon('add'), 'Flip card'),
        h('md-outlined-button', { on: { click: () => addCard('mcq') } }, btnIcon('format_list_bulleted'), 'Multiple choice'))));

  const frame = h('iframe#de-frame', { title: 'Deck preview', sandbox: 'allow-scripts' });
  const preview = h('aside.de-preview', h('div.de-preview-head', icon('visibility'), h('span.title-small', 'Preview'), h('span.spacer'),
    h('span.body-small.muted', 'Updates as you type')), h('div.de-frame-wrap', frame));

  root.className = 'deck-editor' + (st.showPreview ? '' : ' no-preview');
  root.replaceChildren(bar, h('div.de-body', main, preview));
  renderCards();
  startPreview(frame);
}

function textField(label, value, set, { rows = 2, cls = '', toolbar = false, field = null, placeholder = '' } = {}) {
  const ta = h('textarea.de-text', { rows, placeholder: placeholder || ' ', spellcheck: 'true', '.value': value, 'aria-label': label, dataset: field || {} });
  ta.addEventListener('input', () => { set(ta.value); grow(ta); changed(); });
  ta.addEventListener('focus', () => onFocus(ta));
  ta.addEventListener('paste', (e) => {
    const file = Array.from((e.clipboardData && e.clipboardData.files) || []).find((f) => f.type.startsWith('image/'));
    if (file) { e.preventDefault(); insertImage(ta, file); }
  });
  requestAnimationFrame(() => grow(ta));
  return h('div.de-field', { class: cls },
    h('div.de-field-head', h('span.de-label', label), toolbar ? formatBar(ta) : null),
    ta);
}

function formatBar(ta) {
  const b = (ic, title, fn) => h('button.de-fmt', { type: 'button', title, on: { mousedown: (e) => e.preventDefault(), click: () => { fn(); ta.focus(); } } }, icon(ic));
  return h('div.de-fmt-bar',
    b('format_bold', 'Bold (Ctrl+B)', () => wrap(ta, '**', '**')),
    b('format_italic', 'Italic (Ctrl+I)', () => wrap(ta, '*', '*')),
    b('code', 'Code (Ctrl+E)', () => (ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n') ? wrap(ta, '```\n', '\n```') : wrap(ta, '`', '`'))),
    b('function', 'Maths, LaTeX (Ctrl+M)', () => (ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n') ? wrap(ta, '$$\n', '\n$$') : wrap(ta, '$', '$'))),
    b('format_list_bulleted', 'Bulleted list', () => prefixLines(ta, '- ')),
    b('image', 'Insert image', () => pickImage(ta)));
}

function renderCards() {
  const list = $('#de-cards');
  if (!list) return;
  list.replaceChildren(...st.cards.map((c, i) => cardPanel(c, i)));
  updateSummary();
}

function cardPanel(c, i) {
  const n = st.cards.length;
  const seg = (type, label, short) => h('button.de-seg', { type: 'button', class: c.type === type ? 'on' : '', 'aria-pressed': String(c.type === type), title: label, on: { click: () => setType(i, type) } },
    h('span.de-hide-narrow', label), h('span.de-narrow', short));
  const head = h('div.de-card-head',
    h('span.de-num', String(i + 1)),
    h('div.de-segs', seg('basic', 'Flip card', 'Flip'), seg('mcq', 'Multiple choice', 'Choice')),
    h('span.de-incomplete', { title: 'Incomplete cards are skipped in the deck and in quizzes' }, icon('error'), 'Incomplete'),
    h('span.spacer'),
    h('md-icon-button', { title: 'Move up', disabled: i === 0, on: { click: () => move(i, -1) } }, icon('arrow_upward')),
    h('md-icon-button', { title: 'Move down', disabled: i === n - 1, on: { click: () => move(i, 1) } }, icon('arrow_downward')),
    h('md-icon-button', { title: 'Duplicate', on: { click: () => duplicate(i) } }, icon('content_copy')),
    h('md-icon-button', { title: 'Delete card', on: { click: () => remove(i) } }, icon('delete')));

  const front = textField(c.type === 'mcq' ? 'Question' : 'Front', c.front, (v) => { c.front = v; }, { toolbar: true, field: { card: i, side: 'front' }, placeholder: c.type === 'mcq' ? 'Ask a question…' : 'Question or term…' });
  let answer;
  if (c.type === 'mcq') {
    answer = h('div.de-field.de-options',
      h('div.de-field-head', h('span.de-label', 'Options'), h('span.body-small.muted', 'Select the correct one')),
      ...c.choices.map((o, k) => {
        const ta = h('textarea.de-text.de-opt-text', { rows: 1, placeholder: `Option ${LETTERS[k]}`, spellcheck: 'true', '.value': o, 'aria-label': `Option ${LETTERS[k]}`, dataset: { card: i, side: 'front' } });
        ta.addEventListener('input', () => { c.choices[k] = ta.value; grow(ta); changed(); });
        ta.addEventListener('focus', () => onFocus(ta));
        requestAnimationFrame(() => grow(ta));
        return h('div.de-opt', { class: c.correct === k ? 'correct' : '' },
          h('md-radio', { name: 'correct-' + c.uid, '.checked': c.correct === k, 'aria-label': `Option ${LETTERS[k]} is correct`, on: { change: () => { c.correct = k; renderCards(); changed(); } } }),
          h('span.de-letter', LETTERS[k]), ta,
          h('md-icon-button', { title: 'Remove option', disabled: c.choices.length <= 2, on: { click: () => removeOption(i, k) } }, icon('close')));
      }),
      c.choices.length < LETTERS.length
        ? h('md-text-button', { on: { click: () => { c.choices.push(''); renderCards(); changed(); focusLast(i); } } }, btnIcon('add'), 'Add option') : null);
  } else {
    answer = textField('Back', c.back, (v) => { c.back = v; }, { toolbar: true, field: { card: i, side: 'back' }, placeholder: 'Answer or definition…' });
  }

  const more = h('details.de-more', { '.open': c.more, on: { toggle: (e) => { c.more = e.target.open; } } },
    h('summary', icon('expand_more'), 'Hint, explanation & category'),
    h('div.de-more-body',
      textField('Hint', c.hint, (v) => { c.hint = v; }, { rows: 1, field: { card: i, side: 'front' }, placeholder: 'Shown when you ask for a hint' }),
      textField('Explanation', c.explanation, (v) => { c.explanation = v; }, { rows: 1, toolbar: true, field: { card: i, side: 'back' }, placeholder: 'Shown with the answer' }),
      h('label.de-cat', h('span.de-label', 'Category'),
        h('input.de-input', { type: 'text', '.value': c.category, maxlength: 200, placeholder: 'e.g. Verbs', dataset: { card: i, side: 'front' },
          on: { input: (e) => { c.category = e.target.value; changed(); }, focus: (e) => onFocus(e.target) } }))));

  const panel = h('article.de-card', { dataset: { uid: c.uid } }, head, h('div.de-card-body', h('div.de-sides', front, answer), more));
  panel.classList.toggle('incomplete', isStarted(c) && !cardComplete(normalizeDeck({ cards: [c] }).cards[0]));
  return panel;
}

const isStarted = (c) => !!(c.front.trim() || c.back.trim() || c.choices.some((x) => x.trim()));

function updateSummary() {
  if (!st) return;
  const complete = st.cards.filter((c) => cardComplete(normalizeDeck({ cards: [c] }).cards[0])).length;
  const count = $('#de-count');
  if (count) count.textContent = String(st.cards.length);
  const sum = $('#de-summary');
  if (sum) {
    const imgs = Object.keys(st.images).length;
    sum.textContent = `${complete} of ${st.cards.length} card${st.cards.length === 1 ? '' : 's'} ready` +
      (imgs ? ` · ${imgs} image${imgs === 1 ? '' : 's'} (${fmtBytes(Object.values(st.images).reduce((a, s) => a + s.length, 0))})` : '');
  }
  document.querySelectorAll('#de-cards .de-card').forEach((el, i) => {
    const c = st.cards[i];
    if (c) el.classList.toggle('incomplete', isStarted(c) && !cardComplete(normalizeDeck({ cards: [c] }).cards[0]));
  });
}

function grow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, 420) + 'px';
}

const changed = debounce(() => { updateSummary(); postPreview(); }, 200);

function onFocus(el) {
  const i = Number(el.dataset.card);
  if (!Number.isInteger(i)) return;
  const back = el.dataset.side === 'back';
  if (st.focus !== i || st.back !== back) { st.focus = i; st.back = back; postPreview(); }
}

// ------------------------------------------------------------------ card operations
function addCard(type) {
  st.cards.push(blankCard(type));
  renderCards();
  changed();
  const panels = document.querySelectorAll('#de-cards .de-card');
  const last = panels[panels.length - 1];
  if (last) { last.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => last.querySelector('textarea').focus({ preventScroll: true }), 250); }
}
function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= st.cards.length) return;
  [st.cards[i], st.cards[j]] = [st.cards[j], st.cards[i]];
  st.focus = j;
  renderCards();
  changed();
}
function duplicate(i) {
  const c = st.cards[i];
  st.cards.splice(i + 1, 0, { ...c, uid: uid(), choices: [...c.choices] });
  renderCards();
  changed();
}
function remove(i) {
  const c = st.cards[i];
  const [removed] = st.cards.splice(i, 1);
  if (!st.cards.length) st.cards.push(blankCard());
  renderCards();
  changed();
  if (isStarted(c)) {
    snackbar('Card deleted', {
      action: 'Undo',
      onAction: () => {
        if (!st) return;
        if (st.cards.length === 1 && !isStarted(st.cards[0])) st.cards = [];
        st.cards.splice(Math.min(i, st.cards.length), 0, removed);
        renderCards();
        changed();
      },
    });
  }
}
function setType(i, type) {
  const c = st.cards[i];
  if (c.type === type) return;
  if (type === 'mcq') {
    // The back becomes the correct option.
    c.choices = c.back.trim() ? [c.back, '', ''] : (c.choices.length >= 2 ? c.choices : ['', '', '']);
    c.correct = 0;
  } else if (!c.back.trim() && c.choices[c.correct]) {
    c.back = c.choices[c.correct];
  }
  c.type = type;
  renderCards();
  changed();
}
function removeOption(i, k) {
  const c = st.cards[i];
  if (c.choices.length <= 2) return;
  c.choices.splice(k, 1);
  if (c.correct === k) c.correct = 0;
  else if (c.correct > k) c.correct--;
  renderCards();
  changed();
}
function focusLast(i) {
  const panel = document.querySelectorAll('#de-cards .de-card')[i];
  const opts = panel ? panel.querySelectorAll('.de-opt-text') : [];
  if (opts.length) opts[opts.length - 1].focus();
}

// ------------------------------------------------------------------ text formatting
function setValue(ta, value, selStart, selEnd) {
  ta.value = value;
  ta.setSelectionRange(selStart, selEnd);
  ta.dispatchEvent(new Event('input'));
}
function wrap(ta, before, after) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const sel = v.slice(s, e);
  if (sel && v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
    setValue(ta, v.slice(0, s - before.length) + sel + v.slice(e + after.length), s - before.length, e - before.length);
    return;
  }
  setValue(ta, v.slice(0, s) + before + sel + after + v.slice(e), s + before.length, e + before.length);
}
function prefixLines(ta, prefix) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const start = v.lastIndexOf('\n', s - 1) + 1;
  const block = v.slice(start, e);
  const lines = block.split('\n');
  const all = lines.every((l) => l.startsWith(prefix));
  const out = lines.map((l) => (all ? l.slice(prefix.length) : prefix + l)).join('\n');
  setValue(ta, v.slice(0, start) + out + v.slice(e), start, start + out.length);
}
function insertText(ta, text) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  setValue(ta, v.slice(0, s) + text + v.slice(e), s + text.length, s + text.length);
}

// ------------------------------------------------------------------ images
function pickImage(ta) {
  const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  input.addEventListener('change', () => { const f = input.files && input.files[0]; input.remove(); if (f) insertImage(ta, f); });
  document.body.append(input);
  input.click();
}

const readDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/** Embed an image: scaled down to MAX_IMAGE_SIDE and re-encoded (WebP) unless the original is already small. */
async function encodeImage(file) {
  const original = await readDataUrl(file);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('not an image this app can read'));
      im.src = url;
    });
    const w = img.naturalWidth || 800, ht = img.naturalHeight || 600;
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(w, ht));
    if (scale === 1 && IMAGE_RX.test(original) && (file.type === 'image/gif' || file.size < 300 * 1024)) return original;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(ht * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    let out = canvas.toDataURL('image/webp', 0.85);
    if (!IMAGE_RX.test(out)) out = canvas.toDataURL('image/png');
    if (IMAGE_RX.test(original) && original.length < out.length && scale === 1) return original;
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function insertImage(ta, file) {
  if (!st) return;
  try {
    const data = await encodeImage(file);
    if (!IMAGE_RX.test(data)) throw new Error('unsupported image type');
    let id = uid();
    while (st.images[id]) id = uid();
    st.images[id] = data;
    const alt = (file.name || 'image').replace(/\.[^.]+$/, '').replace(/[[\]\n]/g, ' ').trim() || 'image';
    const before = ta.value.slice(0, ta.selectionStart);
    insertText(ta, (before && !before.endsWith('\n') ? '\n' : '') + `![${alt}](img:${id})\n`);
    if (data.length > 2 * 1024 * 1024) snackbar(`That image adds ${fmtBytes(data.length)} to the deck`);
  } catch (err) {
    snackbar(`Couldn’t add the image: ${err.message || err}`);
  }
}

async function onDrop(e) {
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (!files.length) return;
  e.preventDefault();
  e.stopPropagation();
  const ta = e.target.closest && e.target.closest('textarea.de-text');
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (ta && images.length) {
    ta.focus();
    for (const f of images) await insertImage(ta, f);
    return;
  }
  const table = files.find((f) => /\.(csv|tsv|txt)$/i.test(f.name));
  if (table) { addImported(cardsFromText(await table.text()), table.name); return; }
  if (images.length) snackbar('Drop images onto a card’s text box to add them');
}

// ------------------------------------------------------------------ import
function addImported(res, source) {
  if (!st) return;
  if (!res.cards.length) { snackbar(`No cards found${source ? ' in ' + source : ''}`); return; }
  // Replace a lone empty card.
  if (st.cards.length === 1 && !isStarted(st.cards[0])) st.cards = [];
  st.cards.push(...res.cards.map(fromDeckCard));
  renderCards();
  changed();
  snackbar(`Imported ${res.cards.length} card${res.cards.length === 1 ? '' : 's'}${res.skipped ? ` · ${res.skipped} row${res.skipped === 1 ? '' : 's'} skipped` : ''}`);
}

async function importDialog() {
  const ta = h('textarea.de-text.de-import-text', { rows: 9, spellcheck: 'false', placeholder: 'question,answer\nWhat is 2 + 2?,4\n\nor one card per line:\nchien - dog\nchat - cat' });
  const fileInfo = h('span.body-small.muted', '');
  let fileText = null;
  const pick = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values', style: { display: 'none' } });
  pick.addEventListener('change', async () => {
    const f = pick.files && pick.files[0];
    if (!f) return;
    fileText = await f.text();
    ta.value = fileText.length > 20000 ? fileText.slice(0, 20000) + '\n…' : fileText;
    fileInfo.textContent = `${f.name} · ${fmtBytes(f.size)}`;
  });
  ta.addEventListener('input', () => { fileText = null; fileInfo.textContent = ''; });
  const content = h('div.de-import',
    h('p.body-medium.muted', { style: { marginTop: 0 } },
      'Paste or choose a CSV / TSV file (Anki and Quizlet exports work), or lines like “term - definition” or “Q: … A: …”. ',
      'A header row can name the columns: front, back, hint, explanation, category, and option A–H with correct for multiple choice.'),
    ta,
    h('div.row.gap-s', { style: { marginTop: '8px' } },
      h('md-outlined-button', { type: 'button', on: { click: () => pick.click() } }, btnIcon('folder_open'), 'Choose file…'), fileInfo),
    pick);
  const v = await dialog({
    headline: 'Import cards', icon: 'upload_file', wide: true, content,
    actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Import', value: 'ok', primary: true }],
    onOpen: () => setTimeout(() => ta.focus(), 150),
  });
  if (v !== 'ok') return;
  const text = fileText != null ? fileText : ta.value;
  addImported(fileText != null && /[,;\t]/.test(text.split('\n')[0] || '') ? cardsFromCsv(text) : cardsFromText(text));
}

// ------------------------------------------------------------------ preview
let previewReady = false;
let previewFrame = null;

async function startPreview(frame) {
  previewReady = false;
  previewFrame = frame;
  let runtime;
  try { runtime = await loadRuntime(); } catch (e) { frame.replaceWith(h('div.de-preview-error.body-medium.muted', `Preview unavailable: ${e.message}`)); return; }
  if (!st || previewFrame !== frame) return;
  const base = new URL('.', document.baseURI).href;
  const extra = `<link rel="stylesheet" href="${base}vendor/fonts.css"><script>window.__fvPreview = true; window.__fvVendor = ${JSON.stringify(base + 'vendor/')};<\/script>`;
  const html = buildDeckHtml({ title: '', cards: [] }, runtime).replace('<head>', '<head>' + extra);
  frame.addEventListener('load', () => { previewReady = true; postPreview(true); }, { once: true });
  frame.srcdoc = html;
}

/** Index of card i among cards with a front (what the deck shows). */
function shownIndex(i) {
  if (!st.cards[i] || !st.cards[i].front.trim()) return undefined;
  return st.cards.slice(0, i).filter((c) => c.front.trim()).length;
}

const postPreviewNow = () => {
  if (!st || !previewReady || !previewFrame || !previewFrame.contentWindow || !st.showPreview) return;
  previewFrame.contentWindow.postMessage({
    fvPreview: { deck: deckData(), index: shownIndex(st.focus), back: st.back, theme: deckThemeVars() },
  }, '*');
};
const postPreviewSoon = debounce(postPreviewNow, 150);
function postPreview(now = false) { if (now === true) postPreviewNow(); else postPreviewSoon(); }

// ------------------------------------------------------------------ save
async function save() {
  if (!st || st.saving) return;
  const title = st.title.trim();
  if (!title) {
    const f = $('#de-title');
    if (f) { f.error = true; f.errorText = 'Give your deck a name'; f.focus(); }
    snackbar('Give your deck a name first');
    return;
  }
  const deck = deckData();
  const ready = deck.cards.filter(cardComplete).length;
  if (!ready && !(await confirmDialog('No finished cards', 'None of the cards has both sides filled in yet. Save the deck anyway?', 'Save', 'warning'))) return;
  st.saving = true;
  const btn = $('#de-save');
  if (btn) btn.disabled = true;
  try {
    const html = buildDeckHtml(deck, await loadRuntime());
    if (new Blob([html]).size > MAX_DECK_BYTES) throw new Error(`the deck is ${fmtBytes(new Blob([html]).size)}; remove some images (limit ${fmtBytes(MAX_DECK_BYTES)})`);
    let id = st.id;
    const wasTitle = st.id ? (store.decks.find((d) => d.id === st.id) || {}).title : null;
    if (id) {
      emit('deck-saving');
      await call('saveCustomDeck', id, html);
      // A rename would hide the new title.
      const d = store.decks.find((x) => x.id === id);
      if (d && d.renamed && wasTitle !== title) await call('renameDeck', id, '');
    } else {
      id = await call('createCustomDeck', deckFilename(title), html);
    }
    const skipped = deck.cards.length - ready;
    const cb = onSaved;
    await closeDeckEditor({ force: true });
    snackbar(`Saved “${title}” · ${ready} card${ready === 1 ? '' : 's'}` + (skipped ? ` (${skipped} incomplete)` : ''));
    if (cb) cb(id);
  } catch (err) {
    snackbar(`Couldn’t save the deck: ${err.message || err}`, { timeout: 8000 });
  } finally {
    if (st) { st.saving = false; if (btn) btn.disabled = false; }
  }
}
