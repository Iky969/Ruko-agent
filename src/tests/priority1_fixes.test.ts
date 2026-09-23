import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent, DEFAULT_MAX_TOOL_ITERATIONS } from '../agent/agent.js';
import { handleCommand } from '../agent/commands.js';
import { GeminiProvider } from '../agent/llm.js';
import { runSubagent } from '../agent/subagent.js';
import {
  assertNotSensitivePath,
  isSensitivePath,
  runToolCall,
} from '../agent/tools.js';
import { Context } from '../core/context.js';
import { AgentConfig, DEFAULT_CONFIG } from '../types.js';

// =============================================================================
// Item 1: MAX_TOOL_ITERATIONS Konfigurabel & Subagent maxIterations Inheritance
// =============================================================================

test('Item 1: DEFAULT_CONFIG has maxToolIterations = 30 and Agent uses new default', async () => {
  assert.equal(DEFAULT_CONFIG.maxToolIterations, 30);
  assert.equal(DEFAULT_MAX_TOOL_ITERATIONS, 30);

  // Verify Agent loop stops at configured maxToolIterations
  let callCount = 0;
  const mockLlm = {
    name: 'mock',
    isConfigured: true,
    model: 'mock-model',
    chat: async () => {
      callCount++;
      // Emits distinct tool call every time so loop continues until maxIterations without triggering loop breaker
      return `\`\`\`tool\n{"tool":"mock_tool","step":${callCount}}\n\`\`\``;
    },
    setModel: () => {},
  };

  const cfg: AgentConfig = {
    ...DEFAULT_CONFIG,
    maxToolIterations: 4,
  };
  const ctx = new Context(cfg);
  const agent = new Agent(ctx, mockLlm as any, cfg);

  const res = await agent.handleInstruction('test iterations');
  assert.equal(callCount, 4, 'agent should have stopped at custom maxToolIterations (4)');
  assert.ok(res.includes('reached max tool iterations without a final answer'));
});

test('Item 1: /settings iterations overrides maxToolIterations and validates input', async () => {
  let activeConfig: AgentConfig = { ...DEFAULT_CONFIG, maxToolIterations: 30 };
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(' '));

  const env: any = {
    config: activeConfig,
    updateConfig: (patch: Partial<AgentConfig>) => {
      Object.assign(activeConfig, patch);
    },
    ctx: new Context(activeConfig),
    llm: { name: 'mock', model: 'mock-v1' },
    agent: {},
    confirm: async () => true,
    handle: { getSessionId: () => 'sess-1' },
  };

  try {
    // Check current value display
    await handleCommand('/settings iterations', env);
    assert.ok(logs.some((l) => l.includes('30 iterasi')), 'should display current 30 iterations');

    // Valid update
    logs.length = 0;
    await handleCommand('/settings iterations 50', env);
    assert.equal(activeConfig.maxToolIterations, 50);
    assert.ok(logs.some((l) => l.includes('50 iterasi')), 'should confirm update to 50');

    // Invalid input: negative or zero
    logs.length = 0;
    await handleCommand('/settings iterations -5', env);
    assert.equal(activeConfig.maxToolIterations, 50, 'config should not change on negative');
    assert.ok(logs.some((l) => l.includes('Error: nilai iterations harus berupa bilangan bulat positif')));

    // Invalid input: non-integer
    logs.length = 0;
    await handleCommand('/settings iterations abc', env);
    assert.equal(activeConfig.maxToolIterations, 50);
    assert.ok(logs.some((l) => l.includes('Error: nilai iterations harus berupa bilangan bulat positif')));
  } finally {
    console.log = originalLog;
  }
});

