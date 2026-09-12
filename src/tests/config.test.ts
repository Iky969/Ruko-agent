import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, saveConfig } from '../core/config.js';
import { DEFAULT_CONFIG } from '../types.js';

test('loadConfig returns defaults when the file is missing', () => {
  const config = loadConfig(join(mkdtempSync(join(tmpdir(), 'ruko-')), 'nope.json'));
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test('loadConfig merges a config file over the defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-'));
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({ maxLogChars: 500, approvalEnabled: false, model: 'custom-model' }),
    'utf8',
  );
  const config = loadConfig(path);
  assert.equal(config.maxLogChars, 500);
  assert.equal(config.approvalEnabled, false);
  assert.equal(config.model, 'custom-model');
  assert.equal(config.maxContextChars, DEFAULT_CONFIG.maxContextChars);
  rmSync(dir, { recursive: true, force: true });
});

test('saveConfig round-trips and sets 0600 mode (M2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-'));
  const path = join(dir, 'config.json');
  saveConfig({ ...DEFAULT_CONFIG, execTimeoutMs: 5000, funAnimations: false }, path);
  const config = loadConfig(path);
  assert.equal(config.execTimeoutMs, 5000);
  assert.equal(config.funAnimations, false);
  if (process.platform !== 'win32') {
    const stat = (await import('node:fs')).statSync(path);
    assert.equal(stat.mode & 0o777, 0o600, 'config file must have 0600 permissions');
  }
  rmSync(dir, { recursive: true, force: true });
});

test('sanitizeConfigFile validates types and clamps values (M1 schema validation)', async () => {
  const { sanitizeConfigFile } = await import('../core/config.js');
  const dirty = {
    maxLogChars: -50,
    maxContextChars: 'invalid',
    execTimeoutMs: 10_000_000,
    approvalEnabled: 'not-bool',
    approvalAllowlist: ['  valid-cmd  ', '', '   ', 123, 'another-cmd'],
    guardianTimeoutMs: -100,
  };
  const clean = sanitizeConfigFile(dirty);
  assert.equal(clean.maxLogChars, undefined, 'negative maxLogChars should be dropped');
  assert.equal(clean.maxContextChars, undefined, 'string maxContextChars should be dropped');
  assert.equal(clean.execTimeoutMs, 3_600_000, 'oversized timeout should be clamped');
  assert.equal(clean.approvalEnabled, undefined, 'non-boolean approvalEnabled should be dropped');
  assert.deepEqual(clean.approvalAllowlist, ['valid-cmd', 'another-cmd'], 'empty or non-string items filtered');
  assert.equal(clean.guardianTimeoutMs, undefined, 'negative guardian timeout should be dropped');
});

test('sanitizeConfigFile rejects insecure remote HTTP baseUrl (H3 exfiltration defense)', async () => {
  const { sanitizeConfigFile } = await import('../core/config.js');
  // Localhost HTTP is allowed (e.g. Ollama, LM Studio)
  assert.equal(
    sanitizeConfigFile({ baseUrl: 'http://localhost:11434/v1' }).baseUrl,
    'http://localhost:11434/v1',
  );
  assert.equal(
    sanitizeConfigFile({ baseUrl: 'http://127.0.0.1:8000/v1' }).baseUrl,
    'http://127.0.0.1:8000/v1',
  );
  // HTTPS remote is allowed
  assert.equal(
    sanitizeConfigFile({ baseUrl: 'https://api.openai.com/v1' }).baseUrl,
    'https://api.openai.com/v1',
  );
  // Insecure remote HTTP is dropped
  assert.equal(
    sanitizeConfigFile({ baseUrl: 'http://evil-attacker.com/v1' }).baseUrl,
    undefined,
    'insecure remote HTTP baseUrl must be dropped',
  );
  // Invalid URL string is dropped
  assert.equal(
    sanitizeConfigFile({ baseUrl: 'not a url' }).baseUrl,
    undefined,
  );
});