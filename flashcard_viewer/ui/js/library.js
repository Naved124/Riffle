// Library page: deck list (search / filter / sort / favourites) and the deck viewer.
import { call, fire } from './api.js';
import { store, setSettings, emit } from './store.js';
import { deckThemeVars } from './themes.js';
import {
  $, $$, h, icon, esc, fmtAgo, fmtDuration, fmtBytes, pct, debounce, snackbar, dialog, confirmDialog, promptDialog, deckAvatar,
} from './util.js';

let filter = 'all';
let searchHits = null; // null = no search, else Map(id -> hit)
let selectedId = null;
let frameReady = false;
let lastProgress = null;

// --------------------------------------------------------------- study-time tracking
const study = { deckId: null, active: 0, lastActivity: Date.now(), prompted: false, finishedPrompted: false };
export function markActivity() { study.lastActivity = Date.now(); }
async function flushStudy() {
  if (study.deckId && study.active >= 3) {
    const secs = study.active;
    study.active = 0;
    try { await call('recordStudy', study.deckId, secs); } catch (_) { /* ignore */ }
  }
}
setInterval(() => {
  if (!study.deckId || document.hidden || store.page !== 'library') return;
  const active = Date.now() - study.lastActivity < 120000;
  if (active) { study.active += 5; study.sessionActive = (study.sessionActive || 0) + 5; }
  const mins = store.settings.quiz.promptAfterMinutes;
  if (mins > 0 && !study.prompted && study.sessionActive >= mins * 60) {
    study.prompted = true;
    quizPrompt(`You've studied this deck for ${mins} minute${mins > 1 ? 's' : ''}.`);
  }
}, 5000);
setInterval(flushStudy, 5 * 60 * 1000);
window.__fvBeforeClose = () => { flushStudy(); };

// --------------------------------------------------------------- list
const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  recent: (a, b) => (a.recentIndex ?? 1e9) - (b.recentIndex ?? 1e9) || SORTERS.name(a, b),
  modified: (a, b) => b.mtime - a.mtime,
  studied: (a, b) => (b.stats.seconds || 0) - (a.stats.seconds || 0) || SORTERS.name(a, b),
  progress: (a, b) => (a.stats.progress || 0) - (b.stats.progress || 0) || SORTERS.name(a, b),
};

function kindLabel(d) {
  return { react: 'React', fragment: 'Snippet', html: 'HTML' }[d.kind] || d.kind;
}

function deckItem(d) {
  const hit = searchHits && searchHits.get(d.id);
  const meta = h('div.deck-meta',
    d.card_count ? `${d.card_count} card${d.card_count === 1 ? '' : 's'}` : 'No cards found',
    h('span.dot'), kindLabel(d),
    d.stats.lastOpened ? [h('span.dot'), fmtAgo(d.stats.lastOpened)] : null,
    d.external ? [h('span.dot'), h('span.tag', 'external')] : null);
  const progress = d.card_count ? h('div.deck-progress', { title: `${d.stats.mastered || 0} of ${d.card_count} mastered` },
    h('i', { style: { width: pct(d.stats.progress || 0) } })) : null;
  const snippet = hit && hit.snippet ? h('div.deck-snippet', { html: highlight(hit.snippet, $('#search-input').value) }) : null;
  const fav = h('md-icon-button', {
    class: d.favourite ? 'deck-fav filled' : '', title: d.favourite ? 'Unfavourite' : 'Favourite',
    style: { visibility: d.favourite ? 'visible' : 'hidden' },
    on: { click: (e) => { e.stopPropagation(); toggleFav(d.id); } },
  }, icon('star'));
  const item = h('div.deck-item', {
    tabindex: 0, role: 'option', dataset: { id: d.id }, title: d.path,
    class: (d.id === selectedId ? 'selected ' : '') + (d.favourite ? 'has-fav' : ''),
    on: {
      click: () => openDeck(d.id),
      keydown: (e) => {
        if (e.key === 'Enter') openDeck(d.id);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const items = $$('.deck-item');
          const i = items.indexOf(item) + (e.key === 'ArrowDown' ? 1 : -1);
          if (items[i]) items[i].focus();
        }
      },
      mouseenter: () => { fav.style.visibility = 'visible'; },
      mouseleave: () => { if (!d.favourite) fav.style.visibility = 'hidden'; },
    },
  }, deckAvatar(d), h('div.deck-main', h('div.deck-name', d.name), meta, snippet, progress), fav);
  return item;
}

