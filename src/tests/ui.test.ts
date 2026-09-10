import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildStatusBar,
  buildUsageLine,
  colorsEnabled,
  formatK,
  renderBox,
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

test('buildUsageLine reports per-turn chars and ctx percent', () => {
  const line = buildUsageLine({ promptChars: 3200, completionChars: 800, usedChars: 15_000, budgetChars: 30_000 });
  assert.equal(line, '↑ 3.2k ↓ 800 · ctx 50%');
});
