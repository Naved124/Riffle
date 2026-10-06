// Quiz page: deck picker, mixed-type questions with fuzzy grading, results.
import { call } from './api.js';
import { store, setSettings, emit } from './store.js';
import { $, h, icon, richText, pct, fmtDuration, snackbar, confirmDialog, playSound, deckAvatar } from './util.js';

let pickedDeck = null;
let onlyWeak = false;
let countChoice = null;
let q = null; // running quiz state

const TYPE_INFO = {
  typed: ['keyboard', 'Type the answer'],
  mc: ['format_list_bulleted', 'Multiple choice'],
  tf: ['rule', 'True or false'],
};
// Shown above the question when it is asked another way ("Vary how questions are asked").
const ASK_ICON = { reverse: 'swap_horiz', cloze: 'edit_note', explain: 'lightbulb' };
const root = () => $('#quiz-root');

// ------------------------------------------------------------------ picker
export function renderPicker() {
  q = null;
  const s = store.settings.quiz;
  if (countChoice == null) countChoice = s.questions;
  const decks = store.decks.slice().sort((a, b) => (a.recentIndex ?? 1e9) - (b.recentIndex ?? 1e9) || a.name.localeCompare(b.name));
  if (!pickedDeck || !decks.find((d) => d.id === pickedDeck)) {
    pickedDeck = (store.current && store.current.card_count && store.current.id) || (decks.find((d) => d.card_count) || {}).id || null;
  }
  const grid = h('div.quiz-decks', decks.map((d) => h('button.quiz-deck', {
    class: d.id === pickedDeck ? 'selected' : '', disabled: !d.card_count,
    title: d.card_count ? '' : 'No cards detected — open the deck and use “View / edit cards”',
    on: { click: () => { pickedDeck = d.id; renderPicker(); }, dblclick: () => { pickedDeck = d.id; startQuiz(d.id); } },
  },
  h('div.qd-head', deckAvatar(d), h('div.title-small.ellipsis', { style: { flex: 1 } }, d.name)),
  h('div.body-small.muted', `${d.card_count} cards · best ${pct(d.stats.bestScore)}${d.stats.weakCount ? ` · ${d.stats.weakCount} weak` : ''}`),
  )));
  const seg = h('div.seg', [5, 10, 20, 0].map((n) => h('button', {
    class: countChoice === n ? 'on' : '', on: { click: () => { countChoice = n; renderPicker(); } },
  }, n === 0 ? 'All' : String(n))));
  const typeChips = h('md-chip-set', Object.entries(TYPE_INFO).map(([t, [ic, label]]) => {
    const chip = h('md-filter-chip', { label, '.selected': !!s.types[t] });
    chip.append(h('md-icon', { slot: 'icon' }, ic));
    chip.addEventListener('click', () => {
      setTimeout(() => {
        const types = { ...store.settings.quiz.types, [t]: chip.selected };
        if (!Object.values(types).some(Boolean)) { chip.selected = true; snackbar('Keep at least one question type'); return; }
        setSettings({ quiz: { types } });
      });
    });
    return chip;
  }));
  const weakSwitch = h('md-switch', { '.selected': onlyWeak, on: { change: (e) => { onlyWeak = e.target.selected; } } });
  const deck = decks.find((d) => d.id === pickedDeck);
  root().replaceChildren(h('div.quiz-wrap',
    h('div.section-title', h('h1.headline-medium', { style: { flex: 1 } }, 'Quiz')),
    h('p.body-large.muted', { style: { margin: '-6px 0 22px' } },
      'Pick a deck. Questions mix typed answers (graded by similarity, not exact match), multiple choice and true/false — whichever suits each card.'),
    decks.length ? grid : h('div.card', h('p.body-medium', 'No decks in your library yet.')),
    h('div.card.quiz-setup',
      h('div.col.gap-s', h('span.label-large', 'Questions'), seg),
      h('div.col.gap-s', h('span.label-large', 'Question types'), typeChips),
      h('label.row.gap-s', { style: { cursor: 'pointer' } }, weakSwitch, h('span.body-medium', 'Only weak cards')),
      h('span.spacer'),
      h('md-filled-button', { disabled: !deck, on: { click: () => startQuiz(pickedDeck) } }, h('md-icon', { slot: 'icon' }, 'play_arrow'), 'Start quiz'),
    ),
  ));
}

