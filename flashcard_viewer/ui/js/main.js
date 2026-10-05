// App bootstrap: theme, routing, window chrome, shortcuts, drag & drop, backend signals.
import '../vendor/material.js';
import { ready, call, fire, on } from './api.js';
import { store, subscribe, emit, setSettings } from './store.js';
import { applyTheme } from './themes.js';
import { $, $$, h, snackbar, dialog, comboFromEvent, prettyCombo } from './util.js';
import {
  initLibrary, refreshDecks, renderList, openDeck, reloadDeck, setDeckZoom, pushDeckConfig, onDeckFileChanged, editCards,
  visibleDecks, toggleFav, markActivity, dismissQuizPrompt, showDeckList,
} from './library.js';
import { initQuiz, renderPicker, startQuiz, quizKey, quizActive } from './quiz.js';
import { renderStats, deckStatsDialog, updateStreakBadge } from './stats.js';
import { initSettings, openSettings, renderSection, SHORTCUT_LABELS } from './settings.js';

// ------------------------------------------------------------------ appearance
function applyAll() {
  const s = store.settings;
  const r = applyTheme(s.appearance, store.systemScheme);
  const b = document.body;
  b.classList.toggle('no-motion', !s.motion.enabled || s.motion.reduce);
  b.classList.toggle('no-ripple', !s.motion.rippleEffects);
  document.documentElement.style.setProperty('--motion', String(s.motion.enabled ? s.motion.speed : 0));
  document.documentElement.style.setProperty('--sidebar-w', (s.window.sidebarWidth || 300) + 'px');
  b.classList.toggle('sidebar-collapsed', !!s.window.sidebarCollapsed);
  b.classList.toggle('native-titlebar', !s.window.customTitlebar);
  $('#btn-mode md-icon').textContent = r.dark ? 'light_mode' : 'dark_mode';
  const bar = getComputedStyle(document.documentElement).getPropertyValue('--md-sys-color-surface-container').trim();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && bar) meta.content = bar;
  if (window.AndroidBridge && window.AndroidBridge.setSystemBars && bar) window.AndroidBridge.setSystemBars(bar, r.dark);
  pushDeckConfig();
}

// ------------------------------------------------------------------ routing
const pageRenderers = {
  library: () => renderList(),
  quiz: () => { if (!quizActive()) renderPicker(); },
  stats: () => renderStats(),
  settings: () => renderSection(),
};
function goto(page, { silent = false } = {}) {
  if (!pageRenderers[page]) return;
  if (store.page === 'library' && page !== 'library') markActivity();
  store.page = page;
  document.body.dataset.page = page;
  $$('.rail-item').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
  if (!silent) pageRenderers[page]();
}

// ------------------------------------------------------------------ focus / fullscreen
let osFullscreen = false;
async function toggleFullscreen() {
  osFullscreen = await call('toggleFullscreen');
  document.body.classList.toggle('focus', osFullscreen);
  if (osFullscreen) flashExit();
}
function toggleFocus() {
  if (osFullscreen) return toggleFullscreen();
  if (store.page !== 'library') goto('library');
  document.body.classList.toggle('focus');
  if (document.body.classList.contains('focus')) flashExit();
}
function flashExit() {
  document.body.classList.add('show-exit');
  setTimeout(() => document.body.classList.remove('show-exit'), 2200);
}

