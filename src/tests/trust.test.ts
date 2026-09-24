import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isWorkspaceTrusted, markWorkspaceTrusted, promptWorkspaceTrust, TRUST_MARKER_FILE } from '../core/trust.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { DEFAULT_CONFIG } from '../types.js';

function inTempWorkspace<T>(fn: (ws: string) => Promise<T> | T): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-trust-'));
  return Promise.resolve(fn(ws)).finally(() => {
    rmSync(ws, { recursive: true, force: true });
  });
}

test('isWorkspaceTrusted returns false by default for new folder', async () => {
  await inTempWorkspace(async (ws) => {
    const configPath = join(ws, '.ruko', 'config.json');
    assert.equal(isWorkspaceTrusted(ws, configPath), false);
  });
});

test('isWorkspaceTrusted returns true when RUKO_TRUST_FOLDER=1', async () => {
  await inTempWorkspace(async (ws) => {
    const prev = process.env.RUKO_TRUST_FOLDER;
    try {
      process.env.RUKO_TRUST_FOLDER = '1';
      assert.equal(isWorkspaceTrusted(ws), true);
    } finally {
      if (prev !== undefined) process.env.RUKO_TRUST_FOLDER = prev;
      else delete process.env.RUKO_TRUST_FOLDER;
    }
  });
});

test('markWorkspaceTrusted writes marker file and sets trustedWorkspace in config', async () => {
  await inTempWorkspace(async (ws) => {
    const configPath = join(ws, '.ruko', 'config.json');
    const cfg = { ...DEFAULT_CONFIG };
    saveConfig(cfg, configPath);

    assert.equal(isWorkspaceTrusted(ws, configPath), false);

    markWorkspaceTrusted(ws, configPath);

    assert.equal(existsSync(join(ws, '.ruko', TRUST_MARKER_FILE)), true);
    assert.equal(isWorkspaceTrusted(ws, configPath), true);

    const loaded = loadConfig(configPath);
    assert.equal(loaded.trustedWorkspace, true);
  });
});

test('promptWorkspaceTrust marks folder trusted when user answers y', async () => {
  await inTempWorkspace(async (ws) => {
    const configPath = join(ws, '.ruko', 'config.json');
    const asked: string[] = [];
    const io = {
      question: async (q: string) => {
        asked.push(q);
        return 'y';
      },
    };

    const trusted = await promptWorkspaceTrust(io, ws, configPath);
    assert.equal(trusted, true);
    assert.ok(asked.some((q) => q.includes('Percayai folder')));
    assert.equal(isWorkspaceTrusted(ws, configPath), true);
  });
});

test('promptWorkspaceTrust returns false and does not trust folder when user answers n', async () => {
  await inTempWorkspace(async (ws) => {
    const configPath = join(ws, '.ruko', 'config.json');
    const asked: string[] = [];
    const io = {
      question: async (q: string) => {
        asked.push(q);
        return 'n';
      },
    };

    const trusted = await promptWorkspaceTrust(io, ws, configPath);
    assert.equal(trusted, false);
    assert.ok(asked.some((q) => q.includes('Percayai folder')));
    assert.equal(isWorkspaceTrusted(ws, configPath), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L1 (audit v1.7.7, batch 2): RUKO_TRUST_FOLDER mem-bypass trust check tanpa
// log/warning. Bypass tetap ada (escape hatch CI) tetapi harus terlihat.
// ─────────────────────────────────────────────────────────────────────────────

test('L1: RUKO_TRUST_FOLDER mem-bypass trust check DENGAN warning eksplisit', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-trust-warn-'));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  const prev = process.env.RUKO_TRUST_FOLDER;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  };
  try {
    process.env.RUKO_TRUST_FOLDER = '1';
    assert.equal(isWorkspaceTrusted(ws), true, 'bypass tetap berfungsi');
    assert.equal(warnings.length, 1, 'harus ada tepat satu warning');
    assert.match(warnings[0], /RUKO_TRUST_FOLDER/);
    assert.match(warnings[0], /DILEWATI/);
  } finally {
    if (prev === undefined) delete process.env.RUKO_TRUST_FOLDER;
    else process.env.RUKO_TRUST_FOLDER = prev;
    console.warn = originalWarn;
    rmSync(ws, { recursive: true, force: true });
  }
});
