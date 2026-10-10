import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runToolCall } from '../agent/tools.js';
import { SessionApprovalAllowlist, type ApprovalRequest } from '../core/approval/sessionAllowlist.js';
import { DEFAULT_CONFIG } from '../types.js';

for (const command of [
  'cat ../outside.txt',
  'cat src/../../outside.txt',
  'cat /etc/passwd',
  'cat ..\\outside.txt',
  'cat C:\\Windows\\win.ini',
  'cat C:/Windows/win.ini',
  'cat --file=../outside.txt',
  'cat --file=/etc/passwd',
  'cat -I/etc',
  '../outside-tool --version',
]) {
  test(`start_process always refuses an out-of-workspace command without storing it: ${command}`, (t) => {
    const ws = mkdtempSync(join(tmpdir(), 'ruko-allowlist-path-'));
    t.after(() => rmSync(ws, { recursive: true, force: true }));
    const allowlist = new SessionApprovalAllowlist();
    const request: ApprovalRequest = { kind: 'start_process', cwd: ws, command };
    const display = `start_process ${command}`;
    assert.equal(allowlist.canRemember(display, request), false, 'always must not be offered');
    assert.equal(allowlist.remember(display, request), false, 'outside command must not be stored');
    assert.equal(allowlist.allows(display, request), false, 'outside command must still require approval');
  });
}

test('start_process always stores workspace-contained paths only after first approval', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-allowlist-local-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  mkdirSync(join(ws, 'src'));
  mkdirSync(join(ws, 'RUNNER~1'));
  const allowlist = new SessionApprovalAllowlist();
  for (const command of [
    'cat src/file.txt',
    'cat ./src/../file.txt',
    'cat --file=src/file.txt',
    'cat RUNNER~1/src.txt',
    'git --version',
  ]) {
    const request: ApprovalRequest = { kind: 'start_process', cwd: ws, command };
    const display = `start_process ${command}`;
    assert.equal(allowlist.allows(display, request), false, `first approval is required: ${command}`);
    assert.equal(allowlist.canRemember(display, request), true, command);
    assert.equal(allowlist.remember(display, request), true, command);
    assert.equal(allowlist.allows(display, request), true, command);
    assert.equal(allowlist.allows(display + ' extra', { ...request, command: command + ' extra' }), false);
  }
});

test('start_process allows absolute paths inside a workspace when command syntax is safely rememberable', (t) => {
  const workspaceRoot = mkdtempSync(join(process.cwd(), 'ruko-allowlist-absolute-'));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  const cwd = workspaceRoot;
  const inWorkspace = join(workspaceRoot, 'inside.txt');
  const normalizedPath = process.platform === 'win32'
    ? inWorkspace.replace(/\\/g, '/')
    : inWorkspace;
  const command = `cat ${normalizedPath}`;
  const allowlist = new SessionApprovalAllowlist();
  const request: ApprovalRequest = { kind: 'start_process', cwd, workspaceRoot, command };
  const display = `start_process ${command}`;
  assert.equal(allowlist.allows(display, request), false, 'first approval is still required');
  assert.equal(allowlist.remember(display, request), true);
  assert.equal(allowlist.allows(display, request), true);
});

test('start_process never remembers shell-leading tilde expansion', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-allowlist-tilde-expansion-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const allowlist = new SessionApprovalAllowlist();
  for (const command of ['cat ~/outside.txt', 'cat file=~/outside.txt']) {
    const request: ApprovalRequest = { kind: 'start_process', cwd: ws, workspaceRoot: ws, command };
    assert.equal(allowlist.canRemember(`start_process ${command}`, request), false, command);
    assert.equal(allowlist.remember(`start_process ${command}`, request), false, command);
  }
});

test('start_process path resolution uses the host workspace boundary from a nested cwd', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-allowlist-cwd-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const cwd = join(ws, 'src');
  mkdirSync(cwd);
  const allowlist = new SessionApprovalAllowlist();
  const command = 'cat ../root.txt';
  const request = { kind: 'start_process' as const, cwd, workspaceRoot: ws, command };
  const display = `start_process ${command}`;
  assert.equal(allowlist.allows(display, request), false);
  assert.equal(allowlist.remember(display, request), true, 'parent is still inside the workspace');
  assert.equal(allowlist.allows(display, request), true);
  const escaping = { ...request, command: 'cat ../../outside.txt' };
  assert.equal(allowlist.remember(`start_process ${escaping.command}`, escaping), false);
  assert.equal(allowlist.allows(`start_process ${escaping.command}`, escaping), false);
});

test('start_process cannot remember a host execution cwd outside the workspace', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ruko-allowlist-outside-cwd-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, 'workspace');
  const cwd = join(root, 'workspace-sibling');
  mkdirSync(workspaceRoot);
  mkdirSync(cwd);
  const request = { kind: 'start_process' as const, cwd, workspaceRoot, command: 'git --version' };
  const allowlist = new SessionApprovalAllowlist();
  assert.equal(allowlist.remember('start_process git --version', request), false);
  assert.equal(allowlist.allows('start_process git --version', request), false);
});

test('start_process first approval receives the host workspace boundary and execution cwd', async (t) => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'ruko-allowlist-host-'));
  t.after(() => rmSync(workspaceRoot, { recursive: true, force: true }));
  const cwd = join(workspaceRoot, 'src');
  mkdirSync(cwd);
  let prompts = 0;
  const result = JSON.parse(await runToolCall({ tool: 'start_process', command: 'git --version', cwd: 'src' }, {
    workspaceRoot, config: { ...DEFAULT_CONFIG, approvalEnabled: true },
    confirm: async (_command, _reason, request) => {
      prompts += 1;
      assert.equal(request?.cwd, cwd);
      assert.equal((request as ApprovalRequest & { workspaceRoot?: string })?.workspaceRoot, workspaceRoot);
      return false;
    },
  }));
  assert.equal(prompts, 1, 'initial approval must not be skipped');
  assert.match(result.error, /Persetujuan ditolak/);
});
