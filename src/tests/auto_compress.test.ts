import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleCommand } from '../agent/commands.js';
import { loadConfig, sanitizeConfigFile, saveConfig } from '../core/config.js';
import { Context } from '../core/context.js';
import {
  DEFAULT_AUTO_COMPRESS_THRESHOLD_CHARS,
  DEFAULT_CONFIG,
  MAX_AUTO_COMPRESS_THRESHOLD_CHARS,
} from '../types.js';

function makeCtx(overrides: Record<string, unknown> = {}) {
  const config = {
    ...DEFAULT_CONFIG,
    maxContextChars: 1000,
    autoCompressThresholdChars: 500,
    autoCompress: true,
    ...overrides,
  };
  const ctx = new Context(config);
  return { config, ctx };
}

function fill(ctx: Context, count: number): void {
  for (let i = 0; i < count; i++) {
    ctx.add(i % 2 === 0 ? 'user' : 'assistant', `pesan ke-${i} ` + 'x'.repeat(110));
  }
}

function mockEnv(config: Record<string, unknown>, ctx: Context) {
  let patch: Record<string, unknown> | null = null;
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logged.push(args.join(' '));
  const env: any = {
    ctx,
    config,
    llm: { model: 'test-model', isConfigured: true },
    confirm: async () => true,
    updateConfig: (p: Record<string, unknown>) => {
      patch = p;
      Object.assign(config, p);
    },
    handle: { stop: () => {}, getSessionId: () => null, setSessionId: () => {} },
  };
  return {
    env,
    logged,
    getPatch: () => patch,
    restore: () => {
      console.log = origLog;
    },
  };
}

test('defaults: auto-compress ON dengan ambang 500.000 karakter', () => {
  assert.equal(DEFAULT_CONFIG.autoCompress, true);
  assert.equal(DEFAULT_CONFIG.autoCompressThresholdChars, 500_000);
  assert.equal(DEFAULT_AUTO_COMPRESS_THRESHOLD_CHARS, 500_000);
  assert.equal(MAX_AUTO_COMPRESS_THRESHOLD_CHARS, 1_000_000);
});

test('sanitizeConfigFile menerima nilai auto-compress yang valid', () => {
  const clean = sanitizeConfigFile({ autoCompress: false, autoCompressThresholdChars: 250_000 });
  assert.equal(clean.autoCompress, false);
  assert.equal(clean.autoCompressThresholdChars, 250_000);
});

test('sanitizeConfigFile menolak nilai auto-compress yang tidak valid', () => {
  const clean = sanitizeConfigFile({
    autoCompress: 'yes',
    autoCompressThresholdChars: '500k',
  });
  assert.equal(clean.autoCompress, undefined);
  assert.equal(clean.autoCompressThresholdChars, undefined);

  const clean2 = sanitizeConfigFile({ autoCompressThresholdChars: 0 });
  assert.equal(clean2.autoCompressThresholdChars, undefined);
  const clean3 = sanitizeConfigFile({ autoCompressThresholdChars: -5 });
  assert.equal(clean3.autoCompressThresholdChars, undefined);
  const clean4 = sanitizeConfigFile({ autoCompressThresholdChars: Number.NaN });
  assert.equal(clean4.autoCompressThresholdChars, undefined);
});

test('sanitizeConfigFile menjepit ambang yang melebihi batas maksimum', () => {
  const clean = sanitizeConfigFile({ autoCompressThresholdChars: 20_000_000 });
  assert.equal(clean.autoCompressThresholdChars, MAX_AUTO_COMPRESS_THRESHOLD_CHARS);
});

