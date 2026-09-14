import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TIMEOUT_MS, execute } from '../core/executor.js';
import { resolveExecTimeout, runToolCall } from '../agent/tools.js';
import { DEFAULT_CONFIG } from '../types.js';

test('DEFAULT_TIMEOUT_MS and DEFAULT_CONFIG.execTimeoutMs are set to 120_000ms (2 minutes)', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 120_000);
  assert.equal(DEFAULT_CONFIG.execTimeoutMs, 120_000);
});

test('resolveExecTimeout parses various timeout parameters accurately', () => {
  // Default fallback when nothing provided
  assert.equal(resolveExecTimeout({}), 120_000);
  assert.equal(resolveExecTimeout({}, 60_000), 60_000);

  // Explicit timeoutMs in milliseconds
  assert.equal(resolveExecTimeout({ timeoutMs: 15_000 }), 15_000);
  assert.equal(resolveExecTimeout({ timeoutMs: '45000' }), 45_000);

  // timeout_ms alias
  assert.equal(resolveExecTimeout({ timeout_ms: 30_000 }), 30_000);
  assert.equal(resolveExecTimeout({ timeout_ms: '5000' }), 5_000);

  // timeout key in seconds (<= 600) converts to ms
  assert.equal(resolveExecTimeout({ timeout: 60 }), 60_000);
  assert.equal(resolveExecTimeout({ timeout: '120' }), 120_000);
  assert.equal(resolveExecTimeout({ timeout: 2 }), 2_000);

  // timeout key already in ms (> 600)
  assert.equal(resolveExecTimeout({ timeout: 25_000 }), 25_000);

  // Clamping boundaries (min 100ms, max 3_600_000ms)
  assert.equal(resolveExecTimeout({ timeoutMs: 10 }), 100);
  assert.equal(resolveExecTimeout({ timeoutMs: 10_000_000 }), 3_600_000);
});

test('execute terminates long command when timeout is exceeded and appends informative notice', async () => {
  // Run a command that takes 2.5s with a 500ms timeout
  const result = await execute('node -e "setTimeout(() => console.log(\'done\'), 2500)"', {
    timeoutMs: 500,
    summarize: false,
  });

  assert.equal(result.code, null, 'code must be null when killed by timeout');
  assert.ok(result.durationMs >= 450, `durationMs (${result.durationMs}) should be around 500ms`);
  assert.ok(result.output.includes('[Command dihentikan: waktu eksekusi melebihi batas timeout'));
  assert.ok(result.output.includes('Gunakan parameter timeoutMs lebih besar'));
});

test('execute succeeds normally when command finishes before timeout', async () => {
  const result = await execute('node -e "console.log(\'quick-output\')"', {
    timeoutMs: 5000,
  });

  assert.equal(result.code, 0);
  assert.equal(result.output.trim(), 'quick-output');
  assert.ok(!result.output.includes('[Command dihentikan: waktu eksekusi melebihi batas timeout'));
});

test('tool exec respects per-call timeoutMs parameter and kills command accordingly', async () => {
  const resRaw = await runToolCall(
    {
      tool: 'exec',
      command: 'node -e "setTimeout(() => console.log(\'finished\'), 3000)"',
      timeoutMs: 600,
    },
    { config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
  );

  const res = JSON.parse(resRaw);
  assert.equal(res.code, null);
  assert.ok(res.output.includes('[Command dihentikan: waktu eksekusi melebihi batas timeout 600ms'));
});

test('tool exec supports timeout parameter in seconds (e.g. timeout: 1)', async () => {
  const resRaw = await runToolCall(
    {
      tool: 'exec',
      command: 'node -e "setTimeout(() => console.log(\'finished\'), 3000)"',
      timeout: 1, // 1 second
    },
    { config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
  );

  const res = JSON.parse(resRaw);
  assert.equal(res.code, null);
  assert.ok(res.output.includes('batas timeout 1000ms'));
});
