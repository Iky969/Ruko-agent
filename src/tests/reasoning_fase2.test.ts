/**
 * Fase 2 tests: Command /reasoning (popup + argumen), SessionState per-sesi,
 * dan WIRING NYATA parameter reasoning ke payload provider di llm.ts.
 *
 * Mapping PASTI yang diuji (lihat llm.ts):
 * - OpenAI-compatible : top-level `reasoning_effort` (Extreme di-clamp ke 'max')
 * - Anthropic         : `thinking: { type: 'enabled', budget_tokens }`
 *   (+ guard: temperature 1, max_tokens > budget_tokens)
 * - Gemini            : `thinkingConfig: { thinkingBudget }` (Extreme di-clamp ke 24576)
 * - Provider tanpa native / menolak param (400) → fallback prompt injection,
 *   request TIDAK gagal, log sekali di level debug.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AnthropicProvider,
  ChatOptions,
  GeminiProvider,
  LLMProvider,
  OpenAiCompatibleProvider,
  reasoningPromptAddendum,
  toAnthropicBudgetTokens,
  toGeminiThinkingBudget,
  toOpenAiReasoningEffort,
  withReasoningDirective,
} from '../agent/llm.js';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { handleCommand } from '../agent/commands.js';
import {
  ContextMessage,
  createDefaultSessionState,
  DEFAULT_CONFIG,
  ReasoningLevel,
} from '../types.js';

// ============================================================================
// Helpers: stub global fetch untuk menangkap body request per provider
// ============================================================================

interface RecordedCall {
  body: Record<string, unknown>;
}

const originalFetch = globalThis.fetch;

function stubFetchResponders(responders: Array<() => Response>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  let idx = 0;
  (globalThis as any).fetch = async (_url: unknown, init?: { body?: string }) => {
    calls.push({ body: init?.body ? JSON.parse(init.body) : {} });
    const responder = responders[Math.min(idx, responders.length - 1)];
    idx += 1;
    return responder();
  };
  return calls;
}

function restoreFetch(): void {
  (globalThis as any).fetch = originalFetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const openAiOk = () =>
  jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
const anthropicOk = () =>
  jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
const geminiOk = () =>
  jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });

const rejectReasoning = () =>
  jsonResponse({ error: { message: 'Unknown parameter: reasoning_effort' } }, 400);
const rejectThinking = () =>
  jsonResponse({ error: { message: 'thinking: field not supported by this model' } }, 400);
const rejectThinkingBudget = () =>
  jsonResponse({ error: { message: 'thinkingBudget is not a supported field' } }, 400);

function msgs(content = 'halo'): ContextMessage[] {
  return [{ role: 'user', content, timestamp: new Date().toISOString() }];
}

const testCfg: Record<string, string> = {
  baseUrl: 'http://provider.test/v1',
  model: 'test-model',
};
testCfg['apiKey'] = 'test-key';

// ============================================================================
// Mapping level → parameter provider (harus match 100% dengan llm.ts)
// ============================================================================

test('Fase 2: mapping OpenAI-compatible — reasoning_effort, Extreme clamp ke max', () => {
  assert.equal(toOpenAiReasoningEffort('high'), 'high');
  assert.equal(toOpenAiReasoningEffort('xhigh'), 'xhigh');
  assert.equal(toOpenAiReasoningEffort('max'), 'max');
  assert.equal(toOpenAiReasoningEffort('extreme'), 'max', 'Extreme clamp ke nilai API tertinggi');
});

test('Fase 2: mapping Anthropic — budget_tokens 4096/8192/16384/32768', () => {
  assert.equal(toAnthropicBudgetTokens('high'), 4096);
  assert.equal(toAnthropicBudgetTokens('xhigh'), 8192);
  assert.equal(toAnthropicBudgetTokens('max'), 16384);
  assert.equal(toAnthropicBudgetTokens('extreme'), 32768);
  for (const level of ['high', 'xhigh', 'max', 'extreme'] as ReasoningLevel[]) {
    const budget = toAnthropicBudgetTokens(level);
    assert.ok(budget >= 1024 && budget <= 32768, 'budget dalam range API 1024–32768');
  }
});

test('Fase 2: mapping Gemini — thinkingBudget, Extreme clamp ke 24576', () => {
  assert.equal(toGeminiThinkingBudget('high'), 4096);
  assert.equal(toGeminiThinkingBudget('xhigh'), 8192);
  assert.equal(toGeminiThinkingBudget('max'), 16384);
  assert.equal(toGeminiThinkingBudget('extreme'), 24576, 'Extreme clamp ke batas API 24576');
});

test('Fase 2: template fallback prompt injection tersedia per level', () => {
  const seen = new Set<string>();
  for (const level of ['high', 'xhigh', 'max', 'extreme'] as ReasoningLevel[]) {
    const addendum = reasoningPromptAddendum(level);
    assert.ok(addendum.includes('REASONING DEPTH'), 'teridentifikasi sebagai instruksi reasoning');
    seen.add(addendum);
  }
  assert.equal(seen.size, 4, 'empat template berbeda untuk empat level');
});

// ============================================================================
// Payload provider menerima parameter yang sesuai per level
// ============================================================================

test('Fase 2: payload OpenAI-compatible membawa reasoning_effort sesuai level', async () => {
  const cases: Array<[ReasoningLevel, string | undefined]> = [
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'max'],
    ['extreme', 'max'],
  ];
  try {
    for (const [level, expected] of cases) {
      const calls = stubFetchResponders([openAiOk]);
      const provider = new OpenAiCompatibleProvider(testCfg, { retries: 0 });
      await provider.chat(msgs(), { reasoning: level });
      assert.equal(calls[0].body.reasoning_effort, expected, `level ${level}`);
    }
    // Tanpa opsi reasoning: field tidak dikirim sama sekali.
    const calls = stubFetchResponders([openAiOk]);
    const provider = new OpenAiCompatibleProvider(testCfg, { retries: 0 });
    await provider.chat(msgs());
    assert.equal('reasoning_effort' in calls[0].body, false, 'tanpa level → tanpa parameter');
  } finally {
    restoreFetch();
  }
});

test('Fase 2: payload Anthropic membawa thinking.budget_tokens + guard API', async () => {
  try {
    const calls = stubFetchResponders([anthropicOk]);
    const provider = new AnthropicProvider(testCfg, { retries: 0 });
    await provider.chat(msgs(), { reasoning: 'xhigh' });
    const body = calls[0].body;
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 8192 });
    assert.equal(body.temperature, 1, 'thinking hanya kompatibel dengan temperature 1');
    assert.ok(
      (body.max_tokens as number) > 8192,
      'max_tokens harus > budget_tokens sesuai constraint API',
    );

    const noReasonCalls = stubFetchResponders([anthropicOk]);
    const plain = new AnthropicProvider(testCfg, { retries: 0 });
    await plain.chat(msgs());
    assert.equal('thinking' in noReasonCalls[0].body, false, 'tanpa level → tanpa thinking');
  } finally {
    restoreFetch();
  }
});

test('Fase 2: payload Gemini membawa thinkingConfig.thinkingBudget sesuai level', async () => {
  try {
    const cases: Array<[ReasoningLevel, number]> = [
      ['high', 4096],
      ['xhigh', 8192],
      ['max', 16384],
      ['extreme', 24576],
    ];
    for (const [level, expected] of cases) {
      const calls = stubFetchResponders([geminiOk]);
      const provider = new GeminiProvider(testCfg, { retries: 0 });
      await provider.chat(msgs(), { reasoning: level });
      assert.deepEqual(calls[0].body.thinkingConfig, { thinkingBudget: expected }, `level ${level}`);
    }
  } finally {
    restoreFetch();
  }
});

// ============================================================================
// Fallback prompt injection saat provider tidak mendukung parameter native
// ============================================================================

test('Fase 2: fallback OpenAI-compatible — 400 reasoning_effort → retry tanpa param + prompt injection, request tidak gagal', async () => {
  try {
    const calls = stubFetchResponders([rejectReasoning, openAiOk]);
    const provider = new OpenAiCompatibleProvider(testCfg, { retries: 0 });
    const result = await provider.chat(msgs(), { reasoning: 'max' });
    assert.equal(result, 'ok', 'request tetap berhasil (tidak gagal)');
    assert.equal(calls.length, 2, 'tepat satu retry');
    assert.equal(calls[0].body.reasoning_effort, 'max');
    assert.equal('reasoning_effort' in calls[1].body, false, 'param native di-strip');
    const messages = calls[1].body.messages as Array<{ role: string; content: string }>;
    const systemMsg = messages.find((m) => m.role === 'system');
    assert.ok(systemMsg, 'fallback via system prompt');
    assert.ok(systemMsg.content.includes('REASONING DEPTH'), 'template per level terpasang');

    // Flag persisten: call berikutnya langsung fallback tanpa 400 lagi.
    await provider.chat(msgs('lagi'), { reasoning: 'high' });
    assert.equal(calls.length, 3);
    assert.equal('reasoning_effort' in calls[2].body, false, 'flag persisten per provider');
  } finally {
    restoreFetch();
  }
});

test('Fase 2: fallback Anthropic — 400 thinking → retry tanpa thinking + prompt injection', async () => {
  try {
    const calls = stubFetchResponders([rejectThinking, anthropicOk]);
    const provider = new AnthropicProvider(testCfg, { retries: 0 });
    const result = await provider.chat(msgs(), { reasoning: 'extreme' });
    assert.equal(result, 'ok', 'request tetap berhasil (tidak gagal)');
    assert.equal(calls.length, 2, 'tepat satu retry');
    assert.deepEqual(calls[0].body.thinking, { type: 'enabled', budget_tokens: 32768 });
    assert.equal('thinking' in calls[1].body, false, 'param native di-strip');
    assert.ok(
      String(calls[1].body.system ?? '').includes('REASONING DEPTH'),
      'fallback via system prompt',
    );
  } finally {
    restoreFetch();
  }
});

test('Fase 2: fallback Gemini — 400 thinkingConfig → retry tanpa thinkingConfig + prompt injection', async () => {
  try {
    const calls = stubFetchResponders([rejectThinkingBudget, geminiOk]);
    const provider = new GeminiProvider(testCfg, { retries: 0 });
    const result = await provider.chat(msgs(), { reasoning: 'high' });
    assert.equal(result, 'ok', 'request tetap berhasil (tidak gagal)');
    assert.equal(calls.length, 2, 'tepat satu retry');
    assert.deepEqual(calls[0].body.thinkingConfig, { thinkingBudget: 4096 });
    assert.equal('thinkingConfig' in calls[1].body, false, 'param native di-strip');
    const systemInstruction = calls[1].body.systemInstruction as
      | { parts: Array<{ text: string }> }
      | undefined;
    assert.ok(systemInstruction, 'fallback via systemInstruction');
    assert.ok(
      systemInstruction.parts[0].text.includes('REASONING DEPTH'),
      'template per level terpasang',
    );
  } finally {
    restoreFetch();
  }
});

test('Fase 2: withReasoningDirective menyisipkan ke system prompt yang sudah ada', () => {
  const withSystem = withReasoningDirective(
    [
      { role: 'system', content: 'Kamu asisten.', timestamp: new Date().toISOString() },
      { role: 'user', content: 'halo', timestamp: new Date().toISOString() },
    ],
    'max',
  );
  assert.equal(withSystem.length, 2, 'tidak menambah jumlah pesan');
  assert.ok(withSystem[0].content.startsWith('Kamu asisten.'));
  assert.ok(withSystem[0].content.includes('REASONING DEPTH'));

  const withoutSystem = withReasoningDirective(msgs(), 'extreme');
  assert.equal(withoutSystem.length, 2);
  assert.equal(withoutSystem[0].role, 'system');
  assert.ok(withoutSystem[0].content.includes('REASONING DEPTH'));
});

// ============================================================================
// State per-sesi: default XHigh, /reasoning popup & argumen, reset /new
// ============================================================================

test('Fase 2: default sesi baru reasoningLevel = xhigh', () => {
  const state = createDefaultSessionState();
  assert.equal(state.reasoningLevel, 'xhigh', 'Default sesi baru: XHigh');
  assert.equal(state.mode, 'default');
  assert.equal(state.buildPhase, 'explore');
});

function mockCommandEnv(overrides: Record<string, unknown> = {}) {
  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const provider = new MockReplyProvider();
  const agent = new Agent(ctx, provider, config);
  return {
    env: {
      ctx,
      config,
      llm: provider,
      agent,
      sessionState: agent.sessionState,
      confirm: async () => true,
      updateConfig: () => {
        assert.fail('updateConfig tidak boleh dipanggil untuk state per-sesi');
      },
      handle: {
        stop: () => {},
        getSessionId: () => 'prev-session',
        setSessionId: () => {},
      },
      ...overrides,
    } as any,
    agent,
  };
}

class MockReplyProvider implements LLMProvider {
  readonly name = 'mock-reply';
  readonly isConfigured = true;
  model = 'mock-model';
  receivedOptions: ChatOptions[] = [];
  setModel(model: string): void {
    this.model = model;
  }
  async chat(_messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    this.receivedOptions.push({ ...options });
    return 'ok';
  }
}

test('Fase 2: /reasoning popup selector update SessionState in-memory (4 opsi + deskripsi)', async () => {
  let captured: any = null;
  const { env, agent } = mockCommandEnv({
    select: async (options: any) => {
      captured = options;
      return 'extreme';
    },
  });

  await handleCommand('/reasoning', env);
  assert.ok(captured, 'popup selector dijalankan');
  assert.equal(captured.title, 'Pilih Level Reasoning');
  assert.equal(captured.defaultId, 'xhigh', 'default highlight = level aktif');
  assert.equal(captured.items.length, 4, 'empat pilihan: High, XHigh, Max, Extreme');
  for (const item of captured.items) {
    assert.ok(item.description.length > 0, `deskripsi 1 baris untuk ${item.label}`);
  }
  assert.equal(agent.sessionState.reasoningLevel, 'extreme', 'level diperbarui in-memory');
  assert.equal((env as any).config.reasoningLevel, undefined, 'config.json tidak ditulis');
});

test('Fase 2: /reasoning dibatalkan (Esc) tanpa side effect', async () => {
  const { env, agent } = mockCommandEnv({
    select: async () => null,
  });
  agent.sessionState.reasoningLevel = 'max';
  await handleCommand('/reasoning', env);
  assert.equal(agent.sessionState.reasoningLevel, 'max', 'level tidak berubah saat cancel');
});

test('Fase 2: /reasoning argumen langsung + argumen invalid', async () => {
  const { env, agent } = mockCommandEnv();

  await handleCommand('/reasoning HIGH', env);
  assert.equal(agent.sessionState.reasoningLevel, 'high', 'argumen case-insensitive');

  await handleCommand('/reasoning max', env);
  assert.equal(agent.sessionState.reasoningLevel, 'max');

  await handleCommand('/reasoning ultra', env);
  assert.equal(agent.sessionState.reasoningLevel, 'max', 'argumen invalid tidak mengubah state');
});

test('Fase 2: /new reset reasoningLevel ke xhigh', async () => {
  const { env, agent } = mockCommandEnv();
  agent.sessionState.reasoningLevel = 'extreme';
  await handleCommand('/new', env);
  assert.equal(agent.sessionState.reasoningLevel, 'xhigh', 'reset ke default tiap sesi baru');
});

test('Fase 2: Agent meneruskan reasoningLevel dari SessionState ke ChatOptions provider', async () => {
  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const provider = new MockReplyProvider();
  const agent = new Agent(ctx, provider, config);

  await agent.handleInstruction('halo');
  assert.equal(provider.receivedOptions[0]?.reasoning, 'xhigh', 'default XHigh terkirim');

  agent.sessionState.reasoningLevel = 'extreme';
  await agent.handleInstruction('lagi');
  assert.equal(provider.receivedOptions[1]?.reasoning, 'extreme', 'level aktif terkirim');
});
