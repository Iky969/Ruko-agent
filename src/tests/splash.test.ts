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

test('splash separates model and provider into two distinct lines without hyphen separator', () => {
  const separatedInfo: SplashInfo = {
    title: 'Ruko-agent 1.2.0',
    version: 'version 1.2.0 ',
    tagline: '"Masuk Ruko..."',
    model: 'claude-3-5-sonnet-20241022',
    provider: 'anthropic',
    hint: 'Ketik / untuk daftar perintah, Ctrl+C untuk keluar.',
  };

  const lines = renderSplashLines(separatedInfo);
  const plain = lines.map(stripAnsi);

  // Must have model line and provider line separately
  const modelLine = plain.find((l) => l.includes('model: claude-3-5-sonnet-20241022'));
  const providerLine = plain.find((l) => l.includes('provider: anthropic'));

  assert.ok(modelLine, 'must contain a line with model: claude-3-5-sonnet-20241022');
  assert.ok(providerLine, 'must contain a line with provider: anthropic');
  assert.notEqual(modelLine, providerLine, 'model and provider must be on separate lines');
  assert.ok(!plain.some((l) => l.includes('──── provider:') || l.includes('── provider:')), 'must not contain single-line joined separator');

  // Closed borders and equal widths
  const widths = new Set(lines.map((l) => visibleLength(l)));
  assert.equal(widths.size, 1, 'all splash rows must have equal visible width');
});

test('splash with separate model and provider never truncates on 40-column viewport', () => {
  const saved = process.stdout.columns;
  try {
    process.stdout.columns = 40;
    const separatedInfo: SplashInfo = {
      title: 'Ruko-agent 1.1.0',
      version: 'version 1.1.0 ',
      tagline: '"Masuk Ruko..."',
      model: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
      hint: 'Ketik / untuk daftar perintah, Ctrl+C untuk keluar.',
    };

    const lines = renderSplashLines(separatedInfo);
    const plain = lines.map(stripAnsi);

    for (const l of lines) {
      assert.ok(visibleLength(l) <= 40 - 1, `row exceeded width: ${visibleLength(l)}`);
    }

    // Neither model nor provider should be truncated on 40-column viewport
    assert.ok(plain.some((l) => l.includes('model: claude-3-5-sonnet-20241022')));
    assert.ok(plain.some((l) => l.includes('provider: anthropic')));

    const widths = new Set(lines.map((l) => visibleLength(l)));
    assert.equal(widths.size, 1, 'all splash rows must have equal visible width on 40 cols');
  } finally {
    process.stdout.columns = saved;
  }
});

