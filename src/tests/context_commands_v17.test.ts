import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleCommand, listCommands } from '../agent/commands.js';
import { Context } from '../core/context.js';
import { DEFAULT_CONFIG, ContextMessage } from '../types.js';
import { sanitizeTerminalOutput, stripAnsi } from '../core/ui.js';
import { compressHistory } from '../core/compressor.js';
import { runSubagent } from '../agent/subagent.js';
import { LLMProvider, ChatOptions } from '../agent/llm.js';

test('/setctx and /settoken commands exist in registry', () => {
  const names = new Set(listCommands().map((c) => c.name));
  assert.ok(names.has('setctx'), 'missing /setctx');
  assert.ok(names.has('settoken'), 'missing /settoken');
});

test('/setctx display and update with validation', async () => {
  const config = { ...DEFAULT_CONFIG, maxContextChars: 40000 };
  const ctx = new Context(config);
  ctx.add('user', 'halo ruko testing context window'); // ~33 chars

  let updatedPatch: any = null;
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);

  const env: any = {
    ctx,
    config,
    llm: { model: 'test-model', isConfigured: true },
    confirm: async () => true,
    updateConfig: (patch: any) => {
      updatedPatch = patch;
      Object.assign(config, patch);
    },
    handle: { stop: () => {}, getSessionId: () => null, setSessionId: () => {} },
  };

  try {
    // 1. Display status without arguments
    await handleCommand('/setctx', env);
    assert.ok(logged.some((l) => l.includes('Context Budget')));
    assert.ok(logged.some((l) => l.includes('40000 chars')));

    // 2. Set with k notation (e.g. 50k)
    logged.length = 0;
    await handleCommand('/setctx 50k', env);
    assert.equal(config.maxContextChars, 50000);
    assert.equal(updatedPatch.maxContextChars, 50000);
    assert.ok(logged.some((l) => l.includes('50000 karakter')));

    // 3. Set with numeric string
    logged.length = 0;
    await handleCommand('/setctx 65000', env);
    assert.equal(config.maxContextChars, 65000);

    // 4. Reject invalid / negative
    logged.length = 0;
    await handleCommand('/setctx -1000', env);
    assert.ok(logged.some((l) => l.includes('angka positif')));
    assert.equal(config.maxContextChars, 65000);

    // 5. Reject value smaller than currently active chars
    logged.length = 0;
    await handleCommand(`/setctx ${ctx.totalChars - 5}`, env);
    assert.ok(logged.some((l) => l.includes('tidak boleh lebih rendah')));
    assert.equal(config.maxContextChars, 65000);
  } finally {
    console.log = origLog;
  }
});

test('/settoken display and update with token-to-char conversion (1:4)', async () => {
  const config = { ...DEFAULT_CONFIG, maxContextChars: 32000 };
  const ctx = new Context(config);
  ctx.add('user', 'pesan token context test');

  let updatedPatch: any = null;
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);

  const env: any = {
    ctx,
    config,
    llm: { model: 'test-model', isConfigured: true },
    confirm: async () => true,
    updateConfig: (patch: any) => {
      updatedPatch = patch;
      Object.assign(config, patch);
    },
    handle: { stop: () => {}, getSessionId: () => null, setSessionId: () => {} },
  };

  try {
    // 1. Display status without arguments
    await handleCommand('/settoken', env);
    assert.ok(logged.some((l) => l.includes('Token Budget')));
    assert.ok(logged.some((l) => l.includes('8000 tokens'))); // 32000 / 4

    // 2. Set with k notation (e.g. 16k tokens -> 64,000 chars)
    logged.length = 0;
    await handleCommand('/settoken 16k', env);
    assert.equal(config.maxContextChars, 64000);
    assert.equal(updatedPatch.maxContextChars, 64000);
    assert.ok(logged.some((l) => l.includes('16000 token') && l.includes('64000 karakter')));

    // 3. Set with plain integer (e.g. 20000 tokens -> 80,000 chars)
    logged.length = 0;
    await handleCommand('/settoken 20000', env);
    assert.equal(config.maxContextChars, 80000);

    // 4. Reject invalid input
    logged.length = 0;
    await handleCommand('/settoken xyz', env);
    assert.ok(logged.some((l) => l.includes('angka positif')));

    // 5. Reject token count whose character budget is lower than active chars
    logged.length = 0;
    await handleCommand('/settoken 1', env); // 4 chars < ctx.totalChars
    assert.ok(logged.some((l) => l.includes('tidak boleh lebih rendah')));
    assert.equal(config.maxContextChars, 80000);
  } finally {
    console.log = origLog;
  }
});

