import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactApiKey, saveConfig } from '../core/config.js';
import { statSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

const PROJECT_ROOT = join(import.meta.dirname, '..', '..');
const CLI_PATH = join(PROJECT_ROOT, 'dist', 'index.js');

test('CLI blocks raw literal --api-key without --insecure-api-key', () => {
  try {
    execFileSync('node', [CLI_PATH, '--api-key', 'sk-literal-secret', '--version'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.fail('Should have exited with error code 1');
  } catch (err: any) {
    assert.strictEqual(err.status, 1);
    const stderr = err.stderr?.toString() ?? '';
    assert.ok(stderr.includes('KEAMANAN') || stderr.includes('--insecure-api-key'));
  }
});

test('CLI accepts literal --api-key when --insecure-api-key is supplied', () => {
  const out = execFileSync('node', [CLI_PATH, '--api-key', 'sk-literal-secret', '--insecure-api-key', '--version'], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  assert.ok(out.includes('1.7.6') || out.length > 0);
});

test('CLI securely loads --api-key from @file', () => {
  const tmpKeyFile = join(tmpdir(), `ruko-test-key-${Date.now()}.txt`);
  try {
    writeFileSync(tmpKeyFile, 'sk-from-file-secret\n');
    const out = execFileSync('node', [CLI_PATH, '--api-key', `@${tmpKeyFile}`, '--version'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.ok(out.includes('1.7.6') || out.length > 0);
  } finally {
    try { unlinkSync(tmpKeyFile); } catch {}
  }
});

test('CLI securely loads --api-key from stdin (-)', () => {
  const out = execFileSync('node', [CLI_PATH, '--api-key', '-', '--version'], {
    encoding: 'utf8',
    input: 'sk-from-stdin-secret',
    stdio: 'pipe',
  });
  assert.ok(out.includes('1.7.6') || out.length > 0);
});

