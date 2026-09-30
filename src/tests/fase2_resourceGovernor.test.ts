/**
 * fase2_resourceGovernor.test.ts — Test Isolasi Subproses & Resource Governor
 *
 * Menguji:
 *  - TC-GOV-01: Timeout subprocess membunuh hierarki proses (SIGKILL)
 *  - TC-GOV-02: Pembersihan NODE_OPTIONS, NODE_PATH, LD_PRELOAD
 *  - DX PATH Sanitization: Direktori toolchain diizinkan, traversal .. ditolak
 *  - Penanganan batas buffer output (RESOURCE_OVERFLOW)
 *  - Eksekusi normal subprocess terisolasi
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildIsolatedEnv,
  sanitizePathEnv,
  spawnIsolated,
} from '../core/executor/resourceGovernor.js';

describe('Resource Governor Subprocess Isolation', () => {
  test('TC-GOV-02: process.env.NODE_OPTIONS dan variabel injeksi kode dihapus dari sandbox', () => {
    process.env.NODE_OPTIONS = '--require /tmp/malicious.js';
    process.env.NODE_PATH = '/tmp/malicious-modules';
    process.env.LD_PRELOAD = '/tmp/hook.so';
    process.env.DYLD_INSERT_LIBRARIES = '/tmp/hook.dylib';

    const env = buildIsolatedEnv();
    assert.equal(env.NODE_OPTIONS, undefined, 'NODE_OPTIONS wajib dihapus');
    assert.equal(env.NODE_PATH, undefined, 'NODE_PATH wajib dihapus');
    assert.equal(env.LD_PRELOAD, undefined, 'LD_PRELOAD wajib dihapus');
    assert.equal(env.DYLD_INSERT_LIBRARIES, undefined, 'DYLD_INSERT_LIBRARIES wajib dihapus');
    assert.equal(env.RUKO_ENFORCED, '1', 'RUKO_ENFORCED penanda sandbox harus aktif');

    delete process.env.NODE_OPTIONS;
    delete process.env.NODE_PATH;
    delete process.env.LD_PRELOAD;
    delete process.env.DYLD_INSERT_LIBRARIES;
  });

  test('TC-GOV-02 di subprocess nyata: proses anak tidak dapat mengakses NODE_OPTIONS', async () => {
    process.env.NODE_OPTIONS = '--expose-internals';
    const script = 'console.log(JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS || null }));';
    const result = await spawnIsolated(process.execPath, ['-e', script], process.cwd(), {
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.nodeOptions, null, 'Subprocess harus membaca NODE_OPTIONS sebagai null/undefined');
    delete process.env.NODE_OPTIONS;
  });

  test('TC-GOV-01: Eksekusi subprocess yang melebihi timeout dibunuh dengan RESOURCE_TIMEOUT', async () => {
    const t0 = Date.now();
    const script = 'setTimeout(() => {}, 10000);';
    await assert.rejects(
      () =>
        spawnIsolated(process.execPath, ['-e', script], process.cwd(), {
          timeoutMs: 250,
        }),
      (err: Error) => {
        assert.ok(err.message.includes('RESOURCE_TIMEOUT'));
        return true;
      },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `Proses harus dibunuh cepat (<2s), memakan waktu: ${elapsed}ms`);
  });

  test('Output proses melebihi batas (RESOURCE_OVERFLOW) memutus stream seketika', async () => {
    const script = 'for (let i = 0; i < 5000; i++) process.stdout.write("A".repeat(100));';
    await assert.rejects(
      () =>
        spawnIsolated(process.execPath, ['-e', script], process.cwd(), {
          maxOutputBytes: 1024, // 1 KB limit
          timeoutMs: 5000,
        }),
      (err: Error) => {
        assert.ok(err.message.includes('RESOURCE_OVERFLOW'));
        return true;
      },
    );
  });

  test('DX-Preserving PATH: sanitasi menyaring traversal ".." dan menjaga direktori sah', () => {
    const rawPath = ['/usr/bin', '/tmp/../etc/bad', '/home/user/.nvm/versions/node/v20/bin'].join(':');
    const sanitized = sanitizePathEnv(rawPath);
    assert.ok(sanitized.includes('/usr/bin'));
    assert.ok(sanitized.includes('.nvm'));
    assert.equal(sanitized.includes('..'), false, 'Traversal ".." wajib disaring');
  });

  test('spawnIsolated berhasil menjalankan proses aman dan mengumpulkan stdout/exitCode', async () => {
    const result = await spawnIsolated(
      process.execPath,
      ['-e', 'console.log("hello isolated");'],
      process.cwd(),
      { timeoutMs: 5000 },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'hello isolated');
    assert.equal(result.stderr, '');
  });
});