test('sanitizeTerminalOutput strips OSC, DCS, PM, APC, and bells to prevent terminal injection', () => {
  // OSC title setting injection
  const oscPayload = '\x1b]0;Evil Terminal Title\x07Hello World';
  assert.equal(sanitizeTerminalOutput(oscPayload), 'Hello World');

  // OSC 8 hyperlink injection
  const osc8Payload = '\x1b]8;;http://malicious.com\x07Click Me\x1b]8;;\x07';
  assert.equal(sanitizeTerminalOutput(osc8Payload), 'Click Me');

  // Bell characters and form feeds
  const bellPayload = 'Step 1\x07\x0cDone';
  assert.equal(sanitizeTerminalOutput(bellPayload), 'Step 1Done');

  // Standard ANSI colors should be preserved by sanitizeTerminalOutput
  const coloredText = '\x1b[32m✔ Success\x1b[0m';
  assert.equal(sanitizeTerminalOutput(coloredText), coloredText);

  // But stripAnsi should strip both ANSI and dangerous sequences
  assert.equal(stripAnsi(oscPayload), 'Hello World');
  assert.equal(stripAnsi(coloredText), '✔ Success');
});

test('compressHistory best-effort fallback reduces head turns when target budget is unreachable', () => {
  // 10 large head turns (10 * 500 = 5000 chars)
  // 2 large tail turns (2 * 500 = 1000 chars)
  // targetChars = 800 chars (smaller than tailChars = 1000)
  const headTurns: ContextMessage[] = Array.from({ length: 10 }, (_, i) => ({
    role: 'user',
    content: `Head turn ${i} ` + 'a'.repeat(500),
    timestamp: '2026-01-01T00:00:00.000Z',
  }));
  const tailTurns: ContextMessage[] = Array.from({ length: 2 }, (_, i) => ({
    role: 'assistant',
    content: `Tail turn ${i} ` + 'b'.repeat(500),
    timestamp: '2026-01-01T00:00:00.000Z',
  }));
  const messages = [...headTurns, ...tailTurns];

  const result = compressHistory(messages, {
    targetChars: 800,
    keepLast: 2,
    maxPerMessageChars: 200,
  });

  const originalTotal = messages.reduce((s, m) => s + m.content.length, 0);
  const compressedTotal = result.reduce((s, m) => s + m.content.length, 0);

  // Best effort MUST save space rather than leaving 12 huge messages uncompressed
  assert.ok(result.length < messages.length, 'should fold head turns');
  assert.ok(compressedTotal < originalTotal, `compressed (${compressedTotal}) must be less than original (${originalTotal})`);
  assert.ok(result[0].content.startsWith('[compressed history'), 'digest header should be present');
  assert.equal(result.at(-1)?.content, tailTurns[1].content, 'tail preserved');
  assert.equal(result.at(-2)?.content, tailTurns[0].content, 'tail preserved');
});

test('runSubagent cumulative timeout triggers clean timeout output', async () => {
  // Mock hanging provider
  class HangingProvider implements LLMProvider {
    readonly name = 'hanging';
    readonly isConfigured = true;
    model = 'mock-hang';
    setModel(m: string): void {
      this.model = m;
    }
    async chat(_messages: any[], options?: ChatOptions): Promise<string> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve('done after delay');
        }, 5000);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
  }

  const result = await runSubagent(
    'Tugas yang membutuhkan waktu lama',
    {
      config: { ...DEFAULT_CONFIG, approvalEnabled: false },
      llmProvider: new HangingProvider(),
    },
    { timeoutMs: 50 },
  );

  assert.ok(result.includes('timed out after 50ms'), `expected timeout message, got: ${result}`);
});

