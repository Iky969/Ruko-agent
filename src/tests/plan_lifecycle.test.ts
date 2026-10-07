/**
 * WP-04 (v2.1.0) — Sinkronisasi Siklus Hidup Mode Rencana
 *
 * DoD: "Menjalankan /plan on mengubah hostState.mode secara persisten."
 *
 * `planMode` pada kelas agen adalah proyeksi langsung dari `hostState.mode`,
 * dan `/plan on` menyimpan state secara atomik (mode='plan', approvalScope=null).
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../agent/agent.js';
import { handleCommand } from '../agent/commands.js';
import { Context } from '../core/context.js';
import { loadHostState, saveHostState } from '../core/state/hostState.js';
import { DEFAULT_CONFIG } from '../types.js';

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

test('WP-04: /plan on menyinkronkan hostState.mode secara persisten & mengosongkan approvalScope', async () => {
  process.env.RUKO_HOST_STATE_DIR = tempDir('ruko-plan-host-');
  const ws = tempDir('ruko-plan-ws-');
  const sessionId = 'sess-plan-lifecycle';

  const state = await loadHostState(sessionId, { resume: false });
  state.mode = 'act';
  state.activePlanHash = 'plan-hash-1';
  state.approvalScope = {
    planHash: 'plan-hash-1',
    allowedPaths: ['src'],
    approvedAt: new Date().toISOString(),
    correlationId: 'corr-1',
  };
  await saveHostState(state);

  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const provider: any = { name: 'test-provider', model: 'test-model', isConfigured: false };
  const agent = new Agent(ctx, provider, config, null, ws);
  agent.setHostState(state);

  assert.equal(agent.planMode, false, 'mode awal harus act');

  const env: any = {
    ctx,
    config,
    llm: provider,
    confirm: async () => true,
    updateConfig: () => {},
    handle: { stop() {}, getSessionId: () => sessionId, setSessionId() {} },
    agent,
  };

  await handleCommand('/plan on', env);

  assert.equal(agent.planMode, true, 'planMode harus mengikuti hostState.mode');
  assert.equal(state.mode, 'plan', 'hostState.mode harus berubah ke plan');
  assert.equal(state.approvalScope, null, 'approvalScope sementara harus dikosongkan');

  const persisted = await loadHostState(sessionId, { resume: false });
  assert.equal(persisted.mode, 'plan', 'mode harus tersimpan ke disk');
  assert.equal(persisted.approvalScope, null, 'approvalScope kosong harus tersimpan ke disk');

  await handleCommand('/plan off', env);
  const persistedOff = await loadHostState(sessionId, { resume: false });
  assert.equal(persistedOff.mode, 'act', 'mode act juga harus tersimpan ke disk');
  assert.equal(agent.planMode, false);
});

test('WP-04: planMode tanpa HostState memakai nilai in-memory (tanpa regresi)', () => {
  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const provider: any = { name: 'test-provider', model: 'test-model', isConfigured: false };
  const agent = new Agent(ctx, provider, config);

  assert.equal(agent.planMode, false);
  agent.planMode = true;
  assert.equal(agent.planMode, true);
  agent.planMode = false;
  assert.equal(agent.planMode, false);
});
