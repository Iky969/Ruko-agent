import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { revertFile, takeSnapshot } from '../core/undo.js';
import { runToolCall, setWorkspaceRoot } from '../agent/tools.js';
import { DEFAULT_CONFIG } from '../types.js';

function inTempWorkspace<T>(fn: (ws: string) => Promise<T> | T): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-revert-test-'));
  const prev = process.cwd();
  process.chdir(ws);
  setWorkspaceRoot(ws);
  return Promise.resolve(fn(ws)).finally(() => {
    setWorkspaceRoot(null);
    process.chdir(prev);
    rmSync(ws, { recursive: true, force: true });
  });
}

test('revertFile restores specific file from snapshot even with multiple files modified', async () => {
  await inTempWorkspace((ws) => {
    const fileA = join(ws, 'a.txt');
    const fileB = join(ws, 'b.txt');

    writeFileSync(fileA, 'a-original', 'utf8');
    writeFileSync(fileB, 'b-original', 'utf8');

    takeSnapshot(fileA);
    writeFileSync(fileA, 'a-edited', 'utf8');

    takeSnapshot(fileB);
    writeFileSync(fileB, 'b-edited', 'utf8');

    // Revert only fileA
    const resA = revertFile(fileA, { workspaceRoot: ws });
    assert.equal(resA.ok, true);
    assert.equal(resA.action, 'restored');
    assert.equal(resA.source, 'snapshot');
    assert.equal(readFileSync(fileA, 'utf8'), 'a-original');
    // fileB remains modified
    assert.equal(readFileSync(fileB, 'utf8'), 'b-edited');

    // Revert fileB
    const resB = revertFile(fileB, { workspaceRoot: ws });
    assert.equal(resB.ok, true);
    assert.equal(readFileSync(fileB, 'utf8'), 'b-original');
  });
});

test('revertFile deletes newly created file from snapshot', async () => {
  await inTempWorkspace((ws) => {
    const file = join(ws, 'newfile.txt');
    takeSnapshot(file); // existed: false
    writeFileSync(file, 'created-content', 'utf8');

    const res = revertFile(file, { workspaceRoot: ws });
    assert.equal(res.ok, true);
    assert.equal(res.action, 'deleted');
    assert.equal(res.source, 'snapshot');
    assert.ok(!existsSync(file), 'new file should be removed');
  });
});

test('revertFile falls back to git checkout when in git repo and no snapshot exists', async () => {
  await inTempWorkspace((ws) => {
    try {
      execFileSync('git', ['init'], { cwd: ws, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: ws, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: ws, stdio: 'ignore' });
    } catch {
      // Git not available in test environment, skip git test
      return;
    }

    const tracked = join(ws, 'tracked.txt');
    writeFileSync(tracked, 'git-initial-content', 'utf8');
    execFileSync('git', ['add', 'tracked.txt'], { cwd: ws, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: ws, stdio: 'ignore' });

    // Modify tracked file directly without creating a snapshot
    writeFileSync(tracked, 'git-modified-content', 'utf8');

    const res = revertFile(tracked, { workspaceRoot: ws, mode: 'auto' });
    assert.equal(res.ok, true);
    assert.equal(res.source, 'git');
    assert.equal(res.action, 'reverted_git');
    assert.equal(readFileSync(tracked, 'utf8'), 'git-initial-content');
  });
});

test('revertFile respects mode: snapshot and fails when snapshot is absent', async () => {
  await inTempWorkspace((ws) => {
    const file = join(ws, 'somefile.txt');
    writeFileSync(file, 'content', 'utf8');

    const res = revertFile(file, { workspaceRoot: ws, mode: 'snapshot' });
    assert.equal(res.ok, false);
    assert.ok(res.error?.includes('Tidak ada snapshot undo'));
  });
});

test('tool revert_file restores file through runToolCall', async () => {
  await inTempWorkspace(async (ws) => {
    const target = join(ws, 'src', 'calc.ts');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(target, 'export const add = (a: number, b: number) => a + b;\n', 'utf8');

    // Simulate agent editing the file
    const editResRaw = await runToolCall(
      {
        tool: 'patch_file',
        path: 'src/calc.ts',
        oldText: 'a + b',
        newText: 'a * b',
      },
      { workspaceRoot: ws },
    );
    const editRes = JSON.parse(editResRaw);
    assert.equal(editRes.ok, true);
    assert.equal(readFileSync(target, 'utf8').includes('a * b'), true);

    // Now call revert_file
    const revertResRaw = await runToolCall(
      {
        tool: 'revert_file',
        path: 'src/calc.ts',
      },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
    );
    const revertRes = JSON.parse(revertResRaw);
    assert.equal(revertRes.ok, true);
    assert.equal(revertRes.action, 'restored');
    assert.equal(revertRes.source, 'snapshot');
    assert.equal(readFileSync(target, 'utf8').includes('a + b'), true);
  });
});

