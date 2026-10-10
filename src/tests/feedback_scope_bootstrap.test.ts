import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { Agent } from '../agent/agent.js';
import { buildHelpText, handleCommand, listCommands, matchCommands, type CommandEnv } from '../agent/commands.js';
import type { LLMProvider } from '../agent/llm.js';
import { runToolCall } from '../agent/tools.js';
import { Context } from '../core/context.js';
import { SystemLoop } from '../core/loop.js';
import { ScopeAmendmentManager } from '../core/approval/scopeAmendment.js';
import { bootstrapSecurityPipeline, type SecurityPipeline } from '../core/securityPipeline.js';
import { loadHostState, saveHostState } from '../core/state/hostState.js';
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

  test('/plan on revokes scope and blocks file mutations and subprocesses even with YOLO', async () => {
    await handleCommand('/plan off', env);
    await handleCommand('/plan on', env);
    assert.equal(agent.planMode, true);
    assert.equal(pipeline.hostState.mode, 'plan');
    assert.equal(pipeline.hostState.approvalScope, null);
    const saved = await loadHostState(pipeline.sessionId, { resume: false });
    assert.equal(saved.mode, 'plan');
    assert.equal(saved.approvalScope, null);
    env.config.approvalEnabled = false;
    for (const tool of ['write_file', 'edit_file', 'patch_file', 'delete_file', 'move_file', 'revert_file', 'exec', 'start_process']) {
      const result = JSON.parse(await runToolCall({ tool, path: 'blocked.txt', command: 'git status' }, {
        hostState: pipeline.hostState, scopeAmendmentManager: pipeline.scopeManager,
        workspaceRoot: workspace, config: env.config,
      }));
      assert.match(result.error, /plan mode aktif/i, tool);
    }
    await handleCommand('/plan off', env);
    assert.deepEqual(agent.getHostState()?.approvalScope?.allowedPaths, ['.']);
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
      assert.equal((await pipeline.evaluateToolCall('write_file', { path: target }, false)).allowed, false, target);
    }
    const scopeBefore = pipeline.hostState.approvalScope;
    await handleCommand('/scope allow ../outside', env);
    await handleCommand('/scope allow escape', env);
    await handleCommand('/scope allow escape/new/subtree', env);
    assert.strictEqual(pipeline.hostState.approvalScope, scopeBefore);
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
    assert.equal(await manager.evaluateMutationTarget('docs/new.ts', 'new plan', true), false);
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
});
