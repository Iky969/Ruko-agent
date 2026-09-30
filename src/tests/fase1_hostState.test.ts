/**
 * F1-T3 — Dual-plane host state: `~/.ruko/sessions/<id>/state.json` mode 0600,
 * penulisan atomik, backoff Win32, dan invarian fail-safe resume.
 *
 * Semua state diuji terhadap `baseDir` sementara — modul ini tidak pernah
 * menyentuh `~/.ruko` milik pengguna saat pengujian.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  computeBackoffDelay,
  createInitialState,
  loadHostState,
  planProjectionPath,
  readPlanProjection,
  saveHostState,
  validateSessionId,
  writePlanProjection,
  type HostState,
} from '../core/state/hostState.js';

const IS_WIN = process.platform === 'win32';
const tempRoots: string[] = [];
const silentWarn = (): void => undefined;

async function makeStore(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'ruko-state-'));
  tempRoots.push(dir);
  return dir;
}

function actState(sessionId: string): HostState {
  return {
    sessionId,
    mode: 'act',
    activePlanHash: 'plan-hash-abc',
    approvalScope: {
      planHash: 'plan-hash-abc',
      allowedPaths: ['src/'],
      approvedAt: '2026-09-30T00:00:00.000Z',
      correlationId: 'corr-1',
    },
    sessionTokenHash: 'token-hash',
    updatedAt: '2026-09-30T00:00:00.000Z',
  };
}

after(async () => {
  for (const dir of tempRoots) await fs.rm(dir, { recursive: true, force: true });
});

describe('F1-T3 hostState — identifikasi sesi & state awal', () => {
  test('sessionId traversal / malformed ditolak', () => {
    for (const bad of ['', '..', '../evil', 'a/b', 'a\\b', 'x'.repeat(65), 'sess ion']) {
      assert.throws(() => validateSessionId(bad), /SESSION_ID_INVALID/, bad);
    }
    for (const good of ['a', 'sess-1', 'A_b-9', 'x'.repeat(64)]) {
      assert.doesNotThrow(() => validateSessionId(good), good);
    }
  });

  test('state awal selalu deny-by-default: mode plan, tanpa scope', () => {
    const state = createInitialState('s1');
    assert.equal(state.mode, 'plan');
    assert.equal(state.approvalScope, null);
    assert.equal(state.activePlanHash, null);
    // Token sesi disimpan sebagai hash, bukan mentah.
    assert.match(state.sessionTokenHash, /^[0-9a-f]{64}$/);
    assert.notEqual(createInitialState('s1').sessionTokenHash, state.sessionTokenHash);
  });

  test('backoff Win32 naik eksponensial dan dibatasi per platform', () => {
    assert.deepEqual(
      [0, 1, 2, 3].map(computeBackoffDelay),
      [10, 20, 40, 80],
    );
  });
});

describe('F1-T3 hostState — izin berkas & penulisan atomik', () => {
  test('state.json ditulis 0600 di direktori 0700, tanpa sisa berkas temp', async (t) => {
    const baseDir = await makeStore();
    await saveHostState(createInitialState('perm'), { baseDir, warn: silentWarn });

    const dir = join(baseDir, 'perm');
    const statePath = join(dir, 'state.json');
    const entries = await fs.readdir(dir);
    assert.deepEqual(entries, ['state.json'], 'berkas temp harus dipromosikan lewat rename');

    if (IS_WIN) {
      t.skip('mode POSIX tidak berlaku di Win32');
      return;
    }
    assert.equal((await fs.stat(statePath)).mode & 0o777, 0o600, 'state.json wajib 0600');
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700, 'direktori sesi wajib 0700');
  });

  test('penulisan berulang menimpa lewat rename, bukan menumpuk', async () => {
    const baseDir = await makeStore();
    const state = createInitialState('rewrite');
    await saveHostState(state, { baseDir, warn: silentWarn });
    state.mode = 'act';
    await saveHostState(state, { baseDir, warn: silentWarn });

    const raw = JSON.parse(await fs.readFile(join(baseDir, 'rewrite', 'state.json'), 'utf8'));
    assert.equal(raw.mode, 'act');
    assert.deepEqual(await fs.readdir(join(baseDir, 'rewrite')), ['state.json']);
  });

  test('rename EPERM di Win32 di-retry dengan backoff lalu berhasil', async () => {
    const baseDir = await makeStore();
    const sleeps: number[] = [];
    let attempts = 0;
    // Seam menyimulasikan antivirus/indexer Win32 yang menahan rename dua kali.
    const renameFn = async (from: string, to: string): Promise<void> => {
      attempts += 1;
      if (attempts <= 2) {
        const err: NodeJS.ErrnoException = new Error('resource busy');
        err.code = 'EPERM';
        throw err;
      }
      await fs.rename(from, to);
    };

    await saveHostState(createInitialState('winretry'), {
      baseDir,
      isWindows: true,
      renameFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      warn: silentWarn,
    });

    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [10, 20], 'backoff harus eksponensial: 10ms lalu 20ms');
    assert.deepEqual(
      await fs.readdir(join(baseDir, 'winretry')),
      ['state.json'],
      'rename yang berhasil harus menyelesaikan promosi state tanpa sisa temp',
    );
  });

  test('rename yang gagal dengan kode non-retryable langsung dilempar & temp dibersihkan', async () => {
    const baseDir = await makeStore();
    const renameFn = async (): Promise<void> => {
      const err: NodeJS.ErrnoException = new Error('disk full');
      err.code = 'ENOSPC';
      throw err;
    };

    await assert.rejects(
      saveHostState(createInitialState('fail'), {
        baseDir,
        isWindows: true,
        maxRenameAttempts: 4,
        renameFn: renameFn as unknown as (a: string, b: string) => Promise<void>,
        sleep: async () => undefined,
        warn: silentWarn,
      }),
      /ENOSPC|disk full/,
    );
    assert.deepEqual(await fs.readdir(join(baseDir, 'fail')), [], 'temp harus dihapus saat gagal');
  });
});

describe('F1-T3 hostState — fail-safe resume reset', () => {
  test('state `act` + scope yang di-resume SELALU kembali ke plan dan scope dibuang', async () => {
    const baseDir = await makeStore();
    await saveHostState(actState('resume'), { baseDir, warn: silentWarn });

    const loaded = await loadHostState('resume', { baseDir, warn: silentWarn });
    assert.equal(loaded.mode, 'plan', 'resume tidak boleh mewarisi mode act');
    assert.equal(loaded.approvalScope, null, 'scope tidak boleh diwarisi setelah resume');

    // Reset harus PERSISTEN, bukan hanya di memori.
    const raw = JSON.parse(await fs.readFile(join(baseDir, 'resume', 'state.json'), 'utf8'));
    assert.equal(raw.mode, 'plan');
    assert.equal(raw.approvalScope, null);
  });

  test('state `plan` dimuat apa adanya (tanpa perlu menulis ulang yang sama)', async () => {
    const baseDir = await makeStore();
    const initial = createInitialState('steady');
    await saveHostState(initial, { baseDir, warn: silentWarn });
    const before = (await fs.stat(join(baseDir, 'steady', 'state.json'))).mtimeMs;

    const loaded = await loadHostState('steady', { baseDir, warn: silentWarn });
    assert.equal(loaded.mode, 'plan');
    assert.equal(loaded.sessionTokenHash, initial.sessionTokenHash);

    await new Promise((r) => setTimeout(r, 20));
    const after = (await fs.stat(join(baseDir, 'steady', 'state.json'))).mtimeMs;
    assert.equal(after, before, 'state plan yang sehat tidak perlu ditulis ulang');
  });

  test('sesi tanpa state berkas dibuat baru dalam mode plan', async () => {
    const baseDir = await makeStore();
    const loaded = await loadHostState('brandnew', { baseDir, warn: silentWarn });
    assert.equal(loaded.mode, 'plan');
    assert.equal(loaded.approvalScope, null);
    assert.equal((await fs.readdir(join(baseDir, 'brandnew'))).length, 1);
  });

  test('state.json rusak dikarantina, bukan ditelan diam-diam', async () => {
    const baseDir = await makeStore();
    const dir = join(baseDir, 'corrupt');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'state.json'), '{ ini bukan json', 'utf8');
    const warnings: string[] = [];

    const loaded = await loadHostState('corrupt', { baseDir, warn: (m) => warnings.push(m) });
    assert.equal(loaded.mode, 'plan', 'harus mulai ulang deny-by-default');
    assert.match(loaded.sessionTokenHash, /^[0-9a-f]{64}$/);
    assert.ok(warnings.some((w) => w.includes('dikarantina')), warnings.join(' | '));

    const files = await fs.readdir(dir);
    assert.ok(files.some((f) => f.startsWith('state.corrupt.')), `karantina hilang: ${files}`);
    assert.ok(files.includes('state.json'), 'state baru harus ditulis');
  });

  test('bentuk state tak valid (mode ngawur, scope bukan objek) diluruskan ke plan', async () => {
    const baseDir = await makeStore();
    const dir = join(baseDir, 'weird');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        sessionId: 'weird',
        mode: 'yolo',
        approvalScope: 'bukan-objek',
        sessionTokenHash: 'abc',
      }),
      'utf8',
    );

    const loaded = await loadHostState('weird', { baseDir, warn: silentWarn });
    assert.equal(loaded.mode, 'plan');
    assert.equal(loaded.approvalScope, null);
    assert.equal(loaded.activePlanHash, null);
    assert.equal(loaded.sessionTokenHash, 'abc');
  });

  test('sessionTokenHash kosong ditolak sebagai bentuk tidak valid', async () => {
    const baseDir = await makeStore();
    const dir = join(baseDir, 'notoken');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'state.json'), JSON.stringify({ sessionId: 'notoken' }), 'utf8');

    const loaded = await loadHostState('notoken', { baseDir, warn: silentWarn });
    assert.match(loaded.sessionTokenHash, /^[0-9a-f]{64}$/);
  });
});

describe('F1-T3 hostState — proyeksi baca di dalam workspace', () => {
  test('proyeksi ditulis 0400 dan hanya memuat ringkasan (bukan otorisasi)', async (t) => {
    const baseDir = await makeStore();
    const workspace = await makeStore();
    const state = actState('proj');
    await saveHostState(state, { baseDir, warn: silentWarn });

    const projection = await writePlanProjection(workspace, state);
    assert.equal(projection, planProjectionPath(workspace));

    const payload = await readPlanProjection(workspace);
    assert.deepEqual(payload?.allowedPaths, ['src/']);
    assert.equal(payload?.authority, 'host:~/.ruko/sessions');

    // Proyeksi tidak boleh memuat token sesi.
    assert.equal(JSON.stringify(payload).includes('token-hash'), false);

    if (!IS_WIN) {
      assert.equal((await fs.stat(projection)).mode & 0o777, 0o400, 'proyeksi wajib baca-saja');
    } else {
      t.skip('mode POSIX tidak berlaku di Win32');
    }
  });

  test('proyeksi yang hilang terbaca null, bukan melempar', async () => {
    const workspace = await makeStore();
    assert.equal(await readPlanProjection(workspace), null);
  });
});
