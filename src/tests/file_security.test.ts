import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  detectWorkspaceMutationInExec,
  isPathInsideWorkspace,
  runToolCall,
  setWorkspaceRoot,
} from '../agent/tools.js';
import { undoLast } from '../core/undo.js';
import { AgentConfig, DEFAULT_CONFIG } from '../types.js';

function inTempWorkspace<T>(fn: (ws: string) => Promise<T> | T): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-filesec-'));
  setWorkspaceRoot(ws);
  const prev = process.cwd();
  process.chdir(ws);
  return Promise.resolve(fn(ws)).finally(() => {
    setWorkspaceRoot(null);
    process.chdir(prev);
    rmSync(ws, { recursive: true, force: true });
  });
}

test('delete_file deletes file and can be restored with /undo', async () => {
  await inTempWorkspace(async (ws) => {
    const file = join(ws, 'test.txt');
    writeFileSync(file, 'original content', 'utf8');

    let promptSeen = '';
    const confirm = async (cmd: string, reason: string) => {
      promptSeen = cmd;
      return true;
    };

    const resRaw = await runToolCall(
      { tool: 'delete_file', path: 'test.txt' },
      { confirm, workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: true } },
    );
    const res = JSON.parse(resRaw);
    assert.equal(res.ok, true);
    assert.ok(promptSeen.includes('delete_file test.txt'));
    assert.ok(!existsSync(file), 'file should be deleted');

    // Test undo recovery
    const undoRes = undoLast();
    assert.equal(undoRes?.action, 'restored');
    assert.ok(existsSync(file), 'file should be restored');
    assert.equal(readFileSync(file, 'utf8'), 'original content');
  });
});

test('delete_file is blocked when confirmation is rejected by user', async () => {
  await inTempWorkspace(async (ws) => {
    const file = join(ws, 'safe.txt');
    writeFileSync(file, 'important', 'utf8');

    const confirm = async () => false; // User selects No

    const resRaw = await runToolCall(
      { tool: 'delete_file', path: 'safe.txt' },
      { confirm, workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: true } },
    );
    const res = JSON.parse(resRaw);
    assert.ok(res.error.includes('Persetujuan ditolak'));
    assert.ok(existsSync(file), 'file must still exist');
  });
});

test('delete_file fails when confirm hook is missing in approval mode', async () => {
  await inTempWorkspace(async (ws) => {
    const file = join(ws, 'safe2.txt');
    writeFileSync(file, 'important', 'utf8');

    const resRaw = await runToolCall(
      { tool: 'delete_file', path: 'safe2.txt' },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: true } },
    );
    const res = JSON.parse(resRaw);
    assert.ok(res.error.includes('Persetujuan ditolak'));
    assert.ok(existsSync(file), 'file must still exist');
  });
});

test('delete_file asserts workspace boundary anti-path-traversal', async () => {
  await inTempWorkspace(async (ws) => {
    const resRaw = await runToolCall(
      { tool: 'delete_file', path: '../../etc/passwd' },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
    );
    const res = JSON.parse(resRaw);
    assert.ok(res.error.includes('di luar working directory'));
  });
});

test('delete_file rejects directories and non-existent files', async () => {
  await inTempWorkspace(async (ws) => {
    const dir = join(ws, 'somedir');
    mkdirSync(dir);

    const resDirRaw = await runToolCall(
      { tool: 'delete_file', path: 'somedir' },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
    );
    assert.ok(JSON.parse(resDirRaw).error.includes('adalah direktori'));

    const resMissingRaw = await runToolCall(
      { tool: 'delete_file', path: 'missing.txt' },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
    );
    assert.ok(JSON.parse(resMissingRaw).error.includes('tidak ditemukan'));
  });
});

test('delete_file is blocked in plan mode', async () => {
  await inTempWorkspace(async (ws) => {
    const resRaw = await runToolCall(
      { tool: 'delete_file', path: 'test.txt' },
      { planMode: true, workspaceRoot: ws },
    );
    assert.ok(JSON.parse(resRaw).error.includes('plan mode aktif'));
  });
});

test('move_file moves file, preserves directory structure, and can be restored via /undo', async () => {
  await inTempWorkspace(async (ws) => {
    const src = join(ws, 'src.txt');
    const dst = join(ws, 'sub', 'dst.txt');
    writeFileSync(src, 'content to move', 'utf8');

    let promptSeen = '';
    const confirm = async (cmd: string) => {
      promptSeen = cmd;
      return true;
    };

    const resRaw = await runToolCall(
      { tool: 'move_file', source: 'src.txt', target: 'sub/dst.txt' },
      { confirm, workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: true } },
    );
    const res = JSON.parse(resRaw);
    assert.equal(res.ok, true);
    assert.ok(promptSeen.includes('move_file src.txt -> sub/dst.txt'));
    assert.ok(!existsSync(src), 'source should no longer exist');
    assert.ok(existsSync(dst), 'target should exist');
    assert.equal(readFileSync(dst, 'utf8'), 'content to move');

    // Undo should restore source and remove destination
    const undo1 = undoLast();
    assert.equal(undo1?.action, 'deleted');
    assert.ok(!existsSync(dst), 'target should be deleted on first undo');

    const undo2 = undoLast();
    assert.equal(undo2?.action, 'restored');
    assert.ok(existsSync(src), 'source should be restored on second undo');
    assert.equal(readFileSync(src, 'utf8'), 'content to move');
  });
});

