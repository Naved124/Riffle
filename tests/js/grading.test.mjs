import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { grade, answerVariants } from '../../flashcard_viewer/ui/js/core/similarity.js';
import { buildQuiz, gradeResponse, answerKind } from '../../flashcard_viewer/ui/js/core/quizcore.js';
import { extractCards } from '../../flashcard_viewer/ui/js/core/extract.js';

// Mirrors tests/test_similarity.py so both platforms grade identically.
const CORRECT = [
  ['The mitochondria', 'mitochondria'], ['The mitochondria', 'mitocondria'], ['Amazon S3', 's3'], ['SIGTERM (15)', 'sigterm'],
  ['SIGTERM (15)', '15'], ['ls -la', 'ls -al'], ['127.0.0.1 / localhost', 'localhost'],
  ['Translates domain names into IP addresses', 'it translates domain names to ip addresses'], ['False', 'no'],
  ['No — osmosis is passive transport.', 'no'], ['Niccolò Machiavelli', 'niccolo machiavelli'], ['$\\cos x$', 'cos x'],
  ['Chloroplast', 'chloroplasts'], ['1', 'one'], ['grep -r "TODO" .', 'grep -r TODO .'],
];
const NOT_CORRECT = [
  ['22', '23'], ['1989', '1988'], ['the dog', 'the cat'], ['ls -la', 'ls'], ['Elizabeth I', 'Elizabeth II'], ['Is safe', 'is not safe'],
  ['-p', '-v'], ['CMD', 'RUN'], ['Stateful', 'stateless'], ['False', 'true'], ['The mitochondria', ''],
];
for (const [e, g] of CORRECT) test(`correct: ${e} <- ${g}`, () => assert.equal(grade(e, g).verdict, 'correct'));
for (const [e, g] of NOT_CORRECT) test(`not correct: ${e} <- ${g}`, () => assert.notEqual(grade(e, g).verdict, 'correct'));

test('threshold and close band', () => {
  assert.notEqual(grade('Thymine', 'thiamine', 0.95).verdict, 'correct');
  assert.equal(grade('Thymine', 'thiamine', 0.6).verdict, 'correct');
  const g = grade('Layer 3 (Network layer)', 'layer 4');
  assert.equal(g.verdict, 'close');
  assert.ok(g.note);
});

test('variants', () => {
  assert.deepEqual(answerVariants('SIGTERM (15)'), ['SIGTERM (15)', 'SIGTERM', '15']);
});

test('quiz mixes types suitably', () => {
  const name = '08-signals-quiz-typescript.tsx';
  const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'samples');
  const { cards } = extractCards(readFileSync(join(SAMPLES, name), 'utf8'), name);
  const seen = new Set();
  for (let seed = 0; seed < 40; seed++) {
    for (const q of buildQuiz(cards, { count: 0, seed })) {
      seen.add(q.type);
      if (q.type === 'mc') {
        assert.equal(q.choices.length, 4);
        assert.equal(q.choices[q.correctIndex], q.answer);
      }
      if (q.answer.startsWith('A process that has finished')) assert.ok(['mc', 'tf'].includes(q.type));
    }
  }
  assert.deepEqual([...seen].sort(), ['mc', 'tf', 'typed']);
  assert.equal(answerKind('Yes'), 'boolean');
});

test('grade responses', () => {
  assert.equal(gradeResponse({ type: 'mc', correctIndex: 2, answer: 'x' }, 2).verdict, 'correct');
  assert.equal(gradeResponse({ type: 'tf', truth: false, answer: 'x' }, false).verdict, 'correct');
  assert.equal(gradeResponse({ type: 'typed', answer: 'The mitochondria' }, 'mitochondria').verdict, 'correct');
});

// Mirrors the varied-question tests in tests/test_quiz.py.
const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'samples');
test('varied questions stay on the card', () => {
  const styles = {};
  for (const name of ['02-biology-js-array.html', '13-deck-editor-chemistry.html', '03-spanish-vocab-react.jsx', '01-linux-commands-flip.html', '11-docker-mcq-quiz.html']) {
    const cards = extractCards(readFileSync(join(SAMPLES, name), 'utf8'), name).cards;
    for (let seed = 0; seed < 25; seed++) {
      for (const q of buildQuiz(cards, { count: 0, seed, vary: true })) {
        const card = cards.find((c) => c.key === q.key);
        assert.equal(q.front, card.front);
        if (q.type === 'mc') {
          assert.equal(q.choices[q.correctIndex], q.answer);
          assert.ok(q.choices.length >= 3 && new Set(q.choices.map((c) => c.toLowerCase())).size === q.choices.length);
        }
        const style = q.style || 'normal';
        styles[style] = (styles[style] || 0) + 1;
        if (style === 'reverse') {
          assert.equal(q.prompt, card.back); assert.equal(q.answer, card.front);
          if (q.type === 'typed') assert.ok(!card.front.includes('?'));
        } else if (style === 'cloze') {
          assert.ok(q.prompt.includes('_____') && ['mc', 'typed'].includes(q.type));
          assert.ok([card.back, card.explanation].includes(q.prompt.replaceAll('_____', q.answer)));
          assert.equal(q.context, card.front);
        } else if (style === 'explain') {
          assert.equal(q.prompt, card.explanation); assert.equal(q.answer, card.back);
        } else {
          assert.equal(q.prompt, card.front); assert.equal(q.answer, card.back);
        }
      }
    }
  }
  assert.deepEqual(Object.keys(styles).sort(), ['cloze', 'explain', 'normal', 'reverse']);
  assert.ok(styles.normal > Math.max(styles.reverse, styles.cloze, styles.explain));
});

test('vary off asks cards as written; enabled types are respected', () => {
  const name = '02-biology-js-array.html';
  const cards = extractCards(readFileSync(join(SAMPLES, name), 'utf8'), name).cards;
  for (let seed = 0; seed < 20; seed++) {
    for (const q of buildQuiz(cards, { count: 0, seed })) assert.ok(!q.style && q.prompt === q.front);
    for (const q of buildQuiz(cards, { count: 0, seed, vary: true, types: ['tf'] })) assert.equal(q.type, 'tf');
    for (const q of buildQuiz(cards, { count: 0, seed, vary: true, types: ['typed'] })) assert.equal(q.type, 'typed');
  }
});