test('saveConfig/loadConfig round-trip untuk setting auto-compress', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-'));
  const path = join(dir, 'config.json');
  try {
    saveConfig({ ...DEFAULT_CONFIG, autoCompress: false, autoCompressThresholdChars: 250_000 }, path);
    const config = loadConfig(path);
    assert.equal(config.autoCompress, false);
    assert.equal(config.autoCompressThresholdChars, 250_000);
    writeFileSync(path, JSON.stringify({ autoCompress: 'yes', autoCompressThresholdChars: -1 }), 'utf8');
    const fallback = loadConfig(path);
    assert.equal(fallback.autoCompress, true, 'nilai tidak valid jatuh kembali ke default');
    assert.equal(fallback.autoCompressThresholdChars, 500_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compress() tidak melipat apa pun saat autoCompress mati, walau riwayat besar', () => {
  const { ctx } = makeCtx({ autoCompress: false });
  fill(ctx, 20); // ~2.400 chars, jauh di atas maxContextChars 1.000
  const before = ctx.totalChars;
  const removed = ctx.compress();
  assert.equal(removed, 0);
  assert.equal(ctx.totalChars, before);
  assert.equal(ctx.size, 20);
});

test('compress() tidak melipat apa pun saat ambang belum tercapai', () => {
  const { ctx } = makeCtx({ autoCompress: true, autoCompressThresholdChars: 500 });
  fill(ctx, 4); // ~484 chars < ambang 500
  const before = ctx.totalChars;
  assert.equal(ctx.compress(), 0);
  assert.equal(ctx.totalChars, before);
});

test('compress() melipat riwayat lama saat ambang tercapai dan menjaga pesan terakhir', () => {
  const { ctx } = makeCtx({ autoCompress: true, autoCompressThresholdChars: 500 });
  fill(ctx, 20);
  const before = ctx.totalChars;
  const lastBefore = ctx.getMessages().at(-1)?.content;
  const removed = ctx.compress();
  assert.ok(removed > 0, 'harus ada karakter yang dilipat');
  assert.ok(ctx.totalChars < before);
  assert.equal(ctx.getMessages().at(-1)?.content, lastBefore, 'pesan terakhir dipertahankan utuh');
});

test('compress() tetap jalan saat ambang tidak diset (config lama tanpa field)', () => {
  const config = { ...DEFAULT_CONFIG, maxContextChars: 1000 };
  delete (config as Record<string, unknown>).autoCompress;
  delete (config as Record<string, unknown>).autoCompressThresholdChars;
  const ctx = new Context(config);
  // Ambang default 500.000 chars: isi riwayat sampai melewatinya.
  fill(ctx, 5000);
  assert.ok(ctx.totalChars >= 500_000);
  assert.ok(ctx.compress() > 0, 'default lama = auto-compress ON dengan ambang 500.000');
});

test('compress() dengan ambang di atas maxContextChars tetap melipat ke budget', () => {
  const { ctx } = makeCtx({ autoCompress: true, autoCompressThresholdChars: 5000 });
  fill(ctx, 50); // ~6.000 chars >= ambang 5.000
  const before = ctx.totalChars;
  const removed = ctx.compress();
  assert.ok(removed > 0);
  assert.ok(ctx.totalChars < before);
});

test('/compact manual (compressNow) tetap jalan saat autoCompress mati', () => {
  const { ctx } = makeCtx({ autoCompress: false });
  fill(ctx, 20);
  const before = ctx.totalChars;
  const removed = ctx.compressNow(4);
  assert.ok(removed > 0, 'kompres manual tidak terpengaruh setting auto-compress');
  assert.ok(ctx.totalChars < before);
});

test('/settings auto-compress on/off dan ambang via handleCommand', async () => {
  const { config, ctx } = makeCtx();
  const m = mockEnv(config as unknown as Record<string, unknown>, ctx);
  try {
    await handleCommand('/settings auto-compress off', m.env);
    assert.deepEqual(m.getPatch(), { autoCompress: false });
    assert.equal(config.autoCompress, false);

    await handleCommand('/settings auto-compress on', m.env);
    assert.deepEqual(m.getPatch(), { autoCompress: true });

    await handleCommand('/settings auto-compress maybe', m.env);
    assert.ok(m.logged.some((l) => l.includes('/settings auto-compress <on|off>')));

    await handleCommand('/settings auto-compress-threshold 300k', m.env);
    assert.deepEqual(m.getPatch(), { autoCompressThresholdChars: 300_000 });

    await handleCommand('/settings auto-compress-threshold 0', m.env);
    assert.ok(m.logged.some((l) => l.includes('bilangan bulat positif')));

    await handleCommand('/settings auto-compress-threshold 99m', m.env);
    assert.ok(m.logged.some((l) => l.includes('tidak boleh melebihi')));
  } finally {
    m.restore();
  }
});

test('/settings menampilkan status auto-compress di dashboard', async () => {
  const { config, ctx } = makeCtx({ autoCompress: false, autoCompressThresholdChars: 250_000 });
  const m = mockEnv(config as unknown as Record<string, unknown>, ctx);
  try {
    await handleCommand('/settings', m.env);
    assert.ok(m.logged.some((l) => l.includes('Auto-Compress')));
    assert.ok(m.logged.some((l) => l.includes('OFF')));
    assert.ok(m.logged.some((l) => l.includes('250,000')));
  } finally {
    m.restore();
  }
});

test('/config set autoCompress dan autoCompressThresholdChars via handleCommand', async () => {
  const { config, ctx } = makeCtx();
  const m = mockEnv(config as unknown as Record<string, unknown>, ctx);
  try {
    await handleCommand('/config set autoCompress false', m.env);
    assert.deepEqual(m.getPatch(), { autoCompress: false });

    await handleCommand('/config set autoCompressThresholdChars 250k', m.env);
    assert.deepEqual(m.getPatch(), { autoCompressThresholdChars: 250_000 });

    await handleCommand('/config set autoCompressThresholdChars abc', m.env);
    assert.ok(m.logged.some((l) => l.includes('Nilai tidak valid')));

    await handleCommand('/config', m.env);
    assert.ok(m.logged.some((l) => l.includes('autoCompress')));
  } finally {
    m.restore();
  }
});
