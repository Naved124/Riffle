// Shared application state + settings persistence.
import { call } from './api.js';
import { debounce } from './util.js';

const listeners = new Set();

export const store = {
  settings: null,
  defaults: null,
  systemScheme: 'light',
  decks: [],
  current: null,      // currently open deck object
  page: 'library',
  version: '',
  dataDir: '',
  configDir: '',
};

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function emit(what) { for (const fn of listeners) fn(what); }

let pending = {};
const flush = debounce(async () => {
  const patch = pending;
  pending = {};
  try { await call('updateSettings', JSON.stringify(patch)); } catch (e) { console.error(e); }
}, 300);

function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) merge(target[k], v);
    else target[k] = v;
  }
}

/** Update settings locally (immediately) and persist (debounced). */
export function setSettings(patch, { immediate = false } = {}) {
  merge(store.settings, patch);
  merge(pending, JSON.parse(JSON.stringify(patch)));
  emit('settings');
  if (immediate) {
    const p = pending; pending = {};
    return call('updateSettings', JSON.stringify(p));
  }
  flush();
  return Promise.resolve();
}

export const S = () => store.settings;
