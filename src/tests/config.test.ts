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

test('saveConfig round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-'));
  const path = join(dir, 'config.json');
  saveConfig({ ...DEFAULT_CONFIG, execTimeoutMs: 5000, funAnimations: false }, path);
  const config = loadConfig(path);
  assert.equal(config.execTimeoutMs, 5000);
  assert.equal(config.funAnimations, false);
  rmSync(dir, { recursive: true, force: true });
});