test('move_file enforces approval gate and path traversal checks', async () => {
  await inTempWorkspace(async (ws) => {
    const src = join(ws, 'source.txt');
    writeFileSync(src, 'data', 'utf8');

    // Rejection on user saying No
    const confirmNo = async () => false;
    const resReject = JSON.parse(await runToolCall(
      { tool: 'move_file', source: 'source.txt', target: 'target.txt' },
      { confirm: confirmNo, workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: true } },
    ));
    assert.ok(resReject.error.includes('Persetujuan ditolak'));
    assert.ok(existsSync(src));

    // Path traversal on source
    const resTravSrc = JSON.parse(await runToolCall(
      { tool: 'move_file', source: '../secret.txt', target: 'target.txt' },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
    ));
    assert.ok(resTravSrc.error.includes('di luar working directory'));

    // Path traversal on target
    const resTravDst = JSON.parse(await runToolCall(
      { tool: 'move_file', source: 'source.txt', target: '../../etc/evil' },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
    ));
    assert.ok(resTravDst.error.includes('di luar working directory'));
  });
});

test('move_file is blocked in plan mode', async () => {
  await inTempWorkspace(async (ws) => {
    const resRaw = await runToolCall(
      { tool: 'move_file', source: 'a.txt', target: 'b.txt' },
      { planMode: true, workspaceRoot: ws },
    );
    assert.ok(JSON.parse(resRaw).error.includes('plan mode aktif'));
  });
});

test('Point 6: detectWorkspaceMutationInExec blocks rm, mv, truncate, and empty redirects on workspace files', async () => {
  await inTempWorkspace(async (ws) => {
    // rm checks
    const rmCheck = detectWorkspaceMutationInExec('rm test1.py', ws);
    assert.equal(rmCheck.blocked, true);
    assert.match(rmCheck.message ?? '', /delete_file/);

    const rmFlagCheck = detectWorkspaceMutationInExec('rm -rf src/dir', ws);
    assert.equal(rmFlagCheck.blocked, true);
    assert.match(rmFlagCheck.message ?? '', /delete_file/);

    // mv checks
    const mvCheck = detectWorkspaceMutationInExec('mv old.ts new.ts', ws);
    assert.equal(mvCheck.blocked, true);
    assert.match(mvCheck.message ?? '', /move_file/);

    // truncate checks
    const truncCheck = detectWorkspaceMutationInExec('truncate -s 0 out.log', ws);
    assert.equal(truncCheck.blocked, true);
    assert.match(truncCheck.message ?? '', /write_file/);

    // empty redirect checks
    const redirCheck1 = detectWorkspaceMutationInExec('> empty.log', ws);
    assert.equal(redirCheck1.blocked, true);
    assert.match(redirCheck1.message ?? '', /write_file/);

    const redirCheck2 = detectWorkspaceMutationInExec(': > empty.log', ws);
    assert.equal(redirCheck2.blocked, true);

    const redirCheck3 = detectWorkspaceMutationInExec('cat /dev/null > empty.log', ws);
    assert.equal(redirCheck3.blocked, true);

    // chained commands
    const chainCheck = detectWorkspaceMutationInExec('npm test && rm -f file.txt', ws);
    assert.equal(chainCheck.blocked, true);

    // target outside workspace is not blocked by workspace guard
    const outsideCheck = detectWorkspaceMutationInExec('rm /tmp/scratch.txt', ws);
    assert.equal(outsideCheck.blocked, false);

    // harmless commands are not blocked
    assert.equal(detectWorkspaceMutationInExec('npm test', ws).blocked, false);
    assert.equal(detectWorkspaceMutationInExec('git status', ws).blocked, false);
    assert.equal(detectWorkspaceMutationInExec('echo "hello world"', ws).blocked, false);
  });
});

test('Point 6: exec tool rejects workspace file mutations and guides to official tools', async () => {
  await inTempWorkspace(async (ws) => {
    const file = join(ws, 'test.py');
    writeFileSync(file, 'print(1)', 'utf8');

    // Attempting exec rm test.py
    const resRmRaw = await runToolCall(
      { tool: 'exec', command: 'rm test.py' },
      { workspaceRoot: ws },
    );
    const resRm = JSON.parse(resRmRaw);
    assert.ok(resRm.error.includes("Gunakan tool resmi 'delete_file'"));
    assert.ok(existsSync(file), 'file should not be deleted');

    // Attempting exec mv test.py renamed.py
    const resMvRaw = await runToolCall(
      { tool: 'exec', command: 'mv test.py renamed.py' },
      { workspaceRoot: ws },
    );
    const resMv = JSON.parse(resMvRaw);
    assert.ok(resMv.error.includes("Gunakan tool resmi 'move_file'"));
    assert.ok(existsSync(file), 'file should not be moved');
  });
});

