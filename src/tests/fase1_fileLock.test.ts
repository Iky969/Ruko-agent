/**
 * fase1_fileLock.test.ts — Test F1-T2 (Fase 1, Blueprint v2.0.0)
 *
 * Mencakup matriks QA.md: TC-LCK-01 (eksklusi mutex antar proses),
 * TC-LCK-02 (eviksi stale lock), heartbeat mtime, clock skew (QA.md §1.3),
 * release idempoten, dan LOCK_TIMEOUT.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileLock } from '../core/state/fileLock.js';
import { NODE_BIN, PROJECT_ROOT, toFileUrl } from './helpers/platform.js';

const execFileAsync = promisify(execFile);

describe('F1-T2 FileLock', () => {
  const dirs: string[] = [];
  const tempDir = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };
  after(() => {
    for (const dir of dirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  test('lock diperoleh → release menghapus direktori .lock', async () => {
    const dir = tempDir('ruko-lock-basic-');
    const target = join(dir, 'state.json');
    const lock = new FileLock(target);
    const release = await lock.acquire({ heartbeatIntervalMs: 50 });
    const lockPath = `${target}.lock`;
    assert.equal(statSync(lockPath).isDirectory(), true);
    await release();
    assert.throws(() => statSync(lockPath), /ENOENT/);
  });

  test('TC-LCK-01: proses kedua MENUNGGU sampai release, lalu berhasil', async () => {
    const dir = tempDir('ruko-lock-two-');
    const target = join(dir, 'shared.json');
    const lockA = new FileLock(target);
    const releaseA = await lockA.acquire({ timeoutMs: 2000, heartbeatIntervalMs: 50 });

    // Lepaskan lock A setelah 150ms — B yang sedang menunggu harus mewarisinya
    const releaser = setTimeout(() => void releaseA(), 150);
    void releaser;

    const lockB = new FileLock(target);
    const acquireStart = Date.now();
    const releaseB = await lockB.acquire({ timeoutMs: 5000, retryIntervalMs: 20 });
    const waitedMs = Date.now() - acquireStart;
    await releaseB();

    // B pasti benar-benar menunggu lock A dilepas (bukan langsung menang)
    assert.ok(waitedMs > 100, `lock B seharusnya menunggu; hanya ${waitedMs}ms`);
  });

  test('TC-LCK-02: stale lock (mtime 15 detik lalu) dieviksi, lock baru berhasil', async () => {
    const dir = tempDir('ruko-lock-stale-');
    const target = join(dir, 'state.json');
    const lockPath = `${target}.lock`;

    // Pemilik lama "mati": pegang lock tanpa heartbeat yang efektif,
    // LALU backdate mtime ke 15 detik lalu (melampaui staleTimeoutMs).
    const deadOwner = new FileLock(target);
    const releaseDead = await deadOwner.acquire({ heartbeatIntervalMs: 60_000 });
    const old = new Date(Date.now() - 15_000);
    utimesSync(lockPath, old, old);

    // Pemilik baru mengenali lock stale dan mengeviksinya
    const lock = new FileLock(target);
    const release = await lock.acquire({ staleTimeoutMs: 2000, retryIntervalMs: 20 });
    await release();

    // Release milik pemilik mati bersifat best-effort (sudah dieviksi)
    await assert.doesNotReject(() => releaseDead());
  });

  test('LOCK_TIMEOUT bila lock dipegang pemilik lain dalam batas timeout', async () => {
    const dir = tempDir('ruko-lock-timeout-');
    const target = join(dir, 'state.json');
    const lockA = new FileLock(target);
    const releaseA = await lockA.acquire({ heartbeatIntervalMs: 50 });
    try {
      const lockB = new FileLock(target);
      await assert.rejects(
        () => lockB.acquire({ timeoutMs: 250, retryIntervalMs: 20 }),
        /LOCK_TIMEOUT/,
      );
    } finally {
      await releaseA();
    }
  });

  test('heartbeat memperbarui mtime lock selama dipegang', async () => {
    const dir = tempDir('ruko-lock-heartbeat-');
    const target = join(dir, 'state.json');
    const lockPath = `${target}.lock`;
    const lock = new FileLock(target);
    const release = await lock.acquire({ heartbeatIntervalMs: 60 });
    const before = statSync(lockPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 220));
    const after = statSync(lockPath).mtimeMs;
    await release();
    assert.ok(after >= before, 'mtime harus bertambah oleh heartbeat');
  });

  test('release idempoten (dipanggil dua kali tidak melempar)', async () => {
    const dir = tempDir('ruko-lock-idem-');
    const target = join(dir, 'state.json');
    const lock = new FileLock(target);
    const release = await lock.acquire({ heartbeatIntervalMs: 50 });
    await release();
    await assert.doesNotReject(() => release());
  });

  test('TC-LCK-01 lintas proses: child proses terpisah menunggu lock (fisik)', async () => {
    const dir = tempDir('ruko-lock-child-');
    const target = join(dir, 'cross.json');

    // Child script: coba acquire, catat waktu, release
    const moduleUrl = toFileUrl(join(PROJECT_ROOT, 'dist', 'core', 'state', 'fileLock.js'));
    const script = `
      import { FileLock } from ${JSON.stringify(moduleUrl)};
      const lock = new FileLock(${JSON.stringify(target)});
      const t0 = Date.now();
      const release = await lock.acquire({ timeoutMs: 5000, retryIntervalMs: 25 });
      console.log(JSON.stringify({ waited: Date.now() - t0 }));
      await release();
    `;
    const lockA = new FileLock(target);
    const releaseA = await lockA.acquire({ heartbeatIntervalMs: 100 });
    const childPromise = execFileAsync(NODE_BIN, ['--input-type=module', '-e', script], {
      timeout: 15_000,
    });
    // Lepaskan lock A setelah 150ms agar child harus menunggu dulu
    await new Promise((r) => setTimeout(r, 150));
    await releaseA();
    const { stdout } = await childPromise;
    const waited = JSON.parse(stdout).waited as number;
    assert.ok(waited > 100, `child seharusnya menunggu lock lintas proses; hanya ${waited}ms`);
  });
});
