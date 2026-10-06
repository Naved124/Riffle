// CSV / TSV import for the deck editor. Handles quoted fields, comma / semicolon / tab separators,
// Anki text exports ("#separator:tab" header lines, HTML in fields) and Quizlet exports (term<TAB>definition).

/** Split CSV text into rows of fields (RFC 4180 quoting). */
export function parseCsv(text, delimiter) {
  text = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  // Anki: leading "#separator:tab", "#html:true", "#columns:..." lines.
  let directives = {};
  while (lines.length && /^#[\w ]+:/.test(lines[0])) {
    const [k, ...v] = lines.shift().slice(1).split(':');
    directives[k.trim().toLowerCase()] = v.join(':').trim();
  }
  text = lines.join('\n');
  const named = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ' }[(directives.separator || '').toLowerCase()];
  const delim = delimiter || named || detectDelimiter(text);
  const rows = [];
  let row = [], field = '', quoted = false, i = 0, startOfField = true;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && startOfField) { quoted = true; startOfField = false; i++; continue; }
    if (ch === delim) { row.push(field); field = ''; startOfField = true; i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; startOfField = true; i++; continue; }
    field += ch; startOfField = false; i++;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return { rows: rows.filter((r) => r.some((f) => f.trim())), delimiter: delim, columns: directives.columns };
}

function detectDelimiter(text) {
  const sample = text.split('\n').filter((l) => l.trim()).slice(0, 20);
  let best = ',', bestScore = -1;
  for (const d of ['\t', ',', ';', '|']) {
    const counts = sample.map((l) => countOutsideQuotes(l, d));
    const rowsWith = counts.filter((c) => c > 0).length;
    if (!rowsWith) continue;
    const same = counts.filter((c) => c === counts[0]).length;
    const score = rowsWith * 2 + same + (d === '\t' ? 1 : 0);
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

function countOutsideQuotes(line, d) {
  let n = 0, q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === d && !q) n++;
  }
  return n;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Anki fields may hold HTML: keep line breaks and bold/italic/code, drop the rest. */
function fromHtml(s) {
  if (!/<[a-z!/][^>]*>|&[#\w]+;/i.test(s)) return s;
  return s
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li)>/gi, '\n')
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**').replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\n{3,}/g, '\n\n').trim();
}

const COLS = {
  front: /^(front|question|q|term|prompt|word|concept|clue|side ?1|text)$/,
  back: /^(back|answer|a|definition|def|meaning|translation|side ?2|solution)$/,
  hint: /^(hint|clue hint)$/,
  explanation: /^(explanation|note|notes|extra|rationale|why)$/,
  category: /^(category|topic|tag|tags|section|deck|group)$/,
  correct: /^(correct|correct ?answer|correct ?option|correct ?index|answer ?key|key|right)$/,
  type: /^(type|kind)$/,
};
const OPTION_COL = /^(option|choice|opt|answer ?option|distractor)[ _-]?([a-h]|[1-8])?$|^[a-h]$/;

/** Map header names to fields; null when the first row doesn't look like a header. */
function headerMap(row) {
  const map = { options: [] };
  let hits = 0;
  row.forEach((raw, i) => {
    const h = raw.trim().toLowerCase().replace(/[^\w ]+/g, '').trim();
    if (!h) return;
    // "a".."h" are option columns only when there is no separate answer column called "a".
    for (const [field, rx] of Object.entries(COLS)) {
      if (rx.test(h) && map[field] == null && !(field === 'back' && h === 'a' && row.some((x) => /^b$/i.test(x.trim())))) { map[field] = i; hits++; return; }
    }
    if (OPTION_COL.test(h)) { map.options.push(i); hits++; }
  });
  return hits && map.front != null ? map : null;
}

/** Turn CSV text into editor cards. Returns {cards, skipped, header}. */
export function cardsFromCsv(text) {
  const { rows } = parseCsv(text);
  if (!rows.length) return { cards: [], skipped: 0, header: false };
  let map = headerMap(rows[0]);
  const header = !!map;
  const body = header ? rows.slice(1) : rows;
  if (!map) {
    // No header: front, back, then hint / explanation if present.
    map = { front: 0, back: 1, hint: 2, explanation: 3, options: [] };
  }
  const get = (r, i) => (i == null || i >= r.length ? '' : fromHtml(r[i]).trim());
  const cards = [];
  let skipped = 0;
  for (const r of body) {
    const front = get(r, map.front);
    const base = { front, hint: get(r, map.hint), explanation: get(r, map.explanation), category: get(r, map.category) };
    const options = map.options.map((i) => get(r, i)).filter(Boolean);
    const type = get(r, map.type).toLowerCase();
    if (options.length >= 2 && !/^(basic|flip|card)$/.test(type)) {
      const key = get(r, map.correct) || get(r, map.back);
      let correct = options.findIndex((o) => o.toLowerCase() === key.toLowerCase());
      if (correct < 0 && /^[a-h]$/i.test(key)) correct = key.toLowerCase().charCodeAt(0) - 97;
      if (correct < 0 && /^\d+$/.test(key)) correct = +key - 1;
      if (!front || correct < 0 || correct >= options.length) { skipped++; continue; }
      cards.push({ type: 'mcq', ...base, back: '', choices: options, correct });
      continue;
    }
    const back = get(r, map.back);
    if (!front || !back) { skipped++; continue; }
    cards.push({ type: 'basic', ...base, back });
  }
  return { cards, skipped, header };
}

const SEPARATORS = ['\t', ' — ', ' – ', ' - ', ' = ', ' :: ', ': ', ' : '];

/** Pasted text: "Q: … / A: …" pairs, "term - definition" lines (also —, –, =, ::, :), or CSV / TSV. */
export function cardsFromText(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { cards: [], skipped: 0, header: false };
  // Q: / A: blocks (answers may run over several lines).
  if (lines.some((l) => /^(q|question)\s*[:.)]/i.test(l)) && lines.some((l) => /^(a|answer)\s*[:.)]/i.test(l))) {
    const cards = [];
    let skipped = 0, cur = null, side = null;
    const push = () => { if (cur) { if (cur.front && cur.back) cards.push({ type: 'basic', ...cur }); else skipped++; } };
    for (const l of lines) {
      let m;
      if ((m = /^(?:q|question)\s*[:.)]\s*(.*)$/i.exec(l))) { push(); cur = { front: m[1], back: '', hint: '', explanation: '', category: '' }; side = 'front'; }
      else if (cur && (m = /^(?:a|answer)\s*[:.)]\s*(.*)$/i.exec(l))) { cur.back = m[1]; side = 'back'; }
      else if (cur && side) cur[side] += (cur[side] ? '\n' : '') + l;
    }
    push();
    return { cards, skipped, header: false };
  }
  if (!lines.some((l) => l.includes('\t'))) {
    for (const sep of SEPARATORS.slice(1)) {
      const hits = lines.filter((l) => l.indexOf(sep) > 0);
      if (hits.length < Math.max(1, lines.length * 0.6)) continue;
      const cards = [];
      for (const l of hits) {
        const i = l.indexOf(sep);
        const front = l.slice(0, i).trim(), back = l.slice(i + sep.length).trim();
        if (front && back) cards.push({ type: 'basic', front, back, hint: '', explanation: '', category: '' });
      }
      return { cards, skipped: lines.length - cards.length, header: false };
    }
  }
  return cardsFromCsv(text);
}