test('Item 1: runSubagent respects custom maxIterations separate from parent limit', async () => {
  let subagentCalls = 0;
  const mockLlm = {
    name: 'mock',
    isConfigured: true,
    model: 'mock-model',
    chat: async () => {
      subagentCalls++;
      return `\`\`\`tool\n{"tool":"mock_tool","step":${subagentCalls}}\n\`\`\``;
    },
    setModel: () => {},
  };

  const parentConfig: AgentConfig = {
    ...DEFAULT_CONFIG,
    maxToolIterations: 30, // Parent has limit of 30
  };

  // Run subagent with maxIterations = 3
  const result = await runSubagent(
    'research task',
    {
      config: parentConfig,
      llmProvider: mockLlm as any,
    },
    {
      maxIterations: 3, // Subagent custom limit
    },
  );

  assert.equal(subagentCalls, 3, 'subagent must stop at its custom maxIterations limit (3)');
  assert.ok(result.includes('reached max tool iterations without a final answer'));
});

// =============================================================================
// Item 2: Lindungi .ruko/trusted dari Modifikasi Tool Agen
// =============================================================================

test('Item 2: isSensitivePath and assertNotSensitivePath detect .ruko/trusted', () => {
  const ws = '/workspace/project';

  // Relative paths
  assert.equal(isSensitivePath('.ruko/trusted', ws), true);
  assert.equal(isSensitivePath('./.ruko/trusted', ws), true);
  assert.equal(isSensitivePath('.ruko\\trusted', ws), true);
  assert.equal(isSensitivePath('.RUKO/TRUSTED', ws), true);

  // Absolute paths
  assert.equal(isSensitivePath(`${ws}/.ruko/trusted`, ws), true);
  assert.equal(isSensitivePath('/home/user/.ruko/trusted', ws), true);

  // Path traversal attempts
  assert.equal(isSensitivePath('subdir/../.ruko/trusted', ws), true);

  // assertNotSensitivePath throws with explicit error
  assert.throws(
    () => assertNotSensitivePath('.ruko/trusted', ws),
    /Akses ke file sensitif ".ruko\/trusted" ditolak demi keamanan kredensial\/data sensitif\./,
  );
  assert.throws(
    () => assertNotSensitivePath(`${ws}/.ruko/trusted`, ws),
    /Akses ke file sensitif .* ditolak demi keamanan kredensial\/data sensitif\./,
  );
});

