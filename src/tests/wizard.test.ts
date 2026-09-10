import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsSetup, promptSetup, setupBanner } from '../core/wizard.js';
import { stripAnsi } from '../core/ui.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../agent/llm.js';

function fakeRl(answers: string[]): { question: (q: string) => Promise<string>; asked: string[] } {
  const asked: string[] = [];
  let i = 0;
  return {
    asked,
    async question(q: string) {
      asked.push(q);
      const a = answers[i++];
      if (a === undefined) throw new Error('ran out of answers');
      return a;
    },
  };
}

test('needsSetup is false when a config key or env key exists', () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  assert.equal(needsSetup(undefined), true);
  assert.equal(needsSetup('sk-abc'), false);
  process.env.OPENAI_API_KEY = 'from-env';
  assert.equal(needsSetup(''), false);
  if (saved === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = saved;
});

test('setup banner carries the welcome text', () => {
  const banner = setupBanner();
  assert.ok(stripAnsi(banner).includes('Welcome to Ruko Agent Setup!'));
});

test('promptSetup applies defaults on empty answers', async () => {
  const rl = fakeRl(['sk-test-123', '', '']);
  const result = await promptSetup(rl);
  assert.deepEqual(result, { apiKey: 'sk-test-123', baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL });
  assert.equal(stripAnsi(rl.asked[1]).includes(DEFAULT_BASE_URL), true);
  assert.equal(stripAnsi(rl.asked[2]).includes(DEFAULT_MODEL), true);
});

test('promptSetup keeps custom base url and model', async () => {
  const rl = fakeRl(['sk-1', 'http://localhost:11434/v1', 'llama3']);
  const result = await promptSetup(rl);
  assert.deepEqual(result, { apiKey: 'sk-1', baseUrl: 'http://localhost:11434/v1', model: 'llama3' });
});

test('promptSetup aborts on empty API key', async () => {
  const rl = fakeRl(['']);
  assert.equal(await promptSetup(rl), null);
});

test('promptSetup probes the connection and reports success (§2.8)', async () => {
  const rl = fakeRl(['sk-probe', '', '']);
  const probes: unknown[] = [];
  const result = await promptSetup(rl, {
    probe: async (r) => {
      probes.push(r);
      return { ok: true, message: r.model };
    },
  });
  assert.ok(result);
  assert.equal(probes.length, 1);
  assert.equal(result.model, DEFAULT_MODEL);
});

test('promptSetup on failed probe: save-anyway keeps the result (§2.11 retry path)', async () => {
  const rl = fakeRl(['sk-bad', '', '', '']); // 4th answer = "" → save anyway
  const result = await promptSetup(rl, {
    probe: async () => ({ ok: false, message: 'API key salah atau kedaluwarsa' }),
  });
  assert.ok(result, 'still returns the config so it can be saved');
  assert.equal(result.apiKey, 'sk-' + 'bad');
});

test('promptSetup probe cancel (b) aborts setup', async () => {
  const rl = fakeRl(['sk-bad', '', '', 'b']);
  const result = await promptSetup(rl, {
    probe: async () => ({ ok: false, message: 'gagal' }),
  });
  assert.equal(result, null);
});
