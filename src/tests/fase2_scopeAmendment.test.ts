/**
 * fase2_scopeAmendment.test.ts — Test F2-T2 (Fase 2, Blueprint v2.0.0 §2.6)
 *
 * Menguji Scope Amendment Manager:
 *  - TC-SCM-01: Subtree Auto-Approve (perubahan dalam folder disetujui langsung lolos)
 *  - TC-SCM-02: Fail-Closed non-TTY / CI (mutasi di luar subtree ditolak tanpa hang)
 *  - DoD #2: Kriptografi Kontrak Scope (mismatch activePlanHash membatalkan izin)
 *  - Penolakan traversal di luar workspace root
 *  - Micro-prompt terminal [Y/n] persetujuan & penolakan dengan pembaruan FileLock
 *  - Fungsi hash plan kanonis computePlanHash
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { after, describe, test } from 'node:test';
import {
  computePlanHash,
  ScopeAmendmentManager,
  type ScopeAmendmentOptions,
} from '../core/approval/scopeAmendment.js';
import { saveHostState, type HostState } from '../core/state/hostState.js';

const tempDirs: string[] = [];

function createHostDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-scope-host-'));
  tempDirs.push(dir);
  process.env.RUKO_HOST_STATE_DIR = dir;
  return dir;
}

function createWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-scope-ws-'));
  tempDirs.push(dir);
  return dir;
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
  planHash = 'hash-initial',
  activePlanHash: string | null = 'hash-initial',
): HostState {
  return {
    sessionId,
    mode: 'act',
    activePlanHash,
    approvalScope: {
      planHash,
      allowedPaths,
      approvedAt: new Date().toISOString(),
      correlationId: 'corr-01',
    },
    sessionTokenHash: 'token-test',
    updatedAt: new Date().toISOString(),
  };
}

describe('F2-T2 Scope Amendment Manager', () => {
  test('TC-SCM-01: Perubahan di dalam subfolder yang disetujui (Subtree Auto-Approve) langsung diizinkan', async () => {
    createHostDir();
    const ws = createWorkspace();

    // Buat struktur direktori riil (TC-SCM-03 memerlukan resolusi fisik realpathSync)
    mkdirSync(join(ws, 'src', 'core', 'utils'), { recursive: true });
    mkdirSync(join(ws, 'docs', 'guide'), { recursive: true });

    const state = createMockHostState('sess-scm-01', ['src/core', 'docs']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // Target persis folder yang diizinkan
    const resExact = await manager.evaluateMutationTarget('src/core', 'ubah folder', false);
    assert.equal(resExact, true, 'Folder persis harus disetujui otomatis');

    // Target di dalam subfolder yang diizinkan (anak langsung)
    const resChild = await manager.evaluateMutationTarget('src/core/main.ts', 'tambah file', false);
    assert.equal(resChild, true, 'Subfile dalam subtree harus auto-approved');

    // Target di dalam nested subfolder
    const resNested = await manager.evaluateMutationTarget('src/core/utils/helper.ts', 'tambah util', false);
    assert.equal(resNested, true, 'Nested subfile dalam subtree harus auto-approved');

    // Target di subfolder docs
    const resDocs = await manager.evaluateMutationTarget('docs/guide/readme.md', 'update docs', false);
    assert.equal(resDocs, true, 'Subfile docs harus auto-approved');
  });

  test('TC-SCM-02: Mutasi di luar subtree pada lingkungan non-TTY (CI=true) otomatis ditolak tanpa menggantung', async () => {
    createHostDir();
    const ws = createWorkspace();
    const state = createMockHostState('sess-scm-02', ['src/core']);
    await saveHostState(state);

    // non-TTY environment
    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });
    const res = await manager.evaluateMutationTarget('package.json', 'tambah dep', true);
    assert.equal(res, false, 'Mutasi di luar subtree pada non-TTY harus fail-closed');

    const resUnrelated = await manager.evaluateMutationTarget('scripts/deploy.sh', 'ubah script', false);
    assert.equal(resUnrelated, false, 'Mutasi di luar subtree non-interactive harus ditolak');
  });

  test('DoD #2: Modifikasi hash rencana membatalkan izin eksekusi secara otomatis (fail-closed)', async () => {
    createHostDir();
    const ws = createWorkspace();
    // activePlanHash berbeda dari approvalScope.planHash (rencana diubah di tengah jalan)
    const state = createMockHostState('sess-scm-03', ['src/core'], 'hash-old', 'hash-tampered');
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });
    const res = await manager.evaluateMutationTarget('src/core/main.ts', 'mutasi file', false);
    assert.equal(res, false, 'Mismatch plan hash harus menggugurkan izin eksekusi secara mekanis');
  });

  test('Target di luar workspace root (path traversal) ditolak mutlak', async () => {
    createHostDir();
    const ws = createWorkspace();
    const state = createMockHostState('sess-scm-04', ['src']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });
    const resEscape = await manager.evaluateMutationTarget('../../etc/passwd', 'baca /etc', false);
    assert.equal(resEscape, false, 'Pelarian di luar workspace root wajib ditolak mutlak');
  });

  test('Micro-prompt terminal [Y/n]: input "y" menyetujui dan memperbarui allowedPaths secara atomik', async () => {
    createHostDir();
    const ws = createWorkspace();
    const state = createMockHostState('sess-scm-05', ['src/core']);
    await saveHostState(state);

    // Mock stdin dengan jawaban "y\n"
    const inStream = Readable.from(['y\n']);
    let outputBuffer = '';
    const outStream = new Writable({
      write(chunk, _enc, cb) {
        outputBuffer += chunk.toString();
        cb();
      },
    });

    const manager = new ScopeAmendmentManager(state, ws, {
      input: inStream,
      output: outStream,
      isTTY: true,
      promptTimeoutMs: 5000,
    });

    const approved = await manager.evaluateMutationTarget('src/new_module.ts', 'fitur baru', true);
    assert.equal(approved, true, 'Amandemen harus disetujui');
    assert.ok(manager.getState().approvalScope?.allowedPaths.includes('src/new_module.ts'));
    assert.ok(outputBuffer.includes('AI mengusulkan amandemen scope'));
  });

  test('Micro-prompt terminal [Y/n]: input "n" menolak amandemen dan tidak menambah path', async () => {
    createHostDir();
    const ws = createWorkspace();
    const state = createMockHostState('sess-scm-06', ['src/core']);
    await saveHostState(state);

    // Mock stdin dengan jawaban "n\n"
    const inStream = Readable.from(['n\n']);
    const manager = new ScopeAmendmentManager(state, ws, {
      input: inStream,
      isTTY: true,
      promptTimeoutMs: 5000,
    });

    const approved = await manager.evaluateMutationTarget('secrets.env', 'akses env', true);
    assert.equal(approved, false, 'Amandemen harus ditolak bila user menjawab n');
    assert.equal(manager.getState().approvalScope?.allowedPaths.includes('secrets.env'), false);
  });

  test('computePlanHash menghasilkan hash deterministik kanonis', () => {
    const ws = '/workspace/project';
    const plan = { step: 1, action: 'refactor', files: ['b.ts', 'a.ts'] };
    const paths = ['src/a.ts', 'src/b.ts'];

    const h1 = computePlanHash(plan, paths, ws);
    const h2 = computePlanHash(plan, paths, ws);
    assert.equal(h1, h2, 'Hash harus identik untuk input yang sama');
    assert.match(h1, /^[0-9a-f]{64}$/, 'Hash harus berupa 64-karakter SHA-256 hex');

    // Urutan path berbeda tetap menghasilkan hash yang sama karena di-sort
    const hReordered = computePlanHash(plan, ['src/b.ts', 'src/a.ts'], ws);
    assert.equal(h1, hReordered, 'Urutan input allowedPaths harus dinormalisasi');
  });
});

describe('TC-FSM-01 Circuit Breaker: Consecutive Identical Rejections', () => {
  test('TC-FSM-01: Circuit breaker trigger tepat di percobaan ke-3 pada path identik', async () => {
    createHostDir();
    const ws = createWorkspace();
    const state = createMockHostState('sess-fsm-01', ['src/core']);
    await saveHostState(state);

    const inStream = Readable.from(['n\n', 'n\n', 'n\n']); // 3x rejection
    let outputBuffer = '';
    const outStream = new Writable({
      write(chunk, _enc, cb) {
        outputBuffer += chunk.toString();
        cb();
      },
    });

    const manager = new ScopeAmendmentManager(state, ws, {
      input: inStream,
      output: outStream,
      isTTY: true,
      promptTimeoutMs: 5000,
    });

    // 1st rejection
    const r1 = await manager.evaluateMutationTarget('src/secrets.env', 'akses env', true);
    assert.equal(r1, false, '1st rejection should return false');

    // 2nd rejection
    const r2 = await manager.evaluateMutationTarget('src/secrets.env', 'akses env lagi', true);
    assert.equal(r2, false, '2nd rejection should return false');

    // 3rd rejection - circuit breaker should trigger
    const r3 = await manager.evaluateMutationTarget('src/secrets.env', 'akses env sekali lagi', true);
    assert.equal(r3, false, '3rd rejection should return false');

    // 4th attempt - should be blocked by circuit breaker WITHOUT prompting
    const r4 = await manager.evaluateMutationTarget('src/secrets.env', 'masih coba akses', true);
    assert.equal(r4, false, '4th attempt should be blocked by circuit breaker');
    assert.ok(outputBuffer.includes('Circuit breaker aktif'), 'Should show circuit breaker message');
  });

  test('TC-FSM-01: Circuit breaker TIDAK trigger kalau penolakan di path berbeda (bukan konsekutif identik)', async () => {
    createHostDir();
    const ws = createWorkspace();
    const state = createMockHostState('sess-fsm-02', ['src/core']);
    await saveHostState(state);

    const inStream = Readable.from(['n\n', 'n\n', 'n\n']); // rejections on different paths
    const outStream = new Writable({
      write(chunk, _enc, cb) { cb(); },
    });

    const manager = new ScopeAmendmentManager(state, ws, {
      input: inStream,
      output: outStream,
      isTTY: true,
      promptTimeoutMs: 5000,
    });

    // Reject 3 different paths - should NOT trigger circuit breaker on any
    const r1 = await manager.evaluateMutationTarget('src/secrets.env', 'akses env', true);
    assert.equal(r1, false);

    const r2 = await manager.evaluateMutationTarget('src/config.json', 'akses config', true);
    assert.equal(r2, false);

    const r3 = await manager.evaluateMutationTarget('src/private.key', 'akses key', true);
    assert.equal(r3, false);

    // 4th attempt on a NEW path should still prompt (not blocked)
    // We can't easily test prompt here since stream is consumed, but verify internal counter
    const status1 = manager.getCircuitBreakerStatus('src/secrets.env');
    const status2 = manager.getCircuitBreakerStatus('src/config.json');
    const status3 = manager.getCircuitBreakerStatus('src/private.key');

    assert.equal(status1.rejectionCount, 1, 'Path 1 should have 1 rejection');
    assert.equal(status2.rejectionCount, 1, 'Path 2 should have 1 rejection');
    assert.equal(status3.rejectionCount, 1, 'Path 3 should have 1 rejection');
    assert.equal(status1.isBlocked, false, 'Path 1 should not be blocked');
    assert.equal(status2.isBlocked, false, 'Path 2 should not be blocked');
    assert.equal(status3.isBlocked, false, 'Path 3 should not be blocked');
  });

  test('TC-FSM-01: Path A tetap diblokir selama sesi setelah path B disetujui', async () => {
    createHostDir();
    const ws = createWorkspace();
    const state = createMockHostState('sess-fsm-03', ['src/core']);
    await saveHostState(state);

    let outputBuffer = '';
    const options: ScopeAmendmentOptions = {
      output: new Writable({ write(chunk, _enc, cb) { outputBuffer += chunk.toString(); cb(); } }),
      isTTY: true,
      promptTimeoutMs: 5000,
    };
    const manager = new ScopeAmendmentManager(state, ws, options);

    const callWithAnswer = async (answer: string, target: string, reason: string) => {
      options.input = Readable.from([answer + '\n']);
      return manager.evaluateMutationTarget(target, reason, true);
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal(await callWithAnswer('n', 'src/secrets.env', 'akses env'), false);
    }
    assert.equal(manager.getCircuitBreakerStatus('src/secrets.env').isBlocked, true);
    assert.equal(await callWithAnswer('y', 'src/config.json', 'akses config'), true);
    assert.ok(manager.getState().approvalScope?.allowedPaths.includes('src/config.json'));
    const statusA = manager.getCircuitBreakerStatus('src/secrets.env');
    assert.equal(statusA.rejectionCount, 3, 'Approval B must not reset counter A');
    assert.equal(statusA.isBlocked, true, 'Path A remains blocked for the rest of this session');
    const promptCount = outputBuffer.split('Izinkan amandemen scope ini?').length;
    options.input = new Readable({ read() { assert.fail('blocked path must not read stdin'); } });
    const decision = await manager.evaluateMutationDecision('src/secrets.env', 'ulang A', true);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.code, 'SCOPE_CIRCUIT_BREAKER');
    assert.equal(outputBuffer.split('Izinkan amandemen scope ini?').length, promptCount);
  });

  for (const transition of ['allow different path', 'reset and allow', 'reset and seed', 'allow parent subtree']) {
    test(`TC-FSM-01: Session breaker survives ${transition}`, async () => {
      createHostDir();
      const ws = createWorkspace();
      mkdirSync(join(ws, 'src', 'core'), { recursive: true });
      const state = createMockHostState(`sess-fsm-${transition.replaceAll(' ', '-')}`, ['src/core']);
      await saveHostState(state);
      const options: ScopeAmendmentOptions = {
        isTTY: true, promptTimeoutMs: 5000,
        output: new Writable({ write(_chunk, _enc, cb) { cb(); } }),
      };
      const manager = new ScopeAmendmentManager(state, ws, options);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        options.input = Readable.from(['n\n']);
        assert.equal(await manager.evaluateMutationTarget('src/blocked.txt', 'reject A', true), false);
      }
      if (transition.startsWith('reset')) await manager.resetScope();
      if (transition === 'reset and seed') manager.seedWorkspaceScope(true);
      else await manager.allowPath(transition === 'allow parent subtree' ? 'src' : 'src/other.txt');
      assert.equal(manager.getCircuitBreakerStatus('src/blocked.txt').rejectionCount, 3);
      assert.equal(manager.getCircuitBreakerStatus('src/blocked.txt').isBlocked, true);
      options.input = new Readable({ read() { assert.fail('latched breaker must not prompt'); } });
      const decision = await manager.evaluateMutationDecision('src/./blocked.txt', 'canonical alias A', true);
      assert.equal(decision.allowed, false);
      if (!decision.allowed) assert.equal(decision.code, 'SCOPE_CIRCUIT_BREAKER');
    });
  }

  test('TC-FSM-01: Approval B does not discard pre-threshold rejections for A', async () => {
    createHostDir();
    const ws = createWorkspace();
    const state = createMockHostState('sess-fsm-partial', ['src/core']);
    await saveHostState(state);
    const options: ScopeAmendmentOptions = {
      isTTY: true, promptTimeoutMs: 5000,
      output: new Writable({ write(_chunk, _enc, cb) { cb(); } }),
    };
    const manager = new ScopeAmendmentManager(state, ws, options);
    for (const [answer, target] of [
      ['n', 'src/a.txt'], ['n', 'src/a.txt'], ['y', 'src/b.txt'], ['n', 'src/a.txt'],
    ]) {
      options.input = Readable.from([answer + '\n']);
      assert.equal(await manager.evaluateMutationTarget(target, 'per-path sequence', true), answer === 'y');
    }
    assert.equal(manager.getCircuitBreakerStatus('src/a.txt').rejectionCount, 3);
    assert.equal(manager.getCircuitBreakerStatus('src/a.txt').isBlocked, true);
  });

  test('TC-FSM-01: A new session starts without the previous session breaker', async () => {
    createHostDir();
    const ws = createWorkspace();
    const state = createMockHostState('sess-fsm-old-session', ['src/core']);
    await saveHostState(state);
    const options: ScopeAmendmentOptions = {
      isTTY: true, promptTimeoutMs: 5000,
      output: new Writable({ write(_chunk, _enc, cb) { cb(); } }),
    };
    const oldManager = new ScopeAmendmentManager(state, ws, options);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      options.input = Readable.from(['n\n']);
      await oldManager.evaluateMutationTarget('src/a.txt', 'reject in old session', true);
    }
    assert.equal(oldManager.getCircuitBreakerStatus('src/a.txt').isBlocked, true);
    const newState = createMockHostState('sess-fsm-new-session', ['src/core']);
    await saveHostState(newState);
    const newManager = new ScopeAmendmentManager(newState, ws, {
      isTTY: true, input: Readable.from(['y\n']), output: options.output,
    });
    assert.equal(newManager.getCircuitBreakerStatus('src/a.txt').rejectionCount, 0);
    assert.equal(await newManager.evaluateMutationTarget('src/a.txt', 'new session approval', true), true);
    assert.equal(oldManager.getCircuitBreakerStatus('src/a.txt').isBlocked, true);
  });

  test('TC-FSM-01: Approval already waiting cannot reopen A after another prompt latches its breaker', async (t) => {
    createHostDir();
    const ws = createWorkspace();
    const state = createMockHostState('sess-fsm-pending', ['src/core']);
    await saveHostState(state);
    const options: ScopeAmendmentOptions = {
      isTTY: true, promptTimeoutMs: 5000,
      output: new Writable({ write(_chunk, _enc, cb) { cb(); } }),
    };
    const manager = new ScopeAmendmentManager(state, ws, options);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      options.input = Readable.from(['n\n']);
      await manager.evaluateMutationTarget('src/a.txt', 'reject A', true);
    }
    const pendingInput = new PassThrough();
    t.after(() => pendingInput.destroy());
    options.input = pendingInput;
    const pending = manager.evaluateMutationDecision('src/a.txt', 'pending approval A', true);
    options.input = Readable.from(['n\n']);
    assert.equal(await manager.evaluateMutationTarget('src/a.txt', 'third rejection A', true), false);
    assert.equal(manager.getCircuitBreakerStatus('src/a.txt').isBlocked, true);
    pendingInput.write('y\n');
    const decision = await pending;
    assert.equal(decision.allowed, false, 'late approval cannot reopen the latched path');
    if (!decision.allowed) assert.equal(decision.code, 'SCOPE_CIRCUIT_BREAKER');
    assert.equal(manager.getCircuitBreakerStatus('src/a.txt').isBlocked, true);
    assert.equal(manager.getState().approvalScope?.allowedPaths.includes('src/a.txt'), false);
  });

  test('TC-FSM-01: Setelah breaker trigger, permintaan lanjutan ke path sama ditolak otomatis tanpa prompt', async () => {
    createHostDir();
    const ws = createWorkspace();
    const state = createMockHostState('sess-fsm-04', ['src/core']);
    await saveHostState(state);

    const outStream = new Writable({
      write(_chunk, _enc, cb) { cb(); },
    });

    const manager = new ScopeAmendmentManager(state, ws, {
      input: Readable.from(['n\n', 'n\n', 'n\n']),
      output: outStream,
      isTTY: true,
      promptTimeoutMs: 500,
    });

    // We need to simulate the prompt being shown - use getCircuitBreakerStatus
    // to verify internal state instead of mocking prompt

    // 3 rejections
    await manager.evaluateMutationTarget('src/private.key', 'akses key', true);
    await manager.evaluateMutationTarget('src/private.key', 'akses key lagi', true);
    await manager.evaluateMutationTarget('src/private.key', 'akses key sekali lagi', true);

    // 4th attempt should be blocked
    const blocked = await manager.evaluateMutationTarget('src/private.key', 'masih coba', false);
    assert.equal(blocked, false, 'Should be blocked without prompt');

    // Verify circuit breaker status
    const status = manager.getCircuitBreakerStatus('src/private.key');
    assert.equal(status.rejectionCount, 3, 'Should have 3 rejections');
    assert.equal(status.isBlocked, true, 'Should be blocked');
  });
});

describe('TC-SCM-05 Scope Contraction Utility', () => {
  test('TC-SCM-05: Scope contraction utility reset allowedPaths ke initial state', async () => {
    createHostDir();
    const ws = createWorkspace();
    const initialPaths = ['src/core', 'docs'];
    const state = createMockHostState('sess-scm-05', initialPaths);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // Verify initial state
    const initial = manager.getInitialAllowedPaths();
    assert.deepEqual(initial, ['src/core', 'docs'], 'Initial paths should match');

    // Simulate some approvals adding new paths (by directly modifying state)
    state.approvalScope!.allowedPaths.push('src/new_module.ts', 'scripts/deploy.sh');
    await saveHostState(state);

    // Verify expansion happened
    const expanded = manager.getState().approvalScope!.allowedPaths;
    assert.ok(expanded.includes('src/new_module.ts'), 'Should have expanded paths');
    assert.ok(expanded.includes('scripts/deploy.sh'), 'Should have expanded paths');

    // Now contract scope
    const contracted = await manager.contractScope();
    assert.equal(contracted, true, 'Contract should succeed');

    // Verify reset to initial
    const afterContract = manager.getState().approvalScope!.allowedPaths;
    assert.deepEqual(afterContract.sort(), ['src/core', 'docs'].sort(), 'Should reset to initial paths');
    assert.equal(afterContract.includes('src/new_module.ts'), false, 'Expanded paths should be removed');
    assert.equal(afterContract.includes('scripts/deploy.sh'), false, 'Expanded paths should be removed');
  });

  test('TC-SCM-05: Contract scope tidak membuka kembali session circuit breaker', async () => {
    createHostDir();
    const ws = createWorkspace();
    const state = createMockHostState('sess-scm-06', ['src/core']);
    await saveHostState(state);

    const options: ScopeAmendmentOptions = {
      output: new Writable({ write(_chunk, _enc, cb) { cb(); } }),
      isTTY: true,
      promptTimeoutMs: 5000,
    };
    const manager = new ScopeAmendmentManager(state, ws, options);

    // Trigger circuit breaker on a path
    for (let attempt = 0; attempt < 3; attempt += 1) {
      options.input = Readable.from(['n\n']);
      await manager.evaluateMutationTarget('src/secrets.env', 'akses env', true);
    }

    // Verify circuit breaker is active
    let status = manager.getCircuitBreakerStatus('src/secrets.env');
    assert.equal(status.isBlocked, true, 'Circuit breaker should be active');

    // Contract scope
    await manager.contractScope();

    // Contraction revokes scope, not the session-lifetime rejection policy.
    status = manager.getCircuitBreakerStatus('src/secrets.env');
    assert.equal(status.rejectionCount, 3, 'Rejection count survives scope contraction');
    assert.equal(status.isBlocked, true, 'Circuit breaker remains blocked for this session');
    options.input = new Readable({ read() { assert.fail('blocked path must not read stdin'); } });
    const decision = await manager.evaluateMutationDecision('src/secrets.env', 'retry after contraction', true);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.code, 'SCOPE_CIRCUIT_BREAKER');
  });

  test('TC-SCM-05: Regresi - alur approval normal (approve/reject biasa) tetap bekerja', async () => {
    createHostDir();
    const ws = createWorkspace();
    const state = createMockHostState('sess-scm-07', ['src/core']);
    await saveHostState(state);

    // Test normal approve
    const inApprove = Readable.from(['y\n']);
    const outApprove = new Writable({ write(chunk, _enc, cb) { cb(); } });
    const manager1 = new ScopeAmendmentManager(state, ws, {
      input: inApprove,
      output: outApprove,
      isTTY: true,
      promptTimeoutMs: 5000,
    });

    const approved = await manager1.evaluateMutationTarget('src/new_feature.ts', 'fitur baru', true);
    assert.equal(approved, true, 'Normal approve should work');
    assert.ok(manager1.getState().approvalScope?.allowedPaths.includes('src/new_feature.ts'));

    // Test normal reject
    const inReject = Readable.from(['n\n']);
    const outReject = new Writable({ write(chunk, _enc, cb) { cb(); } });
    const manager2 = new ScopeAmendmentManager(state, ws, {
      input: inReject,
      output: outReject,
      isTTY: true,
      promptTimeoutMs: 5000,
    });

    const rejected = await manager2.evaluateMutationTarget('src/another.ts', 'fitur lain', true);
    assert.equal(rejected, false, 'Normal reject should work');
    assert.equal(manager2.getState().approvalScope?.allowedPaths.includes('src/another.ts'), false);
  });

  test('TC-SCM-04: Sibling directory prefix collision (src-patch vs src) ditolak otomatis', async () => {
    // QA.md §4.B TC-SCM-04: target /repo/src-patch/x vs scope /repo/src
    createHostDir();
    const ws = createWorkspace();
    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'src-patch'), { recursive: true });
    mkdirSync(join(ws, 'src_extra'), { recursive: true });

    const state = createMockHostState('sess-scm-04', ['src']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, {
      isTTY: false, // Non-TTY -> fail-closed jika bukan subtree
    });

    // Mutasi di dalam allowed subtree 'src' harus lolos
    const insideAllowed = await manager.evaluateMutationTarget('src/valid.ts', 'file sah', false);
    assert.equal(insideAllowed, true, 'Target di dalam src harus auto-approve');

    // Mutasi pada direktori tetangga dengan prefiks sama (sibling prefix) HARUS DITOLAK
    const sibling1 = await manager.evaluateMutationTarget('src-patch/evil.ts', 'sibling collision', false);
    assert.equal(sibling1, false, 'Sibling prefix src-patch tidak boleh lolos under scope src');

    const sibling2 = await manager.evaluateMutationTarget('src_extra/evil.ts', 'sibling underscore', false);
    assert.equal(sibling2, false, 'Sibling prefix src_extra tidak boleh lolos under scope src');
  });
});
