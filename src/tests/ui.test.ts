import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildStatusBar,
  buildUsageLine,
  colorsEnabled,
  formatK,
  LineGate,
  renderBox,
  truncateVisible,
  RevealFilter,
  stripAnsi,
  visibleLength,
} from '../core/ui.js';

test('stripAnsi removes escape sequences', () => {
  assert.equal(stripAnsi('\u001b[32mhello\u001b[0m'), 'hello');
});

test('visibleLength ignores ANSI codes', () => {
  assert.equal(visibleLength('\u001b[1mabc\u001b[0m'), 3);
});

test('formatK formats budgets', () => {
  assert.equal(formatK(30_000), '30k');
  assert.equal(formatK(32_500), '32.5k');
  assert.equal(formatK(900), '900');
});

test('renderBox draws unicode borders with equal widths', () => {
  const box = renderBox('Title', ['one', 'two-longer-line']);
  const lines = box.split('\n');
  assert.ok(lines[0].startsWith('┌') && lines[0].endsWith('┐'));
  assert.ok(lines[1].startsWith('│') && lines[1].includes('Title'));
  assert.ok(lines[2].startsWith('├') && lines[2].endsWith('┤'));
  assert.ok(lines[lines.length - 1].startsWith('└'));
  assert.ok(lines[lines.length - 1].endsWith('┘'));
  const widths = new Set(lines.map((l) => visibleLength(l)));
  assert.equal(widths.size, 1, 'all box rows must have equal visible width');
});

test('status bar contains model, context usage and hint', () => {
  const bar = buildStatusBar({ model: 'qwen3.8-flash', usedChars: 12345, budgetChars: 30_000 });
  const plain = stripAnsi(bar);
  assert.ok(plain.includes('⚡'));
  assert.ok(plain.includes('[qwen3.8-flash]'));
  assert.ok(plain.includes('ctx 41%'), 'percent usage per feedback §7.47');
  assert.ok(plain.includes('12.3k/30k'));
  assert.ok(plain.includes('/ perintah'));
  if (!colorsEnabled()) return;
  assert.ok(bar.includes('\u001b['), 'expected ANSI colors when TTY');
});

test('status bar flags plan mode and role', () => {
  const plain = stripAnsi(
    buildStatusBar({
      model: 'm',
      usedChars: 0,
      budgetChars: 100,
      role: 'teacher',
      planMode: true,
    }),
  );
  assert.ok(plain.includes('⏸ PLAN'));
  assert.ok(plain.includes('· teacher'));
});

test('status bar carries per-turn stats instead of a separate line (§8)', () => {
  const plain = stripAnsi(
    buildStatusBar({
      model: 'm',
      usedChars: 1000,
      budgetChars: 30_000,
      turn: { promptChars: 3200, completionChars: 800 },
    }),
  );
  assert.ok(plain.includes('↑3.2k ↓800'), 'turn stats live in the bar');
  const without = stripAnsi(buildStatusBar({ model: 'm', usedChars: 1, budgetChars: 100 }));
  assert.ok(!without.includes('↑'), 'no stray stats when no turn ran');
});

test('buildUsageLine reports per-turn chars and ctx percent', () => {
  const line = buildUsageLine({ promptChars: 3200, completionChars: 800, usedChars: 15_000, budgetChars: 30_000 });
  assert.equal(line, '↑ 3.2k ↓ 800 · ctx 50%');
});

test('LineGate holds the trailing line and flushes it for a final answer (§2)', () => {
  let out = '';
  const gate = new LineGate((t) => {
    out += t;
  });
  gate.push('Hello world');
  assert.equal(out, '', 'single trailing line is held back');
  assert.equal(gate.finish(true), true);
  assert.equal(out, 'Hello world');
});

test('LineGate drops a dangling preamble before a tool block (§2)', () => {
  let out = '';
  const gate = new LineGate((t) => {
    out += t;
  });
  gate.push('dengan: melihat daftar perintah');
  assert.equal(gate.finish(false), false);
  assert.equal(out, '', 'fragment must not reach the screen');
});

test('LineGate streams completed lines but reserves the last one', () => {
  let out = '';
  const gate = new LineGate((t) => {
    out += t;
  });
  gate.push('first\nsecond\nthird');
  assert.equal(out, 'first\n', 'only the last line stays reserved');
  gate.finish(true);
  assert.equal(out, 'first\nsecond\nthird');
});

// --- v0.6.1: single box helper + width clamp (feedback: stacking borders) ---

test('truncateVisible cuts to visible width and closes open colors', () => {
  const colored = '\u001b[93mmodel: claude-5\u001b[0m ── provider: custom';
  const cut = truncateVisible(colored, 10);
  assert.equal(visibleLength(cut), 10);
  assert.ok(!/\u001b\[93m[^\u001b]*$/.test(cut), 'no dangling color at cut end');
  assert.equal(truncateVisible('short', 50), 'short', 'no-op when it fits');
});

test('renderBox clamps to the terminal width so borders never wrap-stack', () => {
  const saved = process.stdout.columns;
  try {
    process.stdout.columns = 30;
    const box = renderBox('Title', ['x'.repeat(200)]);
    for (const line of box.split('\n')) {
      assert.ok(
        visibleLength(line) <= 30 - 1,
        `row must fit the terminal: ${visibleLength(line)}`,
      );
    }
    const widths = new Set(box.split('\n').map(visibleLength));
    assert.equal(widths.size, 1, 'all rows equal width even when clamped');
  } finally {
    process.stdout.columns = saved;
  }
});
