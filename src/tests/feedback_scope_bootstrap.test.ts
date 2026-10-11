import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough, Readable, Writable } from 'node:stream';
import { Agent } from '../agent/agent.js';
import { buildHelpText, handleCommand, listCommands, matchCommands, type CommandEnv } from '../agent/commands.js';
import type { LLMProvider } from '../agent/llm.js';
import { runToolCall } from '../agent/tools.js';
import { Context } from '../core/context.js';
import { SystemLoop } from '../core/loop.js';
import { ScopeAmendmentManager } from '../core/approval/scopeAmendment.js';
import { bootstrapSecurityPipeline, type SecurityPipeline } from '../core/securityPipeline.js';
import { loadHostState, saveHostState, type HostState } from '../core/state/hostState.js';
import { stripAnsi } from '../core/ui.js';
import { CLI_ENTRY, rukoEnv, tryCreateSymlink } from './helpers/platform.js';
import type { ContextMessage } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

const provider: LLMProvider = {
  name: 'scope-test',
  model: 'scope-test',
  isConfigured: false,
  setModel() {},
  async chat() { return ''; },
};

describe('feedback PR-A: ACT scope bootstrap', () => {
  let root: string;
  let workspace: string;
  let originalHostDir: string | undefined;
  let pipeline: SecurityPipeline;
  let agent: Agent;
  let env: CommandEnv;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'ruko-feedback-scope-'));
    workspace = join(root, 'workspace');
    mkdirSync(workspace);
    originalHostDir = process.env.RUKO_HOST_STATE_DIR;
    process.env.RUKO_HOST_STATE_DIR = join(root, 'host');
    pipeline = await bootstrapSecurityPipeline({
      sessionId: 'feedback-scope', workspaceRoot: workspace, resume: false, isTTY: false,
    });
    const config = { ...DEFAULT_CONFIG };
    const ctx = new Context(config);
    agent = new Agent(ctx, provider, config, null, workspace);
    agent.setHostState(pipeline.hostState);
    agent.setScopeAmendmentManager(pipeline.scopeManager);
    env = {
      ctx, config, llm: provider, agent, confirm: async () => false,
      updateConfig: (patch) => { Object.assign(config, patch); },
      handle: { stop() {}, getSessionId: () => pipeline.sessionId, setSessionId() {} },
    };
  });

  afterEach(async () => {
    await pipeline?.releaseLock();
    if (originalHostDir === undefined) delete process.env.RUKO_HOST_STATE_DIR;
    else process.env.RUKO_HOST_STATE_DIR = originalHostDir;
    rmSync(root, { recursive: true, force: true });
  });

  test('non-TTY ACT transition without user authorization cannot seed workspace scope', async () => {
    const stateFile = join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json');
    const before = readFileSync(stateFile, 'utf8');
    await assert.rejects(agent.setPlanMode(false), /SCOPE_BOOTSTRAP_DENIED/);
    assert.equal(agent.planMode, true);
    assert.equal(pipeline.hostState.mode, 'plan');
    assert.equal(pipeline.hostState.approvalScope, null);
    assert.equal(readFileSync(stateFile, 'utf8'), before);
  });

  test('scope manager rejects a direct implicit seed without creating a contract', () => {
    const stateFile = join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json');
    const before = readFileSync(stateFile, 'utf8');
    assert.throws(() => pipeline.scopeManager.seedWorkspaceScope(), /SCOPE_BOOTSTRAP_DENIED/);
    assert.equal(pipeline.hostState.approvalScope, null);
    assert.equal(readFileSync(stateFile, 'utf8'), before);
  });

  test('non-TTY mutation cannot recreate a revoked scope through YOLO or tool arguments', async () => {
    await handleCommand('/plan off', env);
    await handleCommand('/scope reset', env);
    env.config.approvalEnabled = false;
    const stateFile = join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json');
    const before = readFileSync(stateFile, 'utf8');
    let confirmations = 0;
    const result = JSON.parse(await runToolCall({
      tool: 'write_file', path: 'blocked.txt', content: 'unapproved', userAuthorized: true,
    }, {
      workspaceRoot: workspace, hostState: pipeline.hostState,
      scopeAmendmentManager: pipeline.scopeManager, config: env.config,
      confirm: async () => { confirmations += 1; return true; },
    }));
    assert.match(result.error, /SECURITY_DENIED/);
    assert.equal(confirmations, 0);
    assert.equal(existsSync(join(workspace, 'blocked.txt')), false);
    assert.equal(pipeline.hostState.mode, 'act');
    assert.equal(pipeline.hostState.approvalScope, null);
    await assert.rejects(agent.setPlanMode(false), /SCOPE_BOOTSTRAP_DENIED/);
    assert.equal(pipeline.hostState.mode, 'act');
    assert.equal(readFileSync(stateFile, 'utf8'), before);
  });

  test('non-TTY narrow scope denies expansion without reading input or prompting', async () => {
    mkdirSync(join(workspace, 'src'));
    await handleCommand('/scope allow src', env);
    await agent.setPlanMode(false);
    let inputReads = 0;
    let output = '';
    let confirmations = 0;
    const manager = new ScopeAmendmentManager(pipeline.hostState, workspace, {
      sessionLock: pipeline.fileLock, isTTY: false,
      input: new Readable({ read() { inputReads += 1; this.push(null); } }),
      output: new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } }),
    });
    const stateFile = join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json');
    const before = readFileSync(stateFile, 'utf8');
    const deps = {
      workspaceRoot: workspace, hostState: pipeline.hostState, scopeAmendmentManager: manager,
      config: { ...env.config, approvalEnabled: false },
      confirm: async () => { confirmations += 1; return true; },
    };
    const denied = JSON.parse(await runToolCall({
      tool: 'write_file', path: 'docs/blocked.txt', content: 'outside approved subtree',
    }, deps));
    assert.match(denied.error, /SECURITY_DENIED: \[SCOPE_OUTSIDE\]/);
    assert.match(denied.error, /Scope: src/);
    assert.match(denied.error, /Target: docs\/blocked\.txt/);
    assert.match(denied.error, /\/scope allow/);
    assert.equal(existsSync(join(workspace, 'docs')), false);
    assert.equal(inputReads, 0);
    assert.equal(output, '');
    assert.equal(confirmations, 0);
    assert.equal(readFileSync(stateFile, 'utf8'), before);
    assert.deepEqual(pipeline.hostState.approvalScope?.allowedPaths, ['src']);
    const allowed = JSON.parse(await runToolCall({
      tool: 'write_file', path: 'src/allowed.txt', content: 'explicit narrow authorization',
    }, deps));
    assert.equal(allowed.error, undefined);
    assert.equal(readFileSync(join(workspace, 'src/allowed.txt'), 'utf8'), 'explicit narrow authorization');
  });

  test('fresh session /plan off persists ACT with workspace scope and permits a real write', async () => {
    await handleCommand('/plan off', env);
    assert.equal(pipeline.hostState.mode, 'act');
    assert.deepEqual(pipeline.hostState.approvalScope?.allowedPaths, ['.']);
    const saved = await loadHostState(pipeline.sessionId, { resume: false });
    assert.deepEqual(saved.approvalScope, pipeline.hostState.approvalScope);
    assert.equal(saved.mode, 'act');
    const result = JSON.parse(await runToolCall({
      tool: 'write_file', path: 'allowed.txt', content: 'workspace content',
    }, {
      workspaceRoot: workspace, hostState: pipeline.hostState,
      scopeAmendmentManager: pipeline.scopeManager, config: env.config,
    }));
    assert.equal(result.error, undefined);
    assert.equal(readFileSync(join(workspace, 'allowed.txt'), 'utf8'), 'workspace content');
  });

  test('Agent numbered-plan auto-off seeds scope before executing its write tool', async () => {
    env.ctx.add('assistant', '1. Buat selected.txt\n2. Periksa struktur');
    let calls = 0;
    const scripted: LLMProvider = {
      ...provider, isConfigured: true,
      async chat(_messages: ContextMessage[]) {
        return calls++ === 0
          ? '```tool\n{"tool":"write_file","path":"selected.txt","content":"selected option"}\n```'
          : 'Selesai.';
      },
    };
    agent.setLlmProvider(scripted);
    await agent.handleInstruction('1');
    assert.deepEqual(pipeline.hostState.approvalScope?.allowedPaths, ['.']);
    assert.equal(readFileSync(join(workspace, 'selected.txt'), 'utf8'), 'selected option');
    assert.equal((await loadHostState(pipeline.sessionId, { resume: false })).mode, 'act');
  });

  test('REPL numbered-plan auto-off persists ACT scope before handing the turn to Agent', async () => {
    env.ctx.add('assistant', '1. Kerjakan file\n2. Lihat struktur');
    const loop = new SystemLoop(env.ctx, agent, env.config, join(root, 'config.json'), pipeline);
    let turnInstruction = '';
    (loop as any).runTurn = async (instruction: string) => {
      turnInstruction = instruction;
      const saved = await loadHostState(pipeline.sessionId, { resume: false });
      assert.equal(saved.mode, 'act');
      assert.deepEqual(saved.approvalScope?.allowedPaths, ['.']);
    };
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args) => { errors.push(args); };
    try {
      await (loop as any).handleLine('1');
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(errors, []);
    assert.match(turnInstruction, /User memilih opsi 1/);
    assert.deepEqual(pipeline.hostState.approvalScope?.allowedPaths, ['.']);
  });

  test('/scope allow src establishes an explicit narrow contract without leaving PLAN', async () => {
    mkdirSync(join(workspace, 'src'));
    await handleCommand('/scope allow src', env);
    assert.equal(agent.planMode, true);
    assert.equal(pipeline.hostState.mode, 'plan');
    assert.deepEqual(pipeline.hostState.approvalScope?.allowedPaths, ['src']);
    assert.strictEqual(pipeline.scopeManager.getState(), pipeline.hostState);
    const saved = await loadHostState(pipeline.sessionId, { resume: false });
    assert.deepEqual(saved.approvalScope, pipeline.hostState.approvalScope);
    await handleCommand('/plan off', env);
    assert.deepEqual(pipeline.hostState.approvalScope?.allowedPaths, ['src']);
    assert.equal((await pipeline.evaluateToolCall('write_file', { path: 'src/main.ts' }, false)).allowed, true);
    assert.equal((await pipeline.evaluateToolCall('write_file', { path: 'docs/readme.md' }, false)).allowed, false);
  });

  test('/scope reset revokes the contract in memory and on disk without leaving ACT', async () => {
    await handleCommand('/plan off', env);
    await handleCommand('/scope reset', env);
    assert.equal(agent.planMode, false);
    assert.equal(pipeline.hostState.mode, 'act');
    assert.equal(pipeline.hostState.approvalScope, null);
    assert.equal(pipeline.scopeManager.getState().approvalScope, null);
    assert.equal((await loadHostState(pipeline.sessionId, { resume: false })).approvalScope, null);
    assert.equal((await pipeline.evaluateToolCall('write_file', { path: 'blocked.txt' }, false)).allowed, false);
    await handleCommand('/scope allow .', env);
    assert.equal((await pipeline.evaluateToolCall('write_file', { path: 'allowed.txt' }, false)).allowed, true);
  });

  test('scope denial explains a missing contract and gives an explicit recovery command', async () => {
    await handleCommand('/plan off', env);
    await handleCommand('/scope reset', env);
    const stateFile = join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json');
    const before = readFileSync(stateFile, 'utf8');
    const result = JSON.parse(await runToolCall({
      tool: 'write_file', path: 'blocked.txt', content: 'unapproved',
    }, {
      workspaceRoot: workspace, hostState: pipeline.hostState,
      scopeAmendmentManager: pipeline.scopeManager, config: env.config,
    }));
    assert.match(result.error, /^SECURITY_DENIED: \[SCOPE_MISSING\]/);
    assert.match(result.error, /approvalScope kosong/);
    assert.match(result.error, /Mode: ACT/);
    assert.match(result.error, /Scope: \(none\)/);
    assert.match(result.error, /Target: blocked\.txt/);
    assert.match(result.error, /\/scope allow/);
    assert.doesNotMatch(result.error, /\/mode|\/role|\/yolo/);
    assert.equal(existsSync(join(workspace, 'blocked.txt')), false);
    assert.equal(readFileSync(stateFile, 'utf8'), before);
  });

  test('/scope status reports PLAN/ACT and current paths without altering authorization', async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    try {
      const before = readFileSync(join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json'), 'utf8');
      await handleCommand('/scope status', env);
      assert.match(stripAnsi(logs.join('\n')), /Mode: PLAN/);
      assert.match(stripAnsi(logs.join('\n')), /Scope: \(none\)/);
      assert.equal(readFileSync(join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json'), 'utf8'), before);
      await handleCommand('/plan off', env);
      logs.length = 0;
      await handleCommand('/scope', env);
      assert.match(stripAnsi(logs.join('\n')), /Mode: ACT/);
      assert.match(stripAnsi(logs.join('\n')), /Scope: \./);
    } finally {
      console.log = originalLog;
    }
    assert.ok(listCommands().some((command) => command.name === 'scope'));
    assert.ok(matchCommands('/sc').some((command) => command.name === 'scope'));
    assert.match(stripAnsi(buildHelpText()), /\/scope/);
  });

  test('REPL status bar and panel show live host PLAN/ACT and scope after authorization changes', async () => {
    const loop = new SystemLoop(env.ctx, agent, env.config, join(root, 'config.json'), pipeline);
    const assertStatus = (mode: string, scope: string) => {
      for (const width of [30, 80, 120]) {
        for (const render of ['statusBarLine', 'statusPanel']) {
          const output = stripAnsi((loop as any)[render](width));
          assert.ok(output.includes(mode), output);
          assert.ok(output.includes(`scope: ${scope}`), output);
        }
      }
    };
    assertStatus('PLAN', '(none)');
    await handleCommand('/scope allow src', env);
    assertStatus('PLAN', 'src');
    await handleCommand('/plan off', env);
    assertStatus('ACT', 'src');
    await handleCommand('/scope reset', env);
    assertStatus('ACT', '(none)');
    await handleCommand('/plan on', env);
    assertStatus('PLAN', '(none)');
    (agent as any)._planMode = false; // stale fallback must not override authoritative host display
    assertStatus('PLAN', '(none)');
  });

  test('scope denial identifies a changed plan and its recovery replaces the stale contract', async () => {
    await handleCommand('/scope allow src', env);
    await handleCommand('/plan off', env);
    pipeline.hostState.activePlanHash = 'changed-plan';
    await saveHostState(pipeline.hostState);
    const stateFile = join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json');
    const before = readFileSync(stateFile, 'utf8');
    const decision = await pipeline.evaluateToolCall('write_file', { path: 'src/blocked.txt' }, false);
    assert.equal(decision.allowed, false);
    assert.match(decision.reason!, /\[SCOPE_PLAN_CHANGED\]/);
    assert.match(decision.reason!, /rencana aktif berubah/i);
    assert.match(decision.reason!, /\/scope reset/);
    assert.match(decision.reason!, /\/scope allow/);
    assert.match(decision.reason!, /Scope: src/);
    assert.equal(readFileSync(stateFile, 'utf8'), before);
    await handleCommand('/scope reset', env);
    await handleCommand('/scope allow src', env);
    assert.equal(pipeline.hostState.approvalScope?.planHash, 'changed-plan');
    assert.deepEqual(await pipeline.evaluateToolCall('write_file', { path: 'src/allowed.txt' }, false), { allowed: true });
  });

  test('scope amendment denial reports user rejection and the subsequent circuit breaker', async () => {
    await handleCommand('/scope allow src', env);
    await handleCommand('/plan off', env);
    const input = new PassThrough();
    let output = '';
    const manager = new ScopeAmendmentManager(pipeline.hostState, workspace, {
      sessionLock: pipeline.fileLock, isTTY: true, input,
      output: new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } }),
    });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        input.write('n\n');
        const denied = await manager.evaluateMutationDecision('docs/blocked.txt', 'update docs', true);
        assert.equal(denied.allowed, false);
        if (!denied.allowed) assert.equal(denied.code, 'SCOPE_AMENDMENT_DECLINED');
      }
      output = '';
      const blocked = await manager.evaluateMutationDecision('docs/blocked.txt', 'retry', true);
      assert.equal(blocked.allowed, false);
      if (!blocked.allowed) assert.equal(blocked.code, 'SCOPE_CIRCUIT_BREAKER');
      assert.doesNotMatch(output, /Izinkan amandemen/);
      assert.deepEqual(pipeline.hostState.approvalScope?.allowedPaths, ['src']);
    } finally {
      input.destroy();
    }
  });

  test('scope amendment reports revoked authorization after the prompt without claiming an outside path', async () => {
    await handleCommand('/scope allow src', env);
    await handleCommand('/plan off', env);
    const freshState = await loadHostState(pipeline.sessionId, { resume: false });
    freshState.mode = 'plan';
    await saveHostState(freshState);
    const manager = new ScopeAmendmentManager(pipeline.hostState, workspace, {
      sessionLock: pipeline.fileLock, isTTY: true,
      input: Readable.from(['y\n']),
      output: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    });
    const decision = await manager.evaluateMutationDecision('docs/blocked.txt', 'update docs', true);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.code, 'SCOPE_PLAN_ACTIVE');
      assert.match(decision.reason, /\/plan off/);
    }
    assert.equal(pipeline.hostState.mode, 'plan');
    assert.deepEqual(pipeline.hostState.approvalScope?.allowedPaths, ['src']);
  });

  test('/plan on revokes scope and blocks file mutations and subprocesses even with YOLO', async () => {
    writeFileSync(join(workspace, 'existing.txt'), 'original');
    await handleCommand('/plan off', env);
    await handleCommand('/plan on', env);
    assert.equal(agent.planMode, true);
    assert.equal(pipeline.hostState.mode, 'plan');
    assert.equal(pipeline.hostState.approvalScope, null);
    const saved = await loadHostState(pipeline.sessionId, { resume: false });
    assert.equal(saved.mode, 'plan');
    assert.equal(saved.approvalScope, null);
    const stateFile = join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json');
    const before = readFileSync(stateFile, 'utf8');
    let confirmations = 0;
    const calls = [
      { tool: 'write_file', path: 'blocked.txt', content: 'unapproved' },
      { tool: 'edit_file', path: 'existing.txt', content: 'changed' },
      { tool: 'patch_file', path: 'existing.txt', oldText: 'original', newText: 'changed' },
      { tool: 'delete_file', path: 'existing.txt' },
      { tool: 'move_file', source: 'existing.txt', target: 'moved.txt' },
      { tool: 'revert_file', path: 'existing.txt', mode: 'auto' },
      { tool: 'exec', command: 'git status' },
      { tool: 'start_process', command: 'git status' },
      { tool: 'remember', content: 'unapproved memory' },
      { tool: 'save_skill', name: 'blocked-skill', description: 'blocked', content: 'unapproved skill' },
      { tool: 'delete_skill', name: 'blocked-skill' },
    ];
    for (const call of calls) {
      const result = JSON.parse(await runToolCall(call, {
        hostState: pipeline.hostState, scopeAmendmentManager: pipeline.scopeManager,
        workspaceRoot: workspace, config: { ...env.config, approvalEnabled: false },
        confirm: async () => { confirmations += 1; return true; },
      }));
      assert.match(result.error, /plan mode aktif/i, call.tool);
      assert.match(result.error, /\/plan off/, call.tool);
    }
    assert.equal(confirmations, 0);
    assert.equal(readFileSync(join(workspace, 'existing.txt'), 'utf8'), 'original');
    assert.deepEqual(readdirSync(workspace), ['existing.txt']);
    assert.equal(readFileSync(stateFile, 'utf8'), before);
    await handleCommand('/plan off', env);
    assert.deepEqual(agent.getHostState()?.approvalScope?.allowedPaths, ['.']);
  });

  test('PLAN blocks a valid scoped write before approval while reads still work', async () => {
    writeFileSync(join(workspace, 'readable.txt'), 'read-only content');
    await handleCommand('/scope allow .', env);
    assert.equal(pipeline.hostState.mode, 'plan');
    assert.ok(pipeline.hostState.approvalScope);
    const stateFile = join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json');
    const before = readFileSync(stateFile, 'utf8');
    let confirmations = 0;
    for (const approvalEnabled of [true, false]) {
      const deps = {
        workspaceRoot: workspace, hostState: pipeline.hostState,
        scopeAmendmentManager: pipeline.scopeManager, planMode: false,
        config: { ...env.config, approvalEnabled },
        confirm: async () => { confirmations += 1; return true; },
      };
      const denied = JSON.parse(await runToolCall({
        tool: 'write_file', path: 'blocked.txt', content: 'must not be written',
      }, deps));
      assert.match(denied.error, /plan mode aktif/i);
      const read = await runToolCall({ tool: 'read_file', path: 'readable.txt' }, deps);
      assert.match(read, /read-only content/);
    }
    assert.equal(confirmations, 0);
    assert.deepEqual(readdirSync(workspace), ['readable.txt']);
    assert.equal(readFileSync(stateFile, 'utf8'), before);
  });

  test('resume resets ACT scope and /plan off bootstraps a fresh contract', async () => {
    await handleCommand('/plan off', env);
    const originalCorrelation = pipeline.hostState.approvalScope!.correlationId;
    await pipeline.releaseLock();
    pipeline = await bootstrapSecurityPipeline({
      sessionId: pipeline.sessionId, workspaceRoot: workspace, isTTY: false,
    });
    agent.setHostState(pipeline.hostState);
    agent.setScopeAmendmentManager(pipeline.scopeManager);
    assert.equal(agent.planMode, true);
    assert.equal(pipeline.hostState.approvalScope, null);
    await handleCommand('/plan off', env);
    assert.deepEqual(agent.getHostState()?.approvalScope?.allowedPaths, ['.']);
    assert.notEqual(agent.getHostState()?.approvalScope?.correlationId, originalCorrelation);
    assert.equal((await pipeline.evaluateToolCall('write_file', { path: 'resumed.txt' }, false)).allowed, true);
  });

  test('TTY amendment reuses the pipeline lock and /scope reset revokes the shared amended state', async () => {
    mkdirSync(join(workspace, 'src'));
    mkdirSync(join(workspace, 'docs'));
    await handleCommand('/scope allow src', env);
    await handleCommand('/plan off', env);
    const manager = new ScopeAmendmentManager(pipeline.hostState, workspace, {
      sessionLock: pipeline.fileLock, isTTY: true,
      input: Readable.from(['y\n']),
      output: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    });
    agent.setScopeAmendmentManager(manager);
    assert.equal(await manager.evaluateMutationTarget('docs/readme.md', 'update docs', true), true);
    assert.strictEqual(manager.getState(), pipeline.hostState);
    assert.ok(pipeline.hostState.approvalScope!.allowedPaths.includes('docs/readme.md'));
    await handleCommand('/scope reset', env);
    assert.equal(await manager.evaluateMutationTarget('src/main.ts', 'after reset', false), false);
    assert.equal(pipeline.hostState.approvalScope, null);
  });

  test('/scope allow accepts a new subtree and permits new nested files only inside it', async () => {
    await handleCommand('/scope allow generated', env);
    assert.deepEqual(pipeline.hostState.approvalScope?.allowedPaths, ['generated']);
    await handleCommand('/plan off', env);
    assert.equal((await pipeline.evaluateToolCall('write_file', { path: 'generated/nested/new.ts' }, false)).allowed, true);
    assert.equal((await pipeline.evaluateToolCall('write_file', { path: 'generated-other/new.ts' }, false)).allowed, false);
  });

  test('workspace scope denies path traversal and parent symlink escape in non-TTY mode', async (t) => {
    const outside = join(root, 'outside');
    mkdirSync(outside);
    if (!tryCreateSymlink(outside, join(workspace, 'escape'))) {
      t.skip('Platform does not support directory symlinks');
      return;
    }
    await handleCommand('/plan off', env);
    for (const target of ['../outside/escaped.txt', 'escape/escaped.txt', 'escape/new/deep.txt']) {
      const decision = await pipeline.evaluateToolCall('write_file', { path: target }, false);
      assert.equal(decision.allowed, false, target);
      assert.match(decision.reason!, target.startsWith('..') ? /\[SCOPE_OUTSIDE_WORKSPACE\]/ : /\[SCOPE_CONTAINMENT\]/);
      assert.ok(decision.reason!.includes(`Target: ${target}`));
      assert.doesNotMatch(decision.reason!, /\/scope allow|\/yolo/);
    }
    const scopeBefore = pipeline.hostState.approvalScope;
    await handleCommand('/scope allow ../outside', env);
    await handleCommand('/scope allow escape', env);
    await handleCommand('/scope allow escape/new/subtree', env);
    assert.strictEqual(pipeline.hostState.approvalScope, scopeBefore);
  });

  test('scope denial distinguishes lexical workspace escape without suggesting broader permissions', async () => {
    await handleCommand('/plan off', env);
    const stateFile = join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json');
    const before = readFileSync(stateFile, 'utf8');
    const result = JSON.parse(await runToolCall({
      tool: 'write_file', path: '../outside.txt', content: 'blocked',
    }, {
      workspaceRoot: workspace, hostState: pipeline.hostState,
      scopeAmendmentManager: pipeline.scopeManager, config: env.config,
    }));
    assert.match(result.error, /\[SCOPE_OUTSIDE_WORKSPACE\]/);
    assert.match(result.error, /di luar workspace/i);
    assert.match(result.error, /Target: \.\.\/outside\.txt/);
    assert.doesNotMatch(result.error, /\/scope allow|\/yolo/);
    assert.equal(existsSync(join(root, 'outside.txt')), false);
    assert.equal(readFileSync(stateFile, 'utf8'), before);
  });

  test('invalid /scope inputs leave mode and authorization unchanged', async () => {
    await handleCommand('/plan off', env);
    const before = readFileSync(join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json'), 'utf8');
    for (const input of ['/scope allow', '/scope unknown', '/scope status extra', '/scope reset extra']) {
      await handleCommand(input, env);
    }
    assert.equal(readFileSync(join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json'), 'utf8'), before);
    assert.equal(agent.planMode, false);
  });

  test('/scope does not grant authorization when the pipeline no longer owns its session lock', async () => {
    await pipeline.releaseLock();
    await handleCommand('/scope allow .', env);
    assert.equal(pipeline.hostState.approvalScope, null);
    assert.equal((await loadHostState(pipeline.sessionId, { resume: false })).approvalScope, null);
  });

  test('scope amendment revalidates plan authorization after the user prompt', async () => {
    mkdirSync(join(workspace, 'src'));
    await handleCommand('/scope allow src', env);
    await handleCommand('/plan off', env);
    const changedState = await loadHostState(pipeline.sessionId, { resume: false });
    changedState.activePlanHash = 'changed-plan';
    await saveHostState(changedState);
    const manager = new ScopeAmendmentManager(pipeline.hostState, workspace, {
      sessionLock: pipeline.fileLock, isTTY: true,
      input: Readable.from(['y\n']),
      output: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    });
    const decision = await manager.evaluateMutationDecision('docs/new.ts', 'new plan', true);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.code, 'SCOPE_PLAN_CHANGED');
    const saved = await loadHostState(pipeline.sessionId, { resume: false });
    assert.deepEqual(saved.approvalScope?.allowedPaths, ['src']);
    assert.equal(await manager.evaluateMutationTarget('src/main.ts', 'stale in-memory scope', false), false);
  });

  test('/scope allow does not expand live permissions when persistence fails', async (t) => {
    mkdirSync(join(workspace, 'src'));
    mkdirSync(join(workspace, 'docs'));
    await handleCommand('/scope allow src', env);
    t.mock.method(fsPromises, 'rename', async () => {
      throw Object.assign(new Error('test disk full'), { code: 'ENOSPC' });
    });
    await handleCommand('/scope allow docs', env);
    assert.deepEqual(pipeline.hostState.approvalScope?.allowedPaths, ['src']);
    assert.deepEqual((await loadHostState(pipeline.sessionId, { resume: false })).approvalScope?.allowedPaths, ['src']);
  });

  test('/plan off stays fail-closed when scope persistence fails', async (t) => {
    t.mock.method(fsPromises, 'rename', async () => {
      throw Object.assign(new Error('test disk full'), { code: 'ENOSPC' });
    });
    await assert.rejects(handleCommand('/plan off', env), /test disk full/);
    assert.equal(agent.planMode, true);
    assert.equal(pipeline.hostState.mode, 'plan');
    assert.equal(pipeline.hostState.approvalScope, null);
    assert.equal((await loadHostState(pipeline.sessionId, { resume: false })).mode, 'plan');
  });

  for (const route of ['command', 'agent-auto', 'repl-auto'] as const) {
    test(`host state save failure is reported once and stops ${route} before execution`, async (t) => {
      const failure = Object.assign(new Error('test disk full'), { code: 'ENOSPC' });
      const rename = t.mock.method(fsPromises, 'rename', async () => { throw failure; });
      const logs: string[] = [];
      t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
      const chat = t.mock.method(provider, 'chat');
      env.ctx.add('assistant', '1. Buat file\n2. Baca struktur');
      const stateFile = join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json');
      const before = readFileSync(stateFile, 'utf8');
      if (route === 'agent-auto') {
        await assert.rejects(agent.handleInstruction('1'), (err: unknown) => {
          assert.ok(err instanceof Error);
          assert.match(err.message, /HOST_STATE_SAVE_FAILED.*saveHostState.*PLAN.*ACT.*ENOSPC.*test disk full/);
          assert.equal(err.cause, failure);
          return true;
        });
        assert.deepEqual(logs, [], 'direct callers own error reporting');
      } else {
        const loop = new SystemLoop(env.ctx, agent, env.config, join(root, 'config.json'), pipeline);
        const turn = t.mock.method(loop as any, 'runTurn', async () => {});
        await (loop as any).handleLine(route === 'command' ? '/plan off' : '1');
        assert.equal(logs.length, 1);
        assert.match(logs[0], /\[error\].*HOST_STATE_SAVE_FAILED.*saveHostState.*PLAN.*ACT.*ENOSPC/);
        assert.equal(turn.mock.callCount(), 0);
      }
      assert.equal(chat.mock.callCount(), 0);
      assert.equal(rename.mock.callCount(), 1);
      assert.equal(agent.planMode, true);
      assert.equal(pipeline.hostState.mode, 'plan');
      assert.equal(pipeline.hostState.approvalScope, null);
      assert.equal(readFileSync(stateFile, 'utf8'), before);
    });
  }

  test('slash PLAN transitions and both auto-off paths each persist host state only once', async (t) => {
    const rename = t.mock.method(fsPromises, 'rename');
    await handleCommand('/plan off', env);
    assert.equal(rename.mock.callCount(), 1);
    await handleCommand('/plan on', env);
    assert.equal(rename.mock.callCount(), 2);
    env.ctx.add('assistant', '1. Kerjakan file\n2. Lihat struktur');
    await agent.handleInstruction('1');
    assert.equal(rename.mock.callCount(), 3);
    await handleCommand('/plan on', env);
    const loop = new SystemLoop(env.ctx, agent, env.config, join(root, 'config.json'), pipeline);
    t.mock.method(loop as any, 'runTurn', async () => {});
    await (loop as any).handleLine('1');
    assert.equal(rename.mock.callCount(), 5);
  });

  for (const initialMode of ['plan', 'act'] as const) {
    test(`/plan rejects invalid arguments without changing ${initialMode.toUpperCase()} authorization`, async (t) => {
      if (initialMode === 'act') await handleCommand('/plan off', env);
      const transition = t.mock.method(agent, 'setPlanMode');
      const logs: string[] = [];
      t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
      const stateFile = join(process.env.RUKO_HOST_STATE_DIR!, pipeline.sessionId, 'state.json');
      const before = readFileSync(stateFile, 'utf8');
      const scopeBefore = pipeline.hostState.approvalScope;
      const configBefore = { ...env.config };
      for (const args of ['xyz', 'true', 'false', '0', 'on extra', 'off extra', 'on off']) {
        logs.length = 0;
        await handleCommand(`/plan ${args}`, env);
        assert.match(stripAnsi(logs.join('\n')), /Error:.*\/plan.*on.*off/);
        assert.equal(pipeline.hostState.mode, initialMode, args);
        assert.equal(agent.planMode, initialMode === 'plan', args);
        assert.strictEqual(pipeline.hostState.approvalScope, scopeBefore, args);
        assert.equal(readFileSync(stateFile, 'utf8'), before, args);
        assert.deepEqual(env.config, configBefore);
      }
      assert.equal(transition.mock.callCount(), 0);
    });
  }

  test('/plan accepts on, off, and empty toggles with existing case and whitespace handling', async () => {
    for (const [command, mode] of [
      ['/plan', 'act'], ['/plan   ', 'plan'], ['/plan OFF', 'act'],
      ['/plan   On  ', 'plan'], ['/plan off', 'act'], ['/plan on', 'plan'],
    ] as const) {
      await handleCommand(command, env);
      assert.equal(pipeline.hostState.mode, mode, command);
      const saved = await loadHostState(pipeline.sessionId, { resume: false });
      assert.equal(saved.mode, mode);
      if (mode === 'act') assert.deepEqual(saved.approvalScope?.allowedPaths, ['.']);
      else assert.equal(saved.approvalScope, null);
    }
  });

  test('compiled CLI accepts scope commands and persists the final ACT contract', async () => {
    const home = join(root, 'cli-home');
    mkdirSync(home);
    const child = spawn(process.execPath, [CLI_ENTRY, '--trust-folder'], {
      cwd: workspace,
      env: rukoEnv({
        HOME: home, USERPROFILE: home, RUKO_HOST_STATE_DIR: join(root, 'cli-host'),
        RUKO_NO_ANIM: '1', RUKO_CONFIG: join(root, 'unused-config.json'),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let sent = false;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (!sent && stdout.includes('/? untuk bantuan')) {
        sent = true;
        child.stdin.write('/scope status\n/plan off\n/scope reset\n/scope allow generated\n/scope status\n/exit\n');
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`CLI timeout: ${stdout}\n${stderr}`));
        }, 10_000);
        child.once('error', (err) => { clearTimeout(timer); reject(err); });
        child.once('close', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
      });
      assert.equal(code, 0, stderr);
      assert.match(stdout, /Scope: \(none\)/);
      assert.match(stdout, /Scope: generated/);
      assert.doesNotMatch(stdout + stderr, /Perintah tidak dikenal|\[error\]|LOCK_TIMEOUT/);
      const sessions = readdirSync(join(root, 'cli-host'));
      assert.equal(sessions.length, 1);
      const saved = JSON.parse(readFileSync(join(root, 'cli-host', sessions[0], 'state.json'), 'utf8'));
      assert.equal(saved.mode, 'act');
      assert.deepEqual(saved.approvalScope.allowedPaths, ['generated']);
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  test('fresh compiled non-TTY CLI /plan off executes a real workspace write through the provider', async () => {
    const home = join(root, 'write-cli-home');
    const hostDir = join(root, 'write-cli-host');
    mkdirSync(home);
    const requests: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    let stateAtRequest: HostState | undefined;
    const server = createServer((req, res) => {
      if (req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        requests.push(JSON.parse(body));
        if (requests.length === 1) {
          const sessions = readdirSync(hostDir);
          stateAtRequest = JSON.parse(readFileSync(join(hostDir, sessions[0], 'state.json'), 'utf8'));
        }
        // Local deterministic fixture; no external model or real credential is used.
        const message = requests.length === 1
          ? {
            content: null,
            tool_calls: [{
              id: 'call_scope_write', type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({ path: 'cli.txt', content: 'verified CLI workspace write' }),
              },
            }],
          }
          : { content: 'scope-write-complete.' };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }],
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const child = spawn(process.execPath, [
      CLI_ENTRY, '--trust-folder', '--provider', 'openai-compatible',
      '--base-url', `http://127.0.0.1:${address.port}/v1`, '--model', 'scope-feedback-test',
    ], {
      cwd: workspace,
      env: rukoEnv({
        HOME: home, USERPROFILE: home, RUKO_HOST_STATE_DIR: hostDir,
        RUKO_NO_ANIM: '1', RUKO_CONFIG: join(root, 'missing-write-config.json'),
        OPENAI_API_KEY: 'ruko-local-test-placeholder',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let sent = false;
    let startupMode: string | undefined;
    let startupScope: unknown;
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (!sent && stdout.includes('/? untuk bantuan')) {
        sent = true;
        const sessions = readdirSync(hostDir);
        const initial = JSON.parse(readFileSync(join(hostDir, sessions[0], 'state.json'), 'utf8'));
        startupMode = initial.mode;
        startupScope = initial.approvalScope;
        child.stdin.write('/plan off\nBuat cli.txt\n/exit\n');
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Write CLI timeout: ${stdout}\n${stderr}`));
        }, 10_000);
        child.once('error', (err) => { clearTimeout(timer); reject(err); });
        child.once('close', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
      });
      assert.equal(code, 0, stderr);
      assert.equal(startupMode, 'plan');
      assert.equal(startupScope, null);
      assert.equal(stateAtRequest?.mode, 'act');
      assert.deepEqual(stateAtRequest?.approvalScope?.allowedPaths, ['.']);
      assert.equal(requests.length, 2);
      const toolResult = requests[1].messages.find((message) => message.role === 'tool');
      assert.ok(toolResult?.content, 'provider must receive the actual tool result');
      const resultPrefix = 'Result of tool "write_file":\n';
      assert.ok(toolResult.content.startsWith(resultPrefix));
      assert.equal(JSON.parse(toolResult.content.slice(resultPrefix.length)).error, undefined);
      assert.equal(readFileSync(join(workspace, 'cli.txt'), 'utf8'), 'verified CLI workspace write');
      assert.match(stdout, /scope-write-complete/);
      assert.doesNotMatch(stdout + stderr, /SECURITY_DENIED|\[error\]|Izinkan amandemen/);
      const sessions = readdirSync(hostDir);
      assert.equal(sessions.length, 1);
      const saved = JSON.parse(readFileSync(join(hostDir, sessions[0], 'state.json'), 'utf8'));
      assert.equal(saved.mode, 'act');
      assert.deepEqual(saved.approvalScope.allowedPaths, ['.']);
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    }
  });
});
