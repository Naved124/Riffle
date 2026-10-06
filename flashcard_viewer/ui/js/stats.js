// Stats page: KPI tiles, activity heatmap, score-over-time chart, per-deck table, weak cards.
import { call } from './api.js';
import { store, emit } from './store.js';
import { $, h, icon, esc, fmtDuration, fmtAgo, pct, snackbar, dialog, confirmDialog, showTip, hideTip } from './util.js';

let chartDeck = '';
let data = null;
const root = () => $('#stats-root');

function tile(ic, num, label, hero) {
  return h('div.stat-tile', { class: hero ? 'hero' : '' }, icon(ic), h('div.num', num), h('div.lbl', label));
}

// ---------------------------------------------------------------- heatmap (sequential: one hue, light -> dark)
function heatmap(activity) {
  const cell = 13, gap = 3, step = cell + gap;
  const days = activity.map((a) => ({ ...a, d: new Date(a.date + 'T00:00:00') }));
  // Align first column to Monday.
  const first = days[0].d;
  const offset = (first.getDay() + 6) % 7;
  const weeks = Math.ceil((days.length + offset) / 7);
  const W = 30 + weeks * step, H = 20 + 7 * step;
  const level = (a) => {
    const m = a.seconds / 60 + a.quizzes * 3;
    return m <= 0 ? 0 : m < 10 ? 1 : m < 30 ? 2 : m < 60 ? 3 : 4;
  };
  const fills = ['var(--md-sys-color-surface-container-highest)',
    'color-mix(in srgb, var(--md-sys-color-primary) 30%, var(--md-sys-color-surface-container-highest))',
    'color-mix(in srgb, var(--md-sys-color-primary) 55%, var(--md-sys-color-surface-container-highest))',
    'color-mix(in srgb, var(--md-sys-color-primary) 78%, var(--md-sys-color-surface-container-highest))',
    'var(--md-sys-color-primary)'];
  let svg = `<svg class="heatmap chart" width="${W}" height="${H}" role="img" aria-label="Study activity over the last year">`;
  ['Mon', 'Wed', 'Fri'].forEach((t, i) => { svg += `<text x="0" y="${20 + (i * 2) * step + 10}">${t}</text>`; });
  let lastMonth = -1;
  days.forEach((a, i) => {
    const idx = i + offset;
    const col = Math.floor(idx / 7), row = idx % 7;
    const x = 30 + col * step, y = 20 + row * step;
    if (row === 0 || i === 0) {
      const m = a.d.getMonth();
      if (m !== lastMonth && a.d.getDate() <= 7) {
        svg += `<text x="${x}" y="11">${a.d.toLocaleString(undefined, { month: 'short' })}</text>`;
        lastMonth = m;
      }
    }
    svg += `<rect class="cell" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3" fill="${fills[level(a)]}" data-i="${i}"/>`;
  });
  svg += '</svg>';
  const wrap = h('div.heatmap-wrap', { html: svg });
  wrap.addEventListener('mousemove', (e) => {
    const r = e.target.closest('rect.cell');
    if (!r) { hideTip(); return; }
    const a = days[+r.dataset.i];
    const date = a.d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    showTip(`<b>${date}</b><br>${a.seconds ? fmtDuration(a.seconds) + ' studied' : 'No study time'}${a.quizzes ? `<br>${a.quizzes} quiz${a.quizzes > 1 ? 'zes' : ''} · ${a.cards} questions` : ''}`, e.clientX, e.clientY);
  });
  wrap.addEventListener('mouseleave', hideTip);
  const legend = h('div.heat-legend', 'Less', fills.map((f) => h('i', { style: { background: f } })), 'More');
  setTimeout(() => { wrap.scrollLeft = wrap.scrollWidth; });
  return h('div', wrap, legend);
}

