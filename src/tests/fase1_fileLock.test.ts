/**
 * F1-T2 — FileLock: mutex atomik `fs.mkdir` + heartbeat mtime.
 *
 * Matriks acuan: QA.md §1.3 dan TC-LCK-01 / TC-LCK-02.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { FileLock, LockTimeoutError } from '../core/state/fileLock.js';

const tempRoots: string[] = [];

async function makeTarget(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'ruko-lock-'));
  tempRoots.push(dir);
  return join(dir, 'state.json');
}

after(async () => {
  for (const dir of tempRoots) await fs.rm(dir, { recursive: true, force: true });
});

/** Tunggu sampai `predicate` benar-benar terpenuhi. */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor: kondisi tidak terpenuhi dalam batas waktu');
}

describe('F1-T2 FileLock — akuisisi & pelepasan', () => {
  test('lock dibuat sebagai direktori di samping target dan hilang setelah dilepas', async () => {
    const target = await makeTarget();
    const lock = new FileLock(target);
    const release = await lock.acquire();

    assert.equal(lock.path, `${target}.lock`);
    assert.equal((await fs.stat(lock.path)).isDirectory(), true);
    assert.equal(lock.status.held, true);

    await release();
    await assert.rejects(fs.stat(lock.path), 'direktori lock harus hilang setelah dilepas');
    assert.equal(lock.status.held, false);
  });

  test('pelepasan bersifat idempoten (finally ganda aman)', async () => {
    const target = await makeTarget();
    const lock = new FileLock(target);
    const release = await lock.acquire();
    await release();
    await release();
    assert.equal(lock.status.held, false);
  });

  test('tryAcquire mengembalikan null saat lock dipegang proses lain', async () => {
    const target = await makeTarget();
    const holder = new FileLock(target);
    const release = await holder.acquire();
    try {
      const other = new FileLock(target);
      assert.equal(await other.tryAcquire(), null);
    } finally {
      await release();
    }
    // Setelah dilepas, lock bisa diambil lagi.
    const again = new FileLock(target);
    const release2 = await again.tryAcquire();
    assert.notEqual(release2, null);
    await release2!();
  });

  test('timeout memunculkan LockTimeoutError dengan kode yang stabil', async () => {
    const target = await makeTarget();
    const holder = new FileLock(target);
    const release = await holder.acquire();
    try {
      const other = new FileLock(target, { timeoutMs: 120, retryIntervalMs: 20 });
      await assert.rejects(
        other.acquire(),
        (err: unknown) => err instanceof LockTimeoutError && err.code === 'LOCK_TIMEOUT',
      );
    } finally {
      await release();
    }
  });
});

