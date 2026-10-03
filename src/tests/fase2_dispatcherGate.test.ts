/**
 * fase2_dispatcherGate.test.ts — Test F2-T1 (Fase 2, Blueprint v2.0.0)
 *
 * Menguji Dispatcher Gate Lock di Hulu Pipeline:
 *  - Host-Governed Invariant (DoD #1): seluruh mutasi disk dan eksekusi
 *    subprocess tertolak mekanis di level dispatcher selama Plan Mode aktif.
 *  - Flag /yolo terbukti TIDAK MAMPU membatalkan batasan plan mode.
 *  - Tool read-only tetap diizinkan di Plan Mode.
 *  - Integrasi end-to-end via runToolCall.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  evaluateDispatcherGate,
  isPlanModeBlockedTool,
  MUTATION_AND_SUBPROCESS_TOOLS,
} from '../core/dispatcher/dispatcherGate.js';
import { runToolCall } from '../agent/tools.js';
import type { HostState } from '../core/state/hostState.js';

function makeState(mode: 'plan' | 'act'): HostState {
  return {
    sessionId: 'session-gate-01',
    mode,
    activePlanHash: null,
    approvalScope: null,
    sessionTokenHash: 'token-abc',
    updatedAt: new Date().toISOString(),
  };
}

describe('F2-T1 Dispatcher Gate Lock', () => {
  test('isPlanModeBlockedTool mencakup seluruh tool mutasi disk & subprocess', () => {
    const requiredTools = [
      'exec',
      'start_process',
      'write_file',
      'edit_file',
      'patch_file',
      'delete_file',
      'move_file',
      'revert_file',
      'remember',
      'save_skill',
      'delete_skill',
    ];
    for (const t of requiredTools) {
      assert.ok(isPlanModeBlockedTool(t), `tool ${t} harus terdaftar sebagai blocked di plan mode`);
      assert.ok(MUTATION_AND_SUBPROCESS_TOOLS.has(t));
    }
  });

  test('DoD #1: seluruh tool mutasi dan subprocess tertolak di level dispatcher saat Plan Mode aktif', async () => {
    const state = makeState('plan');
    for (const tool of MUTATION_AND_SUBPROCESS_TOOLS) {
      const decision = await evaluateDispatcherGate({
        tool,
        hostState: state,
        args: { path: 'src/main.ts', command: 'echo hello' },
      });
      assert.equal(decision.allowed, false, `Tool ${tool} seharusnya ditolak dalam plan mode`);
      assert.ok(
        decision.reason?.includes('plan mode aktif'),
        `Alasan penolakan harus jelas: ${decision.reason}`,
      );
    }
  });

  test('DoD #1: flag /yolo (yoloMode: true) TIDAK MAMPU membypass Plan Mode lock', async () => {
    const state = makeState('plan');
    const decisionExec = await evaluateDispatcherGate({
      tool: 'exec',
      hostState: state,
      yoloMode: true,
      args: { command: 'rm -rf /tmp/test' },
    });
    assert.equal(decisionExec.allowed, false, 'exec dengan yoloMode tetap harus ditolak di plan mode');

    const decisionWrite = await evaluateDispatcherGate({
      tool: 'write_file',
      hostState: state,
      yoloMode: true,
      args: { path: 'test.txt', content: 'test' },
    });
    assert.equal(decisionWrite.allowed, false, 'write_file dengan yoloMode tetap harus ditolak di plan mode');
  });

  test('Tool read-only diizinkan di Plan Mode', async () => {
    const state = makeState('plan');
    const readOnlyTools = ['read_file', 'list_dir', 'code_search', 'glob', 'web_fetch'];
    for (const tool of readOnlyTools) {
      const decision = await evaluateDispatcherGate({
        tool,
        hostState: state,
        args: { path: 'README.md' },
      });
      assert.equal(decision.allowed, true, `Tool read-only ${tool} harus diizinkan di plan mode`);
    }
  });

  test('Integrasi via runToolCall: hostState mode plan menolak mutasi dan subprocess', async () => {
    const state = makeState('plan');
    const execResRaw = await runToolCall(
      { tool: 'exec', command: 'echo 123' },
      { hostState: state },
    );
    const execRes = JSON.parse(execResRaw);
    assert.ok(execRes.error?.includes('plan mode aktif'));

    const writeResRaw = await runToolCall(
      { tool: 'write_file', path: 'danger.txt', content: 'payload' },
      { hostState: state },
    );
    const writeRes = JSON.parse(writeResRaw);
    assert.ok(writeRes.error?.includes('plan mode aktif'));
  });

  test('Integrasi via runToolCall: hostState mode plan + config approvalEnabled:false (YOLO) tetap tertolak', async () => {
    const state = makeState('plan');
    const resRaw = await runToolCall(
      { tool: 'exec', command: 'rm -rf target' },
      { hostState: state, config: { approvalEnabled: false } as any },
    );
    const res = JSON.parse(resRaw);
    assert.ok(res.error?.includes('plan mode aktif'), 'YOLO config tidak boleh membypass plan mode di runToolCall');
  });
});
