import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import {
  createProvider,
  detectProviderKind,
  ResponsesApiProvider,
} from '../agent/llm.js';
import { ContextMessage, DEFAULT_CONFIG } from '../types.js';

async function withFetchStub<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function makeProvider(baseUrl = 'https://example.com/v1'): ResponsesApiProvider {
  return new ResponsesApiProvider({ apiKey: 'sk-test', baseUrl, model: 'gpt-5-codex' });
}

test('streaming: reasoning summary delta → onThought, output delta → onToken, completed → stop', async () => {
  const urls: string[] = [];
  let sentBody = '';
  const provider = makeProvider('https://example.com/v1/responses');
  await withFetchStub(async (input, init) => {
    urls.push(String(input));
    sentBody = String(init?.body ?? '');
    return sseResponse([
      sseData({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, delta: 'Memeriksa ' }),
      sseData({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, delta: 'file dulu.' }),
      sseData({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'Halo, ' }),
      sseData({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'dunia!' }),
      sseData({ type: 'response.completed', response: { status: 'completed' } }),
    ]);
  }, async () => {
    const thoughts: string[] = [];
    const tokens: string[] = [];
    const text = await provider.chat(
      [
        { role: 'user', content: 'halo', timestamp: '' },
        { role: 'assistant', content: 'tool call', timestamp: '' },
        { role: 'tool', content: 'isi file', timestamp: '' },
      ],
      {
        reasoning: 'medium',
        onThought: (t) => thoughts.push(t),
        onToken: (t) => tokens.push(t),
      },
    );
    assert.equal(text, 'Halo, dunia!');
    assert.deepEqual(thoughts, ['Memeriksa ', 'file dulu.']);
    assert.deepEqual(tokens, ['Halo, ', 'dunia!']);
    assert.equal(provider.lastFinishReason, 'stop');
    assert.equal(provider.lastReasoning, 'Memeriksa file dulu.');
  });
  // Trailing /responses di baseUrl tidak boleh digandakan.
  assert.deepEqual(urls, ['https://example.com/v1/responses']);
  // History role tool dipetakan ke user di input (pola Anthropic).
  const input = JSON.parse(sentBody).input as Array<{ role: string; content: string }>;
  assert.deepEqual(input.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(input[2].content, 'isi file');
});

test('streaming: event .done adalah fallback bila delta tidak pernah tiba', async () => {
  const provider = makeProvider();
  await withFetchStub(async () =>
    sseResponse([
      sseData({ type: 'response.reasoning_summary_text.done', item_id: 'rs_1', output_index: 0, text: 'Ringkasan saja.' }),
      sseData({ type: 'response.output_text.done', item_id: 'msg_1', output_index: 1, text: 'Jawaban penuh.' }),
      sseData({ type: 'response.completed', response: { status: 'completed' } }),
    ]), async () => {
    const thoughts: string[] = [];
    const tokens: string[] = [];
    const text = await provider.chat(
      [{ role: 'user', content: 'halo', timestamp: '' }],
      { onThought: (t) => thoughts.push(t), onToken: (t) => tokens.push(t) },
    );
    assert.equal(text, 'Jawaban penuh.');
    assert.deepEqual(thoughts, ['Ringkasan saja.']);
    assert.deepEqual(tokens, ['Jawaban penuh.']);
  });
});

test('streaming: .done setelah delta tidak merender teks 2x', async () => {
  const provider = makeProvider();
  await withFetchStub(async () =>
    sseResponse([
      sseData({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, delta: 'Ringkasan.' }),
      sseData({ type: 'response.reasoning_summary_text.done', item_id: 'rs_1', output_index: 0, text: 'Ringkasan.' }),
      sseData({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, delta: 'Teks.' }),
      sseData({ type: 'response.output_text.done', item_id: 'msg_1', output_index: 1, text: 'Teks.' }),
      sseData({ type: 'response.completed', response: { status: 'completed' } }),
    ]), async () => {
    const thoughts: string[] = [];
    const tokens: string[] = [];
    const text = await provider.chat(
      [{ role: 'user', content: 'halo', timestamp: '' }],
      { onThought: (t) => thoughts.push(t), onToken: (t) => tokens.push(t) },
    );
    assert.equal(text, 'Teks.');
    assert.deepEqual(thoughts, ['Ringkasan.']);
    assert.deepEqual(tokens, ['Teks.']);
  });
});

test('streaming: response.failed melempar', async () => {
  const provider = makeProvider();
  await withFetchStub(async () =>
    sseResponse([
      sseData({ type: 'response.failed', error: { message: 'model overloaded' } }),
    ]), async () => {
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'halo', timestamp: '' }]),
      /model overloaded/,
    );
  });
});

