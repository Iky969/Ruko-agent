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
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    out += s;
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
