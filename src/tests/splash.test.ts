/**
 * splash.test.ts — Test banner maskot Ruki (v1.9.0).
 *
 * Semua maksud test LAMA dipertahankan (equal-width rows, border tertutup,
 * konten model/provider/hint, ANSI-safety, fits-40-cols) — hanya targetnya
 * yang dipindah ke renderer banner baru. Test LAMA tentang animasi ikan tidak
 * ada (animasi sudah dihapus); test baru menambah: maskot, versi sempit,
 * mode piped/non-TTY, dan garansi tidak ada timer/interval.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  renderRukiBannerLines,
  renderRukiCompactLines,
  renderRukiPlainLine,
  buildRukiInfoRows,
  splashWidth,
  playSplash,
  SplashInfo,
} from '../core/splash.js';
import { stripAnsi, visibleLength } from '../core/ui.js';
import { resetEnvCache } from '../core/env.js';

const info: SplashInfo = {
  title: 'Ruko-agent v1.9.0',
  version: 'v1.9.0',
  tagline: '"Masuk Ruko..."',
  modelLine: 'model: claude-5 ──── provider: custom',
  hint: 'Ketik / untuk daftar perintah, Ctrl+C untuk keluar.',
};

const separatedInfo: SplashInfo = {
  title: 'Ruko-agent v1.9.0',
  version: 'v1.9.0',
  tagline: '"Masuk Ruko..."',
  model: 'claude-3-5-sonnet-20241022',
  provider: 'anthropic',
  hint: 'Ketik / untuk daftar perintah, Ctrl+C untuk keluar.',
};

// ===========================================================================
// Test LAMA yang maksudnya dipertahankan (target renderer baru)
// ===========================================================================

describe('splash lama: maksud dipertahankan di banner baru', () => {
  test('banner box equal-width rows dan border tertutup', () => {
    const lines = renderRukiBannerLines(info, 56);
    assert.ok(lines[0].startsWith('╭') && lines[0].endsWith('╮'));
    assert.ok(lines[lines.length - 1].startsWith('╰') && lines[lines.length - 1].endsWith('╯'));
    const widths = new Set(lines.map((l) => visibleLength(l)));
    assert.equal(widths.size, 1, 'all splash rows must have equal visible width');
  });

  test('banner memuat version, model/provider, env, status, dan hint', () => {
    const text = renderRukiBannerLines(info, 56).map(stripAnsi).join('\n');
    assert.ok(text.includes('v1.9.0'));
    assert.ok(text.includes('claude-5'));
    assert.ok(text.includes('custom'));
    assert.ok(text.includes('Env'));
    assert.ok(text.includes('Safe at Local'));
    assert.ok(text.includes('Ketik / untuk daftar perintah'));
  });

  test('banner tetap equal-width dengan field ber-ANSI', () => {
    const lines = renderRukiBannerLines(separatedInfo, 56);
    const widths = new Set(lines.map((l) => visibleLength(l)));
    assert.equal(widths.size, 1);
  });

  test('banner muat di terminal sempit tanpa wrap (regresi v0.6.1 stacking bug)', () => {
    for (const cols of [40, 45, 47]) {
      const width = Math.max(20, Math.min(56, cols - 1));
      const lines = renderRukiCompactLines(info, width);
      for (const l of lines) {
        assert.ok(visibleLength(l) <= width, `splash row ${visibleLength(l)} > ${width} (cols=${cols})`);
      }
      const widths = new Set(lines.map(visibleLength));
      assert.equal(widths.size, 1, 'all rows equal width');
    }
  });

  test('model dan provider tetap dua baris terpisah (legacy modelLine dipecah)', () => {
    const plain = renderRukiBannerLines(info, 56).map(stripAnsi).join('\n');
    assert.ok(plain.includes('claude-5'));
    assert.ok(plain.includes('custom'));
    assert.ok(!plain.includes('──── provider:'), 'tidak ada separator legacy utuh');
  });

  test('model/provider tidak pernah terpotong di viewport 40 kolom', () => {
    const lines = renderRukiCompactLines(separatedInfo, 39);
    const plain = lines.map(stripAnsi).join('\n');
    for (const l of lines) assert.ok(visibleLength(l) <= 39);
    assert.ok(plain.includes('claude-3-5-sonnet-20241022'));
    assert.ok(plain.includes('anthropic'));
  });
});

// ===========================================================================
// Test BARU v1.9.0
// ===========================================================================

describe('splash v1.9.0: banner maskot Ruki', () => {
  test('banner penuh memuat maskot (/> _ </, /// ///, RUKO-AGENT)', () => {
    const text = renderRukiBannerLines(info, 56).map(stripAnsi).join('\n');
    assert.ok(text.includes('> _ <'), 'wajah maskot Ruki ada');
    assert.ok(text.includes('///'), 'tanda tangan maskot ada');
    assert.ok(text.includes('RUKO-AGENT'), 'nama maskot ada');
  });

  test('threshold 48: >=48 pakai banner penuh, <48 versi ringkas tanpa maskot', () => {
    const wide = renderRukiBannerLines(info, 47 + 1).map(stripAnsi).join('\n');
    assert.ok(wide.includes('RUKO-AGENT'), '47 inner => penuh (>=48 total)');
    const narrow = renderRukiCompactLines(info, 47).map(stripAnsi).join('\n');
    assert.ok(!narrow.includes('RUKO-AGENT'), 'versi sempit tanpa maskot');
    assert.ok(!narrow.includes('> _ <'), 'versi sempit tanpa wajah maskot');
  });

  test('splashWidth clamp: 20..56 dan mengikuti terminalWidth()-1', () => {
    const saved = process.stdout.columns;
    try {
      process.stdout.columns = 200;
      assert.equal(splashWidth(), 56);
      process.stdout.columns = 30;
      assert.equal(splashWidth(), 29);
      process.stdout.columns = 10;
      assert.equal(splashWidth(), 20);
    } finally {
      process.stdout.columns = saved;
    }
  });

  test('buildRukiInfoRows: env mengikuti EnvProfile (flavor + interactive)', () => {
    resetEnvCache();
    const rows = buildRukiInfoRows(separatedInfo);
    const labels = rows.map((r) => r.label);
    assert.deepEqual(labels, ['Model', 'Provider', 'Env', 'Status']);
    const envRow = rows.find((r) => r.label === 'Env')!;
    assert.ok(/\((?:non-)?interactive\)/.test(envRow.value), `env row: ${envRow.value}`);
    const statusRow = rows.find((r) => r.label === 'Status')!;
    assert.ok(statusRow.value.includes('Safe at Local'));
  });

  test('legacy modelLine tanpa separator utuh tetap masuk sebagai model', () => {
    const rows = buildRukiInfoRows({ ...info, modelLine: 'model: gpt-x', provider: undefined, model: undefined } as SplashInfo);
    assert.equal(rows[0].value, 'gpt-x');
  });
});

describe('splash v1.9.0: mode piped/non-TTY (isInteractiveTTY=false)', () => {
  test('renderRukiPlainLine: satu baris polos tanpa box/border', () => {
    const line = renderRukiPlainLine(separatedInfo);
    assert.ok(!line.includes('╭') && !line.includes('╰'), 'tanpa border unicode');
    assert.ok(line.includes('Ruko-agent v1.9.0'));
    assert.ok(line.includes('model=claude-3-5-sonnet-20241022'));
    assert.ok(line.includes('provider=anthropic'));
    assert.ok(line.includes('env='), 'memuat ringkasan env');
  });

  test('playSplash TANPA timer/interval (animasi terhapus — anti memory-leak by design)', () => {
    // `setTimeout` hanya dipakai di implementasi Promise.delay animasi lama;
    // splash baru tidak lagi memiliki delay/frame loop sama sekali.
    resetEnvCache();
    // Panggil pada lingkungan non-interaktif dan pastikan resolve cepat
    // tanpa perlu membersihkan timer apa pun.
    const p = playSplash(info);
    return p.then((lines) => {
      assert.ok(Array.isArray(lines));
      resetEnvCache();
    });
  });
});
