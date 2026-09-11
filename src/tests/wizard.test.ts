import assert from 'node:assert/strict';
import { test } from 'node:test';
import { needsSetup, promptSetup, setupBanner } from '../core/wizard.js';
import { stripAnsi } from '../core/ui.js';

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

const CRED_ENV = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AGENT_MODEL', 'OPENAI_MODEL'] as const;

function withCleanEnv<T>(fn: () => T): T {
  const saved: Partial<Record<(typeof CRED_ENV)[number], string | undefined>> = {};
  for (const k of CRED_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of CRED_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

test('needsSetup is true until key, base URL and model are all resolvable', () => {
  withCleanEnv(() => {
    assert.equal(needsSetup({}), true);
    assert.equal(needsSetup({ apiKey: 'sk', baseUrl: 'http://x/v1', model: 'm' }), false);
    assert.equal(needsSetup({ apiKey: '', baseUrl: 'http://x/v1', model: 'm' }), true);
    assert.equal(needsSetup({ apiKey: 'sk', baseUrl: '', model: 'm' }), true);
    assert.equal(needsSetup({ apiKey: 'sk', baseUrl: 'http://x/v1', model: '' }), true);
  });
});

test('needsSetup is satisfied by environment credentials too', () => {
  withCleanEnv(() => {
    process.env.OPENAI_API_KEY = 'env-key';
    process.env.OPENAI_BASE_URL = 'https://env.example/v1';
    process.env.AGENT_MODEL = 'env-model';
    assert.equal(needsSetup({}), false);
  });
});

test('setup banner carries the welcome text', () => {
  const banner = setupBanner();
  assert.ok(stripAnsi(banner).includes('Welcome to Ruko Agent Setup!'));
});

test('promptSetup keeps custom base url and model (no provider default)', async () => {
  const rl = fakeRl(['sk-1', 'http://localhost:11434/v1', 'llama3']);
  const result = await promptSetup(rl);
  assert.deepEqual(result, { apiKey: 'sk-1', baseUrl: 'http://localhost:11434/v1', model: 'llama3' });
  // Prompts must NOT advertise a provider-specific example/default.
  assert.equal(stripAnsi(rl.asked[1]).includes('api.b.ai'), false);
  assert.equal(stripAnsi(rl.asked[2]).includes('qwen'), false);
});

test('promptSetup aborts on empty API key', async () => {
  const rl = fakeRl(['']);
  assert.equal(await promptSetup(rl), null);
});

test('promptSetup aborts when base URL is blank', async () => {
  const rl = fakeRl(['sk-1', '']);
  assert.equal(await promptSetup(rl), null);
});

test('promptSetup aborts when model is blank', async () => {
  const rl = fakeRl(['sk-1', 'http://x/v1', '']);
  assert.equal(await promptSetup(rl), null);
});

test('promptSetup probes the connection and reports success (§2.8)', async () => {
  const rl = fakeRl(['sk-probe', 'http://x/v1', 'probe-model']);
  const probes: unknown[] = [];
  const result = await promptSetup(rl, {
    probe: async (r) => {
      probes.push(r);
      return { ok: true, message: r.model };
    },
  });
  assert.ok(result);
  assert.equal(probes.length, 1);
  assert.equal(result.model, 'probe-model');
});

test('promptSetup on failed probe: save-anyway keeps the result (§2.11 retry path)', async () => {
  const rl = fakeRl(['sk-bad', 'http://x/v1', 'm', '']); // 4th answer = "" → save anyway
  const result = await promptSetup(rl, {
    probe: async () => ({ ok: false, message: 'API key salah atau kedaluwarsa' }),
  });
  assert.ok(result, 'still returns the config so it can be saved');
  assert.equal(result.apiKey, 'sk-' + 'bad');
});

test('promptSetup probe cancel (b) aborts setup', async () => {
  const rl = fakeRl(['sk-bad', 'http://x/v1', 'm', 'b']);
  const result = await promptSetup(rl, {
    probe: async () => ({ ok: false, message: 'gagal' }),
  });
  assert.equal(result, null);
});
