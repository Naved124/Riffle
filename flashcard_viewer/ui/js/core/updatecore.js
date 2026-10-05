// Release checks for the Android app and browsers (port of flashcard_viewer/updater.py).
export const REPO = 'Naved124/flashcard-viewer';
export const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
export const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

/** 'v1.2.10' -> [1, 2, 10]. Unknown parts count as 0, so garbage never looks newer. */
export function parseVersion(v) {
  const nums = String(v || '').split('-')[0].split('+')[0].match(/\d+/g) || [];
  const out = nums.slice(0, 4).map(Number);
  return out.length ? out : [0];
}

export function isNewer(latest, current) {
  const a = parseVersion(latest), b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

export function pickApk(release) {
  for (const a of release.assets || []) {
    const name = a.name || '', url = a.browser_download_url || '';
    if (/^FlashcardViewer-[\w.-]+\.apk$/.test(name) && url.startsWith(DOWNLOAD_PREFIX)) {
      const digest = a.digest || '';
      return { name, url, size: Number(a.size) || 0, sha256: digest.startsWith('sha256:') ? digest.slice(7) : '' };
    }
  }
  return null;
}

/** method: 'apk' (Android app that can install updates) or 'none' (browser). */
export function summarize(release, current, method) {
  const tag = release.tag_name || '';
  const latest = tag.replace(/^[vV]/, '');
  const asset = method === 'apk' ? pickApk(release) : null;
  return {
    state: 'checked', current, latest, tag,
    newer: !!latest && isNewer(latest, current),
    notes: String(release.body || '').slice(0, 4000),
    page: release.html_url || `https://github.com/${REPO}/releases/latest`,
    asset, method, canInstall: method === 'apk' && !!asset,
  };
}
