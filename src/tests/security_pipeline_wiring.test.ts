import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { bootstrapSecurityPipeline } from '../core/securityPipeline.js';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { AgentConfig, ContextMessage, DEFAULT_CONFIG } from '../types.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';
import { SystemLoop } from '../core/loop.js';
import { saveHostState } from '../core/state/hostState.js';

class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly isConfigured = true;
  model = 'scripted-model';
  private calls = 0;
  constructor(private readonly replies: string[]) {}
  setModel(model: string): void {
    this.model = model;
  }
  async chat(_messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    options?.onToken?.(reply);
    return reply;
  }
}

describe('P0-1: Security Pipeline Wiring & Anti-Phantom Security', () => {
  let tmpDir: string;
  let hostDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruko-pipeline-test-'));
    hostDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(hostDir, { recursive: true });
    originalEnv = process.env.RUKO_HOST_STATE_DIR;
    process.env.RUKO_HOST_STATE_DIR = hostDir;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.RUKO_HOST_STATE_DIR = originalEnv;
    } else {
      delete process.env.RUKO_HOST_STATE_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('Pipeline bootstrap initializes FileLock, HostState (plan mode), ScopeManager and DispatcherGate', async () => {
    const sessionId = 'test-session-01';
    const pipeline = await bootstrapSecurityPipeline({
      sessionId,
      workspaceRoot: tmpDir,
      resume: false,
      isTTY: false,
    });

    try {
      assert.equal(pipeline.sessionId, sessionId);
      assert.equal(pipeline.workspaceRoot, path.resolve(tmpDir));
      assert.ok(pipeline.fileLock, 'FileLock must be present');
      assert.ok(pipeline.hostState, 'HostState must be present');
      assert.equal(pipeline.hostState.mode, 'plan', 'Default mode must be plan');
      assert.ok(pipeline.scopeManager, 'ScopeManager must be present');

      // DispatcherGate evaluation through pipeline
      const writeDecision = await pipeline.evaluateToolCall('write_file', { path: 'test.txt' }, false);
      assert.equal(writeDecision.allowed, false, 'Mutative tool must be blocked in plan mode');
      assert.match(writeDecision.reason || '', /Plan Mode aktif/i);

      const readDecision = await pipeline.evaluateToolCall('read_file', { path: 'test.txt' }, false);
      assert.equal(readDecision.allowed, true, 'Read-only tool must be allowed in plan mode');
    } finally {
      await pipeline.releaseLock();
    }
  });

  test('Anti-Split-Brain: Two concurrent pipelines on the same session cannot both acquire lock', async () => {
    const sessionId = 'test-session-split-brain';
    const pipeline1 = await bootstrapSecurityPipeline({
      sessionId,
      workspaceRoot: tmpDir,
      timeoutMs: 500,
    });

    try {
      // Second pipeline attempting to acquire the same session lock must fail with LOCK_TIMEOUT
      await assert.rejects(
        async () => {
          await bootstrapSecurityPipeline({
            sessionId,
            workspaceRoot: tmpDir,
            timeoutMs: 200,
          });
        },
        /LOCK_TIMEOUT|kegagalan/i,
        'Second pipeline must fail to acquire lock while pipeline1 holds it',
      );
    } finally {
      await pipeline1.releaseLock();
    }

    // After release, a new pipeline can acquire it
    const pipeline2 = await bootstrapSecurityPipeline({
      sessionId,
      workspaceRoot: tmpDir,
      timeoutMs: 500,
    });
    await pipeline2.releaseLock();
  });

  test('Agent wired with security pipeline rejects mutations during plan mode even if YOLO is ON', async () => {
    const sessionId = 'test-session-agent-wiring';
    const pipeline = await bootstrapSecurityPipeline({
      sessionId,
      workspaceRoot: tmpDir,
      resume: false,
      isTTY: false,
    });

    try {
      const config: AgentConfig = { ...DEFAULT_CONFIG, approvalEnabled: false }; // YOLO mode ON!
      const ctx = new Context(config);
      const llm = new ScriptedProvider([
        '```tool\n{"tool": "write_file", "path": "pwned.txt", "content": "malicious"}\n```',
        'Operasi dibatalkan karena Plan Mode aktif.',
      ]);
      const agent = new Agent(ctx, llm, config, null, tmpDir);

      // Wire pipeline into agent
      agent.setHostState(pipeline.hostState);
      agent.setScopeAmendmentManager(pipeline.scopeManager);

      assert.equal(agent.getHostState()?.mode, 'plan');
      assert.equal(agent.planMode, true, 'Agent planMode must sync with HostState');

      await agent.handleInstruction('Write a file pwned.txt');

      // Verify that agent context recorded rejection by Host Security
      const messages = ctx.toJSON();
      const toolResultMessage = messages.find(
        (m: ContextMessage) => typeof m.content === 'string' && m.content.toLowerCase().includes('plan mode aktif'),
      );
      assert.ok(toolResultMessage, 'Tool call result must contain Plan Mode rejection');

      // Verify file was NOT created on disk
      assert.equal(fs.existsSync(path.join(tmpDir, 'pwned.txt')), false, 'File must not be written to disk');
    } finally {
      await pipeline.releaseLock();
    }
  });

  test('Agent wired with security pipeline allows mutation in ACT mode within approved scope', async () => {
    const sessionId = 'test-session-act-mode';
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

    const pipeline = await bootstrapSecurityPipeline({
      sessionId,
      workspaceRoot: tmpDir,
      resume: false,
      isTTY: false,
    });

    try {
      // Transition host state to ACT mode with approved subtree 'src'
      pipeline.hostState.mode = 'act';
      pipeline.hostState.approvalScope = {
        allowedPaths: ['src'],
        planHash: 'valid-hash',
        approvedAt: new Date().toISOString(),
        correlationId: 'test-corr-id',
      };
      await saveHostState(pipeline.hostState);

      const config: AgentConfig = { ...DEFAULT_CONFIG, approvalEnabled: false };
      const ctx = new Context(config);
      const llm = new ScriptedProvider([
        '```tool\n{"tool": "write_file", "path": "src/allowed.txt", "content": "safe content"}\n```',
        'Selesai menulis file.',
      ]);
      const agent = new Agent(ctx, llm, config, null, tmpDir);

      agent.setHostState(pipeline.hostState);
      agent.setScopeAmendmentManager(pipeline.scopeManager);
      agent.planMode = false;

      await agent.handleInstruction('Write src/allowed.txt');

      // Verify file was created
      assert.equal(fs.existsSync(path.join(tmpDir, 'src', 'allowed.txt')), true, 'File within scope must be written');
      assert.equal(fs.readFileSync(path.join(tmpDir, 'src', 'allowed.txt'), 'utf8'), 'safe content');
    } finally {
      await pipeline.releaseLock();
    }
  });

  test('SystemLoop releases security pipeline lock on stop()', async () => {
    const sessionId = 'test-session-loop-stop';
    const pipeline = await bootstrapSecurityPipeline({
      sessionId,
      workspaceRoot: tmpDir,
      resume: false,
      isTTY: false,
    });

    let lockReleased = false;
    const originalRelease = pipeline.releaseLock;
    pipeline.releaseLock = async () => {
      lockReleased = true;
      return originalRelease.call(pipeline);
    };

    const config: AgentConfig = { ...DEFAULT_CONFIG };
    const ctx = new Context(config);
    const llm = new ScriptedProvider(['hello']);
    const agent = new Agent(ctx, llm, config, null, tmpDir);
    const loop = new SystemLoop(ctx, agent, config, path.join(tmpDir, 'config.json'), pipeline);

    // Call private/internal stop on loop (via any)
    (loop as any).stop();

    assert.equal(lockReleased, true, 'SystemLoop.stop() must release the pipeline lock');
  });

  test('Out-of-scope mutation in ACT mode is rejected fail-closed in headless environment', async () => {
    const sessionId = 'test-session-out-of-scope-fail-closed';
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

    const pipeline = await bootstrapSecurityPipeline({
      sessionId,
      workspaceRoot: tmpDir,
      resume: false,
      isTTY: false,
    });

    try {
      pipeline.hostState.mode = 'act';
      pipeline.hostState.approvalScope = {
        allowedPaths: ['src'],
        planHash: 'valid-hash',
        approvedAt: new Date().toISOString(),
        correlationId: 'test-corr-id',
      };
      await saveHostState(pipeline.hostState);

      // Attempting to evaluate tool call outside allowed scope ('other/file.txt') in headless mode
      const decision = await pipeline.evaluateToolCall('write_file', { path: 'other/file.txt' }, false);
      assert.equal(decision.allowed, false, 'Out-of-scope mutation must be rejected in headless mode');
      assert.match(decision.reason || '', /^SECURITY_DENIED: \[SCOPE_OUTSIDE\]/);
      assert.match(decision.reason || '', /Scope: src/);
      assert.match(decision.reason || '', /Target: other\/file\.txt/);
      assert.match(decision.reason || '', /\/scope allow/);
      assert.deepEqual(pipeline.hostState.approvalScope.allowedPaths, ['src']);
    } finally {
      await pipeline.releaseLock();
    }
  });
});

