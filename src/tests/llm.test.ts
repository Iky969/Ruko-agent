import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createProvider,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  OpenAiCompatibleProvider,
} from '../agent/llm.js';

function withCleanEnv<T>(fn: () => T): T {
  const keys = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AGENT_MODEL', 'OPENAI_MODEL'] as const;
  const saved: Partial<Record<(typeof keys)[number], string | undefined>> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

test('provider prefers config-file credentials over env vars', () => {
  withCleanEnv(() => {
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

test('provider falls back to env vars and defaults', () => {
  withCleanEnv(() => {
    process.env.OPENAI_API_KEY = 'env-key';
    const p = createProvider({});
    assert.equal(p.isConfigured, true);
    assert.equal(p.model, DEFAULT_MODEL);
    const raw = p as unknown as { baseUrl: string };
    assert.equal(raw.baseUrl, DEFAULT_BASE_URL);
  });
});

test('unconfigured provider reports not configured and chat rejects', async () => {
  await withCleanEnv(async () => {
    const p = createProvider({});
    assert.equal(p.isConfigured, false);
    await assert.rejects(p.chat([]), /API key belum dikonfigurasi/);
  });
});

test('setCredentials and setModel update the provider at runtime', () => {
  withCleanEnv(() => {
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
