/**
 * WP-04 (v2.1.0) — Single-Writer State (Anti LOCK_TIMEOUT)
 *
 * DoD: "alur amandemen cakupan tidak memicu LOCK_TIMEOUT."
 *
 * SecurityPipeline memegang FileLock eksklusif kernel untuk state sesi. Manager
 * amandemen cakupan TIDAK boleh membuat FileLock kedua pada berkas state yang
 * sama (itu self-deadlock di proses yang sama) — mutasi state didelegasikan ke
 * mutator terpusat milik pipeline (serialisasi in-process mutex).
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { ScopeAmendmentManager, type HostStateMutator } from '../core/approval/scopeAmendment.js';
import { bootstrapSecurityPipeline } from '../core/securityPipeline.js';
import { loadHostState, saveHostState } from '../core/state/hostState.js';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const savedHostDir = process.env.RUKO_HOST_STATE_DIR;

after(() => {
  if (savedHostDir === undefined) delete process.env.RUKO_HOST_STATE_DIR;
  else process.env.RUKO_HOST_STATE_DIR = savedHostDir;
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

async function prepareSession(sessionId: string, ws: string): Promise<void> {
  const state = await loadHostState(sessionId, { resume: false });
  state.mode = 'act';
  state.activePlanHash = 'plan-hash-lock';
  state.approvalScope = {
    planHash: 'plan-hash-lock',
    allowedPaths: ['src'],
    approvedAt: new Date().toISOString(),
    correlationId: 'corr-lock',
  };
  await saveHostState(state);
  mkdirSync(join(ws, 'src'), { recursive: true });
}

test('WP-04: contractScope saat pipeline memegang lock tidak memicu LOCK_TIMEOUT', async () => {
  process.env.RUKO_HOST_STATE_DIR = tempDir('ruko-lock-host-');
  const ws = tempDir('ruko-lock-ws-');
  const sessionId = 'sess-lock-contract';
  await prepareSession(sessionId, ws);

  const pipeline = await bootstrapSecurityPipeline({
    sessionId,
    workspaceRoot: ws,
    resume: false,
    timeoutMs: 2000,
  });

  try {
    // Pre-fix: ScopeAmendmentManager membuat FileLock kedua pada state.json yang
    // sama → LOCK_TIMEOUT setelah 5s. Post-fix: mutasi lewat mutator pipeline.
    const contracted = await pipeline.scopeManager.contractScope();
    assert.equal(contracted, true, 'contractScope harus berhasil tanpa deadlock');

    const persisted = await loadHostState(sessionId, { resume: false });
    assert.deepEqual(persisted.approvalScope?.allowedPaths, ['src']);

    // Subtree auto-approve tetap berjalan tanpa lock tambahan
    assert.equal(await pipeline.scopeManager.evaluateMutationTarget('src/app.ts', 'uji', false), true);
  } finally {
    await pipeline.releaseLock();
  }
});

test('WP-04: amandemen scope via mutator terpusat tersimpan walau lock pipeline aktif', async () => {
  process.env.RUKO_HOST_STATE_DIR = tempDir('ruko-lock-host2-');
  const ws = tempDir('ruko-lock-ws2-');
  const sessionId = 'sess-lock-amend';
  await prepareSession(sessionId, ws);

  const pipeline = await bootstrapSecurityPipeline({
    sessionId,
    workspaceRoot: ws,
    resume: false,
    timeoutMs: 2000,
  });

  try {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();

    // Mutator dengan kontrak yang sama seperti SecurityPipeline (in-process mutex).
    let chain: Promise<unknown> = Promise.resolve();
    const stateMutator: HostStateMutator = (targetSessionId, mutate) => {
      const task = chain.then(async () => mutate(await loadHostState(targetSessionId, { resume: false })));
      chain = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    };

    const manager = new ScopeAmendmentManager(pipeline.hostState, ws, {
      input,
      output,
      isTTY: true,
      promptTimeoutMs: 3000,
      stateMutator,
    });

    const pending = manager.evaluateMutationTarget('docs/baru.md', 'uji amandemen', true, {
      tool: 'write_file',
      args: { path: 'docs/baru.md', content: 'halo' },
    });
    input.write('y\n');
    const allowed = await pending;

    assert.equal(allowed, true, 'amandemen harus diizinkan tanpa LOCK_TIMEOUT');
    const persisted = await loadHostState(sessionId, { resume: false });
    assert.ok(
      persisted.approvalScope?.allowedPaths.includes('docs/baru.md'),
      'path baru harus tersimpan ke state.json',
    );
  } finally {
    await pipeline.releaseLock();
  }
});
