import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainProviderError } from '../agent/llm.js';
import { DEFAULT_CONFIG, ProviderProfile, resolveProfileCredentials } from '../types.js';

test('error translator: 401/404/ECONNREFUSED become actionable Indonesian text (§2.11)', () => {
  assert.match(explainProviderError(new Error('LLM API error 401: unauthorized')), /API key salah|kedaluwarsa/);
  assert.match(explainProviderError(new Error('LLM API error 404: not found')), /Model tidak ditemukan/);
  assert.match(
    explainProviderError(new Error('fetch failed connect ECONNREFUSED 127.0.0.1:11434')),
    /ollama serve/,
  );
  assert.match(explainProviderError(new Error('connect ECONNREFUSED api.example.com')), /baseUrl/);
  assert.match(explainProviderError(new Error('semua baik')), /Koneksi gagal: semua baik/);
});

test('error translator distinguishes 400 / 403 / 429 / 5xx (§6)', () => {
  assert.match(explainProviderError(new Error('LLM API error 400: bad request')), /400|parameter internal/);
  assert.match(explainProviderError(new Error('LLM API error 403: forbidden')), /403|izin/);
  assert.match(
    explainProviderError(new Error('LLM API error 429: Concurrency limit exceeded')),
    /429|Rate limit/,
  );
  assert.match(explainProviderError(new Error('LLM API error 503: unavailable')), /503|bermasalah/);
  assert.doesNotMatch(
    explainProviderError(new Error('LLM API error 400: bad request')),
    /Koneksi gagal/,
    '400 must not be generalized as a connect failure',
  );
});

function withProfile(p: Record<string, ProviderProfile>, extra: object = {}) {
  return { ...DEFAULT_CONFIG, profiles: p, ...extra } as typeof DEFAULT_CONFIG & Record<string, unknown>;
}

test('resolveProfileCredentials: defaultProfile fills baseUrl/model, apiKeyEnv wins (§2.12)', () => {
  const cfg = withProfile(
    {
      hemat: { baseUrl: 'https://x/v1', model: 'qwen3-flash', apiKeyEnv: 'QWEN_API_KEY' },
      kuat: { baseUrl: 'https://y/v1', model: 'big' },
    },
    { defaultProfile: 'hemat' },
  );
  const resolved = resolveProfileCredentials(cfg, { QWEN_API_KEY: 'sk' + '-env' });
  assert.equal(resolved.baseUrl, 'https://x/v1');
  assert.equal(resolved.model, 'qwen3-flash');
  assert.equal(resolved.apiKey, 'sk' + '-env');
  assert.equal(resolved.activeProfile, 'hemat');
});

test('activeProfile overrides defaultProfile; literal apiKey used when env missing', () => {
  const cfg = withProfile(
    {
      a: { model: 'model-a', apiKey: 'literal-a' },
      b: { model: 'model-b', apiKeyEnv: 'NOT_SET' },
    },
    { defaultProfile: 'a', activeProfile: 'b' },
  );
  const resolved = resolveProfileCredentials(cfg, {});
  assert.equal(resolved.model, 'model-b');
  assert.equal(resolved.apiKey, undefined, 'no key from unset env or missing literal');
});

test('no profile / unknown alias leaves the config untouched', () => {
  assert.equal(resolveProfileCredentials(DEFAULT_CONFIG, {}), DEFAULT_CONFIG);
  const ghost = withProfile({ real: {} }, { activeProfile: 'ghost' });
  const resolved = resolveProfileCredentials(ghost, {});
  assert.equal(resolved.model, DEFAULT_CONFIG.model);
  assert.equal(resolved.baseUrl, DEFAULT_CONFIG.baseUrl);
  assert.equal(resolved.apiKey, undefined, 'ghost profile must not inject credentials');
});
