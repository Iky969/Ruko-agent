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

test('Circuit breaker: Simulasi 4 thought berturut tanpa tool call berhenti dengan error deskriptif', async () => {
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

    const config = { ...DEFAULT_CONFIG };
    const ctx = new Context(config);
    const agent = new Agent(ctx, provider, config);

    const result = await agent.handleInstruction('jalankan pemeriksaan tanpa tool');

    assert.equal(
      result,
      'Agent terjebak dalam thought loop tanpa memanggil tool.',
      'Harus berhenti dengan pesan error deskriptif yang ditentukan',
    );
    assert.equal(
      provider.receivedMessages.length,
      4,
      'Loop harus berhenti tepat pada percobaan ke-4, bukan hang atau infinite loop',
    );
  } finally {
    if (origDelay !== undefined) {
      process.env.RUKO_THOUGHT_LOOP_DELAY_MS = origDelay;
    } else {
      delete process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
    }
  }
});

test('Circuit breaker: Jeda minimum (500ms-1s) diterapkan sebelum giliran berikutnya saat turn thought-only', async () => {
  const origDelay = process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
  delete process.env.RUKO_THOUGHT_LOOP_DELAY_MS; // Memastikan menggunakan jeda default 500ms
  try {
    const thoughtOnly = '<thought>menghitung algoritma tanpa eksekusi tool...</thought>';
    const provider = new MockSequenceProvider([
      thoughtOnly,
      thoughtOnly,
      thoughtOnly,
      thoughtOnly,
    ]);

    const config = { ...DEFAULT_CONFIG };
    const ctx = new Context(config);
    const agent = new Agent(ctx, provider, config);

    const startTime = Date.now();
    const result = await agent.handleInstruction('proses data berat');
    const elapsedMs = Date.now() - startTime;

    assert.equal(result, 'Agent terjebak dalam thought loop tanpa memanggil tool.');
    // 4 thought-only turns = 3 jeda antar turn (3 x 500ms = 1500ms minimum)
    assert.ok(
      elapsedMs >= 1400,
      `Harus ada jeda minimum 500ms per turn thought-only (elapsed: ${elapsedMs}ms)`,
    );
  } finally {
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
