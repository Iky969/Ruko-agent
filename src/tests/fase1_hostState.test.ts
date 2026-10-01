/**
 * fase1_hostState.test.ts — Test F1-T3 (Fase 1, Blueprint v2.0.0)
 *
 * Mencakup: validasi sessionId, atomisitas save (tmp O_EXCL 0600 → rename),
 * hak akses 0600, Win32 backoff tidak merusak POSIX, fail-safe resume reset
 * (mode 'act' → 'plan', approvalScope null), dan fail-closed state rusak.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, mock, test } from 'node:test';
import {
  loadHostState,
  saveHostState,
  validateSessionId,
  CorruptedStateError,
  type HostState,
} from '../core/state/hostState.js';

const stateDirs: string[] = [];

function withHostDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  stateDirs.push(dir);
  process.env.RUKO_HOST_STATE_DIR = dir;
  return dir;
}

after(() => {
  delete process.env.RUKO_HOST_STATE_DIR;
  for (const dir of stateDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function baseState(sessionId: string, overrides: Partial<HostState> = {}): HostState {
  return {
    sessionId,
    mode: 'plan',
    activePlanHash: null,
    approvalScope: null,
    sessionTokenHash: 'a'.repeat(64),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('F1-T3 hostState', () => {
  test('validateSessionId menolak karakter berbahaya (path traversal)', () => {
    assert.doesNotThrow(() => validateSessionId('sesi-01_ABC'));
    assert.throws(() => validateSessionId('../escape'), /SESSION_ID_INVALID/);
    assert.throws(() => validateSessionId('a/b'), /SESSION_ID_INVALID/);
    assert.throws(() => validateSessionId('a b'), /SESSION_ID_INVALID/);
    assert.throws(() => validateSessionId('x'.repeat(65)), /SESSION_ID_INVALID/);
  });

  test('save + load rountrip mempertahankan state mode plan', async () => {
    const dir = withHostDir('ruko-state-roundtrip-');
    const state = baseState('sesi-roundtrip', { mode: 'plan' });
    await saveHostState(state);
    const loaded = await loadHostState('sesi-roundtrip');
    assert.equal(loaded.mode, 'plan');
    assert.equal(loaded.sessionId, 'sesi-roundtrip');
    assert.equal(loaded.sessionTokenHash, 'a'.repeat(64));
    void dir;
  });

  test('state.json tersimpan dengan hak akses 0600 & direktori 0700 (POSIX)', async () => {
    const dir = withHostDir('ruko-state-perm-');
    await saveHostState(baseState('sesi-perm'));
    const statePath = join(dir, 'sesi-perm', 'state.json');
    const st = statSync(statePath);
    if (process.platform !== 'win32') {
      // File HARUS 0600 — tanpa bit group/other
      assert.equal(st.mode & 0o777, 0o600, `mode harus 0600, dapat ${st.mode.toString(8)}`);
      const dirSt = statSync(join(dir, 'sesi-perm'));
      assert.equal(dirSt.mode & 0o777, 0o700, `dir harus 0700, dapat ${dirSt.mode.toString(8)}`);
    } else {
      assert.ok(st.isFile());
    }
  });

  test('Fail-Safe Resume Reset: mode act di-reset ke plan + approvalScope null', async () => {
    const dir = withHostDir('ruko-state-resume-');
    await saveHostState(
      baseState('sesi-act', {
        mode: 'act',
        activePlanHash: 'f'.repeat(64),
        approvalScope: {
          planHash: 'f'.repeat(64),
          allowedPaths: ['src/'],
          approvedAt: new Date().toISOString(),
          correlationId: 'corr-1',
        },
      }),
    );
    const loaded = await loadHostState('sesi-act');
    assert.equal(loaded.mode, 'plan', 'resume wajib mendarat di plan mode');
    assert.equal(loaded.approvalScope, null, 'approvalScope wajib dibatalkan saat resume');
    void dir;
  });

  test('TC-STA-01: fail-closed: manipulasi berkas state.json terpotong (truncated payload) akibat crash/ENOSPC melempar CorruptedStateError', async () => {
    const dir = withHostDir('ruko-state-truncated-');
    mkdirSync(join(dir, 'sesi-truncated'), { recursive: true, mode: 0o700 });
    // Simulasi penulisan terpotong di tengah jalan (misal disk penuh / ENOSPC / crash)
    writeFileSync(join(dir, 'sesi-truncated', 'state.json'), '{"sessionId": "sesi-truncated", "mode": "act", "ap', 'utf8');

    await assert.rejects(
      () => loadHostState('sesi-truncated'),
      (err: unknown) => {
        assert.ok(err instanceof CorruptedStateError, 'Harus melempar CorruptedStateError');
        assert.equal((err as CorruptedStateError).code, 'CORRUPTED_STATE');
        assert.match((err as CorruptedStateError).message, /korup atau terpotong/);
        return true;
      },
    );
    void dir;
  });

  test('TC-STA-01: fail-closed: berkas state korup bukan JSON ({ini bukan json) melempar CorruptedStateError tanpa silent replace', async () => {
    const dir = withHostDir('ruko-state-corrupt-');
    mkdirSync(join(dir, 'sesi-corrupt'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'sesi-corrupt', 'state.json'), '{ini bukan json', 'utf8');

    await assert.rejects(
      () => loadHostState('sesi-corrupt'),
      (err: unknown) => {
        assert.ok(err instanceof CorruptedStateError, 'Harus melempar CorruptedStateError');
        assert.equal((err as CorruptedStateError).code, 'CORRUPTED_STATE');
        return true;
      },
    );
    void dir;
  });

  test('TC-STA-01: fail-closed: berkas state dengan struktur cacat atau sessionId mismatch melempar CorruptedStateError', async () => {
    const dir = withHostDir('ruko-state-invalid-schema-');
    mkdirSync(join(dir, 'sesi-invalid'), { recursive: true, mode: 0o700 });

    // Skenario 1: sessionId di payload tidak cocok dengan sessionId folder
    writeFileSync(
      join(dir, 'sesi-invalid', 'state.json'),
      JSON.stringify({ sessionId: 'mismatched-id', mode: 'plan', sessionTokenHash: 'a'.repeat(64) }),
      'utf8',
    );
    await assert.rejects(
      () => loadHostState('sesi-invalid'),
      (err: unknown) => {
        assert.ok(err instanceof CorruptedStateError);
        assert.match((err as CorruptedStateError).message, /Integritas struktur state/);
        return true;
      },
    );

    // Skenario 2: mode tidak valid
    writeFileSync(
      join(dir, 'sesi-invalid', 'state.json'),
      JSON.stringify({ sessionId: 'sesi-invalid', mode: 'invalid_mode', sessionTokenHash: 'a'.repeat(64) }),
      'utf8',
    );
    await assert.rejects(
      () => loadHostState('sesi-invalid'),
      (err: unknown) => {
        assert.ok(err instanceof CorruptedStateError);
        assert.match((err as CorruptedStateError).message, /Integritas struktur state/);
        return true;
      },
    );

    // Skenario 3: berkas kosong (0 bytes akibat crash sebelum write)
    writeFileSync(join(dir, 'sesi-invalid', 'state.json'), '', 'utf8');
    await assert.rejects(
      () => loadHostState('sesi-invalid'),
      (err: unknown) => {
        assert.ok(err instanceof CorruptedStateError);
        return true;
      },
    );

    void dir;
  });

  test('TC-STA-02: Mutasi state pada lingkungan POSIX memanggil fsync pada berkas sementara dan direktori induk', async () => {
    if (process.platform === 'win32') return;
    const dir = withHostDir('ruko-state-fsync-');
    const sessionId = 'sesi-fsync-posix';
    let dirFsyncCalled = false;
    let fileFsyncCalled = false;

    const origOpen = fsPromises.open;
    mock.method(fsPromises, 'open', async (p: any, flags: any, mode: any) => {
      const handle = await origOpen.call(fsPromises, p, flags, mode);
      const isDir = typeof p === 'string' && p.endsWith(sessionId);
      const isTmpFile = typeof p === 'string' && p.includes('.state.');

      const origSync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (isDir) dirFsyncCalled = true;
        if (isTmpFile) fileFsyncCalled = true;
        return origSync();
      };
      return handle;
    });

    try {
      await saveHostState(baseState(sessionId));
      assert.equal(fileFsyncCalled, true, 'fsync harus dipanggil pada deskriptor file sementara');
      assert.equal(dirFsyncCalled, true, 'fsync harus dipanggil pada deskriptor direktori induk (POSIX)');
    } finally {
      mock.reset();
    }
    void dir;
  });

  test('TC-STA-02: Operasi penulisan status pada lingkungan dengan overlayfs tanpa dukungan directory fsync (EINVAL graceful fallback)', async () => {
    const dir = withHostDir('ruko-state-overlayfs-');
    const sessionId = 'sesi-overlayfs';

    const origOpen = fsPromises.open;
    mock.method(fsPromises, 'open', async (p: any, flags: any, mode: any) => {
      const handle = await origOpen.call(fsPromises, p, flags, mode);
      const isDir = typeof p === 'string' && p.endsWith(sessionId);
      if (isDir) {
        handle.sync = async () => {
          const err = new Error('Invalid argument: directory fsync not supported on overlayfs');
          (err as any).code = 'EINVAL';
          throw err;
        };
      }
      return handle;
    });

    try {
      await assert.doesNotReject(
        () => saveHostState(baseState(sessionId)),
        'saveHostState harus sukses meskipun direktori fsync melempar EINVAL (graceful fallback)',
      );
      const loaded = await loadHostState(sessionId);
      assert.equal(loaded.sessionId, sessionId);
    } finally {
      mock.reset();
    }
    void dir;
  });

  test('load untuk sesi yang belum ada → fail-closed mode plan baru', async () => {
    const dir = withHostDir('ruko-state-new-');
    const loaded = await loadHostState('sesi-baru');
    assert.equal(loaded.mode, 'plan');
    assert.equal(loaded.approvalScope, null);
    void dir;
  });

  test('save atomik: tidak ada file tmp yang tertinggal', async () => {
    const dir = withHostDir('ruko-state-atomic-');
    await saveHostState(baseState('sesi-atomic'));
    const entries = statSync(join(dir, 'sesi-atomic'));
    assert.ok(entries.isFile !== undefined);
    const listing = (await import('node:fs/promises')).readdir;
    const files = await listing(join(dir, 'sesi-atomic'));
    assert.deepEqual(
      files.filter((f) => f !== 'state.json'),
      [],
      `tidak boleh ada file tmp sisa: ${files.join(', ')}`,
    );
  });
});
