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
import { Readable, Writable } from 'node:stream';
import { after, describe, test } from 'node:test';
import {
  computePlanHash,
  ScopeAmendmentManager,
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
