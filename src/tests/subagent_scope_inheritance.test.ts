import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runSubagent } from '../agent/subagent.js';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { AgentConfig, ContextMessage, DEFAULT_CONFIG } from '../types.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';
import { bootstrapSecurityPipeline } from '../core/securityPipeline.js';
import { saveHostState } from '../core/state/hostState.js';
import { runToolCall } from '../agent/tools.js';

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

describe('Subagent Scope Inheritance & Subtree Boundary Containment', () => {
  let tmpDir: string;
  let hostDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruko-subagent-scope-'));
    hostDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(hostDir, { recursive: true });
    originalEnv = process.env.RUKO_HOST_STATE_DIR;
    process.env.RUKO_HOST_STATE_DIR = hostDir;

    // Create directories
    fs.mkdirSync(path.join(tmpDir, 'src', 'frontend'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'backend'), { recursive: true });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.RUKO_HOST_STATE_DIR = originalEnv;
    } else {
      delete process.env.RUKO_HOST_STATE_DIR;
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test('Subagent CANNOT mutate outside parent approved subtree even with a distinct delegated task', async () => {
    const pipeline = await bootstrapSecurityPipeline({
      sessionId: 'sess-sub-01',
      workspaceRoot: tmpDir,
      resume: false,
      isTTY: false,
    });

    try {
      // Parent is in ACT mode with scope strictly limited to 'src/frontend'
      pipeline.hostState.mode = 'act';
      pipeline.hostState.approvalScope = {
        allowedPaths: ['src/frontend'],
        planHash: 'hash-frontend-only',
        approvedAt: new Date().toISOString(),
        correlationId: 'corr-01',
      };
      await saveHostState(pipeline.hostState);

      // Subagent is delegated a task to touch the backend
      const llm = new ScriptedProvider([
        '```tool\n{"tool": "write_file", "path": "src/backend/db.ts", "content": "export const pwned = 1;"}\n```',
        'Saya telah mencoba memodifikasi backend db.ts.',
      ]);

      const subResult = await runSubagent(
        'Refactor backend database helper to export pwned',
        {
          config: { ...DEFAULT_CONFIG, approvalEnabled: false },
          llmProvider: llm,
          hostState: pipeline.hostState,
          scopeAmendmentManager: pipeline.scopeManager,
        },
        {
          workspaceRoot: tmpDir,
          depth: 1,
        },
      );

      // Verify that the subagent output reflects rejection
      assert.ok(
        subResult.includes('backend db.ts') || subResult.includes('di luar scope'),
        `Subagent should complete turn with report: ${subResult}`,
      );

      // CRITICAL: File must NOT be created outside the approved subtree
      const forbiddenFile = path.join(tmpDir, 'src', 'backend', 'db.ts');
      assert.equal(fs.existsSync(forbiddenFile), false, 'Subagent must NOT be able to mutate outside parent allowed subtree');
    } finally {
      await pipeline.releaseLock();
    }
  });

  test('Subagent CAN mutate inside parent approved subtree', async () => {
    const pipeline = await bootstrapSecurityPipeline({
      sessionId: 'sess-sub-02',
      workspaceRoot: tmpDir,
      resume: false,
      isTTY: false,
    });

    try {
      // Parent approved subtree includes 'src/frontend'
      pipeline.hostState.mode = 'act';
      pipeline.hostState.approvalScope = {
        allowedPaths: ['src/frontend'],
        planHash: 'hash-frontend-only',
        approvedAt: new Date().toISOString(),
        correlationId: 'corr-02',
      };
      await saveHostState(pipeline.hostState);

      const llm = new ScriptedProvider([
        '```tool\n{"tool": "write_file", "path": "src/frontend/Button.tsx", "content": "export const Button = () => <button/>;"}\n```',
        'Selesai membuat komponen Button.',
      ]);

      const subResult = await runSubagent(
        'Create Button component in frontend',
        {
          config: { ...DEFAULT_CONFIG, approvalEnabled: false },
          llmProvider: llm,
          hostState: pipeline.hostState,
          scopeAmendmentManager: pipeline.scopeManager,
        },
        {
          workspaceRoot: tmpDir,
          depth: 1,
        },
      );

      assert.ok(subResult.includes('Selesai membuat komponen Button'));

      // File within approved subtree MUST be created
      const allowedFile = path.join(tmpDir, 'src', 'frontend', 'Button.tsx');
      assert.equal(fs.existsSync(allowedFile), true, 'Subagent must be able to mutate within parent approved subtree');
      assert.equal(fs.readFileSync(allowedFile, 'utf8'), 'export const Button = () => <button/>;');
    } finally {
      await pipeline.releaseLock();
    }
  });

  test('Subagent inherits Plan Mode and is blocked from any mutations', async () => {
    const pipeline = await bootstrapSecurityPipeline({
      sessionId: 'sess-sub-03',
      workspaceRoot: tmpDir,
      resume: false,
      isTTY: false,
    });

    try {
      // HostState remains in Plan Mode (default)
      assert.equal(pipeline.hostState.mode, 'plan');

      const llm = new ScriptedProvider([
        '```tool\n{"tool": "write_file", "path": "src/frontend/App.tsx", "content": "hello"}\n```',
        'Ditolak karena plan mode.',
      ]);

      await runSubagent(
        'Add App component',
        {
          config: { ...DEFAULT_CONFIG, approvalEnabled: false },
          llmProvider: llm,
          hostState: pipeline.hostState,
          scopeAmendmentManager: pipeline.scopeManager,
        },
        {
          workspaceRoot: tmpDir,
          planMode: true,
          depth: 1,
        },
      );

      // Verify file was NOT created
      const file = path.join(tmpDir, 'src', 'frontend', 'App.tsx');
      assert.equal(fs.existsSync(file), false, 'Plan Mode subagent must not write files');
    } finally {
      await pipeline.releaseLock();
    }
  });

  test('Parent Agent running tool delegate passes inherited scope to subagent seamlessly', async () => {
    const pipeline = await bootstrapSecurityPipeline({
      sessionId: 'sess-sub-04',
      workspaceRoot: tmpDir,
      resume: false,
      isTTY: false,
    });

    try {
      pipeline.hostState.mode = 'act';
      pipeline.hostState.approvalScope = {
        allowedPaths: ['src/frontend'],
        planHash: 'hash-frontend',
        approvedAt: new Date().toISOString(),
        correlationId: 'corr-04',
      };
      await saveHostState(pipeline.hostState);

      // Subagent LLM tries to write outside scope
      const subLlm = new ScriptedProvider([
        '```tool\n{"tool": "write_file", "path": "src/backend/server.ts", "content": "evil"}\n```',
        'Selesai subagent.',
      ]);

      const delegateResult = await runToolCall(
        {
          tool: 'delegate',
          task: 'Touch backend server',
        },
        {
          config: { ...DEFAULT_CONFIG, approvalEnabled: false },
          llmProvider: subLlm,
          workspaceRoot: tmpDir,
          hostState: pipeline.hostState,
          scopeAmendmentManager: pipeline.scopeManager,
        },
      );

      const parsed = JSON.parse(delegateResult);
      assert.equal(parsed.ok, true);

      // Ensure forbidden file was not created
      const forbiddenFile = path.join(tmpDir, 'src', 'backend', 'server.ts');
      assert.equal(fs.existsSync(forbiddenFile), false, 'Delegated subagent must not violate parent scope');
    } finally {
      await pipeline.releaseLock();
    }
  });
});
