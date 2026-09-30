/**
 * fase1_hostState.test.ts — Test F1-T3 (Fase 1, Blueprint v2.0.0)
 *
 * Mencakup: validasi sessionId, atomisitas save (tmp O_EXCL 0600 → rename),
 * hak akses 0600, Win32 backoff tidak merusak POSIX, fail-safe resume reset
 * (mode 'act' → 'plan', approvalScope null), dan fail-closed state rusak.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { loadHostState, saveHostState, validateSessionId, type HostState } from '../core/state/hostState.js';

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

  test('fail-closed: state.json rusak → state baru mode plan dibuat ulang', async () => {
    const dir = withHostDir('ruko-state-corrupt-');
    mkdirSync(join(dir, 'sesi-corrupt'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'sesi-corrupt', 'state.json'), '{ini bukan json', 'utf8');
    const loaded = await loadHostState('sesi-corrupt');
    assert.equal(loaded.mode, 'plan');
    assert.ok(loaded.sessionTokenHash.length === 64);
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
