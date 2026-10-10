import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../agent/agent.js';
import { runToolCall } from '../agent/tools.js';
import { defaultProcessManager } from '../agent/processManager.js';
import type { LLMProvider } from '../agent/llm.js';
import { guardedExecute, type Confirmer } from '../core/approval.js';
import { SessionApprovalAllowlist, type ApprovalRequest } from '../core/approval/sessionAllowlist.js';
import { ScopeAmendmentManager } from '../core/approval/scopeAmendment.js';
import type { HostState } from '../core/state/hostState.js';
import { Context } from '../core/context.js';
import { SystemLoop } from '../core/loop.js';
import { stripAnsi } from '../core/ui.js';
import { DEFAULT_CONFIG } from '../types.js';

function fixture(answers: Array<string | null>) {
  const config = { ...DEFAULT_CONFIG, approvalAllowlist: [], guardianEnabled: false };
  const ctx = new Context(config);
  const provider: LLMProvider = {
    name: 'approval-test', model: 'test', isConfigured: false,
    setModel() {}, async chat() { return ''; },
  };
  const agent = new Agent(ctx, provider, config);
  const loop = new SystemLoop(ctx, agent, config, 'unused-test-config.json');
  const prompts: Array<{ prompt: string; hideEcho?: boolean }> = [];
  (loop as any).editor = {
    readLine: async (options: { prompt: string; hideEcho?: boolean }) => {
      prompts.push(options);
      assert.ok(answers.length, 'unexpected approval prompt');
      return answers.shift()!;
    },
    close() {},
  };
  const confirm: Confirmer = (loop as any).makeConfirmer();
  return { config, ctx, agent, loop, confirm, prompts };
}

test('always approval runs an exact command and reuses it only in the current loop session', async () => {
  const f = fixture(['a']);
  // Regex marks this harmless echo dangerous; no destructive command is executed.
  const command = 'echo git push';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await guardedExecute(command, { confirm: f.confirm }, f.config);
    assert.equal(result.code, 0);
    assert.match(result.output, /git push/);
  }
  assert.equal(f.prompts.length, 1);
  assert.match(stripAnsi(f.prompts[0].prompt), /\[a\/y\/n\]/i);
  assert.equal(f.prompts[0].hideEcho, true);
  assert.deepEqual(f.config.approvalAllowlist, [], 'session approval must not persist into config');
  const other = fixture(['n']);
  const denied = await guardedExecute(command, { confirm: other.confirm }, other.config);
  assert.equal(denied.code, null);
  assert.equal(other.prompts.length, 1);
});

test('start_process always approval is bound to its actual command and physical cwd', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ruko-session-approval-'));
  t.after(() => { defaultProcessManager.reset(); rmSync(root, { recursive: true, force: true }); });
  const f = fixture(['a']);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = JSON.parse(await runToolCall({ tool: 'start_process', command: 'git --version' }, {
      workspaceRoot: root, config: f.config, confirm: f.confirm,
    }));
    assert.equal(result.ok, true, result.error);
    const proc = defaultProcessManager.getProcess(result.process_id)!;
    assert.equal(proc.command, 'git --version');
    assert.equal(proc.cwd, root);
    if (proc.child?.exitCode === null) await once(proc.child, 'close');
    assert.equal(proc.exitCode, 0);
    assert.match(proc.logs.map((entry) => entry.text).join('\n'), /git version/i);
  }
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(f.config.approvalAllowlist, []);
});

test('once approval does not remember; no, empty input, invalid input and cancellation deny', async () => {
  const f = fixture(['y', 'n', '', 'invalid', null]);
  for (const expected of [0, null, null, null, null]) {
    const result = await guardedExecute('echo git push', { confirm: f.confirm }, f.config);
    assert.equal(result.code, expected);
  }
  assert.equal(f.prompts.length, 5);
  assert.deepEqual(f.config.approvalAllowlist, []);
});

test('configured approvalAllowlist is enforced by guardedExecute for an exact safe test command', async () => {
  const f = fixture([]);
  (f.config as any).approvalAllowlist = ['echo git push'];
  const result = await guardedExecute('echo git push', {
    confirm: async () => { assert.fail('configured allowlist should avoid the prompt'); },
  }, f.config);
  assert.equal(result.code, 0);
  assert.match(result.output, /git push/);
});

test('session matching is exact and separates execution kind and physical cwd', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ruko-exact-approval-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const allowlist = new SessionApprovalAllowlist();
  const command = 'echo git push';
  const request: ApprovalRequest = { kind: 'exec', cwd: process.cwd(), command };
  assert.equal(allowlist.remember(command, request), true);
  assert.equal(allowlist.allows(command, request), true);
  for (const other of [command + ' extra', 'echo git push other', command + ' && git status', command.toUpperCase()]) {
    assert.equal(allowlist.allows(other, { ...request, command: other }), false, other);
  }
  assert.equal(allowlist.allows(command, { ...request, cwd: root }), false);
  assert.equal(allowlist.allows(`start_process ${command}`, { ...request, kind: 'start_process' }), false);
  assert.equal(allowlist.remember('echo safe', request), false, 'display/request mismatch');
  assert.equal(allowlist.remember(command, { ...request, cwd: join(root, 'missing') }), false);
  assert.equal(allowlist.remember(command), false, 'generic confirmations cannot create execution grants');
});