// ------------------------------------------------------------------ running
export async function startQuiz(deckId, opts = {}) {
  const deck = store.decks.find((d) => d.id === deckId);
  if (!deck) return;
  emit({ type: 'goto', page: 'quiz', silent: true });
  const options = { count: opts.count ?? countChoice ?? store.settings.quiz.questions, onlyWeak: opts.onlyWeak ?? onlyWeak };
  let questions = opts.questions;
  if (!questions) {
    const res = await call('buildQuiz', deckId, JSON.stringify(options));
    questions = res.questions;
  }
  if (!questions.length) {
    root().replaceChildren(h('div.quiz-wrap', h('div.card', { style: { textAlign: 'center', padding: '40px' } },
      icon('help'), h('h2.headline-small', 'Nothing to quiz on'),
      h('p.body-medium.muted', `No question/answer pairs were found in “${deck.name}”. Open the deck and use “View / edit cards” to add them.`),
      h('div.row.gap', { style: { justifyContent: 'center', marginTop: '16px' } },
        h('md-outlined-button', { on: { click: renderPicker } }, 'Back'),
        h('md-filled-button', { on: { click: () => emit({ type: 'open-deck', deckId, editCards: true }) } }, 'Edit cards')))));
    return;
  }
  q = { deck, questions, idx: 0, results: [], started: Date.now(), answered: false, timer: null, timeLeft: 0, hint: false };
  renderQuestion();
}

function stopTimer() { if (q && q.timer) { clearInterval(q.timer); q.timer = null; } }

function renderQuestion() {
  stopTimer();
  const qq = q.questions[q.idx];
  q.answered = false;
  q.hint = false;
  const total = q.questions.length;
  const [ic, label] = TYPE_INFO[qq.type];
  const timerChip = h('div.timer-chip.hidden', icon('timer'), h('span', ''));
  const top = h('div.quiz-top',
    h('md-icon-button', { title: 'Quit quiz (Esc)', on: { click: quitQuiz } }, icon('close')),
    h('md-linear-progress', { '.value': q.idx / total }),
    h('span.label-large', `${q.idx + 1} / ${total}`), timerChip);
  const meta = h('div.q-meta', h('span.q-type', icon(ic), label),
    qq.category ? h('span.tag', qq.category) : null, h('span.spacer'),
    qq.hint ? h('md-text-button', { on: { click: showHint } }, h('md-icon', { slot: 'icon' }, 'lightbulb'), 'Hint') : null);
  const card = h('div.q-card', meta,
    qq.ask ? h('div.q-ask', icon(ASK_ICON[qq.style] || 'swap_horiz'), qq.ask) : null,
    qq.context ? h('div.q-context', qq.context) : null,
    h('div.q-prompt', { html: richText(qq.prompt) }));
  card.append(h('div#hint-slot'));
  if (qq.type === 'typed') {
    const field = h('md-outlined-text-field', { label: 'Your answer', autocomplete: 'off' });
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !q.answered) { e.preventDefault(); submit(field.value); } });
    card.append(h('div.typed-row', field, h('md-filled-button', { on: { click: () => submit(field.value) } }, 'Check')));
    setTimeout(() => field.focus(), 60);
  } else if (qq.type === 'mc') {
    card.append(h('div.choices', qq.choices.map((c, i) => h('button.choice', { on: { click: () => submit(i) } },
      h('span.letter', 'ABCD'[i]), h('span.ctext', { html: richText(c) })))));
  } else {
    if (qq.statement) {
      card.append(h('div.q-statement', h('span.label-medium', 'Proposed answer'), h('span', { html: richText(qq.statement) })));
    }
    card.append(h('div.tf-row.choices', qq.choices.map((c, i) => h('button.choice', { on: { click: () => submit(i === 0) } },
      icon(i === 0 ? 'check_circle' : 'cancel'), c))));
  }
  card.append(h('div#feedback-slot'));
  root().replaceChildren(h('div.quiz-wrap', top, card));

  const secs = store.settings.quiz.timer;
  if (secs > 0) {
    q.timeLeft = secs;
    timerChip.classList.remove('hidden');
    const draw = () => {
      timerChip.querySelector('span').textContent = `${q.timeLeft}s`;
      timerChip.classList.toggle('low', q.timeLeft <= 5);
    };
    draw();
    q.timer = setInterval(() => {
      q.timeLeft -= 1;
      draw();
      if (q.timeLeft <= 0) {
        stopTimer();
        if (!q.answered) {
          const f = $('md-outlined-text-field', root());
          submit(qq.type === 'typed' ? (f ? f.value : '') : null, true);
        }
      }
    }, 1000);
  }
}

function showHint() {
  const qq = q.questions[q.idx];
  if (!qq.hint || q.hint) return;
  q.hint = true;
  $('#hint-slot').replaceWith(h('div.hint-box', icon('lightbulb'), h('span', qq.hint)));
}

