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
