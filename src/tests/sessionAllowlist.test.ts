import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('Issue #38-1: symlink escape tidak pernah menghasilkan grant "always"', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-allowlist-symlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'ruko-allowlist-escape-'));
  t.after(() => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(join(outside, 'passwd'), 'root:x:0:0');
  try {
    symlinkSync(outside, join(ws, 'esc'), 'dir');
  } catch {
    return t.skip('Symlinks not supported in environment');
  }

  const allowlist = new SessionApprovalAllowlist();

  // Relatif: ws/esc/passwd secara fisik berada di luar workspace.
  const relative: ApprovalRequest = {
    kind: 'start_process', cwd: ws, workspaceRoot: ws, command: 'cat esc/passwd',
  };
  assert.equal(allowlist.canRemember('start_process cat esc/passwd', relative), false,
    'path relatif melalui symlink keluar wajib ditolak');
  assert.equal(allowlist.remember('start_process cat esc/passwd', relative), false,
    'grant tidak boleh tersimpan');
  assert.equal(allowlist.allows('start_process cat esc/passwd', relative), false);

  // Absolut melalui symlink yang sama.
  const linkAbs = process.platform === 'win32'
    ? join(ws, 'esc').replace(/\\/g, '/')
    : join(ws, 'esc');
  const absolute: ApprovalRequest = {
    kind: 'start_process', cwd: ws, workspaceRoot: ws, command: `cat ${linkAbs}/passwd`,
  };
  assert.equal(allowlist.canRemember(`start_process cat ${linkAbs}/passwd`, absolute), false,
    'path absolut melalui symlink keluar wajib ditolak');

  // Kontrol positif: jalur fisik biasa di dalam workspace tetap dapat di-grant.
  mkdirSync(join(ws, 'src'));
  const control: ApprovalRequest = {
    kind: 'start_process', cwd: ws, workspaceRoot: ws, command: 'cat src/file.txt',
  };
  assert.equal(allowlist.remember('start_process cat src/file.txt', control), true,
    'kontrol: path dalam workspace tetap rememberable');
  assert.equal(allowlist.allows('start_process cat src/file.txt', control), true);
});

test('Issue #38-3: prefix launcher & env-assignment tidak mengelabui denylist / git-push guard', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-allowlist-launcher-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  mkdirSync(join(ws, 'src'));
  const allowlist = new SessionApprovalAllowlist();

  // Matriks: nohup / env / VAR=val / kombinasi dengan git push & shell.
  const denied = [
    'nohup git push origin main',
    'env git push origin main',
    'FOO=bar git push origin main',
    'nohup FOO=bar git push origin main',
    'timeout 5 git push origin main',
    'nice -n 5 git push origin main',
    'stdbuf -oL git push origin main',
    'nohup bash script.sh',
    'FOO=bar bash script.sh',
    'nohup node server.js',
    'FOO=bar python worker.py',
    'chroot / git push origin main',
    'FOO=bar',
  ];
  for (const command of denied) {
    for (const kind of ['start_process', 'exec'] as const) {
      const request: ApprovalRequest = { kind, cwd: ws, workspaceRoot: ws, command };
      const display = kind === 'start_process' ? `start_process ${command}` : command;
      assert.equal(allowlist.canRemember(display, request), false,
        `${kind}: "${command}" tidak boleh ditawarkan sebagai always`);
      assert.equal(allowlist.remember(display, request), false,
        `${kind}: "${command}" tidak boleh tersimpan`);
      assert.equal(allowlist.allows(display, request), false);
    }
  }

  // Kontrol positif: wrapper pada perintah aman TIDAK ikut terblokir.
  for (const command of [
    'nohup git status',
    'env git status',
    'FOO=bar git status',
    'timeout 5 git status',
    'nohup FOO=bar git status',
  ]) {
    const request: ApprovalRequest = { kind: 'start_process', cwd: ws, workspaceRoot: ws, command };
    const display = `start_process ${command}`;
    assert.equal(allowlist.allows(display, request), false, `approval pertama tetap wajib: ${command}`);
    assert.equal(allowlist.remember(display, request), true, `kontrol positif: ${command}`);
    assert.equal(allowlist.allows(display, request), true, command);
  }

  // exec tetap mensyaratkan pola berbahaya pada bentuk asli.
  const execSafe: ApprovalRequest = { kind: 'exec', cwd: ws, workspaceRoot: ws, command: 'nohup echo hello' };
  assert.equal(allowlist.canRemember('nohup echo hello', execSafe), false,
    'exec non-dangerous tetap ditolak untuk always');
  const execDangerous: ApprovalRequest = { kind: 'exec', cwd: ws, workspaceRoot: ws, command: 'nohup echo git push' };
  assert.equal(allowlist.canRemember('nohup echo git push', execDangerous), true,
    'kontrol: pola dangerous tetap terdeteksi setelah prefix dilepas');
  const execOperator: ApprovalRequest = { kind: 'exec', cwd: ws, workspaceRoot: ws, command: 'nohup echo git push && true' };
  assert.equal(allowlist.canRemember('nohup echo git push && true', execOperator), false,
    'operator shell tetap ditolak untuk always');
});

test('tokenizer git-push: bentuk berglobal-flag bernilai (termasuk --config-env) tidak dapat diingat sebagai always', (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-allowlist-gitpush-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const allowlist = new SessionApprovalAllowlist();

  const denied = [
    'git -C . push origin main',
    'git -c user.name=x push origin main',
    'git --config-env user.name=MY_ENV push origin main',
    'git --config-env=user.name=MY_ENV push origin main',
    // COMMIT 2: semua `--config-env` (termasuk key yang tampak aman) dan bentuk
    // tempel `-c<key>=<value>` menyuntikkan config yang tidak dapat diverifikasi.
    'git --config-env user.name=MY_ENV status',
    'git -ccore.fsmonitor=/tmp/M status',
    'git --git-dir=.git push origin main',
    'git --work-tree=/tmp/wt push origin main',
    'git --namespace=ns push origin main',
  ];
  for (const command of denied) {
    for (const kind of ['start_process', 'exec'] as const) {
      const request: ApprovalRequest = { kind, cwd: ws, workspaceRoot: ws, command };
      const display = kind === 'start_process' ? `start_process ${command}` : command;
      assert.equal(allowlist.canRemember(display, request), false,
        `${kind}: "${command}" tidak boleh ditawarkan sebagai always`);
      assert.equal(allowlist.remember(display, request), false,
        `${kind}: "${command}" tidak boleh tersimpan`);
      assert.equal(allowlist.allows(display, request), false);
    }
  }

  // Kontrol positif: bentuk non-push dengan flag bernilai yang sama tetap rememberable.
  // (`--config-env` DIPROMOSI ke daftar denied di atas oleh COMMIT 2.)
  for (const command of ['git -C . status', 'git -c user.name=x status']) {
    const request: ApprovalRequest = { kind: 'start_process', cwd: ws, workspaceRoot: ws, command };
    const display = `start_process ${command}`;
    assert.equal(allowlist.remember(display, request), true, `kontrol positif: ${command}`);
  }
});
