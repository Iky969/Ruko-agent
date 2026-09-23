import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../agent/agent.js';
import { handleCommand } from '../agent/commands.js';
import { Context } from '../core/context.js';
import { createProvider } from '../agent/llm.js';
import { DEFAULT_CONFIG } from '../types.js';

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const origWrite = process.stdout.write.bind(process.stdout);
  const origLog = console.log;
  const origError = console.error;
  (process.stdout as unknown as { write: (s: any, ...args: any[]) => boolean }).write = () => true;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
    console.log = origLog;
    console.error = origError;
  }
}

test('Item 1: /login command refreshes provider instance in active session without process restart', async () => {
  const config = {
    ...DEFAULT_CONFIG,
    provider: 'gemini',
    apiKey: 'old-gemini-key',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-1.5-flash',
  };

  const providerA = createProvider(config);
  assert.equal(providerA.name, 'gemini', 'Initial provider should be gemini');

  const ctx = new Context(config);
  const agent = new Agent(ctx, providerA, config);

  assert.equal(agent.llm.name, 'gemini', 'Agent holds provider A (gemini)');

  // Simulate user running /login with an OpenAI-compatible endpoint
  // prompt inputs: apiKey, baseUrl, trust HTTP, model, save anyway on probe failure
  const answers = ['new-sk-test-12345', 'http://localhost:11434/v1', 'y', 'llama3', 's'];
  let askIndex = 0;
  const ask = async (_q: string) => {
    return answers[askIndex++] ?? '';
  };

  const commandEnv = {
    ctx,
    config,
    llm: agent.llm,
    agent,
    confirm: async () => true,
    ask,
    askSecret: ask,
    updateConfig: (patch: Partial<typeof config>) => {
      Object.assign(config, patch);
    },
    handle: {
      stop: () => {},
      getSessionId: () => null,
      setSessionId: () => {},
    },
  };

  await quiet(async () => {
    await handleCommand('/login', commandEnv);
  });

  // Invariant check: agent.llm must now be the new provider, NOT providerA
  assert.notEqual(agent.llm, providerA, 'Agent provider must not be the old instance');
  assert.equal(agent.llm.name, 'openai-compatible', 'Agent should now hold openai-compatible provider');
  assert.equal(agent.llm.model, 'llama3', 'Agent provider model should be updated');
  assert.equal(config.provider, 'openai-compatible', 'Config provider should be updated');
  assert.equal(config.model, 'llama3', 'Config model should be updated');

  // Verify next request uses the new provider instance
  let chatCalledOnNewProvider = false;
  (agent.llm as any).chat = async () => {
    chatCalledOnNewProvider = true;
    return 'Halo dari llama3';
  };

  const response = await quiet(async () => agent.handleInstruction('halo'));
  assert.equal(chatCalledOnNewProvider, true, 'Next request must immediately route to provider B');
  assert.equal(response, 'Halo dari llama3');
});

