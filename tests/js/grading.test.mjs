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
