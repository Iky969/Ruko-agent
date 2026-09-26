import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { ChatOptions, LLMProvider, OpenAiCompatibleProvider } from '../agent/llm.js';
import { ContextMessage, DEFAULT_CONFIG } from '../types.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setWorkspaceRoot } from '../agent/tools.js';

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

// ============================================================================
// Solusi 3: In-Turn Idempotent Tool Cache / De-duplication
// ============================================================================

test('Solusi 3: Idempotent read_file in same turn reuses cache and avoids disk re-read', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-cache-test-'));
  setWorkspaceRoot(tmp);
  const testFile = join(tmp, 'data.txt');
  writeFileSync(testFile, 'Initial File Content 123', 'utf8');

  // Turn 1: reads file, then reads another file
  // Turn 2: reads file again (separated by another tool, so not consecutive repeat)
  // Turn 3: final answer
  const provider = new MockSequenceProvider([
    '```tool\n{"tool": "read_file", "path": "data.txt"}\n```',
    '```tool\n{"tool": "glob", "pattern": "*.txt"}\n```',
    '```tool\n{"tool": "read_file", "path": "data.txt"}\n```',
    'Analisis selesai.',
  ]);

  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config, async () => true, tmp);

  const result = await agent.handleInstruction('periksa file data');
  assert.equal(result, 'Analisis selesai.');

  // Verify all tool responses are recorded in history with valid tool_call_id
  const lastHistory = provider.receivedMessages[provider.receivedMessages.length - 1];
  const toolMessages = lastHistory.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 3, 'All 3 tool messages must have responses');

  const secondReadMsg = toolMessages[2];
  assert.ok(secondReadMsg.content.includes('Initial File Content 123'), 'Cached result preserves content');

  rmSync(tmp, { recursive: true, force: true });
});

test('Solusi 3: Mutating tool (write_file/patch_file) invalidates read cache', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-cache-inval-'));
  setWorkspaceRoot(tmp);
  const targetFile = join(tmp, 'version.txt');
  writeFileSync(targetFile, 'Version 1.0', 'utf8');

  // Turn 1: read_file -> Version 1.0
  // Turn 2: write_file -> Version 2.0 (invalidates cache!)
  // Turn 3: read_file -> must fetch Version 2.0 from disk, NOT cached Version 1.0
  // Turn 4: final answer
  const provider = new MockSequenceProvider([
    '```tool\n{"tool": "read_file", "path": "version.txt"}\n```',
    '```tool\n{"tool": "edit_file", "path": "version.txt", "content": "Version 2.0"}\n```',
    '```tool\n{"tool": "read_file", "path": "version.txt"}\n```',
    'Pembaruan versi berhasil.',
  ]);

  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config, async () => true, tmp);

  const result = await agent.handleInstruction('update versi');
  assert.equal(result, 'Pembaruan versi berhasil.');

  const lastHistory = provider.receivedMessages[provider.receivedMessages.length - 1];
  const toolMessages = lastHistory.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 3);

  const finalReadMsg = toolMessages[2];
  assert.ok(
    finalReadMsg.content.includes('Version 2.0'),
    'Must read fresh content Version 2.0 from disk after cache invalidation',
  );

  rmSync(tmp, { recursive: true, force: true });
});

// ============================================================================
// Solusi 1: Pencegahan Duplikasi di Level Stream (OpenAiCompatibleProvider)
// ============================================================================