async function submit(response, timedOut = false) {
  if (!q || q.answered) return;
  q.answered = true;
  stopTimer();
  const qq = q.questions[q.idx];
  let grade;
  if (response === null || response === undefined) {
    grade = { verdict: 'wrong', score: 0, matched: qq.answer, note: timedOut ? "Time's up" : '' };
  } else {
    grade = await call('gradeAnswer', JSON.stringify(qq), JSON.stringify(response));
  }
  const result = { key: qq.key, front: qq.front || qq.prompt, type: qq.type, verdict: grade.verdict, score: grade.score, response, overridden: false };
  q.results[q.idx] = result;
  if (store.settings.quiz.sounds) playSound(grade.verdict);

  // Mark choices
  if (qq.type === 'mc') {
    root().querySelectorAll('.choice').forEach((b, i) => {
      b.disabled = true;
      if (i === qq.correctIndex) b.classList.add('correct');
      else if (i === response) b.classList.add('wrong');
      else b.classList.add('dim');
    });
  } else if (qq.type === 'tf') {
    root().querySelectorAll('.choice').forEach((b, i) => {
      b.disabled = true;
      const val = i === 0;
      if (val === qq.truth) b.classList.add('correct');
      else if (val === response) b.classList.add('wrong');
      else b.classList.add('dim');
    });
  } else {
    const f = $('md-outlined-text-field', root());
    if (f) f.disabled = true;
  }
  renderFeedback(qq, result, grade);
  if (store.settings.quiz.autoAdvance && grade.verdict === 'correct') setTimeout(() => { if (q && q.results[q.idx] === result) next(); }, 1200);
}

function renderFeedback(qq, result, grade) {
  const v = result.verdict;
  const title = { correct: 'Correct!', close: 'Almost', wrong: 'Not quite' }[v];
  const ic = { correct: 'check_circle', close: 'error', wrong: 'cancel' }[v];
  const showAnswer = qq.type === 'typed' || v !== 'correct' || qq.type === 'tf';
  let answerLine = null;
  if (showAnswer) {
    if (qq.type === 'tf' && qq.statement) {
      answerLine = h('div.q-answer', { html: `${qq.truth ? 'True' : 'False'} — the answer is <b>${richText(qq.answer)}</b>` });
    } else {
      answerLine = h('div.q-answer', { html: `${v === 'correct' && qq.type === 'typed' ? 'Expected' : 'Answer'}: <b>${richText(qq.answer)}</b>` });
    }
  }
  const scoreTxt = qq.type === 'typed' && result.response ? `${Math.round(grade.score * 100)}% match` : '';
  const fb = h('div.feedback', { class: v }, icon(ic),
    h('div.fb-title', title, scoreTxt ? h('span.fb-score', scoreTxt) : null, grade.note ? h('span.fb-score', '· ' + grade.note) : null),
    answerLine,
    qq.explanation && store.settings.quiz.showExplanations ? h('div.body-medium.muted', qq.explanation) : null);
  const actions = h('div.fb-actions');
  if (qq.type === 'typed' && v !== 'correct' && result.response) {
    actions.append(h('md-text-button', {
      on: {
        click: () => {
          result.verdict = 'correct'; result.score = 1; result.overridden = true;
          if (store.settings.quiz.sounds) playSound('correct');
          renderFeedback(qq, result, { ...grade, verdict: 'correct', note: 'Marked correct by you' });
        },
      },
    }, h('md-icon', { slot: 'icon' }, 'thumb_up'), 'I was right'));
  }
  const last = q.idx === q.questions.length - 1;
  const cont = h('md-filled-button', { on: { click: next } }, last ? 'See results' : 'Continue', h('md-icon', { slot: 'icon' }, last ? 'flag' : 'arrow_forward'));
  cont.setAttribute('trailing-icon', '');
  actions.append(cont);
  const slot = $('#feedback-slot');
  slot.replaceChildren(fb, actions);
  setTimeout(() => cont.focus(), 30);
}

function next() {
  if (!q) return;
  if (q.idx < q.questions.length - 1) {
    q.idx += 1;
    renderQuestion();
  } else {
    finish();
  }
}

async function quitQuiz() {
  if (!q) return renderPicker();
  const answered = q.results.filter(Boolean).length;
  if (answered && !(await confirmDialog('Quit quiz?', `You answered ${answered} of ${q.questions.length}. Answers so far will still be saved to your stats.`, 'Quit', 'logout'))) return;
  stopTimer();
  if (answered) await call('recordQuiz', q.deck.id, JSON.stringify(q.results.filter(Boolean)), (Date.now() - q.started) / 1000);
  emit('stats-changed');
  renderPicker();
}