test('tool revert_file enforces approval gate when approvalEnabled is true', async () => {
  await inTempWorkspace(async (ws) => {
    const file = join(ws, 'doc.txt');
    writeFileSync(file, 'v1', 'utf8');
    takeSnapshot(file);
    writeFileSync(file, 'v2', 'utf8');

    // Case 1: Rejected by user
    const rejectConfirm = async () => false;
    const resRejectRaw = await runToolCall(
      { tool: 'revert_file', path: 'doc.txt' },
      { confirm: rejectConfirm, workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: true } },
    );
    const resReject = JSON.parse(resRejectRaw);
    assert.ok(resReject.error?.includes('Persetujuan ditolak'));
    assert.equal(readFileSync(file, 'utf8'), 'v2');

    // Case 2: Missing confirm hook in approval mode
    const resMissingRaw = await runToolCall(
      { tool: 'revert_file', path: 'doc.txt' },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: true } },
    );
    const resMissing = JSON.parse(resMissingRaw);
    assert.ok(resMissing.error?.includes('konfirmasi pengguna diperlukan'));

    // Case 3: Approved by user
    let promptSeen = '';
    const acceptConfirm = async (cmd: string) => {
      promptSeen = cmd;
      return true;
    };
    const resAcceptRaw = await runToolCall(
      { tool: 'revert_file', path: 'doc.txt' },
      { confirm: acceptConfirm, workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: true } },
    );
    const resAccept = JSON.parse(resAcceptRaw);
    assert.equal(resAccept.ok, true);
    assert.ok(promptSeen.includes('revert_file doc.txt'));
    assert.equal(readFileSync(file, 'utf8'), 'v1');
  });
});

test('tool revert_file is blocked in plan mode', async () => {
  await inTempWorkspace(async (ws) => {
    const file = join(ws, 'plan.txt');
    writeFileSync(file, 'content', 'utf8');

    const resRaw = await runToolCall(
      { tool: 'revert_file', path: 'plan.txt' },
      { planMode: true, workspaceRoot: ws },
    );
    const res = JSON.parse(resRaw);
    assert.ok(res.error?.includes('plan mode aktif'));
  });
});

test('tool revert_file rejects path traversal and sensitive files', async () => {
  await inTempWorkspace(async (ws) => {
    // Path traversal
    const resTravRaw = await runToolCall(
      { tool: 'revert_file', path: '../../etc/shadow' },
      { workspaceRoot: ws },
    );
    const resTrav = JSON.parse(resTravRaw);
    assert.ok(resTrav.error?.includes('di luar working directory'));

    // Sensitive file
    const resEnvRaw = await runToolCall(
      { tool: 'revert_file', path: '.env' },
      { workspaceRoot: ws },
    );
    const resEnv = JSON.parse(resEnvRaw);
    assert.ok(resEnv.error?.includes('file sensitif'));
  });
});

test('/undo [path] command reverts specified file', async () => {
  const { handleCommand } = await import('../agent/commands.js');
  const { Context } = await import('../core/context.js');

  await inTempWorkspace(async (ws) => {
    const file = join(ws, 'undo-me.txt');
    writeFileSync(file, 'initial', 'utf8');
    takeSnapshot(file);
    writeFileSync(file, 'modified', 'utf8');

    const logged: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logged.push(msg);

    try {
      const env: any = {
        ctx: new Context(DEFAULT_CONFIG),
        config: DEFAULT_CONFIG,
        llm: { model: 'test', isConfigured: true },
        confirm: async () => true,
        updateConfig: () => {},
        handle: { stop: () => {}, getSessionId: () => null, setSessionId: () => {} },
      };

      await handleCommand('/undo undo-me.txt', env);
      assert.equal(readFileSync(file, 'utf8'), 'initial');
      assert.ok(logged.some((l) => l.includes('dikembalikan ke kondisi sebelum edit')));
    } finally {
      console.log = origLog;
    }
  });
});