test('streaming: response.incomplete + max_output_tokens → length', async () => {
  const provider = makeProvider();
  await withFetchStub(async () =>
    sseResponse([
      sseData({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, delta: 'Terpotong' }),
      sseData({
        type: 'response.incomplete',
        response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      }),
    ]), async () => {
    const text = await provider.chat([{ role: 'user', content: 'halo', timestamp: '' }]);
    assert.equal(text, 'Terpotong');
    assert.equal(provider.lastFinishReason, 'length');
  });
});

test('non-streaming JSON: reasoning summary → onThought, message output_text → teks penuh', async () => {
  const provider = makeProvider();
  await withFetchStub(async () =>
    jsonResponse({
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ text: 'Saya akan menjawab singkat.' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'Jawaban JSON.' }] },
      ],
    }), async () => {
    const thoughts: string[] = [];
    const tokens: string[] = [];
    const text = await provider.chat(
      [{ role: 'user', content: 'halo', timestamp: '' }],
      { onThought: (t) => thoughts.push(t), onToken: (t) => tokens.push(t) },
    );
    assert.equal(text, 'Jawaban JSON.');
    assert.deepEqual(thoughts, ['Saya akan menjawab singkat.']);
    assert.deepEqual(tokens, ['Jawaban JSON.']);
    assert.equal(provider.lastFinishReason, 'stop');
  });
});

test('retry 400: reasoning ditolak → retry sekali tanpa reasoning', async () => {
  const provider = makeProvider();
  const bodies: string[] = [];
  let calls = 0;
  await withFetchStub(async (_input, init) => {
    calls += 1;
    bodies.push(String(init?.body ?? ''));
    if (calls === 1) return new Response('reasoning is not supported by this model', { status: 400 });
    return sseResponse([
      sseData({ type: 'response.output_text.delta', item_id: 'm', output_index: 0, delta: 'OK.' }),
      sseData({ type: 'response.completed', response: { status: 'completed' } }),
    ]);
  }, async () => {
    const text = await provider.chat(
      [{ role: 'user', content: 'halo', timestamp: '' }],
      { reasoning: 'high' },
    );
    assert.equal(text, 'OK.');
    assert.equal(calls, 2, 'harus retry tepat sekali');
    assert.ok(JSON.parse(bodies[0]).reasoning, 'request pertama membawa reasoning');
    assert.equal(JSON.parse(bodies[1]).reasoning, undefined, 'retry tanpa reasoning');
  });
});

test('retry 400: temperature ditolak → retry sekali tanpa temperature', async () => {
  const provider = makeProvider();
  const bodies: string[] = [];
  let calls = 0;
  await withFetchStub(async (_input, init) => {
    calls += 1;
    bodies.push(String(init?.body ?? ''));
    if (calls === 1) return new Response('temperature is not supported', { status: 400 });
    return sseResponse([
      sseData({ type: 'response.output_text.delta', item_id: 'm', output_index: 0, delta: 'OK.' }),
      sseData({ type: 'response.completed', response: { status: 'completed' } }),
    ]);
  }, async () => {
    const text = await provider.chat(
      [{ role: 'user', content: 'halo', timestamp: '' }],
      { temperature: 0.3 },
    );
    assert.equal(text, 'OK.');
    assert.equal(calls, 2);
    assert.equal(JSON.parse(bodies[0]).temperature, 0.3);
    assert.equal(JSON.parse(bodies[1]).temperature, undefined, 'retry tanpa temperature');
  });
});

