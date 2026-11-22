import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../agent/agent.js';
import { handleCommand } from '../agent/commands.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';
import { Context } from '../core/context.js';
import { sanitizeConfigFile } from '../core/config.js';
import { AgentConfig, ContextMessage, DEFAULT_CONFIG, DEFAULT_MAX_SESSION_TOOL_CALLS, MAX_SESSION_TOOL_CALLS } from '../types.js';

/** Scripted provider: returns one canned reply per chat() call. */
class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  readonly isConfigured = true;
  model = 'fake-model';
  private calls = 0;
  constructor(private readonly replies: string[]) {}
  setModel(model: string): void {
    this.model = model;
  }
  async chat(_messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    options?.onToken?.(reply);
    return reply;
  }
}

const baseConfig: AgentConfig = { ...DEFAULT_CONFIG, approvalEnabled: false };

// NOTE: capture console.* (NOT process.stdout.write). Overriding stdout.write
// swallows node:test's TAP result lines for the tests whose reporting overlaps
// the override window, so those tests silently never get counted under
// `npm test` (verified: only 3/8 tests in this file were counted before this
// change). Tree output goes through console.log, which is all these tests
// need to observe; the final answer is checked via the returned `result`.
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  let out = '';
  const sink = (...args: unknown[]) => {
    out += `${args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')}\n`;
  };
  console.log = sink as typeof console.log;
  console.warn = sink as typeof console.warn;
  console.error = sink as typeof console.error;
  try {
    const result = await fn();
    return { result, out };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
}

function mockEnv(config: Record<string, unknown>, ctx: Context) {
  let patch: Record<string, unknown> | null = null;
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logged.push(args.join(' '));
  const env: any = {
    ctx,
    config,
    llm: { model: 'test-model', isConfigured: true },
    confirm: async () => true,
    updateConfig: (p: Record<string, unknown>) => {
      patch = p;
      Object.assign(config, p);
    },
    handle: { stop: () => {}, getSessionId: () => null, setSessionId: () => {} },
  };
  return {
    env,
    logged,
    getPatch: () => patch,
    restore: () => {
      console.log = origLog;
    },
  };
}

test('default: budget total tool per sesi adalah 180', () => {
  assert.equal(DEFAULT_CONFIG.maxSessionToolCalls, 180);
  assert.equal(DEFAULT_MAX_SESSION_TOOL_CALLS, 180);
  assert.equal(MAX_SESSION_TOOL_CALLS, 10_000);
});

test('sanitizeConfigFile menerima dan menolak maxSessionToolCalls', () => {
  assert.equal(sanitizeConfigFile({ maxSessionToolCalls: 300 }).maxSessionToolCalls, 300);
  assert.equal(sanitizeConfigFile({ maxSessionToolCalls: 0 }).maxSessionToolCalls, undefined);
  assert.equal(sanitizeConfigFile({ maxSessionToolCalls: -1 }).maxSessionToolCalls, undefined);
  assert.equal(sanitizeConfigFile({ maxSessionToolCalls: '180' }).maxSessionToolCalls, undefined);
  assert.equal(
    sanitizeConfigFile({ maxSessionToolCalls: 99_000 }).maxSessionToolCalls,
    MAX_SESSION_TOOL_CALLS,
  );
});

test('getLoopDetectorParams: tool baca KETAT (2), tool eksekusi LONGGAR (10)', () => {
  const agent = new Agent(new Context(baseConfig), new FakeProvider([]), baseConfig);
  const read = agent.getLoopDetectorParams('read_file');
  assert.equal(read.loopThreshold, 2);
  assert.equal(read.consecutiveThreshold, 2);
  const search = agent.getLoopDetectorParams('code_search');
  assert.equal(search.loopThreshold, 2);
  const exec = agent.getLoopDetectorParams('exec');
  assert.equal(exec.loopThreshold, 10);
  assert.equal(exec.consecutiveThreshold, 10);
  const write = agent.getLoopDetectorParams('write_file');
  assert.equal(write.loopThreshold, 10);
});