function highlight(text, q) {
  let out = esc(text);
  for (const t of q.trim().split(/\s+/).filter((x) => x.length > 1)) {
    const rx = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(rx, (m) => `<mark>${m}</mark>`);
  }
  return out;
}

export function visibleDecks() {
  let list = store.decks.slice();
  if (searchHits) list = list.filter((d) => searchHits.has(d.id));
  if (filter === 'fav') list = list.filter((d) => d.favourite);
  if (filter === 'recent') list = list.filter((d) => d.recentIndex != null);
  if (filter === 'weak') list = list.filter((d) => d.stats.weakCount > 0);
  const sort = filter === 'recent' ? 'recent' : store.settings.library.sort;
  list.sort(SORTERS[sort] || SORTERS.name);
  if (searchHits) list.sort((a, b) => (searchHits.get(b.id).inName ? 1 : 0) - (searchHits.get(a.id).inName ? 1 : 0));
  return list;
}

export function renderList() {
  const box = $('#deck-list');
  const list = visibleDecks();
  box.replaceChildren();
  $('#deck-count').textContent = String(store.decks.length);
  if (!list.length) {
    const msg = searchHits ? 'No decks match your search' : filter === 'fav' ? 'No favourites yet — star a deck to pin it here'
      : filter === 'weak' ? 'No weak cards — take a quiz to find them' : filter === 'recent' ? 'Nothing opened yet'
        : 'No decks yet. Drop .html or .jsx flashcard files here, or add a folder in Settings.';
    box.append(h('div.list-empty', icon(searchHits ? 'search_off' : 'style'), h('p.body-medium', msg)));
    return;
  }
  const favFirst = store.settings.library.favouritesFirst && filter === 'all' && !searchHits;
  if (favFirst && list.some((d) => d.favourite) && list.some((d) => !d.favourite)) {
    box.append(h('div.deck-section', 'Favourites'), ...list.filter((d) => d.favourite).map(deckItem));
    box.append(h('div.deck-section', 'All decks'), ...list.filter((d) => !d.favourite).map(deckItem));
  } else {
    box.append(...list.map(deckItem));
  }
}

export async function refreshDecks() {
  store.decks = await call('listDecks');
  if (store.current) {
    const cur = store.decks.find((d) => d.id === store.current.id);
    if (cur) { store.current = cur; renderToolbar(); }
  }
  if (searchHits) await runSearch($('#search-input').value);
  renderList();
  emit('decks');
}

async function toggleFav(id) {
  const fav = await call('toggleFavourite', id);
  const d = store.decks.find((x) => x.id === id);
  if (d) d.favourite = fav;
  if (store.current && store.current.id === id) store.current.favourite = fav;
  renderList();
  renderToolbar();
}

// --------------------------------------------------------------- search
async function runSearch(q) {
  q = q.trim();
  $('#search-clear').classList.toggle('hidden', !q);
  if (!q) { searchHits = null; renderList(); return; }
  const hits = await call('search', q);
  searchHits = new Map(hits.map((x) => [x.id, x]));
  renderList();
}
const debSearch = debounce(runSearch, 140);

// --------------------------------------------------------------- viewer
function frame() { return $('#deck-frame'); }

export function deckConfig() {
  const s = store.settings;
  return {
    font: s.decks.applyAppFont ? s.appearance.font : '',
    mono: s.decks.applyAppFont ? s.appearance.monoFont : '',
    theme: s.decks.applyTheme,
    zoom: s.decks.zoom,
    shortcuts: Object.values(s.shortcuts),
    appMode: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    appTheme: deckThemeVars(),
    reduceMotion: !s.motion.enabled || !!s.motion.reduce,
  };
}
export function pushDeckConfig() {
  const f = frame();
  if (f && f.contentWindow && frameReady) f.contentWindow.postMessage({ fv: 'config', config: deckConfig() }, '*');
  $('#vt-zoom').textContent = Math.round(store.settings.decks.zoom * 100) + '%';
}

