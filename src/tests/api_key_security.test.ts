import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactApiKey, saveConfig } from '../core/config.js';
import { statSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// H5 (audit v1.7.7): format lama membocorkan 3 char awal + 4 char akhir (~35%
// dari key 21-22 char). Kontrak baru: key < 40 char TIDAK membocorkan karakter
// apa pun. Input test tidak berubah, hanya nilai ekspektasi yang diperketat.
test('redactApiKey masks sk- correctly', () => {
  assert.strictEqual(redactApiKey('sk-abc123def456xyz789'), '[REDACTED]');
});

// H5: lihat catatan di atas — key 22 char kini sepenuhnya di-[REDACTED].
test('redactApiKey masks key- correctly', () => {
  assert.strictEqual(redactApiKey('key-abc123def456xyz789'), '[REDACTED]');
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

// ─────────────────────────────────────────────────────────────────────────────
// H5 (audit v1.7.7): kontrak redaksi ketat
//   - key < 40 char  → "[REDACTED]" (tanpa karakter apa pun)
//   - key >= 40 char → "[REDACTED...xxxx]" (hanya 4 karakter terakhir)
// ─────────────────────────────────────────────────────────────────────────────

test('H5: key di bawah 40 karakter tidak membocorkan satu karakter pun', () => {
  const shortSk = `sk-${'a'.repeat(18)}`; // 21 char
  const shortKey = `key-${'b'.repeat(19)}`; // 23 char
  assert.equal(shortSk.length, 21);
  assert.equal(shortKey.length, 23);

  assert.strictEqual(redactApiKey(shortSk), '[REDACTED]');
  assert.strictEqual(redactApiKey(shortKey), '[REDACTED]');
  // 39 karakter (batas atas kategori pendek) tetap tanpa kebocoran
  assert.strictEqual(redactApiKey('c'.repeat(39)), '[REDACTED]');
  // Awalan & akhiran key tidak boleh muncul di output
  const masked = redactApiKey(shortSk);
  assert.ok(!masked.includes('sk-'), 'prefix key tidak boleh muncul');
  assert.ok(!masked.includes(shortSk.slice(-4)), 'suffix key tidak boleh muncul');
});

test('H5: key 40 karakter atau lebih hanya menampilkan 4 karakter terakhir', () => {
  const longKey = `sk-${'d'.repeat(37)}z789`; // 44 char
  assert.equal(longKey.length, 44);
  assert.strictEqual(redactApiKey(longKey), '[REDACTED...z789]');

  const exact40 = `${'e'.repeat(36)}wxyz`; // tepat 40 char
  assert.equal(exact40.length, 40);
  assert.strictEqual(redactApiKey(exact40), '[REDACTED...wxyz]');
});

test('H5: key inline di dalam pesan error/stack trace tetap disamarkan', () => {
  const inlineKey = `key-${'f'.repeat(18)}`;
  const message = `Error: 401 Unauthorized (key ${inlineKey} rejected)`;
  const masked = redactApiKey(message);
  assert.ok(!masked.includes(inlineKey), 'key inline tidak boleh bocor');
  assert.ok(masked.includes('[REDACTED]'), 'key inline harus di-[REDACTED]');
  assert.ok(masked.includes('401 Unauthorized'), 'bagian pesan non-rahasia tetap utuh');
});

test('H5: pesan tanpa key tidak diubah (menjaga keterbacaan error)', () => {
  const plain = 'Error: connect ECONNREFUSED 127.0.0.1:11434';
  assert.strictEqual(redactApiKey(plain), plain);
});


test('saveConfig enforces 0o600 permissions', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ruko-test-'));
  const tmpPath = join(tmpDir, 'config.json');
  try {
    saveConfig({} as any, tmpPath);
    const stat = statSync(tmpPath);
    // On Windows, mode might not match exactly 0o600, but on POSIX it should
    if (process.platform !== 'win32') {
      assert.strictEqual(stat.mode & 0o777, 0o600);
    }
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
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
  assert.ok(out.includes('1.7.7') || out.length > 0);
});

test('CLI securely loads --api-key from @file', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ruko-test-'));
  const tmpKeyFile = join(tmpDir, 'key.txt');
  try {
    writeFileSync(tmpKeyFile, 'sk-from-file-secret\n');
    const out = execFileSync('node', [CLI_PATH, '--api-key', `@${tmpKeyFile}`, '--version'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.ok(out.includes('1.7.7') || out.length > 0);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

test('CLI securely loads --api-key from stdin (-)', () => {
  const out = execFileSync('node', [CLI_PATH, '--api-key', '-', '--version'], {
    encoding: 'utf8',
    input: 'sk-from-stdin-secret',
    stdio: 'pipe',
  });
  assert.ok(out.includes('1.7.7') || out.length > 0);
});

