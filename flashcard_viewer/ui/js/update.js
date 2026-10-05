// "Update available" flow, shared by all platforms. The backend (bridge.py on the desktop,
// core/backend.js on Android) does the network work and reports through the updateStatus signal.
import { call, fire, on } from './api.js';
import { store, setSettings } from './store.js';
import { h, snackbar, dialog } from './util.js';

const AUTO_INTERVAL = 6 * 3600 * 1000;
let lastInfo = null;
let waiters = [];
let progressDlg = null;
const listeners = new Set();

export const updateInfo = () => lastInfo;
export function onUpdateInfo(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Release notes are Markdown; show them as short plain text. */
function plainNotes(md) {
  return String(md || '')
    .split('<!-- install -->')[0] // the release body's install instructions don't belong in the prompt
    .replace(/\r/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 700);
}

function handle(raw) {
  let m;
  try { m = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return; }
  if (!m || !m.state) return;
  switch (m.state) {
    case 'checked':
    case 'error': {
      if (m.state === 'checked') { lastInfo = m; for (const fn of listeners) fn(m); }
      const w = waiters; waiters = [];
      w.forEach((fn) => fn(m));
      if (m.state === 'error' && progressDlg) { closeProgress(); snackbar(m.message, { timeout: 8000 }); }
      break;
    }
    case 'progress': showProgress(m.progress); break;
    case 'installing': showProgress(1, 'Installing… the app will close and reopen by itself.'); break;
    case 'permission': showProgress(-1, 'Allow “Install unknown apps” for Flashcard Viewer, then come back.'); break;
    case 'confirm': closeProgress(); break;
    case 'restart':
      closeProgress();
      if (lastInfo) { lastInfo.installed = true; for (const fn of listeners) fn(lastInfo); }
      askRestart(m.version);
      break;
    default: break;
  }
}

function showProgress(fraction, text) {
  if (!progressDlg) {
    const bar = h('md-linear-progress', { style: { width: '100%' } });
    const label = h('p.body-medium', 'Downloading update…');
    progressDlg = { bar, label, closed: false };
    dialog({
      headline: 'Updating Flashcard Viewer', icon: 'system_update',
      content: h('div.col.gap', label, bar),
      actions: [{ label: 'Hide', value: 'hide' }],
      onOpen: (dlg) => { progressDlg.dlg = dlg; },
    }).then(() => { if (progressDlg) progressDlg.closed = true; });
  }
  if (progressDlg.closed) return;
  const { bar, label } = progressDlg;
  if (fraction < 0) bar.indeterminate = true;
  else { bar.indeterminate = false; bar.value = fraction; }
  if (text) label.textContent = text;
  else if (fraction >= 0) label.textContent = `Downloading update… ${Math.round(fraction * 100)}%`;
  else label.textContent = store.platform === 'desktop' ? 'Installing the new version…' : 'Working…';
}

function closeProgress() {
  if (progressDlg && progressDlg.dlg && !progressDlg.closed) progressDlg.dlg.close();
  progressDlg = null;
}

async function askRestart(version) {
  const v = await dialog({
    headline: 'Update installed', icon: 'restart_alt',
    content: h('p.body-medium', `Flashcard Viewer ${version || ''} is installed. Restart to start using it.`),
    actions: [{ label: 'Later', value: 'later' }, { label: 'Restart now', value: 'restart', primary: true }],
  });
  if (v === 'restart') fire('restartApp');
}

/** Ask the backend for the latest release; resolves with the 'checked' or 'error' message. */
export function checkForUpdates() {
  return new Promise((resolve) => {
    waiters.push(resolve);
    call('checkForUpdate').catch((e) => handle({ state: 'error', message: e.message }));
  }).then((m) => {
    if (m.state === 'checked') setSettings({ general: { lastUpdateCheck: Date.now() } });
    return m;
  });
}

export async function installUpdate(info = lastInfo) {
  if (!info) return;
  if (!info.canInstall) { fire('openExternal', info.page); return; }
  showProgress(store.platform === 'desktop' && info.method === 'pip' ? -1 : 0);
  try {
    const r = await call('installUpdate');
    if (r && r.error) throw new Error(r.error);
  } catch (e) {
    closeProgress();
    snackbar(`Update failed: ${e.message}`, { timeout: 8000 });
  }
}

export async function promptUpdate(info) {
  const notes = plainNotes(info.notes);
  const how = info.canInstall
    ? (store.platform === 'android' ? 'The update downloads in the app; Android then asks you to confirm the install.'
      : info.method === 'installer' ? 'The app downloads the installer, closes, updates itself and reopens.'
        : 'The app installs the update and then asks to restart.')
    : 'Open the release page to download it.';
  const v = await dialog({
    headline: `Update available: ${info.latest}`, icon: 'system_update',
    content: h('div.col.gap',
      h('p.body-medium', `You have version ${info.current}. ${how}`),
      notes ? h('div.update-notes.body-small', notes) : null),
    actions: [
      { label: 'Skip this version', value: 'skip' },
      { label: 'Later', value: 'later' },
      { label: info.canInstall ? 'Update now' : 'Open release page', value: 'update', primary: true },
    ],
  });
  if (v === 'skip') setSettings({ general: { skippedVersion: info.latest } });
  else if (v === 'update') installUpdate(info);
}

/** Startup check: at most every few hours, quietly, and never for a skipped version. */
export function initUpdates() {
  on('updateStatus', handle);
  const g = store.settings.general;
  if (store.platform === 'web' || !g.checkUpdates || store.settings.network.mode === 'offline') return;
  if (Date.now() - (g.lastUpdateCheck || 0) < AUTO_INTERVAL) return;
  setTimeout(async () => {
    const m = await checkForUpdates();
    if (m.state === 'checked' && m.newer && m.latest !== store.settings.general.skippedVersion) promptUpdate(m);
  }, 4000);
}
