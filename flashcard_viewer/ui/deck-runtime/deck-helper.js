/* Injected into every deck page (served at /__fv/deck-helper.js).
 * Talks to the app shell (the parent frame) with postMessage:
 *   deck -> app: ready, progress {current,total}, finished, shortcut {combo}, dragenter, interaction
 *   app -> deck: config {font, mono, theme, zoom, shortcuts, appMode}
 */
(function () {
  if (window.__fvHelper || window.parent === window) return;
  window.__fvHelper = true;

  const send = (type, data) => {
    try { window.parent.postMessage(Object.assign({ fv: type }, data || {}), '*'); } catch (_) { /* ignore */ }
  };

  let config = { font: '', mono: '', theme: 'off', zoom: 1, shortcuts: [], appMode: 'light' };

  // ---- keyboard shortcuts: forward app combos, leave the rest to the deck ----
  const comboOf = (e) => {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let k = e.key;
    if (k === ' ') k = 'Space';
    if (k.length === 1) k = k.toUpperCase();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return '';
    parts.push(k);
    return parts.join('+');
  };
  window.addEventListener('keydown', (e) => {
    const combo = comboOf(e);
    if (combo && (config.shortcuts || []).includes(combo)) {
      e.preventDefault();
      e.stopPropagation();
      send('shortcut', { combo });
    }
  }, true);

  // ---- drag & drop: let the shell show its drop overlay ----
  window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) send('dragenter');
  }, true);

  // ---- activity ping (for study-time tracking) ----
  let lastPing = 0;
  const ping = () => {
    const now = Date.now();
    if (now - lastPing > 5000) { lastPing = now; send('interaction'); }
  };
  ['pointerdown', 'keydown', 'wheel'].forEach((ev) => window.addEventListener(ev, ping, { passive: true, capture: true }));

  // ---- progress detection: look for "3 / 12", "Card 3 of 12", "Question 3/12" ----
  const RX = /(?:^|\b)(?:card|question|q|item|word|#)?\s*(\d{1,4})\s*(?:\/|of|out of|von|de|sur)\s*(\d{1,4})(?:\b|$)/i;
  let last = '';
  let finishedSent = false;
  const scan = () => {
    if (!document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const found = [];
    let n;
    let budget = 4000;
    while ((n = walker.nextNode()) && budget-- > 0) {
      const p = n.parentElement;
      if (!p || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(p.tagName)) continue;
      const text = (p.textContent || '').trim();
      if (text.length > 40 || text.length < 3) continue;
      const m = RX.exec(text);
      if (!m) continue;
      const cur = +m[1], total = +m[2];
      if (cur < 1 || total < 2 || cur > total || total > 2000) continue;
      const r = p.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      found.push({ cur, total });
    }
    if (!found.length) return;
    const { cur, total } = found[0];
    const key = cur + '/' + total;
    if (key === last) return;
    last = key;
    send('progress', { current: cur, total });
    if (cur === total && !finishedSent) { finishedSent = true; send('finished'); }
    if (cur < total - 1) finishedSent = false;
  };
  let t = null;
  const schedule = () => { clearTimeout(t); t = setTimeout(scan, 250); };

  // ---- styling overrides ----
  const STYLE_ID = '__fv-style';
  const parseRGB = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (!m) return null;
    const p = m[1].split(',').map(parseFloat);
    if (p.length > 3 && p[3] === 0) return null;
    return p;
  };
  const deckIsDark = () => {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const rgb = parseRGB(getComputedStyle(el).backgroundColor);
      if (rgb) return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.45;
      const img = getComputedStyle(el).backgroundImage;
      if (img && img !== 'none') {
        const c = parseRGB((img.match(/rgba?\([^)]+\)/) || [])[0]);
        if (c) return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 < 0.45;
      }
    }
    // Tailwind/React decks often colour a full-screen wrapper instead of <body>.
    const first = document.body && document.body.firstElementChild;
    const inner = first && (first.id === 'root' ? first.firstElementChild : first);
    if (inner) {
      const cs = getComputedStyle(inner);
      const rgb = parseRGB(cs.backgroundColor) || parseRGB((cs.backgroundImage.match(/rgba?\([^)]+\)/) || [])[0]);
      if (rgb) return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.45;
    }
    return false;
  };
  const applyConfig = () => {
    let el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    let css = '';
    if (config.font) {
      if (!document.getElementById('__fv-fonts')) {
        const link = document.createElement('link');
        link.id = '__fv-fonts'; link.rel = 'stylesheet'; link.href = '/__fv/vendor/fonts.css';
        (document.head || document.documentElement).appendChild(link);
      }
      css += `body, body :not(code):not(pre):not(kbd):not(samp):not(.katex):not(.katex *):not([class*="icon"]):not([class*="material"]):not(svg):not(svg *) { font-family: "${config.font}", system-ui, sans-serif !important; }\n`;
      if (config.mono) css += `code, pre, kbd, samp, .font-mono { font-family: "${config.mono}", ui-monospace, monospace !important; }\n`;
    }
    let invert = config.theme === 'invert';
    if (config.theme === 'auto') invert = deckIsDark() !== (config.appMode === 'dark');
    if (invert) {
      css += `html { filter: invert(0.9) hue-rotate(180deg) !important; background: #fff; }\n` +
        `img, video, picture, canvas, iframe, [style*="background-image"] { filter: invert(1) hue-rotate(180deg) !important; }\n`;
    }
    el.textContent = css;
    document.documentElement.style.zoom = config.zoom && config.zoom !== 1 ? String(config.zoom) : '';
  };

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || e.source !== window.parent) return;
    if (d.fv === 'config') {
      config = Object.assign(config, d.config || {});
      applyConfig();
      // React/Tailwind decks paint late; re-evaluate auto theming once things settle.
      if (config.theme === 'auto') { setTimeout(applyConfig, 600); setTimeout(applyConfig, 1800); }
    }
  });

  const start = () => {
    new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, characterData: true });
    schedule();
    send('ready', { title: document.title });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
  window.addEventListener('load', () => { schedule(); send('loaded'); });
  window.addEventListener('error', (e) => send('error', { message: String(e.message || e) }));
})();
