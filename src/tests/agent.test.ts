import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../agent/agent.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';
import { Context } from '../core/context.js';
import { AgentConfig, ContextMessage, DEFAULT_CONFIG } from '../types.js';

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

const config: AgentConfig = { ...DEFAULT_CONFIG, approvalEnabled: false };

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let out = '';
  (process.stdout as unknown as { write: (s: any, ...args: any[]) => boolean }).write = (
    s: any,
    ...args: any[]
  ) => {
    out += typeof s === 'string' ? s : s?.toString() ?? '';
    return true;
  };
  try {
    const result = await fn();
    return { result, out };
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
}

test('agent drops a dangling preamble before a tool block (§2)', async () => {
  const provider = new FakeProvider([
    'dengan: melihat daftar perintah\n```tool\n{"tool": "exec", "command": "echo ok"}\n```',
    'Halo! Ada yang bisa saya bantu?',
  ]);
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  const { result, out } = await captureStdout(() => agent.handleInstruction('halo'));
  assert.ok(!out.includes('dengan:'), 'fragment before the hidden tool block must not print');
  assert.ok(out.includes('Halo! Ada yang bisa saya bantu?'), 'final answer is revealed');
  assert.equal(result, 'Halo! Ada yang bisa saya bantu?');
  assert.equal(agent.lastResponseStreamed, true);
  assert.ok((agent.lastUsage?.completionChars ?? 0) > 0);
});

test('agent does not call a tool for a plain greeting and returns full text', async () => {
  const provider = new FakeProvider(['Halo! Saya Ruko, siap membantu.']);
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  const { result, out } = await captureStdout(() => agent.handleInstruction('halo'));
  assert.equal(result, 'Halo! Saya Ruko, siap membantu.');
  assert.ok(out.includes('Halo! Saya Ruko, siap membantu.'), 'answer streams through untouched');
});

// --- v0.7 turn interruption (AbortSignal) -----------------------------------

/** Provider that hangs until its signal aborts, then rejects AbortError. */
class HangingProvider implements LLMProvider {
  readonly name = 'hang';
  readonly isConfigured = true;
  model = 'hang-model';
  aborted = false;
  setModel(): void {}
  chat(_messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    return new Promise<string>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        this.aborted = true;
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }
}

test('interrupted turn resolves cleanly with empty response instead of throwing (v0.7 #3)', async () => {
  const provider = new HangingProvider();
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  const ac = new AbortController();
  const turn = agent.handleInstruction('kerja lama', ac.signal);
  setTimeout(() => ac.abort(), 10);
  const { result } = await captureStdout(() => turn);
  assert.equal(result, '', 'aborted turn returns empty response');
  assert.ok(provider.aborted, 'provider saw the abort signal');
});

test('already-aborted signal stops the turn before any request (v0.7)', async () => {
  const provider = new FakeProvider(['tidak boleh terpanggil']);
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  const ac = new AbortController();
  ac.abort();
  const { result } = await captureStdout(() => agent.handleInstruction('x', ac.signal));
  assert.equal(result, '', 'aborted up-front returns empty');
});

// --- §5 mechanical guard: consecutive identical tool call deduplication -----

test('two consecutive identical destructive tool calls across steps: second call is skipped with clear warning (§5)', async () => {
  let execCount = 0;
  // Provider returns identical exec call in step 1 and step 2, then final text in step 3
  const provider = new FakeProvider([
    '```tool\n{"tool": "exec", "command": "echo destructive-action"}\n```',
    '```tool\n{"tool": "exec", "command": "echo destructive-action"}\n```',
    'Tugas selesai.',
  ]);
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  const { result, out } = await captureStdout(() => agent.handleInstruction('jalankan perintah'));

  assert.equal(result, 'Tugas selesai.');
  assert.ok(out.includes('Perintah identik terdeteksi berulang, dilewati'), 'warning is logged to user');
});

test('two identical tool calls within the same step: second call is skipped (§5)', async () => {
  const provider = new FakeProvider([
    '```tool\n{"tool": "exec", "command": "echo once"}\n```\n```tool\n{"tool": "exec", "command": "echo once"}\n```',
    'Selesai satu kali.',
  ]);
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  const { result, out } = await captureStdout(() => agent.handleInstruction('jalankan'));

  assert.equal(result, 'Selesai satu kali.');
  assert.ok(out.includes('Perintah identik terdeteksi berulang, dilewati'), 'warning is logged when duplicate appears in same response');
});

// --- Empty content handling & Tool result normalization tests --------------

