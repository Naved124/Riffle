// Build the srcdoc HTML for a deck shown in a sandboxed iframe (port of flashcard_viewer/render.py).
// Helper and vendor scripts are referenced by absolute URL relative to the app's own location.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function uiBase() {
  return new URL('.', document.baseURI).href; // .../ui/
}

function injectHead(text, extra) {
  let m = /<head\b[^>]*>/i.exec(text);
  if (m) return text.slice(0, m.index + m[0].length) + extra + text.slice(m.index + m[0].length);
  m = /<html\b[^>]*>/i.exec(text);
  if (m) return text.slice(0, m.index + m[0].length) + '<head>' + extra + '</head>' + text.slice(m.index + m[0].length);
  m = /<!doctype[^>]*>/i.exec(text);
  if (m) return text.slice(0, m.index + m[0].length) + extra + text.slice(m.index + m[0].length);
  return extra + text;
}

const b64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export function renderDeck(text, kind, filename, title = '') {
  const base = uiBase();
  const helper = `<script src="${base}deck-runtime/deck-helper.js"></script>`;
  text = text.replace(/^﻿/, '');
  if (kind === 'react') {
    const v = `${base}vendor/react/`;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${helper}
<script src="${v}react.production.min.js"></script>
<script src="${v}react-dom.production.min.js"></script>
<script src="${v}lucide-react.min.js"></script>
<script src="${v}tailwind.js"></script>
<script src="${v}babel.min.js"></script>
<style>html,body{margin:0;min-height:100%}</style></head><body><div id="root"></div>
<script src="${base}deck-runtime/react-runner.js" data-b64="${b64(text)}" data-name="${esc(filename)}"></script>
</body></html>`;
  }
  if (kind === 'fragment') {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>${helper}</head><body>\n${text}\n</body></html>`;
  }
  let extra = helper;
  if (!/<meta[^>]+charset/i.test(text.slice(0, 3000))) extra = '<meta charset="utf-8">' + extra;
  if (!/<meta[^>]+viewport/i.test(text.slice(0, 5000))) extra += '<meta name="viewport" content="width=device-width, initial-scale=1">';
  return injectHead(text, extra);
}