export async function openDeck(id, { quiet = false } = {}) {
  if (!id) return;
  if (store.current && store.current.id === id && lastSource) {
    selectedId = id;
    document.body.classList.add('deck-open');
    renderList();
    return;
  }
  await flushStudy();
  dismissQuizPrompt();
  const res = await call('openDeck', id);
  if (!res) { if (!quiet) snackbar('That deck is no longer available'); return; }
  selectedId = id;
  store.current = res.deck;
  Object.assign(study, { deckId: id, active: 0, sessionActive: 0, lastActivity: Date.now(), prompted: false, finishedPrompted: false });
  lastProgress = null;
  frameReady = false;
  $('#frame-wrap').classList.remove('empty');
  $('#frame-loading').classList.remove('hidden');
  document.body.classList.add('deck-open');
  setFrameSource(res);
  renderToolbar();
  renderList();
  const el = $(`.deck-item[data-id="${id}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
  emit('deck-opened');
}

let lastSource = null;
// Desktop serves decks from deck://<id>/ (own origin); Android/web hands over the HTML as a sandboxed srcdoc.
function setFrameSource(res) {
  lastSource = res;
  const f = frame();
  if (res.srcdoc != null) {
    f.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-downloads');
    f.removeAttribute('src');
    f.srcdoc = res.srcdoc;
  } else {
    f.removeAttribute('sandbox');
    f.removeAttribute('srcdoc');
    f.src = res.url;
  }
}

export async function reloadDeck() {
  if (!store.current) return;
  frameReady = false;
  $('#frame-loading').classList.remove('hidden');
  if (lastSource && lastSource.srcdoc != null) {
    const res = await call('openDeck', store.current.id);
    if (res) setFrameSource(res);
    return;
  }
  const src = frame().src;
  frame().src = 'about:blank';
  setTimeout(() => { frame().src = src; }, 30);
}

function renderToolbar() {
  const d = store.current;
  const has = !!d;
  $('#vt-name').textContent = has ? d.name : 'No deck open';
  $('#vt-emoji').textContent = has ? d.emoji || '' : '';
  $('#vt-sub').textContent = has
    ? `${d.card_count ? d.card_count + ' cards' : 'No cards detected'} · ${kindLabel(d)} · ${d.filename}`
    : '';
  for (const id of ['vt-fav', 'vt-quiz', 'vt-cards', 'vt-reload', 'vt-more', 'vt-zoom-in', 'vt-zoom-out']) {
    $('#' + id).disabled = !has;
  }
  $('#vt-fav').selected = !!(d && d.favourite);
  renderProgress();
}

function renderProgress() {
  const box = $('#vt-progress');
  if (!lastProgress || !store.current) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.classList.toggle('done', lastProgress.current === lastProgress.total);
  $('#vt-progress-text').textContent = `${lastProgress.current} / ${lastProgress.total}`;
}

export function setDeckZoom(z) {
  z = Math.round(Math.max(0.3, Math.min(3, z)) * 100) / 100;
  setSettings({ decks: { zoom: z } });
  pushDeckConfig();
}

let closePrompt = null;
export function dismissQuizPrompt() { if (closePrompt) { closePrompt(); closePrompt = null; } }
function quizPrompt(text) {
  if (!store.current || !store.current.card_count) return;
  dismissQuizPrompt();
  closePrompt = snackbar(text + ' Ready for a quiz?', {
    action: 'Start quiz', timeout: 12000,
    onAction: () => emit({ type: 'start-quiz', deckId: store.current.id }),
  });
}

// A deck may only make the app act (open a link, run a shortcut) right after the user clicked or
// pressed a key in it: that activation reaches this page too, so a deck can't do it on its own.
const userActed = () => !navigator.userActivation || navigator.userActivation.isActive;
let lastLinkOpened = 0;

// Messages from the deck helper inside the iframe.
function onFrameMessage(e) {
  const d = e.data;
  if (!d || typeof d !== 'object' || !d.fv || e.source !== frame().contentWindow) return;
  switch (d.fv) {
    case 'ready':
      frameReady = true;
      pushDeckConfig();
      $('#frame-loading').classList.add('hidden');
      break;
    case 'loaded':
      $('#frame-loading').classList.add('hidden');
      break;
    case 'progress':
      lastProgress = { current: d.current, total: d.total };
      renderProgress();
      break;
    case 'finished':
      markActivity();
      if (store.settings.quiz.promptOnFinish && !study.finishedPrompted) {
        study.finishedPrompted = true;
        quizPrompt('🎉 You reached the end of the deck!');
      }
      break;
    case 'interaction':
      markActivity();
      break;
    case 'shortcut':
      if (userActed()) emit({ type: 'shortcut', combo: String(d.combo || '') });
      break;
    case 'dragenter':
      emit({ type: 'dragenter' });
      break;
    case 'open-link':
      if (userActed() && Date.now() - lastLinkOpened > 1000) {
        lastLinkOpened = Date.now();
        fire('openExternal', String(d.url || ''));
      }
      break;
    default:
  }
}

// --------------------------------------------------------------- dialogs
async function editCards() {
  const d = store.current;
  if (!d) return;
  if (d.custom) { emit({ type: 'create-deck', deckId: d.id }); return; } // made with the deck editor
  const data = await call('getCards', d.id);
  let rows = data.cards.map((c) => ({ ...c }));
  const list = h('div.card-editor');
  const draw = () => {
    list.replaceChildren(h('div.ce-head', h('span', '#'), h('span', 'Front (question)'), h('span', 'Back (answer)'), h('span')));
    rows.forEach((r, i) => {
      const f = h('textarea', { rows: 2, '.value': r.front, on: { input: (e) => { r.front = e.target.value; } } });
      const b = h('textarea', { rows: 2, '.value': r.back, on: { input: (e) => { r.back = e.target.value; } } });
      list.append(h('div.ce-row', h('span.n', String(i + 1)), f, b,
        h('md-icon-button', { title: 'Delete card', on: { click: () => { rows.splice(i, 1); draw(); } } }, icon('delete'))));
    });
    list.append(h('div.row.gap', { style: { marginTop: '8px' } },
      h('md-outlined-button', { type: 'button', on: { click: () => { rows.push({ front: '', back: '' }); draw(); list.lastChild.previousSibling.querySelector('textarea').focus(); } } }, icon('add'), 'Add card')));
  };
  draw();
  const how = data.manual ? 'You edited these cards by hand.'
    : data.methods.length ? `Detected automatically (${data.methods.join(', ')}). Fix anything that looks wrong — your edits are stored separately and never change the deck file.`
      : 'No cards were detected in this deck. Add them here to enable quizzes.';
  const actions = [];
  if (data.manual) {
    actions.push({ label: 'Reset to auto-detected', value: 'reset', submit: true });
  }
  actions.push({ label: 'Make editable copy', value: 'copy' });
  actions.push({ label: 'Cancel', value: 'cancel' }, { label: 'Save cards', value: 'save', primary: true });
  const v = await dialog({
    headline: `Cards — ${d.name}`, icon: 'edit_note', wide: true,
    content: h('div', h('p.body-medium.muted', { style: { marginTop: 0 } }, how), list), actions,
  });
  if (v === 'save') {
    const clean = rows.filter((r) => r.front.trim() && r.back.trim());
    await call('saveCards', d.id, JSON.stringify(clean));
    snackbar(`Saved ${clean.length} card${clean.length === 1 ? '' : 's'}`);
    await refreshDecks();
  } else if (v === 'reset') {
    await call('resetCards', d.id);
    snackbar('Cards reset to auto-detected');
    await refreshDecks();
  } else if (v === 'copy') {
    // A new deck-editor deck with these cards (formatting, images and maths can then be added).
    const cards = rows.filter((r) => r.front.trim() && r.back.trim()).map((r) => (r.choices && r.choices.length >= 2 && r.choices.includes(r.back)
      ? { type: 'mcq', front: r.front, choices: r.choices, correct: r.choices.indexOf(r.back), hint: r.hint, explanation: r.explanation, category: r.category }
      : { type: 'basic', front: r.front, back: r.back, hint: r.hint, explanation: r.explanation, category: r.category }));
    emit({ type: 'create-deck', seed: { title: `${d.name} (my copy)`, emoji: d.emoji, cards } });
  }
}

async function renameDeck() {
  const d = store.current;
  if (!d) return;
  const name = await promptDialog('Rename deck', 'Display name', d.name, 'drive_file_rename_outline');
  if (name == null) return;
  await call('renameDeck', d.id, name);
  await refreshDecks();
}

async function deckInfo() {
  const d = store.current;
  if (!d) return;
  const row = (k, v) => h('tr', h('td', k), h('td.selectable', v));
  await dialog({
    headline: d.name, icon: 'info',
    content: h('table.info-table',
      row('File', d.path), row('Type', kindLabel(d)), row('Size', fmtBytes(d.size)),
      row('Modified', new Date(d.mtime * 1000).toLocaleString()), row('Cards', String(d.card_count)),
      row('Detected via', d.manualCards ? 'manual edits' : (d.methods.join(', ') || '—')),
      row('Opened', `${d.stats.openCount} times, last ${fmtAgo(d.stats.lastOpened)}`),
      row('Study time', fmtDuration(d.stats.seconds)), row('Quizzes', `${d.stats.quizzes} (best ${pct(d.stats.bestScore)})`)),
    actions: [{ label: 'Close', value: 'ok' }],
  });
}

async function deleteDeck() {
  const d = store.current;
  if (!d) return;
  const msg = d.external ? 'Remove this deck from the library? The file itself is not touched.'
    : `Move “${d.filename}” to the trash?`;
  if (store.settings.general.confirmDelete && !(await confirmDialog('Remove deck', msg, d.external ? 'Remove' : 'Move to trash', 'delete'))) return;
  await call('deleteDeck', d.id);
  closeDeck();
  await refreshDecks();
  snackbar('Deck removed');
}

/** Phone layout: leave the full-screen viewer and show the deck list (deck stays loaded). */
export function showDeckList() {
  if (!document.body.classList.contains('deck-open')) return false;
  flushStudy();
  dismissQuizPrompt();
  document.body.classList.remove('deck-open');
  return true;
}

export function closeDeck() {
  document.body.classList.remove('deck-open');
  flushStudy();
  store.current = null;
  selectedId = null;
  study.deckId = null;
  frame().removeAttribute('srcdoc');
  frame().src = 'about:blank';
  lastSource = null;
  $('#frame-wrap').classList.add('empty');
  lastProgress = null;
  renderToolbar();
  renderList();
}

// --------------------------------------------------------------- init
export function initLibrary() {
  window.addEventListener('message', onFrameMessage);
  frame().addEventListener('load', () => $('#frame-loading').classList.add('hidden'));

  $('#search-input').addEventListener('input', (e) => {
    if (store.page !== 'library') emit({ type: 'goto', page: 'library' });
    debSearch(e.target.value);
  });
  $('#search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; runSearch(''); e.target.blur(); }
    if (e.key === 'Enter') { const first = visibleDecks()[0]; if (first) openDeck(first.id); }
    if (e.key === 'ArrowDown') { e.preventDefault(); const f = $('.deck-item'); if (f) f.focus(); }
  });
  $('#search-clear').addEventListener('click', () => { $('#search-input').value = ''; runSearch(''); });

  $('#filter-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('md-filter-chip');
    if (!chip) return;
    filter = chip.dataset.filter;
    $$('#filter-chips md-filter-chip').forEach((c) => { c.selected = c === chip; });
    renderList();
  });
  $('#btn-sort').addEventListener('click', () => { $('#menu-sort').open = !$('#menu-sort').open; });
  $('#menu-sort').addEventListener('close-menu', (e) => {
    const item = e.detail.initiator;
    if (item && item.dataset.sort) { setSettings({ library: { sort: item.dataset.sort } }); renderList(); }
  });
  $('#btn-rescan').addEventListener('click', async () => {
    store.decks = await call('rescan');
    renderList();
    snackbar(`Found ${store.decks.length} deck${store.decks.length === 1 ? '' : 's'}`, { timeout: 2500 });
  });

  $('#vt-fav').addEventListener('click', () => store.current && toggleFav(store.current.id));
  $('#vt-quiz').addEventListener('click', () => store.current && emit({ type: 'start-quiz', deckId: store.current.id }));
  $('#vt-cards').addEventListener('click', editCards);
  $('#vt-reload').addEventListener('click', reloadDeck);
  $('#vt-zoom-in').addEventListener('click', () => setDeckZoom(store.settings.decks.zoom + 0.1));
  $('#vt-zoom-out').addEventListener('click', () => setDeckZoom(store.settings.decks.zoom - 0.1));
  $('#vt-zoom').addEventListener('click', () => setDeckZoom(1));
  $('#vt-focus').addEventListener('click', () => emit({ type: 'toggle-focus' }));
  $('#btn-focus-exit').addEventListener('click', () => emit({ type: 'toggle-focus' }));
  $('#vt-more').addEventListener('click', () => { $('#menu-more').open = !$('#menu-more').open; });
  $('#mi-rename').addEventListener('click', renameDeck);
  $('#vt-back').addEventListener('click', showDeckList);
  $('#mi-cards').addEventListener('click', editCards);
  $('#mi-reload').addEventListener('click', reloadDeck);
  $('#mi-zoom-in').addEventListener('click', () => setDeckZoom(store.settings.decks.zoom + 0.1));
  $('#mi-zoom-out').addEventListener('click', () => setDeckZoom(store.settings.decks.zoom - 0.1));
  $('#mi-fullscreen').addEventListener('click', () => emit({ type: 'toggle-focus' }));
  $('#mi-reveal').addEventListener('click', () => store.current && call('revealDeck', store.current.id));
  $('#mi-info').addEventListener('click', deckInfo);
  $('#mi-delete').addEventListener('click', deleteDeck);
  $('#mi-stats').addEventListener('click', () => store.current && emit({ type: 'deck-stats', deckId: store.current.id }));
  $('#empty-add').addEventListener('click', () => emit({ type: 'add-files' }));
  $('#empty-folder').addEventListener('click', () => call('openPath', store.settings.library.mainFolder));

  // Sidebar resize
  const rz = $('#pane-resizer');
  rz.addEventListener('pointerdown', (e) => {
    rz.setPointerCapture(e.pointerId);
    rz.classList.add('active');
    const startX = e.clientX, startW = $('#deck-pane').getBoundingClientRect().width;
    const move = (ev) => {
      const w = Math.max(220, Math.min(560, startW + ev.clientX - startX));
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    };
    const up = () => {
      rz.classList.remove('active');
      rz.removeEventListener('pointermove', move);
      setSettings({ window: { sidebarWidth: Math.round($('#deck-pane').getBoundingClientRect().width) } });
    };
    rz.addEventListener('pointermove', move);
    rz.addEventListener('pointerup', up, { once: true });
  });
  ['pointerdown', 'keydown', 'wheel'].forEach((ev) => document.addEventListener(ev, markActivity, { passive: true }));
  renderToolbar();
}

// The deck editor is about to overwrite a deck file: reload quietly when the file watcher notices.
let quietUntil = 0;
export function expectDeckChange() { quietUntil = Date.now() + 4000; }

export function onDeckFileChanged(id) {
  if (Date.now() < quietUntil) { refreshDecks(); return; }
  if (store.current && store.current.id === id) {
    reloadDeck();
    snackbar('Deck file changed — reloaded', { timeout: 2500 });
  }
  refreshDecks();
}

export { editCards, deckInfo, toggleFav, fire };