test('Item 2: write_file, edit_file, patch_file, delete_file reject .ruko/trusted with explicit error', async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-trusted-test-'));
  try {
    // 1. write_file
    const writeRes = JSON.parse(
      await runToolCall(
        { tool: 'write_file', path: '.ruko/trusted', content: 'trusted-dir\n' },
        { workspaceRoot: tmpWs },
      ),
    );
    assert.ok(writeRes.error, 'write_file should return error');
    assert.ok(
      writeRes.error.includes('Akses ke file sensitif') && writeRes.error.includes('.ruko/trusted'),
      `unexpected write_file error: ${writeRes.error}`,
    );

    // 2. edit_file
    const editRes = JSON.parse(
      await runToolCall(
        { tool: 'edit_file', path: '.ruko/trusted', content: 'new-content' },
        { workspaceRoot: tmpWs },
      ),
    );
    assert.ok(editRes.error, 'edit_file should return error');
    assert.ok(
      editRes.error.includes('Akses ke file sensitif') && editRes.error.includes('.ruko/trusted'),
      `unexpected edit_file error: ${editRes.error}`,
    );

    // 3. patch_file
    const patchRes = JSON.parse(
      await runToolCall(
        { tool: 'patch_file', path: '.ruko/trusted', oldText: 'a', newText: 'b' },
        { workspaceRoot: tmpWs },
      ),
    );
    assert.ok(patchRes.error, 'patch_file should return error');
    assert.ok(
      patchRes.error.includes('Akses ke file sensitif') && patchRes.error.includes('.ruko/trusted'),
      `unexpected patch_file error: ${patchRes.error}`,
    );

    // 4. delete_file
    const deleteRes = JSON.parse(
      await runToolCall(
        { tool: 'delete_file', path: '.ruko/trusted' },
        { workspaceRoot: tmpWs },
      ),
    );
    assert.ok(deleteRes.error, 'delete_file should return error');
    assert.ok(
      deleteRes.error.includes('Akses ke file sensitif') && deleteRes.error.includes('.ruko/trusted'),
      `unexpected delete_file error: ${deleteRes.error}`,
    );
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

// =============================================================================
// Item 3: Parser Multi-Part Streaming & Thought Extraction GeminiProvider
// =============================================================================

test('Item 3: GeminiProvider streaming iterates all parts, extracts thought, and does not lose text', async () => {
  const provider = new GeminiProvider({
    apiKey: 'fake-key',
    model: 'gemini-2.0-flash',
  });

  // Mock SSE response with multiple parts (thought + multiple text parts)
  const sseChunks = [
    // Chunk 1: Thought part
    'data: ' +
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ thought: 'Analisis masalah langkah 1... ' }],
            },
          },
        ],
      }) +
      '\n\n',

    // Chunk 2: More thought
    'data: ' +
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ thought: 'Analisis masalah langkah 2.' }],
            },
          },
        ],
      }) +
      '\n\n',

    // Chunk 3: Candidate with multiple text parts in the same candidate
    'data: ' +
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Halo! Bagian 1. ' },
                { text: 'Bagian 2 dari respons. ' },
              ],
            },
          },
        ],
      }) +
      '\n\n',

    // Chunk 4: Final candidate with stop finishReason and last text part
    'data: ' +
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'Bagian 3 selesai.' }],
            },
            finishReason: 'STOP',
          },
        ],
      }) +
      '\n\n',
  ];

  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of sseChunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });

  const receivedTokens: string[] = [];
  const receivedThoughts: string[] = [];

  try {
    const reply = await provider.chat(
      [{ role: 'user', content: 'test', timestamp: '' }],
      {
        onToken: (tok) => receivedTokens.push(tok),
        onThought: (th) => receivedThoughts.push(th),
      },
    );

    // Verify all text parts are present and joined in reply
    assert.equal(
      reply,
      'Halo! Bagian 1. Bagian 2 dari respons. Bagian 3 selesai.',
      'all parts must be concatenated without data loss',
    );
    assert.equal(
      receivedTokens.join(''),
      'Halo! Bagian 1. Bagian 2 dari respons. Bagian 3 selesai.',
    );

    // Verify thought extraction
    assert.equal(
      receivedThoughts.join(''),
      'Analisis masalah langkah 1... Analisis masalah langkah 2.',
    );
    assert.equal(
      provider.lastReasoning,
      'Analisis masalah langkah 1... Analisis masalah langkah 2.',
    );
    assert.equal(provider.lastFinishReason, 'STOP');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Item 3: GeminiProvider non-streaming parses multi-part payload with thought boolean and text', async () => {
  const provider = new GeminiProvider({
    apiKey: 'fake-key',
    model: 'gemini-2.0-flash-thinking',
  });

  const responseJson = {
    candidates: [
      {
        content: {
          parts: [
            { text: 'Thinking about the answer...', thought: true },
            { text: 'Answer part 1. ' },
            { text: 'Answer part 2.' },
          ],
        },
        finishReason: 'STOP',
      },
    ],
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(responseJson), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const thoughts: string[] = [];
  const tokens: string[] = [];

  try {
    const reply = await provider.chat(
      [{ role: 'user', content: 'test', timestamp: '' }],
      {
        onToken: (t) => tokens.push(t),
        onThought: (th) => thoughts.push(th),
      },
    );

    // Text output must only have the non-thought parts
    assert.equal(reply, 'Answer part 1. Answer part 2.');
    assert.equal(tokens.join(''), 'Answer part 1. Answer part 2.');

    // Thought must be properly captured
    assert.equal(thoughts.join(''), 'Thinking about the answer...');
    assert.equal(provider.lastReasoning, 'Thinking about the answer...');
    assert.equal(provider.lastFinishReason, 'STOP');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// =============================================================================
// Item 4: ThoughtSlidingWindow Dead Import Cleaned from agent.ts
// =============================================================================

test('Item 4: agent.ts does not import ThoughtSlidingWindow', () => {
  const agentSource = readFileSync(new URL('../../src/agent/agent.ts', import.meta.url), 'utf8');
  assert.ok(
    !agentSource.includes('ThoughtSlidingWindow'),
    'agent.ts should not contain dead import of ThoughtSlidingWindow',
  );
});
