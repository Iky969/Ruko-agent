import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  backoffDelay,
  createProvider,
  missingConfigFields,
  OpenAiCompatibleProvider,
  parseRetryAfterMs,
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
