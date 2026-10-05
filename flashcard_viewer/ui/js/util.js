// DOM helpers, formatting, snackbars, tooltips, dialogs and sounds.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Tiny hyperscript: h('div.cls#id', {attrs, on: {click}}, ...children) */
export function h(spec, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    if (attrs != null) children.unshift(attrs);
    attrs = {};
  }
  const m = /^([\w-]+)?((?:[.#][\w-]+)*)$/.exec(spec) || [];
  const el = document.createElement(m[1] || 'div');
  (m[2] || '').replace(/([.#])([\w-]+)/g, (_, t, v) => {
    if (t === '.') el.classList.add(v); else el.id = v;
  });
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('.')) el[k.slice(1)] = v; // property
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const icon = (name, cls) => h('md-icon', cls ? { class: cls } : {}, name);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Render card text: escape, then turn `code` spans into <code>. */
export function richText(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');
}

export function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const hh = Math.floor(m / 60), mm = m % 60;
  return mm ? `${hh}h ${mm}m` : `${hh}h`;
}

export function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Date.now() / 1000 - ts;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: s > 86400 * 300 ? 'numeric' : undefined });
}

export const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
export const fmtBytes = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------------------------------------------------------- snackbar
export function snackbar(message, { action, onAction, timeout = 5000, closable = true } = {}) {
  const host = $('#snackbar-host');
  const bar = h('div.snackbar', { role: 'status' }, h('span.msg', message));
  const close = () => {
    if (!bar.isConnected) return;
    bar.classList.add('out');
    setTimeout(() => bar.remove(), 200);
  };
  if (action) {
    bar.append(h('md-text-button', { on: { click: () => { close(); onAction && onAction(); } } }, action));
  }
  if (closable) bar.append(h('md-icon-button', { on: { click: close } }, icon('close')));
  while (host.children.length > 2) host.firstChild.remove();
  host.append(bar);
  if (timeout) setTimeout(close, timeout);
  return close;
}

// ---------------------------------------------------------------- tooltip
const tip = () => $('#tooltip');
export function showTip(html, x, y) {
  const t = tip();
  t.innerHTML = html;
  t.classList.add('show');
  const r = t.getBoundingClientRect();
  let left = x + 14, top = y - r.height - 10;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top < 8) top = y + 16;
  t.style.left = left + 'px';
  t.style.top = top + 'px';
}
export function hideTip() { tip().classList.remove('show'); }

// ---------------------------------------------------------------- dialogs
/** Create an md-dialog, show it and resolve with the returnValue when closed. */
export function dialog({ headline, icon: ic, content, actions = [], wide = false, onOpen }) {
  return new Promise((resolve) => {
    const dlg = h('md-dialog', { class: wide ? 'wide' : '' });
    if (ic) dlg.append(h('md-icon', { slot: 'icon' }, ic));
    dlg.append(h('div', { slot: 'headline' }, headline));
    const form = h('form', { slot: 'content', method: 'dialog', id: 'dlg-form-' + Math.random().toString(36).slice(2) });
    form.append(content);
    dlg.append(form);
    const acts = h('div', { slot: 'actions' });
    for (const a of actions) {
      const tag = a.primary ? 'md-filled-button' : a.tonal ? 'md-filled-tonal-button' : 'md-text-button';
      const btn = h(tag, { form: form.id, value: a.value, type: a.submit === false ? 'button' : 'submit' }, a.label);
      if (a.onClick) btn.addEventListener('click', (e) => a.onClick(e, dlg));
      acts.append(btn);
    }
    dlg.append(acts);
    dlg.addEventListener('close', () => { resolve(dlg.returnValue); setTimeout(() => dlg.remove(), 300); });
    $('#dialogs').append(dlg);
    requestAnimationFrame(() => { dlg.show(); onOpen && onOpen(dlg); });
  });
}

export async function confirmDialog(headline, text, okLabel = 'OK', ic = 'help') {
  const v = await dialog({
    headline, icon: ic, content: h('p.body-medium', text),
    actions: [{ label: 'Cancel', value: 'cancel' }, { label: okLabel, value: 'ok', primary: true }],
  });
  return v === 'ok';
}

export async function promptDialog(headline, label, value = '', ic = 'edit') {
  const field = h('md-outlined-text-field', { label, value, style: { width: '100%' } });
  const v = await dialog({
    headline, icon: ic, content: field,
    actions: [{ label: 'Cancel', value: 'cancel' }, { label: 'Save', value: 'ok', primary: true }],
    onOpen: () => setTimeout(() => field.focus(), 150),
  });
  return v === 'ok' ? field.value : null;
}

// ---------------------------------------------------------------- sounds (synthesised, no files)
let audio = null;
export function playSound(kind) {
  try {
    audio = audio || new AudioContext();
    const now = audio.currentTime;
    const notes = { correct: [[660, 0], [880, 0.09]], close: [[520, 0], [560, 0.1]], wrong: [[220, 0], [180, 0.12]], done: [[523, 0], [659, 0.1], [784, 0.2], [1046, 0.3]] }[kind] || [];
    for (const [f, t] of notes) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = kind === 'wrong' ? 'triangle' : 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + t);
      g.gain.exponentialRampToValueAtTime(0.12, now + t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.22);
      o.connect(g).connect(audio.destination);
      o.start(now + t);
      o.stop(now + t + 0.25);
    }
  } catch (_) { /* audio unavailable */ }
}

// ---------------------------------------------------------------- keyboard combos
export function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  if (k === '+') k = '=';
  if (k.length === 1) k = k.toUpperCase();
  if (['Control', 'Shift', 'Alt', 'Meta', 'Dead', 'Unidentified'].includes(k)) return '';
  parts.push(k);
  return parts.join('+');
}

export function prettyCombo(c) {
  return (c || '').replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace('ArrowLeft', '←').replace('ArrowRight', '→').replace(/\+/g, ' + ');
}

export function deckAvatar(d, cls = '') {
  if (d.emoji) return h('div.deck-avatar.emoji', { class: cls }, d.emoji);
  const letter = (d.name || d.title || '?').replace(/^[^\p{L}\p{N}]+/u, '').charAt(0).toUpperCase() || '?';
  return h('div.deck-avatar', { class: (d.kind === 'react' ? 'react ' : '') + cls }, letter);
}