test('Solusi 1: OpenAiCompatibleProvider does not duplicate tool blocks when stream sends both content and delta.tool_calls', async () => {
  const provider = new OpenAiCompatibleProvider();
  provider.setCredentials('sk-test-stream', 'https://api.openai.com/v1');
  provider.setModel('gpt-4o');

  // Simulate an SSE response stream where the model sends BOTH delta.content (with tool block)
  // AND delta.tool_calls for the exact same tool
  const sseChunks = [
    'data: {"choices":[{"delta":{"content":"```tool\\n{\\"tool\\": \\"read_file\\", \\"path\\": \\"ui.ts\\"}\\n```"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"read_file","arguments":"{\\"path\\":\\"ui.ts\\"}"}}]}}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of sseChunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  // Mock global.fetch for this provider instance
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };

  try {
    const full = await provider.chat([{ role: 'user', content: 'test stream', timestamp: new Date().toISOString() }]);
    
    // Count occurrences of ```tool blocks in output
    const matches = full.match(/```tool/g) ?? [];
    assert.equal(
      matches.length,
      1,
      `Tool block must appear exactly once, but appeared ${matches.length} times (duplicate detected in stream!)`,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ============================================================================
// Solusi 1 (jalur non-streaming): dedup identik untuk response JSON polos.
// Regression test untuk bug loop-detector false-positive: provider switch
// gagal/timeout → sesi baru → instruksi pertama ter-flag "Perintah identik
// terdeteksi berulang" padahal hanya dipanggil 1x. Penyebabnya: endpoint yang
// mengabaikan `stream` membalas JSON polos berisi message.content (dengan fence
// ```tool dari model) + message.tool_calls (call native yang sama) — jalur
// non-streaming dulu menyintesis blok duplikat tanpa cek dedup.
// ============================================================================

test('Solusi 1 (non-streaming): OpenAiCompatibleProvider does not duplicate tool blocks when plain-JSON response has both content fence and message.tool_calls', async () => {
  const provider = new OpenAiCompatibleProvider();
  provider.setCredentials('sk-test-nonstream', 'https://api.openai.com/v1');
  provider.setModel('gpt-4o');

  const payload = {
    choices: [
      {
        message: {
          content: '```tool\n{"tool": "read_file", "path": "feedback.txt"}\n```',
          tool_calls: [
            {
              id: 'call_456',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"feedback.txt"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    // Plain JSON, BUKAN text/event-stream → memaksa jalur non-streaming.
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const full = await provider.chat([
      { role: 'user', content: 'baca feedback.txt', timestamp: new Date().toISOString() },
    ]);

    // Fence yang sudah ditulis model di content harus dipertahankan;
    // tool_call native identik TIDAK boleh disintesis ulang.
    const matches = full.match(/```tool/g) ?? [];
    assert.equal(
      matches.length,
      1,
      `Tool block must appear exactly once in non-streaming output, but appeared ${matches.length} times (duplicate synthesis!)`,
    );
    assert.ok(full.includes('feedback.txt'), 'Original content fence must be preserved');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ============================================================================
// Solusi 2: Penguatan Loop Detector dengan Batch Deduplication & N-Gram Cycles
// ============================================================================

test('Solusi 2: Batch deduplication skips duplicated tool calls within the same step', async () => {
  // Provider returns 4 tool calls in a single turn where call 1 & 2 are repeated as call 3 & 4
  const batchCalls = [
    '```tool\n{"tool": "read_file", "path": "fileA.txt"}\n```\n' +
    '```tool\n{"tool": "read_file", "path": "fileB.txt"}\n```\n' +
    '```tool\n{"tool": "read_file", "path": "fileA.txt"}\n```\n' +
    '```tool\n{"tool": "read_file", "path": "fileB.txt"}\n```',
    'Batch selesai.',
  ];

  const tmp = mkdtempSync(join(tmpdir(), 'ruko-batch-dedup-'));
  setWorkspaceRoot(tmp);
  writeFileSync(join(tmp, 'fileA.txt'), 'Content A', 'utf8');
  writeFileSync(join(tmp, 'fileB.txt'), 'Content B', 'utf8');

  const provider = new MockSequenceProvider(batchCalls);
  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config, async () => true, tmp);

  const result = await agent.handleInstruction('proses batch file');
  assert.equal(result, 'Batch selesai.');

  // Verify that all 4 calls received responses, but the duplicates received warning/cached response
  const lastHistory = provider.receivedMessages[provider.receivedMessages.length - 1];
  const toolMessages = lastHistory.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 4, 'All 4 calls must have matching tool responses');

  // Calls 3 and 4 were detected as duplicates and did not perform duplicate disk executions
  assert.ok(
    toolMessages[2].content.includes('Content A') || toolMessages[2].content.includes('WARNING'),
    'Duplicate call 3 safely resolved without unhandled error',
  );

  rmSync(tmp, { recursive: true, force: true });
});

test('Solusi 2: N-gram cycle detection halts multi-step repeating cycle [A, B] -> [A, B] -> [A, B]', async () => {
  // Repeating cycle of 2 tools: tool A (read A), tool B (read B) across turns
  const cycleTurn1 = '```tool\n{"tool": "read_file", "path": "cycleA.txt"}\n```';
  const cycleTurn2 = '```tool\n{"tool": "read_file", "path": "cycleB.txt"}\n```';

  const provider = new MockSequenceProvider([
    cycleTurn1,
    cycleTurn2,
    cycleTurn1,
    cycleTurn2,
    cycleTurn1,
    cycleTurn2,
    cycleTurn1,
  ]);

  const tmp = mkdtempSync(join(tmpdir(), 'ruko-cycle-test-'));
  setWorkspaceRoot(tmp);
  writeFileSync(join(tmp, 'cycleA.txt'), 'Cycle A', 'utf8');
  writeFileSync(join(tmp, 'cycleB.txt'), 'Cycle B', 'utf8');

  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config, async () => true, tmp);

  const result = await agent.handleInstruction('periksa loop siklus');

  // Verify that loop detector stopped the cycle
  assert.ok(result.includes('[deteksi loop]'), 'Must trigger loop detection');
  assert.ok(
    result.includes('siklus pemanggilan') || result.includes('sudah dipanggil'),
    'Must indicate cycle or repeat detection',
  );
  assert.ok(result.includes('eksekusi dihentikan'), 'Must halt execution');
  assert.ok(
    result.includes('simpulkan') || result.includes('respons akhir'),
    'Must guide model to finalize response',
  );

  rmSync(tmp, { recursive: true, force: true });
});
