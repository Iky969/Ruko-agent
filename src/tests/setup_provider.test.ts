import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { promptSetup, SetupResult } from '../core/wizard.js';

function fakeRl(answers: string[]): { question: (q: string) => Promise<string>; asked: string[] } {
  const asked: string[] = [];
  let i = 0;
  return {
    asked,
    async question(q: string) {
      asked.push(q);
      const a = answers[i++];
      if (a === undefined) throw new Error(`ran out of answers (asked: ${q})`);
      return a;
    },
  };
}

describe('Tugas 5: Setup Wizard Explicit Provider Selection', () => {
  it('explicitly prompts for provider and saves openai-compatible', async () => {
    // Answers: apiKey, baseUrl, model, provider
    const rl = fakeRl(['sk-test', 'https://api.openai.com/v1', 'gpt-4o', '1']);
    const result = await promptSetup(rl, { askProvider: true });
    assert.ok(result);
    assert.equal(result.provider, 'openai-compatible');
    assert.equal(result.apiKey, 'sk-test');
    assert.equal(result.baseUrl, 'https://api.openai.com/v1');
    assert.equal(result.model, 'gpt-4o');
    assert.ok(rl.asked.some((q) => q.includes('Provider')));
  });

  it('explicitly prompts for provider and saves anthropic by number (2)', async () => {
    const rl = fakeRl(['sk-ant-test', 'https://api.anthropic.com', 'claude-3-opus', '2']);
    const result = await promptSetup(rl, { askProvider: true });
    assert.ok(result);
    assert.equal(result.provider, 'anthropic');
  });

  it('explicitly prompts for provider and saves gemini by name', async () => {
    const rl = fakeRl(['gem-key', 'https://generativelanguage.googleapis.com', 'gemini-1.5-pro', 'gemini']);
    const result = await promptSetup(rl, { askProvider: true });
    assert.ok(result);
    assert.equal(result.provider, 'gemini');
  });

  it('passes explicit provider to probe function regardless of URL/model heuristics', async () => {
    // Reverse proxy scenario: URL is custom proxy, model has 'claude' in name, but user selects openai-compatible!
    let probeReceivedProvider: string | undefined;
    const probe = async (r: SetupResult) => {
      probeReceivedProvider = r.provider;
      return { ok: true, message: r.model };
    };

    const rl = fakeRl(['sk-custom', 'https://my-custom-proxy.internal/v1', 'claude-3-haiku-proxy', '1']);
    const result = await promptSetup(rl, { probe, askProvider: true });
    assert.ok(result);
    assert.equal(result.provider, 'openai-compatible');
    assert.equal(probeReceivedProvider, 'openai-compatible', 'Probe must receive explicit provider selection');
  });

  it('uses smart default when provider prompt is left blank (Enter)', async () => {
    // Model starts with claude- -> smart default is anthropic
    const rl = fakeRl(['sk-ant', 'https://api.anthropic.com', 'claude-3-sonnet', '']);
    const result = await promptSetup(rl, { askProvider: true });
    assert.ok(result);
    assert.equal(result.provider, 'anthropic');
  });

  it('allows changing provider during connection probe retry', async () => {
    let callCount = 0;
    const probe = async (r: SetupResult) => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, message: 'Provider mismatch error' };
      }
      return { ok: true, message: r.model };
    };

    // First attempt: selects 1 (openai-compatible)
    // Probe fails -> asks retry: 'c' (coba)
    // New key: 'sk-new'
    // New URL: 'https://api.anthropic.com'
    // New Model: 'claude-3-opus'
    // New Provider: '2' (anthropic)
    const rl = fakeRl([
      'sk-test', 'https://api.anthropic.com', 'claude-3-opus', '1',
      'c',
      'sk-new',
      'https://api.anthropic.com',
      'claude-3-opus',
      '2',
    ]);
    const result = await promptSetup(rl, { probe, askProvider: true });
    assert.ok(result);
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.apiKey, 'sk-new');
  });
});
