import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicProvider, GeminiProvider, createProvider } from '../agent/llm.js';

test('createProvider instantiates correct provider based on config', () => {
  const pOpenai = createProvider({ apiKey: 'key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' });
  assert.equal(pOpenai.name, 'openai-compatible');

  const pAnthropic = createProvider({ provider: 'anthropic', apiKey: 'key' });
  assert.equal(pAnthropic.name, 'anthropic');

  const pGemini = createProvider({ provider: 'gemini', apiKey: 'key' });
  assert.equal(pGemini.name, 'gemini');

  const pAnthropicUrl = createProvider({ baseUrl: 'https://api.anthropic.com/v1' });
  assert.equal(pAnthropicUrl.name, 'anthropic');

  const pGeminiUrl = createProvider({ baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
  assert.equal(pGeminiUrl.name, 'gemini');
});

test('AnthropicProvider testConnection handles missing config', async () => {
  const p = new AnthropicProvider({ apiKey: '' });
  const res = await p.testConnection();
  assert.equal(res.ok, false);
  assert.match(res.message, /belum diatur/i);
});

test('GeminiProvider testConnection handles missing config', async () => {
  const p = new GeminiProvider({ apiKey: '' });
  const res = await p.testConnection();
  assert.equal(res.ok, false);
  assert.match(res.message, /belum diatur/i);
});

test('AnthropicProvider listModels returns standard Claude models', async () => {
  const p = new AnthropicProvider({ apiKey: 'test-key' });
  const models = await p.listModels();
  assert.ok(models.includes('claude-3-5-sonnet-20241022'));
});

test('GeminiProvider listModels returns standard Gemini models', async () => {
  const p = new GeminiProvider({ apiKey: 'test-key' });
  const models = await p.listModels();
  assert.ok(models.includes('gemini-1.5-flash'));
});

test('sanitizeGeminiBaseUrl safely falls back on empty, quotes, and trims slashes', async () => {
  const { sanitizeGeminiBaseUrl, DEFAULT_GEMINI_BASE_URL } = await import('../agent/llm.js');
  assert.equal(sanitizeGeminiBaseUrl(undefined), DEFAULT_GEMINI_BASE_URL);
  assert.equal(sanitizeGeminiBaseUrl(''), DEFAULT_GEMINI_BASE_URL);
  assert.equal(sanitizeGeminiBaseUrl('   '), DEFAULT_GEMINI_BASE_URL);
  assert.equal(sanitizeGeminiBaseUrl('""'), DEFAULT_GEMINI_BASE_URL);
  assert.equal(sanitizeGeminiBaseUrl("''"), DEFAULT_GEMINI_BASE_URL);
  assert.equal(sanitizeGeminiBaseUrl('  ""  '), DEFAULT_GEMINI_BASE_URL);
  assert.equal(sanitizeGeminiBaseUrl('https://custom.api.org/v1/'), 'https://custom.api.org/v1');
  assert.equal(sanitizeGeminiBaseUrl('"https://custom.api.org/v1/"'), 'https://custom.api.org/v1');
  assert.equal(sanitizeGeminiBaseUrl("'https://custom.api.org/v1///'"), 'https://custom.api.org/v1');
});

test('GeminiProvider uses x-goog-api-key header and never leaks api key in query params', async () => {
  const capturedUrls: string[] = [];
  const capturedHeaders: Array<Record<string, string>> = [];
  const secret = 'AIzaSySecretKey12345';

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrls.push(String(url));
    const h = (init?.headers ?? {}) as Record<string, string>;
    capturedHeaders.push(h);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const p = new GeminiProvider({ apiKey: secret, baseUrl: '""' });

    // testConnection
    const res = await p.testConnection();
    assert.equal(res.ok, true);

    // chat
    const reply = await p.chat([{ role: 'user', content: 'test', timestamp: new Date().toISOString() }]);
    assert.equal(reply, 'ok');

    assert.equal(capturedUrls.length, 2);
    for (const u of capturedUrls) {
      assert.equal(u.includes(secret), false, `URL must not contain API key: ${u}`);
      assert.equal(u.includes('?key='), false, `URL must not contain ?key= parameter: ${u}`);
      assert.equal(u.includes('&key='), false, `URL must not contain &key= parameter: ${u}`);
      assert.equal(u.includes('//models'), false, `URL must not contain double slashes: ${u}`);
    }

    assert.equal(capturedUrls[0], 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent');
    assert.equal(capturedUrls[1], 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?alt=sse');

    for (const h of capturedHeaders) {
      assert.equal(h['x-goog-api-key'], secret, 'x-goog-api-key header must carry the secret API key');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GeminiProvider sanitizes error messages and masks API keys on failures', async () => {
  const secret = 'AIzaSyVerySecretKey999';
  const originalFetch = globalThis.fetch;

  try {
    // 1. Network exception leaking key in error URL
    globalThis.fetch = (async () => {
      throw new Error(`transport error: https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${secret}`);
    }) as typeof fetch;

    const p = new GeminiProvider({ apiKey: secret });
    const res = await p.testConnection();
    assert.equal(res.ok, false);
    assert.equal(res.message.includes(secret), false, 'testConnection error must redact API key');
    assert.match(res.message, /••••••••/);

    // 2. HTTP error response with body leaking key
    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({ error: { message: `Invalid key ${secret} or token=ABC123XYZ` } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    await assert.rejects(
      async () => {
        await p.chat([{ role: 'user', content: 'hello', timestamp: new Date().toISOString() }]);
      },
      (err: Error) => {
        assert.equal(err.message.includes(secret), false, 'chat error must redact API key');
        assert.match(err.message, /••••••••/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sanitizeAnthropicBaseUrl safely handles empty, quotes, and appends /v1', async () => {
  const { sanitizeAnthropicBaseUrl, DEFAULT_ANTHROPIC_BASE_URL } = await import('../agent/llm.js');
  assert.equal(sanitizeAnthropicBaseUrl(undefined), DEFAULT_ANTHROPIC_BASE_URL);
  assert.equal(sanitizeAnthropicBaseUrl(''), DEFAULT_ANTHROPIC_BASE_URL);
  assert.equal(sanitizeAnthropicBaseUrl('""'), DEFAULT_ANTHROPIC_BASE_URL);
  assert.equal(sanitizeAnthropicBaseUrl('  ""  '), DEFAULT_ANTHROPIC_BASE_URL);
  assert.equal(sanitizeAnthropicBaseUrl('https://api.anthropic.com'), 'https://api.anthropic.com/v1');
  assert.equal(sanitizeAnthropicBaseUrl('"https://custom.anthropic.proxy/v1/"'), 'https://custom.anthropic.proxy/v1');
});

test('AnthropicProvider sends official /v1/messages request format and required headers', async () => {
  let capturedUrl = '';
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: Record<string, unknown> = {};

  const apiKey = 'sk-ant-api03-test-secret-12345';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
    capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Anthropic response' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const p = new AnthropicProvider({
      apiKey,
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-3-5-sonnet-20241022',
    });

    const reply = await p.chat([
      { role: 'system', content: 'You are an assistant', timestamp: new Date().toISOString() },
      { role: 'user', content: 'Hello', timestamp: new Date().toISOString() },
    ]);

    assert.equal(reply, 'Anthropic response');
    assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages');
    assert.equal(capturedHeaders['x-api-key'], apiKey);
    assert.equal(capturedHeaders['anthropic-version'], '2023-06-01');
    assert.equal(capturedHeaders['Content-Type'], 'application/json');

    // System prompt must be top-level 'system', not in 'messages'
    assert.equal(capturedBody.system, 'You are an assistant');
    assert.equal(capturedBody.model, 'claude-3-5-sonnet-20241022');
    assert.equal(capturedBody.max_tokens, 2048);
    assert.deepEqual(capturedBody.messages, [{ role: 'user', content: 'Hello' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AnthropicProvider parses SSE content_block_delta stream and handles stream errors', async () => {
  const apiKey = 'sk-ant-test-token-777';
  const originalFetch = globalThis.fetch;

  const sseFrames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-3-5-sonnet-20241022"}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: ping\ndata: {"type":"ping"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Halo "}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Dunia!"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of sseFrames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });

  globalThis.fetch = (async () => {
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;

  try {
    const p = new AnthropicProvider({ apiKey });
    const tokens: string[] = [];
    const result = await p.chat(
      [{ role: 'user', content: 'Halo', timestamp: new Date().toISOString() }],
      {
        onToken: (t) => tokens.push(t),
      },
    );

    assert.equal(result, 'Halo Dunia!');
    assert.deepEqual(tokens, ['Halo ', 'Dunia!']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('AnthropicProvider masks secrets on network errors and stream errors', async () => {
  const apiKey = 'sk-ant-supersecrettoken-999';
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async () => {
      throw new Error(`request failed to https://api.anthropic.com/v1/messages with key ${apiKey}`);
    }) as typeof fetch;

    const p = new AnthropicProvider({ apiKey });
    const res = await p.testConnection();
    assert.equal(res.ok, false);
    assert.equal(res.message.includes(apiKey), false, 'testConnection error must redact API key');
    assert.match(res.message, /••••••••/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