test('testConnection POST minimal ke /responses dengan endpoint responses', async () => {
  const provider = makeProvider();
  const seen: Array<{ url: string; body: string }> = [];
  await withFetchStub(async (input, init) => {
    seen.push({ url: String(input), body: String(init?.body ?? '') });
    return jsonResponse({ status: 'completed', output: [] });
  }, async () => {
    const result = await provider.testConnection();
    assert.equal(result.ok, true);
    assert.equal(result.message, 'gpt-5-codex');
    assert.equal(result.endpoint, 'responses');
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://example.com/v1/responses');
  assert.equal(JSON.parse(seen[0].body).model, 'gpt-5-codex');
});

test('listModels mengembalikan [] bila backend tanpa /models', async () => {
  const provider = makeProvider();
  await withFetchStub(async () => new Response('not found', { status: 404 }), async () => {
    assert.deepEqual(await provider.listModels(), []);
  });
});

test('detectVisibleReasoning → true (reasoning summary native)', async () => {
  const provider = makeProvider();
  assert.equal(await provider.detectVisibleReasoning(), true);
});

test('routing: detectProviderKind dari URL/provider, bukan nama model', () => {
  assert.equal(detectProviderKind('https://chatgpt.com/v1', 'gpt-5'), 'responses');
  assert.equal(detectProviderKind('https://api.openai.com/v1/responses', 'gpt-5'), 'responses');
  assert.equal(detectProviderKind('https://api.openai.com/v1', 'gpt-5'), 'openai-compatible');
  assert.equal(detectProviderKind('https://api.openai.com/v1', 'gpt-5', 'codex'), 'responses');
  assert.equal(detectProviderKind('https://api.openai.com/v1', 'gpt-5', 'responses-codex'), 'responses');
  assert.equal(detectProviderKind('https://api.anthropic.com/v1', 'x', 'claude'), 'anthropic');
  assert.equal(detectProviderKind('https://generativelanguage.googleapis.com/v1beta', 'x', 'google'), 'gemini');
  assert.equal(detectProviderKind('https://api.anthropic.com/v1', 'claude-3-5-sonnet-20241022'), 'anthropic');
  assert.equal(detectProviderKind('https://generativelanguage.googleapis.com/v1beta', 'gemini-2.0-flash'), 'gemini');
  assert.equal(detectProviderKind('http://localhost:11434/v1', 'llama3:8b'), 'openai-compatible');
  // createProvider memakai routing yang sama.
  assert.equal(createProvider({ baseUrl: 'https://chatgpt.com/v1', model: 'gpt-5', apiKey: 'k' }).name, 'responses');
  assert.equal(createProvider({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', apiKey: 'k' }).name, 'openai-compatible');
});

test('integrasi agent: Responses provider → thought native + jawaban akhir', async () => {
  const provider = makeProvider();
  await withFetchStub(async () =>
    sseResponse([
      sseData({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, delta: 'AGENT-NATIVE reasoning summary text here.' }),
      sseData({ type: 'response.output_text.delta', item_id: 'm', output_index: 1, delta: 'Jawaban via Responses.' }),
      sseData({ type: 'response.completed', response: { status: 'completed' } }),
    ]), async () => {
    const config = { ...DEFAULT_CONFIG, maxToolIterations: 3 };
    const ctx = new Context(config);
    const agent = new Agent(ctx, provider, config);
    const result = await agent.handleInstruction('tanya via responses');
    assert.equal(result, 'Jawaban via Responses.');
    assert.equal(agent.sessionState.thoughtSource, 'native');
    const systemPrompt = (provider as unknown as { lastReasoning: string | null }).lastReasoning;
    assert.ok(systemPrompt?.includes('AGENT-NATIVE'), 'reasoning summary tersimpan di provider');
  });
});