test('/usage displays session token accumulation and supports /usage clear', async () => {
  const { Agent } = await import('../agent/agent.js');
  const config = { ...DEFAULT_CONFIG, maxContextChars: 40000 };
  const ctx = new Context(config);

  class MockProvider implements LLMProvider {
    readonly name = 'mock';
    readonly isConfigured = true;
    model = 'mock-llm';
    setModel() {}
    async chat(): Promise<string> {
      return 'Jawaban AI sepanjang 32 karakter ini.';
    }
  }

  const agent = new Agent(ctx, new MockProvider(), config);
  // Simulate 2 turns handled
  await agent.handleInstruction('Instruksi pertama untuk testing');
  await agent.handleInstruction('Instruksi kedua yang sedikit lebih panjang');

  assert.ok(agent.sessionUsage.totalTurns >= 2);
  assert.ok(agent.sessionUsage.totalTokens > 0);

  const logged: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => logged.push(msg);

  const env: any = {
    ctx,
    config,
    llm: { model: 'mock-llm', name: 'mock', isConfigured: true },
    agent,
    confirm: async () => true,
    updateConfig: () => {},
    handle: { stop: () => {}, getSessionId: () => 'test-sess-1', setSessionId: () => {} },
  };

  try {
    // 1. /usage displays session tokens
    await handleCommand('/usage', env);
    assert.ok(logged.some((l) => l.includes('total token sesi ini')));
    assert.ok(logged.some((l) => l.includes('prompt:') && l.includes('tokens')));
    assert.ok(logged.some((l) => l.includes('completion:') && l.includes('tokens')));
    assert.ok(logged.some((l) => l.includes('turn terakhir:')));

    // 2. /usage clear resets session usage
    logged.length = 0;
    await handleCommand('/usage clear', env);
    assert.equal(agent.sessionUsage.totalTokens, 0);
    assert.equal(agent.sessionUsage.totalTurns, 0);
    assert.ok(logged.some((l) => l.includes('di-reset')));
  } finally {
    console.log = origLog;
  }
});

test('isSensitiveEnvCommand blocks declare -p, typeset -p, and bare set', async () => {
  const { isSensitiveEnvCommand } = await import('../agent/tools.js');

  // Bare dumps
  assert.equal(isSensitiveEnvCommand('declare -p'), true);
  assert.equal(isSensitiveEnvCommand('typeset -p'), true);
  assert.equal(isSensitiveEnvCommand('declare -p | grep KEY'), true);
  assert.equal(isSensitiveEnvCommand('set'), true);
  assert.equal(isSensitiveEnvCommand('set | grep RUKO'), true);
  assert.equal(isSensitiveEnvCommand('set > /tmp/env.txt'), true);

  // declare -p on sensitive var
  assert.equal(isSensitiveEnvCommand('declare -p RUKO_API_KEY'), true);
  assert.equal(isSensitiveEnvCommand('typeset -p MY_TOKEN'), true);

  // Normal set options should NOT be blocked
  assert.equal(isSensitiveEnvCommand('set -e'), false);
  assert.equal(isSensitiveEnvCommand('set -x'), false);
  assert.equal(isSensitiveEnvCommand('set -o pipefail'), false);
});

test('containsSensitiveFilePattern detects id_ecdsa, id_dsa, .pem, and .key in subagent tasks', async () => {
  const { containsSensitiveFilePattern } = await import('../agent/subagent.js');

  assert.equal(containsSensitiveFilePattern('Baca ~/.ssh/id_ecdsa'), true);
  assert.equal(containsSensitiveFilePattern('Cek file id_dsa'), true);
  assert.equal(containsSensitiveFilePattern('Buka server.key untuk melihat isinya'), true);
  assert.equal(containsSensitiveFilePattern('Periksa cert.pem di direktori'), true);
  assert.equal(containsSensitiveFilePattern('Jelaskan cara konfigurasi nginx'), false);
});

test('execute captures interleaved stdout and stderr sequentially', async () => {
  const { execute } = await import('../core/executor.js');
  // PERBAIKAN (Windows): cmd.exe /S melepas kutip luar dan memecah kutip dalam,
  // sehingga `node -e "..."` dikirim sebagai argumen terpotong. Cara aman
  // lintas platform: kirim skrip via STDIN (`node` tanpa -e) — tidak ada kutip
  // sama sekali, dan assertion identik di semua OS.
  // Jeda 60ms (bukan 20ms): di runner CI lambat, gap 20ms bisa tertelan
  // scheduler sehingga B (stderr) tiba bersamaan C (stdout) — urutan antar-
  // pipe jadi tidak deterministik ('ACB'). 60ms menjaga urutan kedatangan.
  const script =
    'process.stdout.write("A"); setTimeout(() => { process.stderr.write("B"); setTimeout(() => { process.stdout.write("C"); }, 60); }, 60);';
  let res;
  if (process.platform === 'win32') {
    const { execFile } = await import('node:child_process');
    const piped = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [],
        { encoding: 'utf8' } as any,
        (error: any, stdout: string, stderr: string) => {
          resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
        },
      );
      child.stdin?.end(script);
    });
    res = {
      code: piped.code,
      stdout: piped.stdout,
      stderr: piped.stderr,
      output: piped.stdout + piped.stderr,
    };
  } else {
    const r = await execute(`node -e '${script}'`, { summarize: false });
    res = { code: r.code, stdout: r.stdout, stderr: r.stderr, output: r.output };
  }

  // Field per-stream harus persis di semua OS (tidak ada data yang hilang
  // ataupun tertukar antar-stream).
  assert.equal(res.stdout, 'AC');
  assert.equal(res.stderr, 'B');
  if (process.platform === 'win32') {
    // PERBAIKAN (CI Windows): latensi pipe stdout vs stderr di Windows ASIMETRIS
    // secara sistematis — B (stderr, ditulis sebelum C) konsisten tiba SETELAH
    // C di semua run runner ('ACB'), walau gap tulis 60ms. Semua chunk tetap
    // tiba lengkap dan output interleave mengikuti urutan KEDATANGAN (bukan
    // penggabungan akhir per-stream), jadi di Windows yang divalidasi:
    // seluruh karakter hadir dan B berada DI ANTARA output (interleave nyata).
    assert.equal([...res.output].sort().join(''), 'ABC', 'semua chunk stdout+stderr harus tiba lengkap');
    assert.notEqual(res.output, 'AC', 'stderr B tidak boleh hilang dari output');
  } else {
    // POSIX: latensi pipe seragam → urutan ketat tulis-then-arrive.
    assert.equal(res.output, 'ABC');
  }
});