class RecordingProvider implements LLMProvider {
  readonly name = 'recording';
  readonly isConfigured = true;
  model = 'recording-model';
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

test('empty content after tool execution triggers follow-up message to summarize results instead of no-response', async () => {
  const provider = new RecordingProvider([
    '```tool\n{"tool": "exec", "command": "echo data-ok"}\n```',
    '', // Model returns empty content after tool execution
    'Hasil eksekusi adalah data-ok.', // Model responds to follow-up summary prompt
  ]);
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  const { result, out } = await captureStdout(() => agent.handleInstruction('ambil data'));

  assert.equal(result, 'Hasil eksekusi adalah data-ok.');
  assert.ok(!out.includes('(no response)'), 'must never print (no response)');
  assert.equal(provider.receivedMessages.length, 3, 'three chat calls: tool block, empty response, follow-up summary');

  // Verify internal follow-up user prompt was sent
  const lastMsgHistory = provider.receivedMessages[2];
  const followUpMsg = lastMsgHistory[lastMsgHistory.length - 1];
  assert.equal(followUpMsg.role, 'user');
  assert.ok(followUpMsg.content.includes('ringkasan') || followUpMsg.content.includes('rangkuman'));
});

test('tool call and tool result schema contains valid tool_call_id and tool_calls metadata', async () => {
  const provider = new RecordingProvider([
    '```tool\n{"tool": "exec", "command": "echo schema-check"}\n```',
    'Tuntas.',
  ]);
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  await captureStdout(() => agent.handleInstruction('cek schema'));

  assert.equal(provider.receivedMessages.length, 2);
  const secondCallMsgs = provider.receivedMessages[1];

  // Check assistant message has tool_calls
  const assistantMsg = secondCallMsgs.find((m) => m.role === 'assistant');
  assert.ok(assistantMsg, 'assistant message must exist');
  assert.ok(Array.isArray(assistantMsg?.tool_calls), 'assistant must have tool_calls array');
  assert.ok((assistantMsg?.tool_calls?.length ?? 0) > 0);
  const expectedId = assistantMsg?.tool_calls?.[0]?.id;
  assert.ok(expectedId && expectedId.startsWith('call_'));

  // Check tool result message has matching tool_call_id
  const toolMsg = secondCallMsgs.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'tool message must exist');
  assert.equal(toolMsg?.tool_call_id, expectedId, 'tool_call_id must match assistant tool_calls id');
  assert.equal(toolMsg?.name, 'exec', 'tool name must match tool executed');
});

test('reproduksi gejala: teks asisten dan tool call identik berulang pada giliran berturut-turut', async () => {
  const provider = new RecordingProvider([
    'Saya periksa dulu kodenya...\n```tool\n{"tool": "read_file", "path": "a.txt"}\n```',
    'Saya periksa dulu kodenya...\n```tool\n{"tool": "read_file", "path": "a.txt"}\n```',
    'Pemeriksaan selesai.',
  ]);
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  const { result, out } = await captureStdout(() => agent.handleInstruction('periksa file a.txt'));

  assert.equal(result, 'Pemeriksaan selesai.');
  assert.equal(provider.receivedMessages.length, 3, 'tiga giliran chat dipanggil');
  assert.ok(out.includes('Perintah identik terdeteksi berulang, dilewati'), 'guard mendeteksi tool call kedua berulang');

  // Inspeksi message history pada giliran 2: assistant message harus utuh (teks + tool call)
  const secondCallMsgs = provider.receivedMessages[1];
  const assistantMsg = secondCallMsgs.find((m) => m.role === 'assistant');
  assert.ok(assistantMsg, 'assistant message harus ada di context');
  assert.ok(assistantMsg?.content.includes('Saya periksa dulu kodenya...'), 'teks asisten tersimpan');
  assert.ok(assistantMsg?.content.includes('```tool'), 'blok tool call dipertahankan secara utuh');
  assert.ok(Array.isArray(assistantMsg?.tool_calls), 'tool_calls metadata tetap ada');

  // Inspeksi pesan tool hasil giliran kedua: menginformasikan hasil sudah ada di konteks
  const thirdCallMsgs = provider.receivedMessages[2];
  const skippedToolMsg = thirdCallMsgs[thirdCallMsgs.length - 1];
  assert.equal(skippedToolMsg.role, 'tool');
  assert.ok(skippedToolMsg.content.includes('sudah ada di konteks percakapan di atas'));
});

test('two consecutive different tool calls across steps are both executed without deduplication blocking', async () => {
  const provider = new RecordingProvider([
    '```tool\n{"tool": "read_file", "path": "a.txt"}\n```',
    '```tool\n{"tool": "read_file", "path": "b.txt"}\n```',
    'Kedua file sudah dibaca.',
  ]);
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  const { result, out } = await captureStdout(() => agent.handleInstruction('baca file a dan b'));

  assert.equal(result, 'Kedua file sudah dibaca.');
  assert.ok(
    !out.includes('Perintah identik terdeteksi berulang, dilewati'),
    'tool call berbeda tidak boleh diblokir oleh guard deduplikasi',
  );
  assert.equal(provider.receivedMessages.length, 3);

  // Pastikan kedua tool result masuk ke riwayat pada giliran ke-3
  const thirdCallMsgs = provider.receivedMessages[2];
  const toolResults = thirdCallMsgs.filter((m) => m.role === 'tool');
  assert.equal(toolResults.length, 2, 'kedua tool dieksekusi secara berurutan');
});

test('user message is not duplicated in prompt history when context already has it', async () => {
  const ctx = new Context(config);
  ctx.add('user', 'baca kode');
  const provider = new RecordingProvider(['Tuntas.']);
  const agent = new Agent(ctx, provider, config);
  await captureStdout(() => agent.handleInstruction('baca kode'));

  assert.equal(provider.receivedMessages.length, 1);
  const userMsgs = provider.receivedMessages[0].filter((m) => m.role === 'user');
  assert.equal(userMsgs.length, 1, 'pesan user tidak boleh duplikat');
  assert.equal(userMsgs[0].content, 'baca kode');
});

test('loop breaker (item 7): terminates early on repeated identical tool calls without running to max iterations', async () => {
  const repeatedTool = '```tool\n{"tool": "exec", "command": "echo loop"}\n```';
  const provider = new RecordingProvider([
    repeatedTool,
    repeatedTool,
    repeatedTool,
    repeatedTool,
    repeatedTool,
    repeatedTool,
  ]);
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  const { result } = await captureStdout(() => agent.handleInstruction('stuck loop'));
  assert.ok(result.includes('[deteksi loop]'));
  assert.ok(provider.receivedMessages.length <= 5, `Expected <= 5 iterations, got ${provider.receivedMessages.length}`);
});