async function finish() {
  stopTimer();
  const results = q.results.filter(Boolean);
  const secs = (Date.now() - q.started) / 1000;
  await call('recordQuiz', q.deck.id, JSON.stringify(results), secs);
  if (store.settings.quiz.sounds) playSound('done');
  emit('stats-changed');
  const n = results.length;
  const correct = results.filter((r) => r.verdict === 'correct').length;
  const close = results.filter((r) => r.verdict === 'close').length;
  const wrong = n - correct - close;
  const score = n ? (correct + 0.5 * close) / n : 0;
  const R = 64, C = 2 * Math.PI * R;
  const ring = h('div.ring', { html: `<svg width="148" height="148"><circle cx="74" cy="74" r="${R}" fill="none" stroke="var(--md-sys-color-surface-container-highest)" stroke-width="12"/>
    <circle cx="74" cy="74" r="${R}" fill="none" stroke="var(--md-sys-color-primary)" stroke-width="12" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C}" style="transition: stroke-dashoffset calc(1s * var(--motion)) var(--ease-emph)"/></svg>` },
  h('div.val', h('div', h('b', `${Math.round(score * 100)}%`), h('span.body-small.muted', 'score'))));
  requestAnimationFrame(() => requestAnimationFrame(() => { ring.querySelectorAll('circle')[1].style.strokeDashoffset = String(C * (1 - score)); }));
  const msg = score >= 0.9 ? 'Outstanding! 🎉' : score >= 0.7 ? 'Great work!' : score >= 0.5 ? 'Getting there' : 'Keep practising';
  const missed = q.questions.filter((_, i) => q.results[i] && q.results[i].verdict !== 'correct');
  const deck = q.deck;
  const review = h('div.review-list', q.questions.map((qq, i) => {
    const r = q.results[i];
    const vic = { correct: ['check_circle', 'var(--c-good)'], close: ['error', 'var(--c-warn)'], wrong: ['cancel', 'var(--c-bad)'] }[r ? r.verdict : 'wrong'];
    const resp = r && r.response != null && qq.type === 'typed' && r.response !== '' ? ` · you wrote “${r.response}”` : '';
    return h('div.review-item', h('md-icon', { style: { color: vic[1] } }, vic[0]),
      h('div', h('div.ri-q', { html: richText(qq.prompt) }), h('div.ri-a', { html: richText(qq.answer) + richText(resp) + (r && r.overridden ? ' · marked correct by you' : '') })));
  }));
  root().replaceChildren(h('div.quiz-wrap',
    h('div.card.results-hero', ring, h('div',
      h('h1.headline-medium', msg), h('p.body-medium.muted', { style: { margin: '6px 0 0' } }, `${deck.name} · ${fmtDuration(secs)}`),
      h('div.result-counts',
        h('span.count-pill.good', icon('check_circle'), `${correct} correct`),
        h('span.count-pill.warn', icon('error'), `${close} close`),
        h('span.count-pill.bad', icon('cancel'), `${wrong} wrong`)),
      h('div.row.gap.wrap',
        missed.length ? h('md-filled-button', { on: { click: () => startQuiz(deck.id, { questions: missed.map((x) => ({ ...x })) }) } }, h('md-icon', { slot: 'icon' }, 'replay'), `Retry ${missed.length} missed`) : null,
        h('md-filled-tonal-button', { on: { click: () => startQuiz(deck.id) } }, h('md-icon', { slot: 'icon' }, 'shuffle'), 'New quiz'),
        h('md-outlined-button', { on: { click: () => emit({ type: 'open-deck', deckId: deck.id }) } }, h('md-icon', { slot: 'icon' }, 'style'), 'Back to deck'),
      ))),
    h('div.section-title', h('h2.title-large', 'Review')), review));
  q = null;
}

// ------------------------------------------------------------------ keyboard
export function quizKey(e) {
  if (!q || store.page !== 'quiz') return false;
  const qq = q.questions[q.idx];
  const inField = e.composedPath().some((n) => n.tagName === 'MD-OUTLINED-TEXT-FIELD' || n.tagName === 'INPUT');
  if (e.key === 'Escape') { quitQuiz(); return true; }
  if (q.answered) {
    if (e.key === 'Enter' || (e.key === ' ' && !inField)) {
      e.preventDefault();
      // Enter on a focused button already clicks it.
      if (!e.composedPath().some((n) => n.tagName && n.tagName.startsWith('MD-') && n.tagName.endsWith('BUTTON'))) next();
      return true;
    }
    return false;
  }
  if (inField) return false;
  if (qq.type === 'mc' && /^[1-4a-d]$/i.test(e.key)) {
    const i = /\d/.test(e.key) ? +e.key - 1 : 'abcd'.indexOf(e.key.toLowerCase());
    if (i < qq.choices.length) { submit(i); return true; }
  }
  if (qq.type === 'tf') {
    const k = e.key.toLowerCase();
    if (['1', 't', 'y'].includes(k)) { submit(true); return true; }
    if (['2', 'f', 'n'].includes(k)) { submit(false); return true; }
  }
  if (e.key.toLowerCase() === 'h' && qq.hint) { showHint(); return true; }
  return false;
}

export function quizActive() { return !!q; }
export function initQuiz() { renderPicker(); }