test('destructive and dynamic commands cannot be remembered even after an always answer', async () => {
  const commands = [
    'rm -rf output', 'git reset --hard', 'git clean -fd', 'git push --force origin main',
    'git push origin main', 'git -C repo push origin +main:main', 'git push origin :main', 'git --git-dir=repo push --mirror origin',
    'sudo git status', 'Remove-Item file.txt', 'Clear-Content file.txt', 'shutdown now',
    'mkfs.ext4 /dev/sdb1', 'node -e "console.log(1)"', 'sh script.sh',
    'git push origin main; git status', 'git push $REMOTE main', 'echo %PATH%',
  ];
  const f = fixture(commands.map(() => 'a'));
  const allowlist = new SessionApprovalAllowlist();
  for (const command of commands) {
    const request: ApprovalRequest = { kind: 'exec', cwd: process.cwd(), command };
    assert.equal(allowlist.canRemember(command, request), false, command);
    assert.equal(allowlist.remember(command, request), false, command);
    assert.equal(await f.confirm(command, 'test denial only; never executed', request), false, command);
    assert.doesNotMatch(stripAnsi(f.prompts.at(-1)!.prompt), /\[a\/y\/n\]/i);
  }
  const blocked = await guardedExecute('mkfs.ext4 /dev/sdb1', {
    confirm: async () => { assert.fail('BLOCKED commands must not ask for approval'); },
  }, f.config);
  assert.match(blocked.output, /BLOCKED/);
});

test('new conversation revokes remembered approvals and cannot complete a stale pending approval', async () => {
  const f = fixture(['a', 'n']);
  assert.equal((await guardedExecute('echo git push', { confirm: f.confirm }, f.config)).code, 0);
  await (f.loop as any).handleLine('/new');
  assert.equal((await guardedExecute('echo git push', { confirm: f.confirm }, f.config)).code, null);
  let answer!: (value: string) => void;
  (f.loop as any).editor.readLine = () => new Promise<string>((resolve) => { answer = resolve; });
  const pendingRequest: ApprovalRequest = { kind: 'exec', cwd: process.cwd(), command: 'echo git push' };
  const pending = f.confirm(pendingRequest.command, 'test pending approval', pendingRequest);
  await (f.loop as any).handleLine('/new');
  answer('a');
  assert.equal(await pending, false);
});

test('non-TTY confirmer refuses even a previously remembered command', async () => {
  const f = fixture(['a']);
  const ttyRequest: ApprovalRequest = { kind: 'exec', cwd: process.cwd(), command: 'echo git push' };
  assert.equal(await f.confirm(ttyRequest.command, 'test prompt', ttyRequest), true);
  (f.loop as any).editor = null;
  (f.loop as any).rl = null;
  assert.equal(await f.confirm(ttyRequest.command, 'must not read stdin', ttyRequest), false);
  assert.equal(f.prompts.length, 1);
});

test('remembered execution approval does not bypass host PLAN or missing scope in tool dispatch', async () => {
  const f = fixture(['a']);
  const command = 'echo git push';
  assert.equal((await guardedExecute(command, { confirm: f.confirm }, f.config)).code, 0);
  const hostState: HostState = {
    sessionId: 'approval-gates', mode: 'plan', activePlanHash: null, approvalScope: null,
    sessionTokenHash: 'test-only', updatedAt: new Date().toISOString(),
  };
  const scopeAmendmentManager = new ScopeAmendmentManager(hostState, process.cwd(), { isTTY: false });
  const deps = { hostState, scopeAmendmentManager, confirm: f.confirm, config: f.config };
  assert.match(JSON.parse(await runToolCall({ tool: 'exec', command }, deps)).error, /plan mode aktif/);
  hostState.mode = 'act';
  const denied = JSON.parse(await runToolCall({
    tool: 'write_file', path: 'must-not-exist.txt', content: 'blocked', always: true,
  }, deps));
  assert.match(denied.error, /SCOPE_MISSING/);
  assert.equal(f.prompts.length, 1);
});

test('manual and slash exec obey PLAN even after the same shell command was allowlisted', async (t) => {
  const f = fixture(['a']);
  const command = 'echo git push';
  assert.equal((await guardedExecute(command, { confirm: f.confirm }, f.config)).code, 0);
  f.agent.setConfirm(f.confirm);
  f.agent.planMode = true;
  const manual = await f.agent.handleInstruction(`run ${command}`);
  assert.match(manual, /plan mode aktif/i);
  const logs: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  await (f.loop as any).handleLine(`/exec ${command}`);
  assert.match(logs.join('\n'), /plan mode aktif/i);
  assert.equal(f.prompts.length, 1);
});
