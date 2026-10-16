/**
 * scope_session_lock.test.ts — Issue #38-4
 *
 * Kontrak kepemilikan sessionLock pada mutasi state scope:
 *  - Mutasi load → apply → save harus berada di bawah kepemilikan lock yang
 *    sama: nonce divalidasi di entry, tepat sebelum saveHostState, dan
 *    sesudahnya (bukan hanya sekali di depan).
 *  - Stale nonce (lock sudah dilepas) → SCOPE_LOCK_DENIED, tanpa menulis state.
 *  - Fallback tanpa sessionLock tidak membangun FileLock kedua di atas
 *    state.json yang sudah dipegang pipeline (potensi split-brain): gagal cepat
 *    SCOPE_LOCK_DENIED, bukan menunggu LOCK_TIMEOUT 5 detik.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { ScopeAmendmentManager } from '../core/approval/scopeAmendment.js';
import { FileLock } from '../core/state/fileLock.js';
import { loadHostState, saveHostState, type HostState } from '../core/state/hostState.js';

const tempDirs: string[] = [];

function setup(): { ws: string; hostDir: string } {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-issue38-lock-ws-'));
  const hostDir = mkdtempSync(join(tmpdir(), 'ruko-issue38-lock-host-'));
  tempDirs.push(ws, hostDir);
  process.env.RUKO_HOST_STATE_DIR = hostDir;
  mkdirSync(join(ws, 'src'), { recursive: true });
  return { ws, hostDir };
}

function makeState(sessionId: string): HostState {
  return {
    sessionId,
    mode: 'act',
    activePlanHash: 'hash-issue38',
    approvalScope: {
      planHash: 'hash-issue38',
      allowedPaths: ['src'],
      approvedAt: new Date().toISOString(),
      correlationId: 'corr-issue38',
    },
    sessionTokenHash: 'token-issue38',
    updatedAt: new Date().toISOString(),
  };
}

after(() => {
  delete process.env.RUKO_HOST_STATE_DIR;
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe('Issue #38-4: kontrak nonce sessionLock pada mutasi scope', () => {
  test('control: lock masih dipegang → allowPath sukses dan tersimpan ke disk', async () => {
    const { ws, hostDir } = setup();
    const state = makeState('sess-issue38-ok');
    await saveHostState(state);
    const lock = new FileLock(join(hostDir, state.sessionId, 'state.json'));
    const release = await lock.acquire();
    try {
      const manager = new ScopeAmendmentManager(state, ws, { isTTY: false, sessionLock: lock });
      const updated = await manager.allowPath('src/extra');
      assert.equal(updated, true, 'allowPath harus sukses selama lock dipegang');
      const fresh = await loadHostState(state.sessionId, { resume: false });
      assert.ok(
        fresh.approvalScope?.allowedPaths.includes('src/extra'),
        'scope harus tersimpan di disk',
      );
    } finally {
      await release();
    }
  });

  test('stale nonce (lock sudah dilepas) → SCOPE_LOCK_DENIED tanpa menulis state', async () => {
    const { ws, hostDir } = setup();
    const state = makeState('sess-issue38-stale');
    await saveHostState(state);
    const lock = new FileLock(join(hostDir, state.sessionId, 'state.json'));
    const release = await lock.acquire();
    await release(); // kepemilikan hilang: berkas lock terhapus

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false, sessionLock: lock });
    await assert.rejects(() => manager.allowPath('src/extra'), /SCOPE_LOCK_DENIED/);
    const fresh = await loadHostState(state.sessionId, { resume: false });
    assert.deepEqual(fresh.approvalScope?.allowedPaths, ['src'], 'state disk tidak boleh berubah');
  });

  test('kepemilikan hilang DI ANTARA entry check dan save → SCOPE_LOCK_DENIED + tidak tertulis', async () => {
    const { ws, hostDir } = setup();
    const state = makeState('sess-issue38-midflight');
    await saveHostState(state);
    const lock = new FileLock(join(hostDir, state.sessionId, 'state.json'));
    const release = await lock.acquire();
    try {
      // Simulasikan lock dilepas/dicuri setelah validasi entry: pemanggilan
      // readMetadata pertama (entry) masih valid, berikutnya kosong.
      const original = lock.readMetadata.bind(lock);
      let calls = 0;
      lock.readMetadata = () => {
        calls += 1;
        return calls > 1 ? null : original();
      };

      const manager = new ScopeAmendmentManager(state, ws, { isTTY: false, sessionLock: lock });
      await assert.rejects(
        () => manager.allowPath('src/extra'),
        /SCOPE_LOCK_DENIED/,
        'kepemilikan harus divalidasi ulang tepat sebelum saveHostState',
      );
      const fresh = await loadHostState(state.sessionId, { resume: false });
      assert.deepEqual(
        fresh.approvalScope?.allowedPaths,
        ['src'],
        'scope tidak boleh tertulis tanpa kepemilikan lock',
      );
    } finally {
      await release();
    }
  });

  test('fallback tanpa sessionLock: lock aktif → SCOPE_LOCK_DENIED cepat, tanpa FileLock kedua', async () => {
    const { ws, hostDir } = setup();
    const state = makeState('sess-issue38-fallback');
    await saveHostState(state);
    const lockPath = join(hostDir, state.sessionId, 'state.json');

    // Pipeline di proses yang sama sudah memegang lock atas state.json.
    const pipelineLock = new FileLock(lockPath);
    const release = await pipelineLock.acquire();
    try {
      const manager = new ScopeAmendmentManager(state, ws, { isTTY: false }); // tanpa sessionLock
      const started = Date.now();
      await assert.rejects(() => manager.allowPath('src/extra'), /SCOPE_LOCK_DENIED/);
      assert.ok(
        Date.now() - started < 2000,
        'harus gagal cepat, bukan menunggu LOCK_TIMEOUT 5 detik',
      );
    } finally {
      await release();
    }

    // Kontrol: tanpa lock yang menggantung, fallback standalone tetap bekerja.
    const manager2 = new ScopeAmendmentManager(state, ws, { isTTY: false });
    const updated = await manager2.allowPath('src/extra');
    assert.equal(updated, true, 'standalone manager tetap mengunci state-nya sendiri');
    const fresh = await loadHostState(state.sessionId, { resume: false });
    assert.ok(fresh.approvalScope?.allowedPaths.includes('src/extra'));
  });
});