describe('F1-T2 FileLock — heartbeat & deteksi stale', () => {
  test('heartbeat memperbarui mtime direktori lock secara periodik', async () => {
    const target = await makeTarget();
    const lock = new FileLock(target, { heartbeatIntervalMs: 25, unrefHeartbeat: false });
    const release = await lock.acquire();
    try {
      const first = (await fs.stat(lock.path)).mtimeMs;
      await waitFor(async () => (await fs.stat(lock.path)).mtimeMs > first, 3000);
    } finally {
      await release();
    }
  });

  test('TC-LCK-02: lock basi (mtime 15 detik lalu) dievakuasi paksa', async () => {
    const target = await makeTarget();
    const lockDir = `${target}.lock`;
    await fs.mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 15_000);
    await fs.utimes(lockDir, old, old);

    const lock = new FileLock(target, { timeoutMs: 1000, staleTimeoutMs: 8000 });
    const release = await lock.acquire();
    try {
      assert.equal(lock.status.held, true);
      assert.equal((await fs.stat(lockDir)).isDirectory(), true);
    } finally {
      await release();
    }
  });

  test('lock yang masih hidup tidak direbut', async () => {
    const target = await makeTarget();
    const lockDir = `${target}.lock`;
    await fs.mkdir(lockDir, { recursive: true });

    const lock = new FileLock(target, { timeoutMs: 100, retryIntervalMs: 10, staleTimeoutMs: 8000 });
    await assert.rejects(lock.acquire(), LockTimeoutError);
    await fs.rm(lockDir, { recursive: true, force: true });
  });

  test('clock skew: mtime di masa depan dalam grace period dianggap masih hidup', () => {
    const lock = new FileLock('/tmp/ruko-skew-probe');
    const grace = 2000;
    // Jam pemilik lock 1 detik lebih maju — masih di bawah grace period.
    assert.equal(lock.computeAgeMs(Date.now() + 1000, grace), 0);
    // Selisih jauh melampaui grace period: dianggap basi agar tidak membekukan lock.
    assert.equal(lock.computeAgeMs(Date.now() + 60_000, grace), Number.POSITIVE_INFINITY);
    // Waktu normal: usia biasa.
    const age = lock.computeAgeMs(Date.now() - 3000, grace);
    assert.ok(age >= 2900 && age <= 6000, `usia tak terduga: ${age}`);
  });

  test('heartbeat yang gagal berulang: ada peringatan lalu lock ditinggalkan (QA §1.3)', async () => {
    const target = await makeTarget();
    const warnings: string[] = [];
    const lock = new FileLock(target, {
      heartbeatIntervalMs: 20,
      maxHeartbeatFailures: 3,
      unrefHeartbeat: false,
      warn: (m) => warnings.push(m),
    });
    const release = await lock.acquire();

    // Simulasikan kegagalan heartbeat: direktori lock dihapus di belakang
    // punggung sehingga `fs.utimes` akan selalu ENOENT.
    await fs.rm(lock.path, { recursive: true, force: true });

    await waitFor(() => lock.status.abandoned, 5000);

    assert.ok(warnings.length >= 3, `peringatan heartbeat kurang: ${warnings.length}`);
    assert.ok(
      warnings.some((w) => w.includes('Heartbeat lock gagal')),
      warnings.join(' | '),
    );
    assert.ok(warnings.some((w) => w.includes('ditinggalkan')), warnings.join(' | '));
    assert.equal(lock.status.heartbeatFailures, 3);

    await release();
  });
});

describe('F1-T2 FileLock — TC-LCK-01 (eksklusivitas lintas proses)', () => {
  test('proses kedua harus menunggu lalu pemilik pertama melepas', async () => {
    const target = await makeTarget();
    const lockPath = `${target}.lock`;

    // Skrip anak: ambil lock, beri tahu lewat stdout, tahan 600ms, lalu lepas.
    const script = `
      const { FileLock } = await import(${JSON.stringify(new URL('../core/state/fileLock.js', import.meta.url).href)});
      const lock = new FileLock(${JSON.stringify(target)}, { heartbeatIntervalMs: 50 });
      const release = await lock.acquire();
      process.stdout.write('LOCKED\\n');
      await new Promise((r) => setTimeout(r, 600));
      await release();
      process.stdout.write('RELEASED\\n');
    `;

    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    await waitFor(() => {
      stdout += child.stdout?.read()?.toString() ?? '';
      return stdout.includes('LOCKED');
    }, 10_000);

    // Selama anak memegang lock, proses ini tidak boleh bisa mengambilnya.
    const blocked = new FileLock(target, { timeoutMs: 150, retryIntervalMs: 25, staleTimeoutMs: 30_000 });
    await assert.rejects(blocked.acquire(), LockTimeoutError);

    // Tunggu anak selesai melepas.
    await new Promise<void>((resolve) => child.on('close', () => resolve()));

    // Sekarang lock harus bisa diambil.
    const after = new FileLock(target, { timeoutMs: 2000 });
    const release = await after.acquire();
    assert.equal((await fs.stat(lockPath)).isDirectory(), true);
    await release();
  });
});