// ------------------------------------------------------------------ shortcuts
function cycleDeck(dir) {
  const list = visibleDecks();
  if (!list.length) return;
  const i = list.findIndex((d) => store.current && d.id === store.current.id);
  const next = list[(i + dir + list.length) % list.length];
  goto('library');
  openDeck(next.id);
}
const ACTIONS = {
  search: () => { goto('library'); $('#search-input').focus(); $('#search-input').select(); },
  openFile: () => addFiles(),
  fullscreen: () => toggleFullscreen(),
  focusMode: () => toggleFocus(),
  quiz: () => store.current && emit({ type: 'start-quiz', deckId: store.current.id }),
  nextDeck: () => cycleDeck(1),
  prevDeck: () => cycleDeck(-1),
  zoomIn: () => setDeckZoom(store.settings.decks.zoom + 0.1),
  zoomOut: () => setDeckZoom(store.settings.decks.zoom - 0.1),
  zoomReset: () => setDeckZoom(1),
  reload: () => reloadDeck(),
  favourite: () => store.current && toggleFav(store.current.id),
  library: () => goto('library'),
  quizPage: () => goto('quiz'),
  stats: () => goto('stats'),
  settings: () => goto('settings'),
  toggleSidebar: () => setSettings({ window: { sidebarCollapsed: !store.settings.window.sidebarCollapsed } }),
  cheatsheet: () => cheatsheet(),
};
function runCombo(combo) {
  const action = Object.entries(store.settings.shortcuts).find(([, c]) => c && c === combo);
  if (!action || !ACTIONS[action[0]]) return false;
  ACTIONS[action[0]]();
  return true;
}
function onKeyDown(e) {
  if ($('md-dialog[open]')) return;
  const combo = comboFromEvent(e);
  if (!combo) return;
  if (e.key === 'Escape' && document.body.classList.contains('focus')) { e.preventDefault(); toggleFocus(); return; }
  if (quizKey(e)) { e.preventDefault(); return; }
  const typing = e.composedPath().some((n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || (n.tagName || '').includes('TEXT-FIELD'));
  if (typing && !/^(Ctrl|Alt)\+|^F\d+$/.test(combo)) return;
  if (runCombo(combo)) e.preventDefault();
}

function cheatsheet() {
  const sc = store.settings.shortcuts;
  dialog({
    headline: 'Keyboard shortcuts', icon: 'keyboard',
    content: h('div.cheats', Object.keys(SHORTCUT_LABELS).filter((k) => sc[k]).map((k) => [h('span.body-medium', SHORTCUT_LABELS[k]), h('kbd', prettyCombo(sc[k]))]),
      h('span.body-medium', 'Quiz: answer A–D / 1–4, True/False with T/F, hint with H'), h('kbd', 'Quiz'),
      h('span.body-medium', 'Exit focus mode or quit a quiz'), h('kbd', 'Esc')),
    actions: [{ label: 'Customize', value: 'edit' }, { label: 'Close', value: 'close', primary: true }],
  }).then((v) => { if (v === 'edit') { goto('settings'); openSettings('shortcuts'); } });
}

// ------------------------------------------------------------------ files
async function addFiles() {
  const ids = await call('openFilesDialog');
  if (ids && ids.length) {
    await refreshDecks();
    goto('library');
    openDeck(ids[0]);
    snackbar(`Added ${ids.length} deck${ids.length > 1 ? 's' : ''}`);
  }
}

const DECK_RX = /\.(html?|xhtml|jsx|tsx)$/i;
function initDrop() {
  const overlay = $('#drop-overlay');
  let hideTimer = null;
  const show = () => { overlay.classList.add('show'); clearTimeout(hideTimer); hideTimer = setTimeout(() => overlay.classList.remove('show'), 4000); };
  const hide = () => overlay.classList.remove('show');
  window.addEventListener('dragenter', (e) => { if (Array.from(e.dataTransfer.types).includes('Files')) show(); });
  overlay.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; show(); });
  overlay.addEventListener('dragleave', (e) => { if (e.target === overlay) hide(); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    hide();
    const files = Array.from(e.dataTransfer.files || []);
    const good = files.filter((f) => DECK_RX.test(f.name));
    if (!good.length) { snackbar(files.length ? 'Only .html, .htm, .jsx and .tsx decks can be added' : 'Nothing to add'); return; }
    const ids = [];
    for (const f of good) {
      try { ids.push(await call('importDropped', f.name, await f.text())); } catch (err) { snackbar(`Couldn't add ${f.name}: ${err.message}`); }
    }
    await refreshDecks();
    goto('library');
    if (ids.length) openDeck(ids[ids.length - 1]);
    snackbar(`Added ${ids.length} deck${ids.length === 1 ? '' : 's'} to ${store.settings.library.mainFolder}`);
    if (good.length < files.length) snackbar(`${files.length - good.length} file(s) skipped — not a deck`);
  });
  subscribe((ev) => { if (ev && ev.type === 'dragenter') show(); });
}

// ------------------------------------------------------------------ window chrome
function initChrome() {
  const tb = $('#titlebar');
  tb.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !store.settings.window.customTitlebar) return;
    if (e.target.closest('button, input, md-icon-button, .search, a, kbd')) return;
    fire('startMove');
  });
  tb.addEventListener('dblclick', (e) => {
    if (!store.settings.window.customTitlebar || e.target.closest('button, input, md-icon-button, .search')) return;
    fire('toggleMaximize');
  });
  $('#win-min').addEventListener('click', () => fire('minimize'));
  $('#win-max').addEventListener('click', () => fire('toggleMaximize'));
  $('#win-close').addEventListener('click', () => fire('closeWindow'));
  $$('.rz').forEach((el) => el.addEventListener('pointerdown', (e) => { if (e.button === 0) fire('startResize', el.dataset.edge); }));
  $('#btn-sidebar').addEventListener('click', ACTIONS.toggleSidebar);
  $('#btn-mode').addEventListener('click', () => {
    const dark = document.documentElement.classList.contains('dark');
    setSettings({ appearance: { mode: dark ? 'light' : 'dark' } });
  });
  $$('.rail-item').forEach((b) => b.addEventListener('click', () => goto(b.dataset.page)));
  $('#fab-add').addEventListener('click', addFiles);
}

