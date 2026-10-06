// JavaScript implementation of the app backend (same API as flashcard_viewer/bridge.py),
// used on Android (WebView) and in plain browsers. Decks live inside the app (IndexedDB).
import { kv } from './kv.js';
import { DEFAULTS, DEFAULT_LIBRARY, APP_VERSION } from './defaults.js';
import { extractCards, decodeText, isScriptSource, cardKey } from './extract.js';
import { buildQuiz, gradeResponse } from './quizcore.js';
import { Stats } from './statscore.js';
import { renderDeck } from './render.js';
import { API_LATEST, summarize } from './updatecore.js';
import { parseDeckHtml, deckSearchText } from './deckgen.js';

const EXTRACT_VERSION = 2;
const DECK_RX = /\.(html?|xhtml|jsx|tsx)$/i;
const android = () => (typeof window !== 'undefined' && window.AndroidBridge) || null;
// MainActivity passes a per-install key in the page URL (#k=...). Deck frames can't read it, so
// they can't use the bridge methods that save files, open links or install updates.
const KEY = (typeof location !== 'undefined' && (/[#&]k=([\w-]+)/.exec(location.hash) || [])[1]) || '';
const clone = (o) => JSON.parse(JSON.stringify(o));
// The Qt bridge takes JSON strings; accept both forms.
const P = (x) => (typeof x === 'string' ? JSON.parse(x) : x);

function deepMerge(base, over) {
  const out = clone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* quota / private mode */ }
}

// ---------------------------------------------------------------- deck metadata helpers (port of library.py)
const decodeEntities = (s) => { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; };
function prettifyFilename(name) {
  let stem = name.replace(/\.(html?|xhtml|jsx|tsx)$/i, '').replace(/^\d+[\s._-]+/, '').replace(/[_-]+/g, ' ').trim();
  return stem ? stem[0].toUpperCase() + stem.slice(1) : name;
}
function guessTitle(text, filename) {
  if (!isScriptSource(filename, text)) {
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
    if (m) { const t = decodeEntities(m[1]).replace(/\s+/g, ' ').trim(); if (t) return t.slice(0, 120); }
  }
  const m = /<h1[^>]*>([^<{]+)/i.exec(text) || /<h2[^>]*>([^<{]+)/i.exec(text);
  if (m) {
    const t = decodeEntities(m[1]).replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+/u, '').trim();
    if (t.length >= 3) return t.slice(0, 120);
  }
  return prettifyFilename(filename);
}
function guessEmoji(text) {
  for (const m of text.slice(0, 200000).matchAll(/<(h1|h2|title)\b[^>]*>\s*([^<]{1,12})/gi)) {
    const head = m[2].trim();
    let out = '';
    for (const ch of head) {
      if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(ch) || (out && /[️‍\u{1F3FB}-\u{1F3FF}]/u.test(ch))) out += ch;
      else break;
    }
    if (out) return out;
  }
  return '';
}
function deckKind(text, filename) {
  if (isScriptSource(filename, text)) return 'react';
  const head = text.slice(0, 20000).replace(/<!--[\s\S]*?-->/g, '').replace(/^[﻿\s]+/, '').slice(0, 4000).toLowerCase();
  return /<!doctype|<html|<head|<body/.test(head) ? 'html' : 'fragment';
}
const fold = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
function plainText(text, filename) {
  if (isScriptSource(filename, text)) return fold(text);
  return fold(decodeEntities(text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' '));
}
function contentHash(s) { return cardKey(s.length + ':' + s.slice(0, 5000) + s.slice(-5000)); }

// ---------------------------------------------------------------- backend
export class JsBackend {
  constructor() {
    this.listeners = new Map();
    this.decks = new Map(); // id -> record (no text)
    this.texts = new Map(); // id -> text (lazy)
    this.saveTimer = null;
  }

  // -- events (same names as the Qt signals) --
  on(name, fn) { (this.listeners.get(name) || this.listeners.set(name, new Set()).get(name)).add(fn); }
  emit(name, ...args) { for (const fn of this.listeners.get(name) || []) fn(...args); }

  async init() {
    this.settingsData = deepMerge(DEFAULTS, lsGet('fv.settings', {}));
    this.settingsData.library.folders = ['In-app library'];
    this.settingsData.library.mainFolder = 'In-app library';
    this.lib = deepMerge(DEFAULT_LIBRARY, lsGet('fv.library', {}));
    this.stats = new Stats((await kv.get('stats')) || {});
    const index = (await kv.get('decks')) || [];
    for (const rec of index) this.decks.set(rec.id, rec);
    // Re-extract decks indexed by an older extractor.
    for (const rec of this.decks.values()) {
      if (rec.v !== EXTRACT_VERSION) await this.reindex(rec.id);
    }
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => this.emit('systemThemeChanged', e.matches ? 'dark' : 'light'));
    }
    window.__fvImport = (name, text) => this.importExternal(name, text);
    if (android() && android().pendingImports) {
      try { for (const f of JSON.parse(android().pendingImports(KEY) || '[]')) await this.importExternal(f.name, f.text, false); } catch (_) { /* ignore */ }
    }
    if (android() && android().setNetworkMode) android().setNetworkMode(KEY, this.settingsData.network.mode);
    // Download/install progress from MainActivity.
    window.__fvUpdateEvent = (json) => this.emit('updateStatus', json);
    return this;
  }

  saveStats() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => kv.set('stats', this.stats.dump()), 200);
  }
  saveIndex() { return kv.set('decks', [...this.decks.values()]); }
  saveLib() { lsSet('fv.library', this.lib); }

  async text(id) {
    if (!this.texts.has(id)) this.texts.set(id, (await kv.get('deck:' + id)) || '');
    return this.texts.get(id);
  }

  async reindex(id) {
    const rec = this.decks.get(id);
    const text = await this.text(id);
    const ex = extractCards(text, rec.filename);
    Object.assign(rec, {
      v: EXTRACT_VERSION, title: guessTitle(text, rec.filename), emoji: guessEmoji(text), kind: deckKind(text, rec.filename),
      cards: ex.cards, methods: ex.methods, plain: plainText(text, rec.filename).slice(0, 200000), size: text.length, custom: false,
    });
    const custom = parseDeckHtml(text);
    if (custom) {
      Object.assign(rec, { title: custom.title || prettifyFilename(rec.filename), emoji: custom.emoji, plain: fold(deckSearchText(custom)).slice(0, 200000), custom: true });
    }
    await this.saveIndex();
  }

  cards(id) {
    const ov = lsGet('fv.overrides.' + id, null);
    if (ov) return ov.cards.map((c) => ({ ...c, key: cardKey(c.front) }));
    const rec = this.decks.get(id);
    return rec ? rec.cards : [];
  }

  deckDict(rec) {
    const cards = this.cards(rec.id);
    const manual = !!lsGet('fv.overrides.' + rec.id, null);
    const ri = this.lib.recent.indexOf(rec.id);
    return {
      id: rec.id, path: rec.filename, filename: rec.filename, folder: 'In-app library', title: rec.title, emoji: rec.emoji,
      kind: rec.kind, size: rec.size, mtime: rec.mtime, card_count: cards.length, methods: manual ? ['manual'] : rec.methods,
      external: false, name: this.lib.renames[rec.id] || rec.title, favourite: this.lib.favourites.includes(rec.id),
      renamed: rec.id in this.lib.renames, recentIndex: ri < 0 ? null : ri,
      stats: this.stats.deckSummary(rec.id, cards.map((c) => c.key)), manualCards: manual, custom: !!rec.custom,
    };
  }

  // -- importing --
  async importFile(name, text) {
    text = decodeText(text);
    name = (name || 'deck.html').split(/[\\/]/).pop();
    if (!DECK_RX.test(name)) name += /^\s*(import|export)\s/m.test(text) ? '.jsx' : '.html';
    const hash = contentHash(text);
    for (const rec of this.decks.values()) if (rec.hash === hash) return rec.id;
    let filename = name;
    const names = new Set([...this.decks.values()].map((r) => r.filename));
    for (let n = 2; names.has(filename); n++) filename = name.replace(/(\.[^.]+)$/, ` (${n})$1`);
    const id = cardKey(filename + ':' + Date.now() + ':' + Math.random()).slice(0, 16);
    await kv.set('deck:' + id, text);
    this.texts.set(id, text);
    this.decks.set(id, { id, filename, hash, mtime: Date.now() / 1000 });
    await this.reindex(id);
    return id;
  }

  async importExternal(name, text, open = true) {
    const id = await this.importFile(name, text);
    this.emit('decksChanged');
    if (open) this.emit('openDeckRequested', id);
    return id;
  }

  pickFiles(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = accept;
      input.style.display = 'none';
      input.addEventListener('change', () => { resolve(Array.from(input.files || [])); input.remove(); });
      document.body.append(input);
      input.click();
    });
  }

  async saveFile(name, mime, text) {
    if (android() && android().saveFile) { android().saveFile(KEY, name, mime, text); return name; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return name;
  }

  // ================================================================ API (mirrors bridge.py slots)
  async getInitialState() {
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    let pending = [];
    if (this.pendingOpen) { pending = [this.pendingOpen]; this.pendingOpen = null; }
    return {
      settings: this.settingsData, defaults: DEFAULTS, systemScheme: dark ? 'dark' : 'light', version: APP_VERSION,
      dataDir: 'App storage (IndexedDB)', configDir: 'App storage', pendingOpen: pending, maximized: true,
      platform: android() ? 'android' : 'web',
    };
  }

  async updateSettings(patch) {
    patch = P(patch);
    this.settingsData = deepMerge(this.settingsData, patch);
    lsSet('fv.settings', this.settingsData);
    if (patch.network && android() && android().setNetworkMode) android().setNetworkMode(KEY, this.settingsData.network.mode);
    return this.settingsData;
  }

  async resetSettings(section) {
    if (section && DEFAULTS[section]) this.settingsData[section] = clone(DEFAULTS[section]);
    else this.settingsData = clone(DEFAULTS);
    this.settingsData.library.folders = ['In-app library'];
    this.settingsData.library.mainFolder = 'In-app library';
    lsSet('fv.settings', this.settingsData);
    return this.settingsData;
  }

  async systemFonts() { return { all: [], mono: [] }; }
  async listDecks() { return [...this.decks.values()].map((r) => this.deckDict(r)); }
  async rescan() { return this.listDecks(); }
  async getDeck(id) { const r = this.decks.get(id); return r ? this.deckDict(r) : null; }

  async search(query) {
    const terms = fold(query.trim()).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const out = [];
    for (const rec of this.decks.values()) {
      const name = fold((this.lib.renames[rec.id] || rec.title) + ' ' + rec.filename);
      const body = rec.plain || '';
      const inName = terms.every((t) => name.includes(t));
      const inBody = terms.every((t) => body.includes(t) || name.includes(t));
      if (!inName && !inBody) continue;
      let snippet = '';
      if (!inName) {
        const i = body.indexOf(terms[0]);
        if (i >= 0) { const s = Math.max(0, i - 40); snippet = (s ? '…' : '') + body.slice(s, i + 80).trim() + '…'; }
      }
      out.push({ id: rec.id, inName, snippet });
    }
    return out.sort((a, b) => Number(b.inName) - Number(a.inName));
  }

  async toggleFavourite(id) {
    const f = this.lib.favourites;
    const i = f.indexOf(id);
    if (i >= 0) f.splice(i, 1); else f.push(id);
    this.saveLib();
    return i < 0;
  }

  async renameDeck(id, name) {
    if (name.trim()) this.lib.renames[id] = name.trim(); else delete this.lib.renames[id];
    this.saveLib();
    return true;
  }

  async openDeck(id) {
    const rec = this.decks.get(id);
    if (!rec) return null;
    this.lib.recent = [id, ...this.lib.recent.filter((x) => x !== id)].slice(0, 20);
    this.saveLib();
    const name = this.lib.renames[id] || rec.title;
    this.stats.recordOpen(id, name, rec.filename);
    this.saveStats();
    this.settingsData.general.lastDeck = id;
    lsSet('fv.settings', this.settingsData);
    const html = renderDeck(await this.text(id), rec.kind, rec.filename, name);
    return { srcdoc: html, deck: this.deckDict(rec) };
  }

  async recordStudy(id, seconds) { this.stats.recordStudy(id, seconds); this.saveStats(); return true; }
  async revealDeck() { return false; }

  async deleteDeck(id) {
    this.decks.delete(id);
    this.texts.delete(id);
    await kv.del('deck:' + id);
    await this.saveIndex();
    this.emit('decksChanged');
    return true;
  }

  async openFilesDialog() {
    const files = await this.pickFiles('.html,.htm,.xhtml,.jsx,.tsx,text/html');
    const ids = [];
    for (const f of files) {
      const text = await f.text();
      if (!DECK_RX.test(f.name) && !/^\s*</.test(text) && !/export\s+default/.test(text)) continue;
      ids.push(await this.importFile(f.name, text));
    }
    return ids;
  }

  async importDropped(name, content) { return this.importFile(name, content); }
  async chooseFolder() { return null; }
  async openPath() { return false; }

  // -- decks made with the deck editor --
  async getCustomDeck(id) { return this.decks.has(id) ? parseDeckHtml(await this.text(id)) : null; }
  async createCustomDeck(name, html) {
    if (!parseDeckHtml(html)) throw new Error('not a deck made with the deck editor');
    return this.importFile(name, html);
  }
  async saveCustomDeck(id, html) {
    const rec = this.decks.get(id);
    if (!rec) throw new Error('deck not found');
    if (!parseDeckHtml(html)) throw new Error('not a deck made with the deck editor');
    if (!parseDeckHtml(await this.text(id))) throw new Error('only decks made with the deck editor can be edited');
    await kv.set('deck:' + id, html);
    this.texts.set(id, html);
    Object.assign(rec, { hash: contentHash(html), mtime: Date.now() / 1000 });
    try { localStorage.removeItem('fv.overrides.' + id); } catch (_) { /* */ }
    await this.reindex(id);
    return this.deckDict(rec);
  }

  async getCards(id) {
    const rec = this.decks.get(id);
    return { cards: this.cards(id), manual: !!lsGet('fv.overrides.' + id, null), methods: rec ? rec.methods : [] };
  }
  async saveCards(id, cards) {
    cards = P(cards);
    lsSet('fv.overrides.' + id, { cards: cards.map((c) => ({ front: String(c.front), back: String(c.back), hint: c.hint || '', explanation: c.explanation || '', choices: c.choices || [], category: c.category || '', source: 'manual' })) });
    return this.getCards(id);
  }
  async resetCards(id) { try { localStorage.removeItem('fv.overrides.' + id); } catch (_) { /* */ } return this.getCards(id); }

  async buildQuiz(id, opts = {}) {
    opts = P(opts) || {};
    const qs = this.settingsData.quiz;
    const cards = this.cards(id);
    const weak = qs.weakFirst || opts.onlyWeak ? this.stats.weakCards(id).map((w) => w.key) : [];
    const types = Object.entries(qs.types).filter(([, on]) => on).map(([t]) => t);
    const questions = buildQuiz(cards, { count: Number(opts.count ?? qs.questions), types, weakKeys: weak, onlyWeak: !!opts.onlyWeak, shuffle: qs.shuffle });
    return { questions, cardCount: cards.length };
  }
  async gradeAnswer(question, response) {
    question = P(question);
    response = typeof response === 'string' ? JSON.parse(response) : response;
    const qs = this.settingsData.quiz;
    return gradeResponse(question, response, Number(qs.threshold), !!qs.stripAccents);
  }
  async recordQuiz(id, results, seconds) { results = P(results); const a = this.stats.recordQuiz(id, results, seconds); this.saveStats(); return a; }

  async getOverview() {
    const ov = this.stats.overview();
    ov.activity = this.stats.activity();
    ov.history = this.stats.scoreHistory();
    return ov;
  }
  async getDeckStats(id) {
    const keys = this.cards(id).map((c) => c.key);
    return { summary: this.stats.deckSummary(id, keys), weak: this.stats.weakCards(id), history: this.stats.scoreHistory(id) };
  }
  async resetStats(id) { if (id) this.stats.resetDeck(id); else this.stats.resetAll(); this.saveStats(); return true; }

  async exportStats(fmt) {
    const stamp = new Date().toISOString().slice(0, 10);
    if (fmt === 'csv') {
      const titles = Object.fromEntries(this.stats.meta.map((m) => [m.deck_id, m.title]));
      return this.saveFile(`flashcard-stats-${stamp}.csv`, 'text/csv', this.stats.exportCsv(titles));
    }
    return this.saveFile(`flashcard-stats-${stamp}.json`, 'application/json', JSON.stringify({ version: 1, exported: Date.now() / 1000, ...this.stats.dump() }, null, 2));
  }

  async exportBackup() {
    const stamp = new Date().toISOString().slice(0, 10);
    const decks = [];
    for (const rec of this.decks.values()) decks.push({ filename: rec.filename, text: await this.text(rec.id), id: rec.id });
    const overrides = {};
    for (const rec of this.decks.values()) { const o = lsGet('fv.overrides.' + rec.id, null); if (o) overrides[rec.id] = o; }
    const data = { format: 'flashcard-viewer-backup', version: 1, settings: this.settingsData, library: this.lib, stats: this.stats.dump(), overrides, decks };
    return this.saveFile(`flashcard-viewer-backup-${stamp}.json`, 'application/json', JSON.stringify(data));
  }

  async importBackup() {
    const [file] = await this.pickFiles('.json,application/json');
    if (!file) return null;
    const data = JSON.parse(await file.text());
    if (data.format !== 'flashcard-viewer-backup') throw new Error('Not a Riffle backup file (.json from the mobile app)');
    const idMap = {};
    for (const d of data.decks || []) idMap[d.id] = await this.importFile(d.filename, d.text);
    const remap = (id) => idMap[id] || id;
    this.lib = deepMerge(DEFAULT_LIBRARY, data.library || {});
    this.lib.favourites = this.lib.favourites.map(remap);
    this.lib.recent = this.lib.recent.map(remap);
    this.lib.renames = Object.fromEntries(Object.entries(this.lib.renames).map(([k, v]) => [remap(k), v]));
    this.saveLib();
    const st = data.stats || {};
    for (const t of Object.values(st)) for (const row of t) if (row.deck_id) row.deck_id = remap(row.deck_id);
    this.stats.load(st);
    this.saveStats();
    for (const [id, o] of Object.entries(data.overrides || {})) lsSet('fv.overrides.' + remap(id), o);
    if (data.settings) await this.updateSettings(data.settings);
    this.emit('decksChanged');
    return { settings: this.settingsData };
  }

  async cacheInfo() {
    if (android() && android().cacheInfo) return JSON.parse(android().cacheInfo());
    return { files: 0, bytes: 0 };
  }
  async clearCache() {
    if (android() && android().clearCache) android().clearCache(KEY);
    return this.cacheInfo();
  }

  // -- window controls: not applicable on mobile/web --
  minimize() {}
  toggleMaximize() {}
  closeWindow() {}
  startMove() {}
  startResize() {}
  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); return false; }
      await document.documentElement.requestFullscreen();
      return true;
    } catch (_) { return !!document.fullscreenElement; }
  }
  openExternal(url) {
    if (!/^(https?:|mailto:)/.test(url)) return;
    if (android() && android().openExternal) android().openExternal(KEY, url);
    else window.open(url, '_blank', 'noopener');
  }
  // -- updates (same signal protocol as bridge.py) --
  checkForUpdate() {
    const send = (o) => this.emit('updateStatus', JSON.stringify(o));
    if (this.settingsData.network.mode === 'offline') {
      send({ state: 'error', message: 'Strictly offline mode is on (Settings → Offline & network).' });
      return { started: false };
    }
    const method = android() && android().installUpdate ? 'apk' : 'none';
    fetch(API_LATEST, { cache: 'no-store', headers: { Accept: 'application/vnd.github+json' } })
      .then((r) => { if (!r.ok) throw new Error(`GitHub answered ${r.status}`); return r.json(); })
      .then((rel) => { this.update = summarize(rel, APP_VERSION, method); send(this.update); })
      .catch((e) => send({ state: 'error', message: `Couldn't check for updates: ${e.message || e}` }));
    return { started: true };
  }
  installUpdate() {
    const u = this.update;
    if (!u || !u.newer || !u.canInstall) return { error: 'no installable update' };
    android().installUpdate(KEY, u.asset.url, u.asset.sha256 || '', u.asset.size || 0);
    return { started: true };
  }
  restartApp() { location.reload(); }
  setUiZoom(f) { document.documentElement.style.zoom = String(Math.max(0.5, Math.min(2.5, f))); }
}
