import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderSplashLines, SplashInfo } from '../core/splash.js';
import { stripAnsi, visibleLength } from '../core/ui.js';

const info: SplashInfo = {
  title: 'Ruko-agent 0.6.0',
  version: 'version 0.6.0 ',
  tagline: '"Masuk Ruko..."',
  modelLine: 'model: claude-5 ──── provider: custom',
  hint: 'Ketik / untuk daftar perintah, Ctrl+C untuk keluar.',
};

test('splash box has equal-width rows and closed borders', () => {
  const lines = renderSplashLines(info);
  assert.ok(lines[0].startsWith('┌') && lines[0].endsWith('┐'));
  assert.ok(lines[lines.length - 1].startsWith('└'));
  assert.ok(lines[lines.length - 1].endsWith('┘'));
  const widths = new Set(lines.map((l) => visibleLength(l)));
  assert.equal(widths.size, 1, 'all splash rows must have equal visible width');
});

test('splash contains version, model/provider line and hint', () => {
  const text = renderSplashLines(info).map(stripAnsi).join('\n');
  assert.ok(text.includes('version 0.6.0'));
  assert.ok(text.includes('model: claude-5'));
  assert.ok(text.includes('provider: custom'));
  assert.ok(text.includes('Ketik / untuk daftar perintah'));
});

test('splash keeps borders intact with ANSI-coloured fields', () => {
  const coloured: SplashInfo = {
    ...info,
    modelLine: '\u001b[93mmodel: claude-5\u001b[0m ── provider: custom',
  };
  const lines = renderSplashLines(coloured);
  const widths = new Set(lines.map((l) => visibleLength(l)));
  assert.equal(widths.size, 1);
});

test('splash box fits a narrow terminal without wrapping (v0.6.1 stacking bug)', () => {
  const saved = process.stdout.columns;
  try {
    process.stdout.columns = 40;
    const lines = renderSplashLines(info);
    for (const l of lines) {
      assert.ok(visibleLength(l) <= 40 - 1, `splash row too wide: ${visibleLength(l)}`);
    }
    const widths = new Set(lines.map(visibleLength));
    assert.equal(widths.size, 1, 'all splash rows equal width');
  } finally {
    process.stdout.columns = saved;
  }
});