// ---------------------------------------------------------------- score chart (single series line)
function scoreChart(history, width) {
  const pts = history.filter((x) => !chartDeck || x.deck_id === chartDeck);
  if (!pts.length) {
    return h('div.body-medium.muted', { style: { padding: '28px 4px' } }, 'No quizzes yet — finish one to see your scores over time.');
  }
  const W = Math.max(320, width), H = 220, L = 40, R = 16, T = 12, B = 28;
  const iw = W - L - R, ih = H - T - B;
  const x = (i) => L + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);
  const y = (v) => T + (1 - v) * ih;
  let svg = `<svg class="chart" width="${W}" height="${H}" role="img" aria-label="Quiz score over time">`;
  for (const g of [0, 0.25, 0.5, 0.75, 1]) {
    svg += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}"/><text x="${L - 8}" y="${y(g) + 4}" text-anchor="end">${g * 100}%</text>`;
  }
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
  svg += `<path class="area" d="${line} L${x(pts.length - 1)},${y(0)} L${x(0)},${y(0)} Z"/>`;
  svg += `<path class="series" d="${line}"/>`;
  const fmtD = (ts) => new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  svg += `<text x="${x(0)}" y="${H - 8}" text-anchor="${pts.length === 1 ? 'middle' : 'start'}">${fmtD(pts[0].finished_at)}</text>`;
  if (pts.length > 1) svg += `<text x="${x(pts.length - 1)}" y="${H - 8}" text-anchor="end">${fmtD(pts[pts.length - 1].finished_at)}</text>`;
  svg += `<line class="crosshair" id="xh" x1="0" x2="0" y1="${T}" y2="${T + ih}" style="display:none"/>`;
  pts.forEach((p, i) => { if (pts.length <= 60) svg += `<circle class="pt" cx="${x(i)}" cy="${y(p.score)}" r="4"/>`; });
  svg += `<circle class="pt" id="xh-dot" r="5" style="display:none"/></svg>`;
  const box = h('div', { html: svg, style: { position: 'relative' } });
  const titles = Object.fromEntries(store.decks.map((d) => [d.id, d.name]));
  box.addEventListener('mousemove', (e) => {
    const r = box.firstChild.getBoundingClientRect();
    const mx = e.clientX - r.left;
    let best = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = Math.abs(x(i) - mx); if (d < bd) { bd = d; best = i; } });
    const p = pts[best];
    const xh = box.querySelector('#xh'), dot = box.querySelector('#xh-dot');
    xh.style.display = dot.style.display = '';
    xh.setAttribute('x1', x(best)); xh.setAttribute('x2', x(best));
    dot.setAttribute('cx', x(best)); dot.setAttribute('cy', y(p.score));
    const when = new Date(p.finished_at * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    showTip(`<b>${pct(p.score)}</b> · ${p.correct}/${p.total} correct${p.close ? `, ${p.close} close` : ''}<br>${esc(titles[p.deck_id] || 'Deleted deck')}<br>${when}`, e.clientX, e.clientY);
  });
  box.addEventListener('mouseleave', () => {
    hideTip();
    const xh = box.querySelector('#xh'), dot = box.querySelector('#xh-dot');
    if (xh) xh.style.display = dot.style.display = 'none';
  });
  return box;
}

