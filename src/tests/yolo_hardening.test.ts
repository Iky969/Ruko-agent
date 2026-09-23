import assert from 'node:assert/strict';
import { exec } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

test('YOLO Hardening', async (t) => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-yolo-hardening-'));
  
  // Create an absolute file URL for importing the compiled CLI
  const distIndexPath = join(process.cwd(), 'dist', 'index.js');
  const distIndexUrl = 'file://' + distIndexPath;

  const mockScriptPath = join(tmpWs, 'test_tty.mjs');
  
  // A mock script that forces process.stdin.isTTY = true,
  // simulates the process.argv, and imports the CLI.
  const TTY_MOCK_SCRIPT = `
Object.defineProperty(process.stdin, 'isTTY', { value: true });
process.argv = ['node', 'index.js', ...process.argv.slice(2)];
await import('${distIndexUrl}');
`;
  writeFileSync(mockScriptPath, TTY_MOCK_SCRIPT, 'utf-8');

  t.after(() => {
    rmSync(tmpWs, { recursive: true, force: true });
  });

  const untrustedDir = join(tmpWs, 'untrusted');
  mkdirSync(untrustedDir);

  await t.test('bypassTrust is NOT triggered by --yes alone', async () => {
    try {
      // Pipe "n" to stdin to simulate cancelling the trust prompt
      const { stdout } = await execAsync(`echo "n" | node ${mockScriptPath} --yes --exec "echo hello"`, { cwd: untrustedDir });
      assert.ok(stdout.includes('Akses dibatalkan'), 'Should prompt for trust and cancel');
      assert.ok(!stdout.includes('hello\\n[exit code'), 'Should not execute command');
    } catch (e: any) {
      assert.ok(e.stdout.includes('Akses dibatalkan'), 'Should prompt for trust and cancel');
    }
  });

  await t.test('bypassTrust IS triggered by --trust-folder', async () => {
    // With --trust-folder, it should not prompt, and wait for confirmation unless --yes is passed
    // But since we just want to check if it bypassed trust, we'll pipe "y" for the command execution approval
    const { stdout } = await execAsync(`echo "y" | node ${mockScriptPath} --trust-folder --exec "echo hello"`, { cwd: untrustedDir });
    assert.ok(!stdout.includes('Akses dibatalkan'), 'Should NOT prompt for trust');
    assert.ok(stdout.includes('hello'), 'Should execute command');
  });

  await t.test('Security warning is shown when --yes + --exec are used together', async () => {
    // Both --trust-folder (to bypass trust) and --yes (to bypass command approval)
    const { stdout } = await execAsync(`node ${mockScriptPath} --trust-folder --yes --exec "echo hello"`, { cwd: untrustedDir });
    assert.ok(stdout.includes('UNSAFE MODE: Persetujuan otomatis aktif'), 'Should display safety banner');
    assert.ok(stdout.includes('hello'), 'Should execute command');
  });

  await t.test('BLOCKED patterns are still enforced even with --yes', async () => {
    const { stdout } = await execAsync(`node ${mockScriptPath} --trust-folder --yes --exec "rm -rf /"`, { cwd: untrustedDir });
    assert.ok(stdout.includes('UNSAFE MODE'), 'Should display safety banner');
    assert.ok(stdout.includes('BLOCKED oleh Ruko'), 'Should block destructive commands');
  });
});
