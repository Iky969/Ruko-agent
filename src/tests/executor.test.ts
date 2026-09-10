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
  assert.notEqual(result.code, 0);
  assert.ok(result.durationMs < 5000, 'should have stopped well before 5s');
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