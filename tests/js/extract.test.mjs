import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCards, decodeText } from '../../flashcard_viewer/ui/js/core/extract.js';

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'samples');

// Same expectations as tests/test_extract.py — the JS port must agree with the Python extractor.
const EXPECTED = {
  '01-linux-commands-flip.html': [10, ['Redirect stdin from a file into sort', 'sort < input.txt']],
  '02-biology-js-array.html': [12, ['Which organelle is called the cell\'s "post office"?', 'The Golgi apparatus']],
  '03-spanish-vocab-react.jsx': [11, ['la piña', 'the pineapple']],
  '04-aws-fragment.html': [10, ['Managed Kubernetes', 'Amazon EKS']],
  '05-calculus-json-cdn.html': [8, ['Derivative of $\\sin x$', '$\\cos x$']],
  '06-history-table-dl.html': [10, ['Fall of the Berlin Wall', '1989']],
  '07 networking Q&A notes.html': [10, ['Command to test reachability of a host?', 'ping']],
  '08-signals-quiz-typescript.tsx': [8, ['Default signal sent by `kill` with no options?', 'SIGTERM (15)']],
  '09-pomodoro-no-cards.html': [0, null],
  '10-日本語-kana.HTM': [10, ['ふ', 'fu (hu)']],
  '11-docker-mcq-quiz.html': [5, ['What file is used to define multi-container applications?', 'docker-compose.yml']],
  '12-git-tuple-rows.html': [6, ['Which command stages file.txt?', 'git add file.txt']],
};

for (const [name, [count, pair]] of Object.entries(EXPECTED)) {
  test(`extract ${name}`, () => {
    const text = decodeText(readFileSync(join(SAMPLES, name)));
    const { cards } = extractCards(text, name);
    assert.equal(cards.length, count, JSON.stringify(cards.map((c) => [c.front, c.back])));
    if (pair) assert.ok(cards.some((c) => c.front === pair[0] && c.back === pair[1]), `missing ${pair}`);
  });
}

test('every sample covered', () => {
  const files = readdirSync(SAMPLES).filter((f) => !f.endsWith('.md'));
  assert.deepEqual(files.sort(), Object.keys(EXPECTED).sort());
});

test('quiz artifact keeps choices and explanation', () => {
  const name = '11-docker-mcq-quiz.html';
  const { cards } = extractCards(readFileSync(join(SAMPLES, name), 'utf8'), name);
  assert.equal(cards[0].back, 'CMD');
  assert.deepEqual(cards[0].choices, ['RUN', 'CMD', 'COPY', 'EXPOSE']);
  assert.match(cards[0].explanation, /CMD provides defaults/);
});

test('categories from object keys and hints', () => {
  const r = extractCards(readFileSync(join(SAMPLES, '03-spanish-vocab-react.jsx'), 'utf8'), '03.jsx');
  assert.deepEqual(new Set(r.cards.map((c) => c.category)), new Set(['animals', 'food', 'phrases']));
  const b = extractCards(readFileSync(join(SAMPLES, '02-biology-js-array.html'), 'utf8'), '02.html');
  assert.equal(b.cards[0].hint, 'It makes ATP');
  assert.equal(b.cards[6].front, 'What is a codon?');
});

test('tuple rows use topic and note columns', () => {
  const text = decodeText(readFileSync(join(SAMPLES, '12-git-tuple-rows.html')));
  const { cards } = extractCards(text, '12-git-tuple-rows.html');
  const c = cards.find((x) => x.front === 'Create and switch to a branch called dev?');
  assert.equal(c.category, 'Branches');
  assert.equal(c.explanation, 'Older form: git checkout -b dev');
  assert.equal(cards.find((x) => x.front === 'Which command stages file.txt?').explanation, '');
});
