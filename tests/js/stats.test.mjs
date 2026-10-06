import './setup.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stats } from '../../flashcard_viewer/ui/js/core/statscore.js';

test('CSV export neutralises spreadsheet formulas in card text', () => {
  const s = new Stats();
  s.recordQuiz('d', [{ key: 'a', front: '=HYPERLINK("http://evil","x")', verdict: 'wrong' }, { key: 'b', front: '@SUM(1)', verdict: 'correct' }]);
  const csv = s.exportCsv({ d: '+deck' });
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"",""x"")"`));
  assert.ok(csv.includes("'@SUM(1)"));
  assert.ok(csv.includes("'+deck"));
  assert.ok(!/(^|,)[=@+]/m.test(csv));
});
