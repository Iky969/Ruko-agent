/**
 * fase2_dispatcherGate_moveFile.test.ts — Test scope bypass fix untuk move_file
 *
 * Menguji perbaikan celah keamanan di dispatcherGate.ts:
 *  - move_file HARUS memeriksa KEDUA sisi (source dan target) terhadap scope
 *  - Fail-closed: jika salah satu di luar scope, tolak operasi
 *  - Memastikan tidak ada bypass dengan memindahkan file dari luar ke dalam scope
 *  - Memastikan move dalam scope tetap diizinkan
 *  - Tes edit_file pada file yang sudah ada dengan ACT scope seed
 *  - Tes .git/hooks/ guard
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  evaluateDispatcherGate,
} from '../core/dispatcher/dispatcherGate.js';
import { ScopeAmendmentManager } from '../core/approval/scopeAmendment.js';
import { saveHostState, type HostState } from '../core/state/hostState.js';
import { isSensitivePath, runToolCall } from '../agent/tools.js';
import { DEFAULT_CONFIG } from '../types.js';

const tempDirs: string[] = [];

function createHostDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-mvtest-host-'));
  tempDirs.push(dir);
  process.env.RUKO_HOST_STATE_DIR = dir;
  return dir;
}

function createWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-mvtest-ws-'));
  tempDirs.push(dir);
  return dir;
}

function isolateUndo(ws: string): () => void {
  const previous = process.env.RUKO_UNDO_DIR;
  process.env.RUKO_UNDO_DIR = join(ws, '.ruko', 'undo');
  return () => {
    if (previous === undefined) delete process.env.RUKO_UNDO_DIR;
    else process.env.RUKO_UNDO_DIR = previous;
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

function createMockHostState(
  sessionId: string,
  allowedPaths: string[],
  planHash = 'hash-mvtest',
  activePlanHash: string | null = 'hash-mvtest',
): HostState {
  return {
    sessionId,
    mode: 'act',
    activePlanHash,
    approvalScope: {
      planHash,
      allowedPaths,
      approvedAt: new Date().toISOString(),
      correlationId: 'corr-mvtest',
    },
    sessionTokenHash: 'token-mvtest',
    updatedAt: new Date().toISOString(),
  };
}

describe('F2-T1-EXT: move_file scope bypass fix', () => {
  for (const [label, source, target] of [
    ['source outside scope', 'outside/source.txt', 'src/target.txt'],
    ['target outside scope', 'src/source.txt', 'outside/target.txt'],
  ]) {
    test(`move_file denied for ${label} preserves source and does not create target or undo`, async (t) => {
      createHostDir();
      const ws = createWorkspace();
      t.after(isolateUndo(ws));
      mkdirSync(join(ws, 'src'));
      mkdirSync(join(ws, 'outside'));
      writeFileSync(join(ws, source), 'original content', 'utf8');
      const state = createMockHostState(`sess-mv-${label.replaceAll(' ', '-')}`, ['src']);
      await saveHostState(state);
      const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });
      const result = JSON.parse(await runToolCall({ tool: 'move_file', source, target }, {
        workspaceRoot: ws, hostState: state, scopeAmendmentManager: manager,
        config: { ...DEFAULT_CONFIG, approvalEnabled: false },
        confirm: async () => { assert.fail('scope denial must happen before file approval'); },
      }));
      assert.match(result.error, /SCOPE_OUTSIDE/);
      assert.equal(existsSync(join(ws, source)), true);
      assert.equal(readFileSync(join(ws, source), 'utf8'), 'original content');
      assert.equal(existsSync(join(ws, target)), false);
      assert.equal(existsSync(join(ws, '.ruko', 'undo')), false);
    });
  }

  test('move_file scope checks the destination actually executed when aliases conflict', async (t) => {
    createHostDir();
    const ws = createWorkspace();
    t.after(isolateUndo(ws));
    mkdirSync(join(ws, 'src'));
    mkdirSync(join(ws, 'outside'));
    const state = createMockHostState('sess-mv-conflicting-aliases', ['src']);
    await saveHostState(state);
    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });
    for (const alias of ['destination', 'targetPath', 'to']) {
      writeFileSync(join(ws, 'src', 'source.txt'), 'must stay in scope', 'utf8');
      const result = JSON.parse(await runToolCall({
        tool: 'move_file', source: 'src/source.txt', target: 'outside/target.txt',
        [alias]: 'src/decoy.txt',
      }, {
        workspaceRoot: ws, hostState: state, scopeAmendmentManager: manager,
        config: { ...DEFAULT_CONFIG, approvalEnabled: false },
      }));
      assert.match(result.error ?? '', /SCOPE_OUTSIDE/, alias);
      assert.equal(readFileSync(join(ws, 'src', 'source.txt'), 'utf8'), 'must stay in scope');
      assert.equal(existsSync(join(ws, 'outside', 'target.txt')), false);
      assert.equal(existsSync(join(ws, 'src', 'decoy.txt')), false);
      assert.equal(existsSync(join(ws, '.ruko', 'undo')), false);
    }
  });

  test('move_file inside scope actually moves the file after explicit approval', async (t) => {
    createHostDir();
    const ws = createWorkspace();
    t.after(isolateUndo(ws));
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'source.txt'), 'approved content', 'utf8');
    const state = createMockHostState('sess-mv-positive', ['src']);
    await saveHostState(state);
    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });
    let approvals = 0;
    const result = JSON.parse(await runToolCall({
      tool: 'move_file', source: 'src/source.txt', target: 'src/target.txt',
    }, {
      workspaceRoot: ws, hostState: state, scopeAmendmentManager: manager,
      config: { ...DEFAULT_CONFIG, approvalEnabled: true },
      confirm: async () => { approvals += 1; return true; },
    }));
    assert.equal(result.ok, true, result.error);
    assert.equal(approvals, 1);
    assert.equal(existsSync(join(ws, 'src', 'source.txt')), false);
    assert.equal(readFileSync(join(ws, 'src', 'target.txt'), 'utf8'), 'approved content');
  });

  test('move_file dari path di LUAR scope ke path di DALAM scope harus ditolak saat ACT', async () => {
    createHostDir();
    const ws = createWorkspace();

    // Buat struktur: ws/src/ (disetujui) dan ws/outside/ (TIDAK disetujui)
    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'outside'), { recursive: true });
    writeFileSync(join(ws, 'outside', 'secret.txt'), 'sensitive data', 'utf8');

    const state = createMockHostState('sess-mv-01', ['src']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // Coba move dari outside/secret.txt ke src/imported.txt
    // Sebelum perbaikan: hanya target (src/imported.txt) dicek → lolos karena dalam scope
    // Setelah perbaikan: source (outside/secret.txt) juga dicek → ditolak karena di luar scope
    const decision = await evaluateDispatcherGate({
      tool: 'move_file',
      args: { source: 'outside/secret.txt', target: 'src/imported.txt' },
      hostState: state,
      scopeManager: manager,
      isInteractive: false,
      workspaceRoot: ws,
    });

    assert.equal(decision.allowed, false, 'move_file dari luar scope harus ditolak');
    assert.ok(
      decision.reason?.toLowerCase().includes('scope') ||
      decision.reason?.toLowerCase().includes('path'),
      `Alasan penolakan harus jelas tentang scope/path: ${decision.reason}`,
    );
  });

  test('move_file dari path di DALAM scope ke path di LUAR scope harus ditolak saat ACT', async () => {
    createHostDir();
    const ws = createWorkspace();

    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'outside'), { recursive: true });
    writeFileSync(join(ws, 'src', 'internal.txt'), 'internal data', 'utf8');

    const state = createMockHostState('sess-mv-02', ['src']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // Coba move dari src/internal.txt ke outside/exported.txt
    // Target di luar scope → harus ditolak
    const decision = await evaluateDispatcherGate({
      tool: 'move_file',
      args: { source: 'src/internal.txt', target: 'outside/exported.txt' },
      hostState: state,
      scopeManager: manager,
      isInteractive: false,
      workspaceRoot: ws,
    });

    assert.equal(decision.allowed, false, 'move_file ke luar scope harus ditolak');
    assert.ok(
      decision.reason?.toLowerCase().includes('scope') ||
      decision.reason?.toLowerCase().includes('path'),
      `Alasan penolakan harus jelas tentang scope/path: ${decision.reason}`,
    );
  });

  test('move_file di DALAM scope yang sama harus diizinkan saat ACT', async () => {
    createHostDir();
    const ws = createWorkspace();

    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'src', 'subdir'), { recursive: true });
    writeFileSync(join(ws, 'src', 'file.txt'), 'data', 'utf8');

    const state = createMockHostState('sess-mv-03', ['src']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // Move dalam scope yang sama: src/file.txt → src/subdir/file.txt
    // Keduanya dalam scope 'src' → harus diizinkan
    const decision = await evaluateDispatcherGate({
      tool: 'move_file',
      args: { source: 'src/file.txt', target: 'src/subdir/file.txt' },
      hostState: state,
      scopeManager: manager,
      isInteractive: false,
      workspaceRoot: ws,
    });

    assert.equal(decision.allowed, true, 'move_file dalam scope harus diizinkan');
  });

  test('move_file dengan variasi nama argumen (from/to, path/destination) juga diperiksa', async () => {
    createHostDir();
    const ws = createWorkspace();

    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'outside'), { recursive: true });
    writeFileSync(join(ws, 'outside', 'file.txt'), 'data', 'utf8');

    const state = createMockHostState('sess-mv-04', ['src']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // Tes dengan 'from' dan 'to' (variasi nama argumen)
    const decisionFromTo = await evaluateDispatcherGate({
      tool: 'move_file',
      args: { from: 'outside/file.txt', to: 'src/imported.txt' },
      hostState: state,
      scopeManager: manager,
      isInteractive: false,
      workspaceRoot: ws,
    });
    assert.equal(decisionFromTo.allowed, false, 'Variasi from/to harus diperiksa');

    // Tes dengan 'path' dan 'destination'
    const decisionPathDest = await evaluateDispatcherGate({
      tool: 'move_file',
      args: { path: 'outside/file.txt', destination: 'src/imported.txt' },
      hostState: state,
      scopeManager: manager,
      isInteractive: false,
      workspaceRoot: ws,
    });
    assert.equal(decisionPathDest.allowed, false, 'Variasi path/destination harus diperiksa');
  });

  test('edit_file pada file yang SUDAH ADA dalam scope seed harus diizinkan saat ACT', async () => {
    createHostDir();
    const ws = createWorkspace();

    // Buat file yang sudah ada dalam folder yang disetujui
    mkdirSync(join(ws, 'src', 'core'), { recursive: true });
    writeFileSync(join(ws, 'src', 'core', 'existing.ts'), 'export const x = 1;', 'utf8');

    const state = createMockHostState('sess-edit-01', ['src/core']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // Edit file yang sudah ada dalam scope → harus diizinkan (subtree auto-approve)
    const decision = await evaluateDispatcherGate({
      tool: 'edit_file',
      args: { path: 'src/core/existing.ts', old_string: 'x = 1', new_string: 'x = 2' },
      hostState: state,
      scopeManager: manager,
      isInteractive: false,
      workspaceRoot: ws,
    });

    assert.equal(decision.allowed, true, 'edit_file pada file dalam scope harus diizinkan');
  });

  test('edit_file pada file di LUAR scope harus ditolak saat ACT (non-interaktif)', async () => {
    createHostDir();
    const ws = createWorkspace();

    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'outside'), { recursive: true });
    writeFileSync(join(ws, 'outside', 'external.ts'), 'export const y = 1;', 'utf8');

    const state = createMockHostState('sess-edit-02', ['src']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // Edit file di luar scope dalam mode non-interaktif → harus ditolak (fail-closed)
    const decision = await evaluateDispatcherGate({
      tool: 'edit_file',
      args: { path: 'outside/external.ts', old_string: 'y = 1', new_string: 'y = 2' },
      hostState: state,
      scopeManager: manager,
      isInteractive: false,
      workspaceRoot: ws,
    });

    assert.equal(decision.allowed, false, 'edit_file di luar scope harus ditolak');
  });

  test('.git/hooks/ guard: mutasi pada .git/hooks/** harus ditolak (Security Core)', async () => {
    createHostDir();
    const ws = createWorkspace();

    mkdirSync(join(ws, '.git', 'hooks'), { recursive: true });

    // Coba write_file ke .git/hooks/pre-commit (bypass via dispatcher tidak akan ditest,
    // karena Security Core guard di assertNotSecurityCore lebih dulu menolak)
    // Tes ini memastikan isSensitivePath mendeteksi .git/hooks/**
    const result = JSON.parse(await runToolCall(
      { tool: 'write_file', path: '.git/hooks/pre-commit', content: '#!/bin/sh\necho malicious' },
      { workspaceRoot: ws },
    ));

    assert.ok(
      result.error && (
        result.error.includes('.git') ||
        result.error.includes('Security Core') ||
        result.error.includes('sensitif')
      ),
      `.git/hooks/ harus ditolak oleh Security Core guard: ${result.error}`,
    );
    assert.equal(existsSync(join(ws, '.git', 'hooks', 'pre-commit')), false);
  });

  test('.git/hooks/pre-commit guard: deteksi berbagai variasi path', async () => {
    createHostDir();
    const ws = createWorkspace();

    mkdirSync(join(ws, '.git', 'hooks'), { recursive: true });

    const hookPaths = [
      '.git/hooks',
      '.git/hooks/pre-commit',
      '.git/hooks/post-receive',
      '.git/hooks/pre-push',
      join(ws, '.git', 'hooks', 'pre-commit'),
      '.GIT/HOOKS/pre-commit',
      '.git\\hooks\\pre-commit',
      '%2egit/hooks/pre-commit',
      'nested/.git/hooks/pre-commit',
    ];

    for (const hookPath of hookPaths) {
      assert.equal(isSensitivePath(hookPath, ws), true, hookPath);
      const result = JSON.parse(await runToolCall(
        { tool: 'write_file', path: hookPath, content: '#!/bin/sh' },
        { workspaceRoot: ws },
      ));

      assert.ok(
        result.error && (
          result.error.includes('.git') ||
          result.error.includes('Security Core') ||
          result.error.includes('sensitif')
        ),
        `${hookPath} harus ditolak: ${result.error}`,
      );
    }
    assert.equal(isSensitivePath('.git/hooks-backup/pre-commit', ws), false);
    assert.equal(existsSync(join(ws, '.git', 'hooks', 'pre-commit')), false);
  });
});