test('pengulangan tool baca yang sama TIDAK lagi hard stop — turn tetap jalan sampai jawaban akhir', async () => {
  const readCall = '```tool\n{"tool": "read_file", "path": "package.json"}\n```';
  const provider = new FakeProvider([readCall, readCall, readCall, readCall, readCall, 'Ini jawaban akhir.']);
  const ctx = new Context(baseConfig);
  const agent = new Agent(ctx, provider, baseConfig);
  const { result, out } = await captureConsole(() => agent.handleInstruction('baca package.json'));
  assert.equal(result, 'Ini jawaban akhir.');
  assert.ok(!result.includes('dihentikan paksa'), 'tidak ada lagi hard stop deteksi loop');
  assert.ok(!out.includes('Dihentikan karena deteksi loop'));
});

test('budget sesi: berhenti di 3/3 dengan laporan, sesi TIDAK di-reset', async () => {
  const config: AgentConfig = { ...baseConfig, maxSessionToolCalls: 3 };
  const provider = new FakeProvider([
    '```tool\n{"tool": "exec", "command": "echo 1"}\n```',
    '```tool\n{"tool": "exec", "command": "echo 2"}\n```',
    '```tool\n{"tool": "exec", "command": "echo 3"}\n```',
    '```tool\n{"tool": "exec", "command": "echo 4"}\n```',
    'Seharusnya tidak sampai sini.',
  ]);
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  const { result } = await captureConsole(() => agent.handleInstruction('jalankan empat perintah'));
  assert.ok(result.includes('[batas tool sesi]'), 'laporan berhenti budget ditampilkan');
  assert.ok(result.includes('3/3'), 'laporan menyebut jumlah pemakaian budget');
  assert.ok(result.includes('Belum selesai'), 'laporan menyebut apa yang belum selesai');
  assert.ok(result.includes('TIDAK di-reset'), 'laporan menegaskan sesi tidak di-reset');
  assert.ok(result.includes('TIDAK perlu sesi baru'), 'laporan menegaskan tidak perlu sesi baru');
  assert.equal(agent.getSessionToolCallCount(), 3);

  // Instruksi berikutnya di SESI YANG SAMA tetap bisa dijawab tanpa tool.
  const provider2 = new FakeProvider(['Selesai tanpa tool.']);
  agent.setLlmProvider(provider2);
  const { result: result2 } = await captureConsole(() => agent.handleInstruction('ringkas saja'));
  assert.equal(result2, 'Selesai tanpa tool.');
  assert.equal(agent.getSessionToolCallCount(), 3, 'jawaban tanpa tool tidak memakai budget');
});

test('resetSessionToolBudget mengembalikan counter ke 0', async () => {
  const config: AgentConfig = { ...baseConfig, maxSessionToolCalls: 1 };
  const provider = new FakeProvider([
    '```tool\n{"tool": "exec", "command": "echo 1"}\n```',
    '```tool\n{"tool": "exec", "command": "echo 2"}\n```',
  ]);
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  await captureConsole(() => agent.handleInstruction('jalankan dua perintah'));
  assert.equal(agent.getSessionToolCallCount(), 1);
  agent.resetSessionToolBudget();
  assert.equal(agent.getSessionToolCallCount(), 0);
});

test('/settings session-tools mengubah budget dan menolak nilai tidak valid', async () => {
  const config = { ...DEFAULT_CONFIG, maxSessionToolCalls: 180 };
  const ctx = new Context(config);
  const m = mockEnv(config as unknown as Record<string, unknown>, ctx);
  try {
    await handleCommand('/settings session-tools 300', m.env);
    assert.deepEqual(m.getPatch(), { maxSessionToolCalls: 300 });
    assert.equal(config.maxSessionToolCalls, 300);

    await handleCommand('/settings session-tools 0', m.env);
    assert.ok(m.logged.some((l) => l.includes('bilangan bulat positif')));

    await handleCommand('/settings session-tools 99999', m.env);
    assert.ok(m.logged.some((l) => l.includes('tidak boleh melebihi')));
  } finally {
    m.restore();
  }
});

test('/config set maxSessionToolCalls via handleCommand', async () => {
  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const m = mockEnv(config as unknown as Record<string, unknown>, ctx);
  try {
    await handleCommand('/config set maxSessionToolCalls 250', m.env);
    assert.deepEqual(m.getPatch(), { maxSessionToolCalls: 250 });

    await handleCommand('/config set maxSessionToolCalls abc', m.env);
    assert.ok(m.logged.some((l) => l.includes('Nilai tidak valid')));

    await handleCommand('/config', m.env);
    assert.ok(m.logged.some((l) => l.includes('maxSessionToolCalls')));
  } finally {
    m.restore();
  }
});
