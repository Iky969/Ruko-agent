import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';
import { ContextMessage, DEFAULT_CONFIG } from '../types.js';

class MockInterceptorProvider implements LLMProvider {
  readonly name = 'mock';
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

test('Item 2: Consecutive identical tool calls prevent re-executing I/O and return warning with valid tool_call_id', async () => {
  const identicalCall = '```tool\n{"tool": "read_file", "path": "test.txt"}\n```';
  const provider = new MockInterceptorProvider([
    identicalCall,
    identicalCall,
    'Selesai analisis.',
  ]);

  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);

  const result = await agent.handleInstruction('baca file test');
  assert.equal(result, 'Selesai analisis.');
  assert.equal(provider.receivedMessages.length, 3, 'Should have 3 LLM chat iterations');

  // Verify the second tool message contains the required warning
  const thirdTurnHistory = provider.receivedMessages[2];
  const toolMessages = thirdTurnHistory.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 2, 'Should have 2 tool messages in context');

  const secondToolMessage = toolMessages[1];
  assert.equal(secondToolMessage.role, 'tool');
  assert.ok(secondToolMessage.tool_call_id, 'tool_call_id must be valid');
  assert.ok(
    secondToolMessage.content.includes(
      '[WARNING: Tindakan ini baru saja dijalankan dengan hasil yang sama. Dilarang memanggil ulang tool ini. Gunakan data yang sudah ada di riwayat dan segera lanjutkan ke langkah analisis atau eksekusi berikutnya.]',
    ),
    'Warning text must match Item 2 requirement exactly',
  );
});

test('Item 2: Calling identical tool > 2 times consecutively forcibly interrupts agent loop and directs conclusion', async () => {
  const identicalCall = '```tool\n{"tool": "read_file", "path": "stuck.txt"}\n```';
  // Provider repeatedly outputs identical tool call
  const provider = new MockInterceptorProvider([
    identicalCall,
    identicalCall,
    identicalCall,
    identicalCall,
  ]);

  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);

  const result = await agent.handleInstruction('periksa stuck file');

  assert.ok(result.includes('[deteksi loop]'), 'Result must indicate loop detection');
  assert.ok(
    result.includes('2× berturut-turut') || result.includes('eksekusi dihentikan'),
    'Must interrupt loop after exceeding 2 consecutive calls',
  );
  assert.ok(
    result.includes('simpulkan') || result.includes('respons akhir'),
    'Must direct model/agent to conclude or provide final response',
  );
  assert.ok(provider.receivedMessages.length <= 4, 'Must not loop infinitely');
});
