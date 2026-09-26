import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActivityTray } from '../core/activity.js';
import { buildStatusPanel, buildStatusBar, renderStatusPanel, stripAnsi, visibleLength } from '../core/ui.js';
import { createDefaultSessionState } from '../types.js';

// ============================================================================
// Fase 5: Background task & info model dipisah dari status bar
// ============================================================================

test('Satu task tetap tampil satu baris TANPA hint ctrl+o; dua task tampil normal', () => {
  const tray = new ActivityTray({ now: () => 0 });
  tray.start('solo', 'npm test', { icon: '🟢', startedAt: -45_000 });
  const solo = tray.renderRows({ width: 40 }).map(stripAnsi);
  assert.equal(solo.length, 1, 'satu task → satu baris tray');
  assert.ok(!solo.some((r) => r.includes('ctrl+o')), 'satu task tidak pernah menampilkan hint ctrl+o');

  tray.start('dua', 'Subagent halo.md', { icon: '🟣', startedAt: -23_000 });
  const rows = tray.renderRows({ width: 40 }).map(stripAnsi);
  assert.equal(rows.length, 2, 'dua task → dua baris tray');
  assert.ok(!rows.some((r) => r.includes('ctrl+o')), 'dua task muat semua → tanpa hint');
});

test("Overflow hint '-- N more, ctrl+o to expand' hanya muncul dengan >= 2 task dan lebih dari maxRows", () => {
  const tray = new ActivityTray({ now: () => 0 });
  for (let i = 0; i < 4; i++) tray.start(`t${i}`, `task ${i}`, { startedAt: -1000 * (i + 1) });

  const collapsed = tray.renderRows({ width: 40, maxRows: 2 }).map(stripAnsi);
  assert.equal(collapsed.length, 3, '2 baris + overflow hint');
  assert.equal(collapsed[2], '-- 2 more, ctrl+o to expand');

  const expanded = tray.renderRows({ width: 40, maxRows: 2, expanded: true }).map(stripAnsi);
  assert.equal(expanded.length, 4, 'expanded → semua task tampil tanpa hint');
});

test('Status panel memuat indikator mode:<aktif> dan reasoning:<level>', () => {
  const panel = renderStatusPanel({
    width: 100,
    model: 'gemini-3.8-flash',
    usedChars: 1000,
    budgetChars: 30_000,
    mode: 'research',
    reasoning: 'xhigh',
  });
  const plain = stripAnsi(panel);
  assert.ok(plain.includes('mode:research'), 'indikator mode tampil');
  assert.ok(plain.includes('reasoning:xhigh'), 'indikator reasoning tampil');
});

test('Status panel default: mode:default tampil dim, tetap satu baris responsif', () => {
  const lines = buildStatusPanel({
    width: 100,
    model: 'gemini-3.8-flash',
    usedChars: 1000,
    budgetChars: 30_000,
    mode: 'default',
    reasoning: 'high',
  });
  // Semua baris panel berbagi satu lebar visible (layout responsif utuh).
  const widths = new Set(lines.map((l) => visibleLength(stripAnsi(l))));
  assert.equal(widths.size, 1, `semua baris sama lebar: ${JSON.stringify([...widths])}`);
  const plain = stripAnsi(lines.join('\n'));
  assert.ok(plain.includes('mode:default'), 'mode default tetap terlihat');
  assert.ok(plain.includes('reasoning:high'));
});

test('Indikator mode/reasoning hidup di status bar gelap juga (buildStatusBar)', () => {
  const bar = stripAnsi(
    buildStatusBar({
      width: 110,
      model: 'qwen3.8-flash',
      usedChars: 1000,
      budgetChars: 20_000,
      mode: 'build',
      reasoning: 'max',
    }),
  );
  assert.ok(bar.includes('mode:build'), 'bar memuat mode:build');
  assert.ok(bar.includes('reasoning:max'), 'bar memuat reasoning:max');
});

test('Panel tanpa mode/reasoning (field opsional) tetap ter-render normal', () => {
  const panel = buildStatusPanel({
    width: 80,
    model: 'gemini-3.8-flash',
    usedChars: 1000,
    budgetChars: 30_000,
  });
  const plain = stripAnsi(panel.join('\n'));
  assert.ok(plain.includes('gemini'), 'model tetap tampil');
  assert.ok(!plain.includes('mode:'), 'tanpa field mode → tanpa indikator');
});

test('Layar sempit: indikator turun mengikuti kandidat kolom sebelum model terpotong', () => {
  // 46 kolom: panel harus tetap muat satu lebar dan tak pernah wrap.
  const lines = buildStatusPanel({
    width: 46,
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    usedChars: 500,
    budgetChars: 10_000,
    mode: 'code',
    reasoning: 'extreme',
  });
  for (const l of lines) {
    assert.ok(visibleLength(stripAnsi(l)) <= 45, `baris muat di 46 cols: ${stripAnsi(l)}`);
  }
});

test('SessionState default menyediakan nilai awal indikator (mode default, reasoning xhigh)', () => {
  const s = createDefaultSessionState();
  assert.equal(s.mode, 'default');
  assert.equal(s.reasoningLevel, 'xhigh');
});
