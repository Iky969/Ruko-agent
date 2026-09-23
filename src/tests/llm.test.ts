import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  backoffDelay,
  createProvider,
  missingConfigFields,
  OpenAiCompatibleProvider,
  parseRetryAfterMs,
  sanitizeToolMessageContent,
  validateOpenAiMessages,
} from '../agent/llm.js';

const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AGENT_MODEL', 'OPENAI_MODEL'] as const;

function withCleanEnv<T>(fn: () => T | Promise<T>): Promise<T> | T {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

async function withFetchStub<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

test('provider prefers config-file credentials over env vars', async () => {
  await withCleanEnv(() => {
    process.env.OPENAI_API_KEY = 'env-key';
    process.env.OPENAI_BASE_URL = 'https://env.example/v1';
    const p = createProvider({ apiKey: 'file-key', baseUrl: 'https://file.example/v1', model: 'file-model' });
    assert.equal(p.isConfigured, true);
    assert.equal(p.model, 'file-model');
    const raw = p as OpenAiCompatibleProvider;
    assert.equal((raw as unknown as { apiKey: string }).apiKey, 'file-key');
    assert.equal((raw as unknown as { baseUrl: string }).baseUrl, 'https://file.example/v1');
  });
});

test('provider falls back to env vars — there is no built-in provider default (§1)', async () => {
  await withCleanEnv(() => {
    process.env.OPENAI_API_KEY = 'env-key';
    process.env.OPENAI_BASE_URL = 'https://env.example/v1/';
    process.env.AGENT_MODEL = 'env-model';
    const p = createProvider({});
    assert.equal(p.isConfigured, true);
    assert.equal(p.model, 'env-model');
    const raw = p as unknown as { baseUrl: string };
    assert.equal(raw.baseUrl, 'https://env.example/v1', 'trailing slash trimmed');
  });
});

test('provider without base URL or model is not configured', async () => {
  await withCleanEnv(() => {
    process.env.OPENAI_API_KEY = 'env-key';
    const p = createProvider({});
    assert.equal(p.isConfigured, false, 'key alone must not enable LLM mode');
    const missing = missingConfigFields({ apiKey: 'env-key' });
    assert.deepEqual(missing, ['baseUrl', 'model']);
  });
});

test('unconfigured provider reports not configured and chat rejects', async () => {
  await withCleanEnv(async () => {
    const p = createProvider({});
    assert.equal(p.isConfigured, false);
    await assert.rejects(p.chat([]), /Konfigurasi belum lengkap/);
  });
});

test('setCredentials and setModel update the provider at runtime', async () => {
  await withCleanEnv(() => {
    const p = createProvider({});
    assert.equal(p.isConfigured, false);
    p.setCredentials?.('sk-live', 'https://x.test/v1/');
    p.setModel('my-model');
    assert.equal(p.isConfigured, true);
    assert.equal(p.model, 'my-model');
    const raw = p as unknown as { baseUrl: string };
    assert.equal(raw.baseUrl, 'https://x.test/v1', 'trailing slash trimmed');
  });
});

test('testConnection sends a portable max_tokens above provider minimums (§1)', async () => {
  await withCleanEnv(async () => {
    let sent: Record<string, unknown> | null = null;
    await withFetchStub(
      async (_url, init) => {
        sent = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        return jsonResponse({ choices: [{ message: { content: 'pong' } }] });
      },
      async () => {
        const p = createProvider({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' });
        const res = await p.testConnection?.();
        assert.equal(res?.ok, true);
      },
    );
    assert.ok(sent, 'fetch should have been called');
    const maxTokens = (sent as Record<string, unknown>).max_tokens;
    assert.equal(typeof maxTokens, 'number');
    assert.ok((maxTokens as number) > 2, `max_tokens must exceed the strict provider minimum, got ${maxTokens}`);
  });
});

test('chat flushes a final SSE frame without a trailing blank line (§2 truncation fix)', async () => {
  await withCleanEnv(async () => {
    const p = createProvider({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' });
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}', // no trailing blank line
    ];
    let streamed = '';
    await withFetchStub(
      async () => sseResponse(frames),
      async () => {
        const text = await p.chat([{ role: 'user', content: 'hi', timestamp: '' }], {
          onToken: (t) => {
            streamed += t;
          },
        });
        assert.equal(text, 'Hello', 'last token must not be dropped');
        assert.equal(streamed, 'Hello');
      },
    );
  });
});

test('backoffDelay grows exponentially and is capped (§7)', () => {
  assert.equal(backoffDelay(1, 100), 100);
  assert.equal(backoffDelay(2, 100), 200);
  assert.equal(backoffDelay(3, 100), 400);
  assert.equal(backoffDelay(10, 100, 500), 500);
});

test('parseRetryAfterMs reads delta-seconds and rejects junk', () => {
  assert.equal(parseRetryAfterMs('2'), 2000);
  assert.equal(parseRetryAfterMs('0'), 0);
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs('not-a-date'), null);
});

test('chat retries a 429 with backoff and then succeeds (§7)', async () => {
  await withCleanEnv(async () => {
    let calls = 0;
    const delays: number[] = [];
    const p = createProvider(
      { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' },
      { retries: 2, baseDelayMs: 10, sleep: async (ms) => void delays.push(ms) },
    );
    await withFetchStub(
      async () => {
        calls += 1;
        if (calls < 3) return new Response('Concurrency limit exceeded', { status: 429 });
        return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      },
      async () => {
        const text = await p.chat([{ role: 'user', content: 'hi', timestamp: '' }]);
        assert.equal(text, 'ok', 'third attempt succeeds after two retries');
      },
    );
    assert.equal(calls, 3);
    assert.deepEqual(delays, [10, 20], 'exponential backoff between attempts');
  });
});

test('chat honours Retry-After when the provider sends it (§7)', async () => {
  await withCleanEnv(async () => {
    let calls = 0;
    const delays: number[] = [];
    const p = createProvider(
      { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' },
      { retries: 1, baseDelayMs: 9999, sleep: async (ms) => void delays.push(ms) },
    );
    await withFetchStub(
      async () => {
        calls += 1;
        if (calls === 1) {
          return new Response('slow down', { status: 429, headers: { 'retry-after': '3' } });
        }
        return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
      },
      async () => {
        await p.chat([{ role: 'user', content: 'hi', timestamp: '' }]);
      },
    );
    assert.deepEqual(delays, [3000], 'Retry-After wins over the computed backoff');
  });
});

test('chat surfaces the rate-limit error once retries are exhausted (§7)', async () => {
  await withCleanEnv(async () => {
    let calls = 0;
    const p = createProvider(
      { apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' },
      { retries: 2, baseDelayMs: 0, sleep: async () => {} },
    );
    await withFetchStub(
      async () => {
        calls += 1;
        return new Response('Concurrency limit exceeded', { status: 429 });
      },
      async () => {
        await assert.rejects(p.chat([{ role: 'user', content: 'hi', timestamp: '' }]), /429/);
      },
    );
    assert.equal(calls, 3, 'one initial attempt plus two retries');
  });
});

test('testConnection reports incomplete config without calling the endpoint', async () => {
  await withCleanEnv(async () => {
    let calls = 0;
    await withFetchStub(
      async () => {
        calls += 1;
        return jsonResponse({});
      },
      async () => {
        const p = createProvider({ apiKey: 'k' });
        const res = await p.testConnection?.();
        assert.equal(res?.ok, false);
        assert.match(res?.message ?? '', /Belum lengkap: baseUrl, model/);
      },
    );
    assert.equal(calls, 0);
  });
});

test('chat handles partial SSE chunks split across packets without cutting off text', async () => {
  await withCleanEnv(async () => {
    const p = createProvider({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' });
    // Chunk 1 is incomplete JSON cut in the middle of payload; Chunk 2 completes the line
    const frames = [
      'data: {"choices":[{"delta":{"content":"con',
      'nected"}}]}\n',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n',
    ];
    let streamed = '';
    await withFetchStub(
      async () => sseResponse(frames),
      async () => {
        const text = await p.chat([{ role: 'user', content: 'test', timestamp: '' }], {
          onToken: (t) => {
            streamed += t;
          },
        });
        assert.equal(text, 'connected world', 'reconstructed partial chunk smoothly');
        assert.equal(streamed, 'connected world');
        assert.equal(p.lastFinishReason, 'stop', 'captured finish_reason stop from SSE');
      },
    );
  });
});

test('chat normalizes role tool messages with valid tool_call_id and includes tool_calls on assistant message', async () => {
  await withCleanEnv(async () => {
    const p = createProvider({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' });
    let capturedBody: any = null;

    await withFetchStub(
      async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse({
          choices: [{ message: { content: 'Selesai.' }, finish_reason: 'stop' }],
        });
      },
      async () => {
        await p.chat([
          { role: 'user', content: 'baca file', timestamp: '' },
          {
            role: 'assistant',
            content: 'membaca...',
            timestamp: '',
            tool_calls: [
              {
                id: 'call_read_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
              },
            ],
          },
          {
            role: 'tool',
            content: 'isi file a',
            timestamp: '',
            tool_call_id: 'call_read_1',
            name: 'read_file',
          },
        ]);
      },
    );

    assert.ok(capturedBody, 'request body must be captured');
    const msgs = capturedBody.messages;
    assert.equal(msgs.length, 3);

    // Assistant message keeps tool_calls
    assert.equal(msgs[1].role, 'assistant');
    assert.equal(msgs[1].content, 'membaca...');
    assert.deepEqual(msgs[1].tool_calls, [
      {
        id: 'call_read_1',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
      },
    ]);

    // Tool message has role 'tool' with tool_call_id and name
    assert.equal(msgs[2].role, 'tool');
    assert.equal(msgs[2].tool_call_id, 'call_read_1');
    assert.equal(msgs[2].name, 'read_file');
    assert.equal(msgs[2].content, 'isi file a');
  });
});

test('OpenAiCompatibleProvider buffers reasoning_content without logging and invokes onThought', async () => {
  await withCleanEnv(async () => {
    const p = createProvider({ apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' });
    const frames = [
      'data: {"choices":[{"delta":{"reasoning_content":"Menganalisis "}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"masalah..."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hasil akhir."},"finish_reason":"stop"}]}\n\n',
    ];
    const thoughts: string[] = [];
    let content = '';

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => logs.push(args.join(' '));

    try {
      await withFetchStub(
        async () => sseResponse(frames),
        async () => {
          const text = await p.chat([{ role: 'user', content: 'test', timestamp: '' }], {
            onThought: (th) => thoughts.push(th),
            onToken: (t) => {
              content += t;
            },
          });
          assert.equal(text, 'Hasil akhir.');
          assert.equal(content, 'Hasil akhir.');
          assert.deepEqual(thoughts, ['Menganalisis ', 'masalah...']);
          assert.equal(p.lastReasoning, 'Menganalisis masalah...');
          assert.equal(logs.length, 0, 'No console.log should be invoked on reasoning_content');
        },
      );
    } finally {
      console.log = origLog;
    }
  });
});

test('Tugas 7: sanitizeToolMessageContent sanitizes empty, null, or whitespace tool payload', () => {
  const emptyRes = sanitizeToolMessageContent('', 'read_file');
  assert.ok(emptyRes.includes('kosong'));
  assert.ok(emptyRes.includes('read_file'));

  const nullRes = sanitizeToolMessageContent(null, 'exec');
  assert.ok(nullRes.includes('kosong'));
  assert.ok(nullRes.includes('exec'));

  const wsRes = sanitizeToolMessageContent('   \n  ', 'glob');
  assert.ok(wsRes.includes('kosong'));
});

test('Tugas 7: sanitizeToolMessageContent closes unclosed markdown codeblock in truncated payload', () => {
  const truncatedCode = '```typescript\nconst a = 123;\nfunction test() {';
  const sanitized = sanitizeToolMessageContent(truncatedCode, 'read_file');
  assert.ok(sanitized.includes('```\n[Catatan: Output blok kode terpotong / truncated code block]'));
  // Ensure the total count of ``` is now even (valid markdown)
  const matches = sanitized.match(/```/g);
  assert.equal(matches!.length % 2, 0);
});

test('Tugas 7: sanitizeToolMessageContent appends warning on truncated JSON payload', () => {
  const truncatedJson = '{"status": "running", "items": [{"id": 1, "name": "item';
  const sanitized = sanitizeToolMessageContent(truncatedJson, 'custom_tool');
  assert.ok(sanitized.includes('[Peringatan: Payload JSON tool terpotong / truncated JSON payload]'));
});

test('Tugas 7: validateOpenAiMessages applies payload sanitization to all tool messages in conversation', () => {
  const input = [
    { role: 'user', content: 'run tool' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file' } },
        { id: 'call_2', type: 'function', function: { name: 'exec' } },
        { id: 'call_3', type: 'function', function: { name: 'fetch' } },
      ],
    },
    // call_1 returned empty string
    { role: 'tool', tool_call_id: 'call_1', content: '', name: 'read_file' },
    // call_2 returned truncated codeblock
    { role: 'tool', tool_call_id: 'call_2', content: '```bash\nnpm install', name: 'exec' },
    // call_3 returned valid result
    { role: 'tool', tool_call_id: 'call_3', content: '{"status": "ok"}', name: 'fetch' },
  ];

  const validated = validateOpenAiMessages(input);
  assert.equal(validated.length, 5);

  // call_1 sanitized from empty to descriptive fallback
  assert.ok(validated[2].content?.includes('kosong'));

  // call_2 sanitized with closing codeblock
  assert.ok(validated[3].content?.includes('```\n[Catatan: Output blok kode terpotong'));

  // call_3 valid result preserved intact
  assert.equal(validated[4].content, '{"status": "ok"}');
});

