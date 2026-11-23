import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';
import { setWorkspaceRoot } from '../agent/tools.js';
import { ContextMessage, DEFAULT_CONFIG } from '../types.js';

class MockSequenceProvider implements LLMProvider {
  readonly name = 'mock-sequence';
  readonly isConfigured = true;
  model = 'mock-model';
  lastFinishReason: string | null = 'stop';
  receivedMessages: ContextMessage[][] = [];
  private calls = 0;

  constructor(private readonly replies: string[]) {}

  setModel(model: string): void {
    this.model = model;
  }

  async chat(messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    this.receivedMessages.push([...messages]);
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    options?.onToken?.(reply);
    return reply;
  }
}

test('Episode counting: 4 thought berturut-turut tanpa tool call = 1 episode, TIDAK memicu breaker', async () => {
  const origDelay = process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
  process.env.RUKO_THOUGHT_LOOP_DELAY_MS = '10';
  try {
    const thoughtOnly = '<thought>sedang memikirkan rencana langkah selanjutnya...</thought>';
    const provider = new MockSequenceProvider([
      thoughtOnly,
      thoughtOnly,
      thoughtOnly,
      thoughtOnly,
    ]);

    // maxToolIterations kecil supaya test cepat: 6 giliran thought-only
    // dalam SATU episode harus berjalan sampai batas iterasi, bukan breaker.
    const config = { ...DEFAULT_CONFIG, maxToolIterations: 6 };
    const ctx = new Context(config);
    const agent = new Agent(ctx, provider, config);

    const result = await agent.handleInstruction('jalankan pemeriksaan tanpa tool');

    assert.ok(
      !result.includes('terjebak dalam thought loop'),
      'Satu episode thought-only tidak boleh memicu breaker',
    );
    assert.ok(
      result.includes('reached max tool iterations'),
      'Run berakhir di batas iterasi (maxIterations), bukan breaker',
    );
    assert.equal(
      provider.receivedMessages.length,
      6,
      'Semua 6 iterasi dijalankan (mock mengulang reply thought-only)',
    );
  } finally {
    if (origDelay !== undefined) {
      process.env.RUKO_THOUGHT_LOOP_DELAY_MS = origDelay;
    } else {
      delete process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
    }
  }
});

test('Circuit breaker: Jeda minimum (500ms) diterapkan sebelum giliran berikutnya saat turn thought-only', async () => {
  const origDelay = process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
  delete process.env.RUKO_THOUGHT_LOOP_DELAY_MS; // Memastikan menggunakan jeda default 500ms
  // Invariant, bukan wall-clock: di runner Windows yang lambat sekalipun,
  // total elapsed bisa meleset — yang dijamin adalah (a) setiap jeda yang
  // dijadwalkan agent berada di [400,600]ms, dan (b) jeda antar chat-call
  // tidak pernah di bawah 300ms. Patch setTimeout untuk mencatat delay.
  const origSetTimeout = globalThis.setTimeout;
  const scheduledDelays: number[] = [];
  (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = (((
    cb: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (typeof ms === 'number') scheduledDelays.push(ms);
    return origSetTimeout(cb, ms, ...args);
  }) as unknown) as typeof setTimeout;
  try {
    const thoughtOnly = '<thought>menghitung algoritma tanpa eksekusi tool...</thought>';
    const provider = new MockSequenceProvider([
      thoughtOnly,
      thoughtOnly,
      thoughtOnly,
      thoughtOnly,
      thoughtOnly,
    ]);
    const chatCallTimes: number[] = [];
    const origChat = provider.chat.bind(provider);
    provider.chat = (async (messages: ContextMessage[], options?: ChatOptions) => {
      chatCallTimes.push(Date.now());
      return origChat(messages, options);
    }) as typeof provider.chat;

    // 5 giliran = 1 episode: breaker tidak menendang, run berakhir di
    // batas iterasi setelah 4+ jeda thought-only.
    const config = { ...DEFAULT_CONFIG, maxToolIterations: 5 };
    const ctx = new Context(config);
    const agent = new Agent(ctx, provider, config);

    const result = await agent.handleInstruction('proses data berat');

    assert.ok(
      result.includes('reached max tool iterations'),
      'Satu episode berakhir di batas iterasi, bukan breaker',
    );
    const thoughtDelays = scheduledDelays.filter((d) => d >= 400 && d <= 600);
    assert.ok(
      thoughtDelays.length >= 4,
      `Harus ada >=4 jeda thought-only di [400,600]ms (ditemukan ${thoughtDelays.length} dari ${scheduledDelays.length} delay terjadwal: ${scheduledDelays.join(',')})`,
    );
    for (let i = 1; i < chatCallTimes.length; i += 1) {
      const gap = chatCallTimes[i] - chatCallTimes[i - 1];
      assert.ok(
        gap >= 300,
        `Jeda antar chat-call ke-${i} harus >=300ms (aktual: ${gap}ms)`,
      );
    }
  } finally {
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = origSetTimeout;
    if (origDelay !== undefined) {
      process.env.RUKO_THOUGHT_LOOP_DELAY_MS = origDelay;
    } else {
      delete process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
    }
  }
});

test('Regression test: Agent yang memanggil tool normal tidak terpengaruh/terblokir oleh circuit breaker', async () => {
  const origDelay = process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
  process.env.RUKO_THOUGHT_LOOP_DELAY_MS = '10';
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-cb-test-'));
  setWorkspaceRoot(tmp);

  try {
    writeFileSync(join(tmp, 'f1.txt'), 'isi file 1', 'utf8');
    writeFileSync(join(tmp, 'f2.txt'), 'isi file 2', 'utf8');
    writeFileSync(join(tmp, 'f3.txt'), 'isi file 3', 'utf8');
    writeFileSync(join(tmp, 'f4.txt'), 'isi file 4', 'utf8');

    const provider = new MockSequenceProvider([
      '<thought>baca file 1</thought>\n```tool\n{"tool": "read_file", "path": "f1.txt"}\n```',
      '<thought>baca file 2</thought>\n```tool\n{"tool": "read_file", "path": "f2.txt"}\n```',
      '<thought>baca file 3</thought>\n```tool\n{"tool": "read_file", "path": "f3.txt"}\n```',
      '<thought>baca file 4</thought>\n```tool\n{"tool": "read_file", "path": "f4.txt"}\n```',
      '<thought>analisis selesai</thought>\nSemua 4 file berhasil dibaca dan diverifikasi.',
    ]);

    const config = { ...DEFAULT_CONFIG, maxToolIterations: 10 };
    const ctx = new Context(config);
    const agent = new Agent(ctx, provider, config);

    const result = await agent.handleInstruction('baca 4 file berturut-turut');

    assert.ok(
      result.includes('Semua 4 file berhasil dibaca dan diverifikasi.'),
      'Harus berhasil menyelesaikan seluruh tool calls tanpa terblokir',
    );
    assert.equal(provider.receivedMessages.length, 5, 'Harus menjalankan 4 tool calls + 1 final answer');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (origDelay !== undefined) {
      process.env.RUKO_THOUGHT_LOOP_DELAY_MS = origDelay;
    } else {
      delete process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
    }
  }
});

test('Regression test: Respons thought dengan jawaban teks langsung ke user tidak memicu circuit breaker', async () => {
  const provider = new MockSequenceProvider([
    '<thought>pertimbangan cepat</thought>Halo! Saya siap membantu.',
  ]);

  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);

  const result = await agent.handleInstruction('sapa saya');
  assert.equal(result, 'Halo! Saya siap membantu.');
  assert.equal(provider.receivedMessages.length, 1);
});
