import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStatusBar, buildStatusPanel, stripAnsi, visibleLength } from '../core/ui.js';

for (const planMode of [true, false]) {
  test(`authorization status remains readable on narrow screens in ${planMode ? 'PLAN' : 'ACT'}`, () => {
    for (const width of [24, 30, 40, 60, 80, 120]) {
      for (const scopePaths of [null, [], ['.'], ['src'], ['src/very/long/名前/path', 'docs', 'tests']]) {
        const input = {
          width, planMode, scopePaths, model: 'provider/very-long-model-name',
          usedChars: 100, budgetChars: 1000, busy: true, yoloMode: true,
          mode: 'build', reasoning: 'high', pending: 3,
        };
        const bar = stripAnsi(buildStatusBar(input));
        const panel = buildStatusPanel(input).map(stripAnsi);
        assert.match(bar, planMode ? /^PLAN/ : /^ACT/);
        assert.match(bar, /scope: /);
        assert.ok(visibleLength(bar) <= width - 1, bar);
        assert.equal(new Set(panel.map(visibleLength)).size, 1);
        for (const row of panel) assert.ok(visibleLength(row) <= width - 1, row);
        const auth = panel.find((row) => row.includes('scope: '));
        assert.ok(auth, panel.join('\n'));
        assert.ok(auth.includes(planMode ? 'PLAN' : 'ACT'));
        if (!scopePaths?.length) {
          assert.match(bar, /scope: \(none\)/);
          assert.match(auth, /scope: \(none\)/);
        } else if (scopePaths.length === 1) {
          assert.ok(bar.includes(`scope: ${scopePaths[0]}`));
          assert.ok(auth.includes(`scope: ${scopePaths[0]}`));
        } else {
          assert.match(bar, /\(\+2\)/);
          assert.match(auth, /\(\+2\)/);
        }
      }
    }
  });
}

test('scope status cannot inject extra terminal rows or ANSI escapes through a path', () => {
  const input = {
    width: 80, model: 'test', usedChars: 0, budgetChars: 100,
    scopePaths: ['src\n\x1b[31mred\x1b[0m\tname'], planMode: false,
  };
  const bar = stripAnsi(buildStatusBar(input));
  const panel = buildStatusPanel(input).map(stripAnsi);
  assert.doesNotMatch(bar, /[\r\n\t\x1b]/);
  assert.equal(panel.length, 6);
  for (const row of panel) assert.doesNotMatch(row, /[\r\n\t\x1b]/);
  assert.match(bar, /scope: src red name/);
});