test('Finding 1: isSensitivePath and containsSensitiveFilePattern block shell startup configs', async () => {
  const { isSensitivePath, assertNotSensitivePath } = await import('../agent/tools.js');
  const { containsSensitiveFilePattern } = await import('../agent/subagent.js');

  const shellFiles = [
    '.bashrc',
    '~/.bashrc',
    '/home/user/.bash_profile',
    '.zshrc',
    '~/.zshrc',
    '.profile',
    '.bash_login',
    '.bash_logout',
    '.zshenv',
  ];

  for (const f of shellFiles) {
    assert.equal(isSensitivePath(f), true, `isSensitivePath should block ${f}`);
    assert.throws(() => assertNotSensitivePath(f), /Akses ke file sensitif/);
    assert.equal(containsSensitiveFilePattern(`Baca berkas ${f}`), true, `containsSensitiveFilePattern should block ${f}`);
  }

  // Normal safe files should not be blocked
  assert.equal(isSensitivePath('src/index.ts'), false);
  assert.equal(containsSensitiveFilePattern('Baca src/index.ts'), false);
});

test('Finding 2: write_file and writeWithDiff reject payloads exceeding MAX_FILE_WRITE_BYTES (5MB)', async () => {
  const { MAX_FILE_WRITE_BYTES, runToolCall } = await import('../agent/tools.js');
  const { join, relative } = await import('node:path');
  const { mkdtempSync, rmSync } = await import('node:fs');

  assert.equal(MAX_FILE_WRITE_BYTES, 5 * 1024 * 1024);

  const testDir = mkdtempSync(join(process.cwd(), '.tmp-write-limit-'));
  try {
    const hugeContent = 'x'.repeat(MAX_FILE_WRITE_BYTES + 10);
    // `relative()` (bukan replace string) supaya pemisah path Windows
    // (backslash) tetap benar — assertion tidak berubah.
    const relFile = join(relative(process.cwd(), testDir), 'huge.txt');
    const res = await runToolCall(
      { tool: 'write_file', path: relFile, content: hugeContent },
      {},
    );
    const parsed = JSON.parse(res);
    assert.ok(parsed.error, 'Should return error for payload > 5MB');
    assert.ok(parsed.error.includes('melebihi batas maksimum 5MB'));
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Finding 3: exportSessionTrajectory preserves original message timestamps', async () => {
  const { exportSessionTrajectory } = await import('../core/session.js');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');

  const testDir = mkdtempSync(join(tmpdir(), 'ruko-traj-ts-'));
  try {
    const historicalTime = '2025-06-15T10:30:00.000Z';
    const msgs: ContextMessage[] = [
      { role: 'user', content: 'Halo dari masa lalu', timestamp: historicalTime },
      { role: 'assistant', content: 'Halo kembali', timestamp: '2025-06-15T10:30:05.000Z' },
    ];

    const res = exportSessionTrajectory(msgs, 'jsonl', testDir);
    assert.ok(res.filePath.includes('2025-06-15T10-30-00-000Z'));

    const content = readFileSync(res.filePath, 'utf8');
    const firstLine = JSON.parse(content.trim().split('\n')[0]);
    assert.equal(firstLine.timestamp, historicalTime);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});


