import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactApiKey, saveConfig } from '../core/config.js';
import { statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('redactApiKey masks sk- correctly', () => {
  assert.strictEqual(redactApiKey('sk-abc123def456xyz789'), 'sk-***z789');
});

test('redactApiKey masks key- correctly', () => {
  assert.strictEqual(redactApiKey('key-abc123def456xyz789'), 'key***z789');
});

test('redactApiKey leaves short strings unchanged', () => {
  assert.strictEqual(redactApiKey('short'), 'short');
  assert.strictEqual(redactApiKey('sk-short'), 'sk-short');
});

test('redactApiKey handles empty/null-like inputs', () => {
  assert.strictEqual(redactApiKey(''), '');
  assert.strictEqual(redactApiKey(null as any), '');
  assert.strictEqual(redactApiKey(undefined as any), '');
});

test('saveConfig enforces 0o600 permissions', () => {
  const tmpPath = join(tmpdir(), `ruko-test-config-${Date.now()}.json`);
  try {
    saveConfig({} as any, tmpPath);
    const stat = statSync(tmpPath);
    // On Windows, mode might not match exactly 0o600, but on POSIX it should
    if (process.platform !== 'win32') {
      assert.strictEqual(stat.mode & 0o777, 0o600);
    }
  } finally {
    try { rmSync(tmpPath); } catch {}
  }
});
