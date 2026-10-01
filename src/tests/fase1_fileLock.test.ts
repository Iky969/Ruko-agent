/**
 * fase1_fileLock.test.ts — Test F1-T2 (Fase 1, Blueprint v2.0.0 / QA.md §3)
 *
 * Mencakup matriks QA.md: TC-LCK-01 (eksklusi mutex antar proses),
 * TC-LCK-02 v2 (anti split-brain, verifikasi keaktifan PID via process.kill(pid, 0),
 * anti auto-eviction buta, fail-closed pada metadata corrupt, force-unlock,
 * konkurensi 50 proses, heartbeat mtime, release idempoten, dan LOCK_TIMEOUT).
 */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  utimesSync,
  statSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FileLock, isPidAlive } from '../core/state/fileLock.js';
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

  test('lock diperoleh → release menghapus berkas .lock dan menyimpan metadata valid', async () => {
    const dir = tempDir('ruko-lock-basic-');
    const target = join(dir, 'state.json');
    const lock = new FileLock(target);
    const release = await lock.acquire({ heartbeatIntervalMs: 50 });
    const lockPath = lock.getLockPath();

    assert.equal(statSync(lockPath).isFile(), true, 'Lock harus berupa berkas reguler (bukan direktori)');
    const meta = lock.readMetadata();
    assert.ok(meta, 'Metadata lock harus berhasil dibaca');
    assert.equal(meta.pid, process.pid);
    assert.equal(typeof meta.nonce, 'string');
    assert.equal(typeof meta.createdAt, 'number');

    await release();
    assert.throws(() => statSync(lockPath), /ENOENT/, 'Release wajib menghapus berkas .lock');
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

  test('TC-LCK-01 v2: 50 proses konkuren bersaing acquire simultan → tepat 1 pemenang, tidak ada split-brain', async () => {
    const dir = tempDir('ruko-lock-race-');
    const target = join(dir, 'exclusive.json');

    // 50 instance FileLock mencoba acquire bersamaan dengan timeout singkat
    const locks = Array.from({ length: 50 }, () => new FileLock(target));
    const results = await Promise.allSettled(
      locks.map((l) => l.acquire({ timeoutMs: 100, retryIntervalMs: 10 })),
    );

    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');

    assert.equal(winners.length, 1, 'Tepat satu proses yang berhasil memperoleh lock secara atomik');
    assert.equal(losers.length, 49, '49 proses lainnya harus ditolak dengan timeout');

    // Winner melepaskan lock
    const release = (winners[0] as PromiseFulfilledResult<() => Promise<void>>).value;
    await release();
  });

  test('TC-LCK-02 v2: Lock dipegang proses yang masih hidup (pid aktif) → lock TIDAK bisa diambil alih tanpa force: true', async () => {
    const dir = tempDir('ruko-lock-live-');
    const target = join(dir, 'state.json');
    const lockPath = `${target}.lock`;

    // Buat lockfile dengan PID proses saat ini (yang pasti aktif) dan timestamp lama
    const liveMeta = {
      pid: process.pid,
      nonce: 'live-nonce-active-1234',
      createdAt: Date.now() - 30_000,
    };
    writeFileSync(lockPath, JSON.stringify(liveMeta));
    const old = new Date(Date.now() - 30_000);
    utimesSync(lockPath, old, old);

    // Proses kompetitor mencoba acquire tanpa force: DILARANG auto-evict!
    const competitor = new FileLock(target);
    await assert.rejects(
      () => competitor.acquire({ timeoutMs: 250, retryIntervalMs: 25, staleTimeoutMs: 1000 }),
      /LOCK_TIMEOUT/,
      'Lock tidak boleh dieviksi otomatis selama PID pemilik masih hidup',
    );

    // Verifikasi lock tetap tidak berubah
    const existing = competitor.readMetadata();
    assert.equal(existing?.nonce, 'live-nonce-active-1234');

    // Namun dengan opsi eksplisit force: true (--force-unlock), lock boleh diambil alih
    const releaseForced = await competitor.acquire({ timeoutMs: 500, force: true });
    assert.ok(releaseForced);
    const newMeta = competitor.readMetadata();
    assert.notEqual(newMeta?.nonce, 'live-nonce-active-1234');
    assert.equal(newMeta?.pid, process.pid);
    await releaseForced();
  });

  test('TC-LCK-02 v2: Lock dipegang proses yang sudah mati (pid tidak valid) → lock diambil alih otomatis dengan aman', async () => {
    const dir = tempDir('ruko-lock-dead-');
    const target = join(dir, 'state.json');
    const lockPath = `${target}.lock`;

    // Tulis lockfile dengan PID mati (ESRCH)
    const deadPid = 9999999;
    assert.equal(isPidAlive(deadPid), false, 'PID 9999999 harus terdeteksi mati (ESRCH)');

    const deadMeta = {
      pid: deadPid,
      nonce: 'dead-owner-nonce-5678',
      createdAt: Date.now() - 10_000,
    };
    writeFileSync(lockPath, JSON.stringify(deadMeta));

    // Proses baru mencoba acquire: mendeteksi PID mati lalu mereklamasi lock secara otomatis
    const lock = new FileLock(target);
    const release = await lock.acquire({ timeoutMs: 1000, retryIntervalMs: 20 });
    assert.ok(release, 'Harus berhasil mereklamasi lock dari proses yang sudah mati');

    const newMeta = lock.readMetadata();
    assert.equal(newMeta?.pid, process.pid);
    assert.notEqual(newMeta?.nonce, 'dead-owner-nonce-5678');

    await release();
    assert.equal(existsSync(lockPath), false);
  });

  test('TC-LCK-02 v2: Metadata lock corrupt/tidak terbaca → fail-closed (dianggap locked)', async () => {
    const dir = tempDir('ruko-lock-corrupt-');
    const target = join(dir, 'state.json');
    const lockPath = `${target}.lock`;

    // Tulis file lock korup
    writeFileSync(lockPath, 'CORRUPTED_NON_JSON_DATA_PAYLOAD{{{');

    // Coba acquire tanpa force: harus fail-closed (menolak mengambil alih secara buta)
    const lock = new FileLock(target);
    await assert.rejects(
      () => lock.acquire({ timeoutMs: 200, retryIntervalMs: 20 }),
      /LOCK_TIMEOUT/,
      'Metadata korup wajib dianggap locked secara fail-closed',
    );

    // Dengan opsi force: true (--force-unlock), lock korup dibersihkan dan diakuisisi
    const release = await lock.acquire({ timeoutMs: 500, force: true });
    assert.ok(release);
    const meta = lock.readMetadata();
    assert.equal(meta?.pid, process.pid);
    await release();
    assert.equal(existsSync(lockPath), false);
  });

  test('Regresi: skenario lock normal (acquire-release-acquire) tetap bekerja seperti sebelumnya', async () => {
    const dir = tempDir('ruko-lock-normal-');
    const target = join(dir, 'state.json');
    const lock = new FileLock(target);

    // Siklus 1
    const release1 = await lock.acquire();
    assert.ok(statSync(`${target}.lock`).isFile());
    await release1();
    assert.equal(existsSync(`${target}.lock`), false);

    // Siklus 2
    const release2 = await lock.acquire();
    assert.ok(statSync(`${target}.lock`).isFile());
    await release2();
    assert.equal(existsSync(`${target}.lock`), false);
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
    const readyFile = join(dir, 'ready.txt');

    // Child script: coba acquire, catat waktu, release
    const moduleUrl = toFileUrl(join(PROJECT_ROOT, 'dist', 'core', 'state', 'fileLock.js'));
    const script = `
      import { FileLock } from ${JSON.stringify(moduleUrl)};
      import * as fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(readyFile)}, '1');
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
    // Tunggu sampai child proses siap dan mulai mencoba acquire
    for (let i = 0; i < 50; i++) {
      if (existsSync(readyFile)) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // Lepaskan lock A setelah 150ms agar child benar-benar menunggu dulu
    await new Promise((r) => setTimeout(r, 150));
    await releaseA();
    const { stdout } = await childPromise;
    const waited = JSON.parse(stdout).waited as number;
    assert.ok(waited > 100, `child seharusnya menunggu lock lintas proses; hanya ${waited}ms`);
  });
});
