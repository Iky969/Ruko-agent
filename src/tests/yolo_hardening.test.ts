import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CLI_ENTRY,
  childOutput,
  createTempWorkspace,
  removeTempWorkspace,
  runNodeAsync,
  toFileUrl,
  writeLocalModule,
} from './helpers/platform.js';

/**
 * YOLO hardening — TTY-forcing end-to-end checks against the compiled CLI.
 *
 * CROSS-PLATFORM NOTES (do not regress):
 *  - The CLI is imported by the generated mock script through a
 *    `pathToFileURL()` URL (`file:///C:/Users/...` on Windows,
 *    `file:///home/...` on POSIX). Building it as `'file://' + path` produced
 *    `file://C:UsersIkyRuko-agentdistindex.js` on Windows — every backslash was
 *    eaten as a JS escape, the drive letter became the URL host, and
 *    `await import(...)` failed with `ERR_INVALID_URL`.
 *  - The URL is injected into the generated module with `JSON.stringify()`
 *    (escape-proof), never through raw template interpolation.
 *  - Child processes are spawned with `execFile` + `process.execPath` and an
 *    argv array: no shell, no `'node'` PATH lookup, no cmd.exe quoting, and
 *    `--exec "echo hello"` stays a single argument on every platform.
 *  - stdin is fed explicitly via `input` (EOF-terminated) instead of
 *    `echo "n" | node ...`, which behaves differently under cmd.exe.
 *  - The temp workspace prefix intentionally contains a space and `#` so the
 *    suite exercises the Windows `%TEMP%\ruko-...` shapes that broke before.
 */
test('YOLO Hardening', async (t) => {
  const tmpWs = createTempWorkspace('ruko yolo#hardening-');

  // Absolute, properly encoded file URL for the compiled CLI entry point.
  const cliUrl = toFileUrl(CLI_ENTRY);

  // A mock script that forces process.stdin.isTTY = true,
  // simulates the process.argv, and imports the CLI.
  const TTY_MOCK_SCRIPT = `
Object.defineProperty(process.stdin, 'isTTY', { value: true });
process.argv = ['node', 'index.js', ...process.argv.slice(2)];
await import(${JSON.stringify(cliUrl)});
`;

  // Regression guard: the injected URL must be absolute, parseable and free of
  // raw backslashes — the three properties the old concatenation lost on Windows.
  assert.equal(new URL(cliUrl).protocol, 'file:', `CLI URL must be a file: URL, got ${cliUrl}`);
  assert.ok(!cliUrl.includes('\\'), `CLI URL must never contain a raw backslash: ${cliUrl}`);
  assert.ok(TTY_MOCK_SCRIPT.includes(cliUrl), 'generated mock must embed the file URL verbatim');

  const { path: mockScriptPath } = writeLocalModule(tmpWs, 'test_tty.mjs', TTY_MOCK_SCRIPT);

  t.after(() => {
    removeTempWorkspace(tmpWs);
  });

  const untrustedDir = join(tmpWs, 'untrusted');
  mkdirSync(untrustedDir);

  await t.test('bypassTrust is NOT triggered by --yes alone', async () => {
    // Pipe "n" to stdin to simulate cancelling the trust prompt
    let stdout = '';
    try {
      const result = await runNodeAsync([mockScriptPath, '--yes', '--exec', 'echo hello'], {
        cwd: untrustedDir,
        input: 'n\n',
      });
      stdout = result.stdout;
    } catch (err) {
      stdout = childOutput(err).stdout;
    }
    assert.ok(stdout.includes('Akses dibatalkan'), 'Should prompt for trust and cancel');
    assert.ok(!stdout.includes('hello\\n[exit code'), 'Should not execute command');
  });

  await t.test('bypassTrust IS triggered by --trust-folder', async () => {
    // With --trust-folder, it should not prompt, and wait for confirmation unless --yes is passed
    // But since we just want to check if it bypassed trust, we'll pipe "y" for the command execution approval
    const { stdout } = await runNodeAsync([mockScriptPath, '--trust-folder', '--exec', 'echo hello'], {
      cwd: untrustedDir,
      input: 'y\n',
    });
    assert.ok(!stdout.includes('Akses dibatalkan'), 'Should NOT prompt for trust');
    assert.ok(stdout.includes('hello'), 'Should execute command');
  });

  await t.test('Security warning is shown when --yes + --exec are used together', async () => {
    // Both --trust-folder (to bypass trust) and --yes (to bypass command approval)
    const { stdout } = await runNodeAsync([mockScriptPath, '--trust-folder', '--yes', '--exec', 'echo hello'], {
      cwd: untrustedDir,
      input: '',
    });
    assert.ok(stdout.includes('UNSAFE MODE: Persetujuan otomatis aktif'), 'Should display safety banner');
    assert.ok(stdout.includes('hello'), 'Should execute command');
  });

  await t.test('BLOCKED patterns are still enforced even with --yes', async () => {
    const { stdout } = await runNodeAsync([mockScriptPath, '--trust-folder', '--yes', '--exec', 'rm -rf /'], {
      cwd: untrustedDir,
      input: '',
    });
    assert.ok(stdout.includes('UNSAFE MODE'), 'Should display safety banner');
    assert.ok(stdout.includes('BLOCKED oleh Ruko'), 'Should block destructive commands');
  });
});
