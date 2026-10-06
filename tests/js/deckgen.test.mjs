import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { buildDeckHtml, parseDeckHtml, toPlain, deckCards, deckFilename, normalizeDeck } from '../../flashcard_viewer/ui/js/core/deckgen.js';
import { extractCards } from '../../flashcard_viewer/ui/js/core/extract.js';
import { cardsFromCsv, cardsFromText, parseCsv } from '../../flashcard_viewer/ui/js/core/csv.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const RUNTIME = join(ROOT, 'flashcard_viewer', 'ui', 'deck-runtime');
const runtime = { css: readFileSync(join(RUNTIME, 'custom-deck.css'), 'utf8'), js: readFileSync(join(RUNTIME, 'custom-deck.js'), 'utf8') };
const SAMPLE = readFileSync(join(ROOT, 'samples', '13-deck-editor-chemistry.html'), 'utf8');

// Same cases as tests/test_customdeck.py runs against customdeck.to_plain.
for (const [md, plain] of JSON.parse(readFileSync(join(HERE, '..', 'plain_cases.json'), 'utf8'))) {
  test(`toPlain ${JSON.stringify(md).slice(0, 40)}`, () => assert.equal(toPlain(md), plain));
}

test('sample deck: same cards as the Python extractor', () => {
  const { cards, methods } = extractCards(SAMPLE, '13.html');
  assert.deepEqual(methods, ['deck-editor']);
  assert.equal(cards.length, 8);
  const gas = cards.find((c) => c.front === 'Which gas do plants absorb for photosynthesis?');
  assert.equal(gas.back, 'Carbon dioxide');
  assert.deepEqual(gas.choices, ['Oxygen', 'Carbon dioxide', 'Nitrogen', 'Helium']);
  assert.ok(cards.some((c) => c.front === 'Chemical formula of water?' && c.back === '$H_2O$' && c.hint === 'Two hydrogens'));
});

test('build and parse round trip; script-breaking text stays inside the data block', () => {
  const deck = {
    title: 'T </script><script>alert(1)</script>', emoji: '🧪',
    cards: [{ type: 'basic', front: 'a </script><!-- b', back: ' line sep' }, { type: 'mcq', front: 'q', choices: ['x', 'y'], correct: 1 }],
    images: { keep: 'data:image/png;base64,AAAA', drop: 'data:image/png;base64,BBBB' },
  };
  deck.cards[0].front += ' ![i](img:keep)';
  const html = buildDeckHtml(deck, runtime);
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.equal((html.match(/<\/script>/g) || []).length, 2); // data block + runtime
  const back = parseDeckHtml(html);
  assert.equal(back.title, deck.title);
  assert.equal(back.cards[0].front, deck.cards[0].front);
  assert.equal(back.cards[0].back, deck.cards[0].back);
  assert.deepEqual(Object.keys(back.images), ['keep']);
  assert.equal(deckCards(back)[1].back, 'y');
  assert.equal(parseDeckHtml('<p>hello</p>'), null);
});

test('normalizeDeck drops unsafe images and bad answers', () => {
  const d = normalizeDeck({ cards: [{ type: 'mcq', front: 'q', choices: ['a', 'b'], correct: '1' }], images: { a: 'data:image/svg+xml;base64,AA', b: 'javascript:x' } });
  assert.equal(d.cards[0].correct, 0);
  assert.deepEqual(d.images, {});
});

test('deckFilename', () => {
  assert.equal(deckFilename('Spanish: verbs / tenses?'), 'Spanish verbs tenses.html');
  assert.equal(deckFilename('  '), 'My deck.html');
  assert.equal(deckFilename('..hidden'), 'hidden.html');
});

test('runtime renders Markdown safely', async () => {
  const deck = {
    title: 'Safety',
    cards: [{
      type: 'basic',
      front: '<img src=x onerror="window.pwned=1"> **bold** [bad](javascript:window.pwned=2) [ok](https://example.com) ![x](img:nope) `<b>`',
      back: 'answer',
    }],
  };
  const dom = new JSDOM(buildDeckHtml(deck, runtime), { runScripts: 'dangerously', pretendToBeVisual: true });
  await new Promise((r) => setTimeout(r, 50));
  const doc = dom.window.document;
  const front = doc.querySelector('.fv-front .fv-body');
  assert.ok(front, 'card rendered');
  assert.equal(front.querySelector('img'), null);
  assert.equal(front.querySelector('strong').textContent, 'bold');
  const links = [...front.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  assert.deepEqual(links, ['https://example.com']);
  assert.equal(front.querySelector('code').textContent, '<b>');
  assert.equal(dom.window.pwned, undefined);
  assert.equal(doc.querySelector('.fv-count').textContent, '1 / 1');
  dom.window.close();
});

test('CSV: quoting, separators, headers and multiple choice', () => {
  assert.deepEqual(parseCsv('a,"b, c","d ""q"""\n1,2,3').rows, [['a', 'b, c', 'd "q"'], ['1', '2', '3']]);
  assert.equal(parseCsv('x;y\n1;2').delimiter, ';');
  const plain = cardsFromCsv('Front,Back,Hint,Tags\nhola,hello,greeting,spanish\n,missing front,,');
  assert.equal(plain.header, true);
  assert.equal(plain.skipped, 1);
  assert.deepEqual(plain.cards[0], { type: 'basic', front: 'hola', back: 'hello', hint: 'greeting', explanation: '', category: 'spanish' });
  const mcq = cardsFromCsv('question,A,B,C,D,answer\n2+2?,3,4,5,6,B\n1+1?,1,2,3,4,2\nbad,1,2,,,Z');
  assert.deepEqual(mcq.cards.map((c) => [c.type, c.correct]), [['mcq', 1], ['mcq', 1]]);
  assert.equal(mcq.skipped, 1);
  const anki = cardsFromCsv('#separator:tab\n#html:true\nhola<br>hi\thello &amp; <b>bye</b>');
  assert.deepEqual([anki.cards[0].front, anki.cards[0].back], ['hola\nhi', 'hello & **bye**']);
  const noHeader = cardsFromCsv('chien\tdog\nchat\tcat');
  assert.deepEqual(noHeader.cards.map((c) => c.back), ['dog', 'cat']);
});

test('pasted text: term lists and Q/A blocks', () => {
  assert.deepEqual(cardsFromText('chien - dog\nchat - cat\noiseau = bird').cards.map((c) => [c.front, c.back]),
    [['chien', 'dog'], ['chat', 'cat']]);
  assert.deepEqual(cardsFromText('le chien — the dog\nle chat — the cat').cards.map((c) => c.back), ['the dog', 'the cat']);
  const qa = cardsFromText('Q: What is 2+2?\nA: 4\nQ: Capital of France?\nA: Paris\nthe city of light');
  assert.deepEqual(qa.cards.map((c) => [c.front, c.back]), [['What is 2+2?', '4'], ['Capital of France?', 'Paris\nthe city of light']]);
});
