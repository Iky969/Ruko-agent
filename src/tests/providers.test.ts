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