function setWindowState(st) {
  document.body.classList.toggle('maximized', st === 'maximized');
  document.body.classList.toggle('fullscreen', st === 'fullscreen');
  $('#win-max md-icon').textContent = st === 'maximized' ? 'filter_none' : 'crop_square';
  $('#win-max').title = st === 'maximized' ? 'Restore' : 'Maximize';
  if (st !== 'fullscreen' && osFullscreen) { osFullscreen = false; document.body.classList.remove('focus'); }
}

// ------------------------------------------------------------------ events between modules
subscribe(async (ev) => {
  if (ev === 'settings') { applyAll(); return; }
  if (ev === 'deck-config') { pushDeckConfig(); return; }
  if (ev === 'decks') { renderList(); return; }
  if (ev === 'rescan') { await refreshDecks(); return; }
  if (ev === 'stats-changed') { updateStreakBadge(); refreshDecks(); if (store.page === 'stats') renderStats(); return; }
  if (ev === 'titlebar') { applyAll(); return; }
  if (ev === 'cheatsheet') { cheatsheet(); return; }
  if (!ev || typeof ev !== 'object') return;
  switch (ev.type) {
    case 'goto': goto(ev.page, { silent: ev.silent }); break;
    case 'start-quiz': dismissQuizPrompt(); goto('quiz', { silent: true }); startQuiz(ev.deckId, { onlyWeak: ev.onlyWeak }); break;
    case 'open-deck':
      goto('library');
      await openDeck(ev.deckId);
      if (ev.editCards) editCards();
      break;
    case 'toggle-focus': toggleFocus(); break;
    case 'add-files': addFiles(); break;
    case 'deck-stats': deckStatsDialog(ev.deckId); break;
    case 'shortcut': runCombo(ev.combo); break;
    default:
  }
});

// ------------------------------------------------------------------ Android back button
// Returns true when the app handled it (otherwise the activity closes).
window.__fvBack = () => {
  const dlg = document.querySelector('md-dialog[open]');
  if (dlg) { dlg.close('cancel'); return true; }
  const menu = document.querySelector('md-menu[open]');
  if (menu) { menu.open = false; return true; }
  if (document.body.classList.contains('focus')) { toggleFocus(); return true; }
  if (store.page === 'quiz' && quizActive()) { quizKey(new KeyboardEvent('keydown', { key: 'Escape' })); return true; }
  if (store.page === 'library' && showDeckList()) { renderList(); return true; }
  if (store.page !== 'library') { goto('library'); return true; }
  return false;
};

// ------------------------------------------------------------------ boot
async function boot() {
  try {
    await ready;
  } catch (e) {
    document.body.classList.remove('booting');
    document.body.innerHTML = `<p style="padding:40px;font:16px system-ui">${e.message}</p>`;
    return;
  }
  const init = await call('getInitialState');
  Object.assign(store, {
    settings: init.settings, defaults: init.defaults, systemScheme: init.systemScheme, version: init.version,
    dataDir: init.dataDir, configDir: init.configDir, platform: init.platform || 'desktop',
  });
  document.body.classList.add('platform-' + store.platform);
  if (store.platform !== 'desktop') store.settings.window.customTitlebar = false;
  applyAll();
  setWindowState(init.maximized ? 'maximized' : 'normal');
  initChrome();
  initLibrary();
  initQuiz();
  initSettings();
  initDrop();
  window.addEventListener('keydown', onKeyDown, true);

  on('decksChanged', () => refreshDecks());
  on('deckFileChanged', (id) => onDeckFileChanged(id));
  on('openDeckRequested', async (id) => { await refreshDecks(); goto('library'); openDeck(id); });
  on('windowStateChanged', setWindowState);
  on('systemThemeChanged', (scheme) => { store.systemScheme = scheme; applyAll(); if (store.page === 'settings') renderSection(); });

  await refreshDecks();
  updateStreakBadge();
  const start = init.settings.general.startPage;
  if (init.pendingOpen && init.pendingOpen.length) {
    goto('library');
    openDeck(init.pendingOpen[init.pendingOpen.length - 1]);
  } else if (start === 'stats') {
    goto('stats');
  } else {
    goto('library');
    if (start === 'lastDeck' && init.settings.general.lastDeck) openDeck(init.settings.general.lastDeck, { quiet: true });
  }
  requestAnimationFrame(() => document.body.classList.remove('booting'));
}

boot();