// ---------------------------------------------------------------- page
export async function renderStats() {
  data = await call('getOverview');
  const st = data.streak;
  const chartHost = h('div');
  const decksWithQuiz = data.decks.filter((d) => d.quizzes > 0);
  const select = h('md-outlined-select', { label: 'Deck', '.menuPositioning': 'popover', style: { minWidth: '240px' } },
    h('md-select-option', { value: '', '.selected': !chartDeck }, h('div', { slot: 'headline' }, 'All decks')),
    decksWithQuiz.map((d) => h('md-select-option', { value: d.deck_id, '.selected': chartDeck === d.deck_id }, h('div', { slot: 'headline' }, d.title))));
  select.addEventListener('change', () => { chartDeck = select.value; drawChart(); });
  const drawChart = () => {
    const w = chartHost.getBoundingClientRect().width || 800;
    chartHost.replaceChildren(scoreChart(data.history, w));
  };
  const rows = data.decks.map((d) => {
    const live = store.decks.find((x) => x.id === d.deck_id);
    return h('tr.click', { on: { click: () => deckStatsDialog(d.deck_id) } },
      h('td', live ? live.name : h('span.muted', d.title + ' (removed)')),
      h('td.num', fmtDuration(d.seconds)), h('td.num', String(d.quizzes)), h('td.num', pct(d.best)),
      h('td', h('span.bar-mini', h('i', { style: { width: pct(d.avg || 0) } })), ' ', h('span.body-small.muted', pct(d.avg))),
      h('td.num', fmtAgo(d.last_opened)));
  });
  root().replaceChildren(h('div.page-inner',
    h('div.section-title', h('h1.headline-medium', { style: { flex: 1 } }, 'Your progress'),
      h('md-outlined-button', { on: { click: () => exportStats('csv') } }, h('md-icon', { slot: 'icon' }, 'table_view'), 'Export CSV'),
      h('md-outlined-button', { on: { click: () => exportStats('json') } }, h('md-icon', { slot: 'icon' }, 'data_object'), 'Export JSON')),
    h('div.stat-tiles',
      tile('local_fire_department', `${st.current} day${st.current === 1 ? '' : 's'}`, st.studiedToday ? 'Current streak · studied today ✓' : 'Current streak', true),
      tile('emoji_events', `${st.longest} day${st.longest === 1 ? '' : 's'}`, 'Longest streak'),
      tile('schedule', fmtDuration(data.totalSeconds), 'Total study time'),
      tile('quiz', String(data.quizzes), `Quizzes · ${data.questionsAnswered} questions`),
      tile('target', pct(data.quizzes ? data.avgScore : null), 'Average score')),
    h('div.section-title', h('h2.title-large', 'Activity'), h('span.body-small.muted', `${st.totalDays} active day${st.totalDays === 1 ? '' : 's'}`)),
    h('div.card', heatmap(data.activity)),
    h('div.section-title', h('h2.title-large', { style: { flex: 1 } }, 'Quiz scores over time'), select),
    h('div.card', chartHost),
    h('div.section-title', h('h2.title-large', 'Decks')),
    data.decks.length
      ? h('div.card', { style: { padding: '8px 8px' } }, h('table.table',
        h('thead', h('tr', h('th', 'Deck'), h('th.num', 'Study time'), h('th.num', 'Quizzes'), h('th.num', 'Best'), h('th', 'Average'), h('th.num', 'Last opened'))),
        h('tbody', rows)))
      : h('div.card.body-medium.muted', 'Open a deck to start tracking.'),
  ));
  requestAnimationFrame(drawChart);
  window.removeEventListener('resize', onResize);
  window.addEventListener('resize', onResize);
  function onResize() { if (store.page === 'stats') drawChart(); }
}

async function exportStats(fmt) {
  const where = await call('exportStats', fmt);
  if (where) snackbar(`Exported to ${where}`);
}

export async function deckStatsDialog(deckId) {
  const ds = await call('getDeckStats', deckId);
  const deck = store.decks.find((d) => d.id === deckId);
  const s = ds.summary;
  const weak = ds.weak.length
    ? h('div', ds.weak.slice(0, 30).map((w) => h('div.weak-row',
      h('span.bar-mini', { title: `weakness ${pct(w.weakness)}` }, h('i', { style: { width: pct(w.weakness), background: 'var(--c-bad)' } })),
      h('div.wf.body-medium', w.front), h('span.body-small.muted', `${w.attempts} tries`))))
    : h('p.body-medium.muted', 'No weak cards — nice!');
  const v = await dialog({
    headline: deck ? deck.name : 'Deck statistics', icon: 'insights',
    content: h('div',
      h('div.stat-tiles', { style: { marginBottom: '16px' } },
        tile('schedule', fmtDuration(s.seconds), 'Study time'), tile('quiz', String(s.quizzes), 'Quizzes'),
        tile('emoji_events', pct(s.bestScore), 'Best score'), tile('verified', `${s.mastered}`, 'Cards mastered')),
      h('h3.title-medium', 'Weak cards'), weak),
    actions: [
      { label: 'Reset stats', value: 'reset' },
      ...(ds.weak.length && deck ? [{ label: 'Quiz weak cards', value: 'quiz', tonal: true }] : []),
      { label: 'Close', value: 'close', primary: true },
    ],
  });
  if (v === 'quiz') emit({ type: 'start-quiz', deckId, onlyWeak: true });
  if (v === 'reset' && await confirmDialog('Reset deck statistics?', 'Study time, quiz history and weak-card tracking for this deck will be deleted.', 'Reset', 'restart_alt')) {
    await call('resetStats', deckId);
    snackbar('Deck statistics reset');
    emit('stats-changed');
  }
}

export async function updateStreakBadge() {
  try {
    const ov = await call('getOverview');
    const b = $('#rail-streak');
    b.querySelector('span').textContent = String(ov.streak.current);
    b.classList.toggle('cold', !ov.streak.studiedToday);
    b.title = `${ov.streak.current}-day streak${ov.streak.studiedToday ? '' : ' — study today to keep it going'}`;
  } catch (_) { /* ignore */ }
}
