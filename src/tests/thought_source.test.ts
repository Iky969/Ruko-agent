import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent, thoughtSegmentDuplicatesNative } from '../agent/agent.js';
import { Context } from '../core/context.js';
import {
  AnthropicProvider,
  ChatOptions,
  GeminiProvider,
  LLMProvider,
  OpenAiCompatibleProvider,
} from '../agent/llm.js';
import { buildSystemPrompt, getBuiltInRole } from '../agent/roles.js';
import { ContextMessage, DEFAULT_CONFIG } from '../types.js';

const MANDATE = 'MUST output a brief reasoning block enclosed in <thought>';

function baseLayers(thoughtSource?: 'native' | 'thought-tag'): Parameters<typeof buildSystemPrompt>[0] {
  return {
    role: getBuiltInRole('default')!,
    planMode: false,
    mode: 'beginner',
    agentDoc: null,
    ...(thoughtSource ? { thoughtSource } : {}),
  };
}

function withMockFetch(
  handler: (url: string) => Promise<Response> | Response,
): { restore: () => void; calls: string[] } {
  const origFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = origFetch;
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ollamaTags(models: Array<{ name: string; capabilities?: string[] }>): Response {
  return jsonResponse(200, { models });
}

// --- Deteksi: Ollama / OpenAI-compatible via /api/tags ----------------------

test('deteksi: model Ollama dengan capability thinking → true', async () => {
  const mock = withMockFetch(async (url) => {
    assert.ok(url.endsWith('/api/tags'), `harus memanggil /api/tags, bukan ${url}`);
    return ollamaTags([
      { name: 'mimo-v2.6-heretic:9b', capabilities: ['tools', 'thinking', 'completion'] },
    ]);
  });
  try {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'abcd',
      baseUrl: 'http://localhost:11434/v1',
      model: 'mimo-v2.6-heretic:9b',
    });
    assert.equal(await provider.detectVisibleReasoning(), true);
  } finally {
    mock.restore();
  }
});

test('deteksi: model Ollama terdaftar tanpa thinking → false', async () => {
  const mock = withMockFetch(async () => ollamaTags([{ name: 'llama3:8b', capabilities: ['completion'] }]));
  try {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'abcd',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3:8b',
    });
    assert.equal(await provider.detectVisibleReasoning(), false);
  } finally {
    mock.restore();
  }
});

test('deteksi: model tidak terdaftar → null TANPA fetch chat-completion', async () => {
  const mock = withMockFetch(async () => ollamaTags([{ name: 'llama3:8b', capabilities: ['completion'] }]));
  try {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'abcd',
      baseUrl: 'http://localhost:11434/v1',
      model: 'model-lain:7b',
    });
    assert.equal(await provider.detectVisibleReasoning(), null);
    assert.equal(mock.calls.length, 1, 'hanya satu fetch (tags) yang boleh terjadi');
    assert.ok(mock.calls[0].includes('/api/tags'), 'fetch harus ke /api/tags');
    assert.ok(!mock.calls[0].includes('chat/completions'), 'tidak boleh ada probe chat');
  } finally {
    mock.restore();
  }
});

test('deteksi: tags 404 → null', async () => {
  const mock = withMockFetch(async () => jsonResponse(404, { error: 'not found' }));
  try {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'abcd',
      baseUrl: 'http://localhost:11434/v1',
      model: 'deepseek-r1:8b',
    });
    assert.equal(await provider.detectVisibleReasoning(), null);
  } finally {
    mock.restore();
  }
});

test('deteksi: fetch gagal → null', async () => {
  const mock = withMockFetch(async () => {
    throw new Error('fetch failed');
  });
  try {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'abcd',
      baseUrl: 'http://localhost:11434/v1',
      model: 'deepseek-r1:8b',
    });
    assert.equal(await provider.detectVisibleReasoning(), null);
  } finally {
    mock.restore();
  }
});

test('deteksi: hasil di-memoize per model, setModel menginvalidasi', async () => {
  const mock = withMockFetch(async () =>
    ollamaTags([{ name: 'mimo-v2.6-heretic:9b', capabilities: ['thinking'] }]),
  );
  try {
    const provider = new OpenAiCompatibleProvider({
      apiKey: 'abcd',
      baseUrl: 'http://localhost:11434/v1',
      model: 'mimo-v2.6-heretic:9b',
    });
    assert.equal(await provider.detectVisibleReasoning(), true);
    assert.equal(await provider.detectVisibleReasoning(), true);
    assert.equal(mock.calls.length, 1, 'panggilan kedua harus memakai cache');
    provider.setModel('llama3:8b');
    assert.equal(await provider.detectVisibleReasoning(), null);
    assert.equal(mock.calls.length, 2, 'setModel harus menginvalidasi cache');
  } finally {
    mock.restore();
  }
});

test('deteksi: Anthropic dan Gemini selalu true (thinking/thought terlihat)', async () => {
  const anthropic = new AnthropicProvider({ apiKey: 'sk-ant', model: 'claude-3-5-sonnet-20241022' });
  const gemini = new GeminiProvider({ apiKey: 'gkey', model: 'gemini-2.0-flash' });
  assert.equal(await anthropic.detectVisibleReasoning(), true);
  assert.equal(await gemini.detectVisibleReasoning(), true);
});

// --- Prompt: varian native vs default ---------------------------------------

test('prompt: default byte-identik dengan thought-tag', () => {
  assert.equal(buildSystemPrompt(baseLayers()), buildSystemPrompt(baseLayers('thought-tag')));
});

test('prompt: varian native tanpa mandat <thought>', () => {
  const native = buildSystemPrompt(baseLayers('native'));
  assert.ok(!native.includes(MANDATE), 'varian native tidak boleh memuat mandat <thought>');
  assert.ok(
    native.includes('do NOT write a <thought>'),
    'varian native harus melarang blok <thought> eksplisit',
  );
  assert.ok(native.includes('```tool'), 'protokol tool tetap ada di varian native');
  assert.ok(native.includes('general coding assistant'), 'role tetap ada di varian native');
});

test('prompt: varian native tetap memuat aturan tool-call dan identitas', () => {
  const native = buildSystemPrompt(baseLayers('native'));
  assert.ok(native.includes('You are Ruko'), 'identitas inti tetap ada');
  assert.ok(
    !native.includes('always output a <thought> reasoning block'),
    'aturan pasca-tool-result tidak boleh lagi meminta blok <thought>',
  );
});

// --- Integrasi agent ---------------------------------------------------------

class ScriptedProvider implements LLMProvider {
  readonly name: string;
  readonly isConfigured = true;
  model = 'mock-model';
  lastFinishReason: string | null = 'stop';
  lastReasoning: string | null = null;
  receivedMessages: ContextMessage[][] = [];
  private calls = 0;

  constructor(
    name: string,
    private readonly visible: boolean | null,
    private readonly script: (callIndex: number, options: ChatOptions) => string,
  ) {
    this.name = name;
  }

  setModel(model: string): void {
    this.model = model;
  }

  async detectVisibleReasoning(): Promise<boolean | null> {
    return this.visible;
  }

  async chat(messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    this.receivedMessages.push([...messages]);
    const idx = this.calls;
    this.calls += 1;
    return this.script(idx, options ?? {});
  }
}

function makeAgent(provider: LLMProvider, maxToolIterations = 6): Agent {
  const config = { ...DEFAULT_CONFIG, maxToolIterations };
  const ctx = new Context(config);
  return new Agent(ctx, provider, config);
}

test('integrasi: deteksi native → prompt tanpa mandat + thought tampil 1x', async () => {
  const native = 'NATIVE-SOURCE reasoning about the task, planning the next steps carefully.';
  const provider = new ScriptedProvider('mock', true, (_idx, options) => {
    options.onThought?.(native);
    options.onToken?.('Jawaban akhir.');
    return 'Jawaban akhir.';
  });
  const agent = makeAgent(provider);
  const result = await agent.handleInstruction('kerjakan tugas');
  assert.equal(result, 'Jawaban akhir.');
  assert.equal(agent.sessionState.thoughtSource, 'native');
  const systemPrompt = provider.receivedMessages[0].find((m) => m.role === 'system')?.content ?? '';
  assert.ok(!systemPrompt.includes(MANDATE), 'prompt sesi native tanpa mandat <thought>');
});

test('integrasi: deteksi fallback → mandat <thought> dipertahankan', async () => {
  const provider = new ScriptedProvider('mock', false, (_idx, options) => {
    const reply = '<thought>Fallback thought: check the file first now.</thought>\nJawaban akhir.';
    options.onToken?.(reply);
    return reply;
  });
  const agent = makeAgent(provider);
  const result = await agent.handleInstruction('kerjakan tugas');
  assert.equal(result, 'Jawaban akhir.');
  assert.equal(agent.sessionState.thoughtSource, 'thought-tag');
  const systemPrompt = provider.receivedMessages[0].find((m) => m.role === 'system')?.content ?? '';
  assert.ok(systemPrompt.includes(MANDATE), 'prompt fallback tetap memuat mandat <thought>');
});

test('integrasi: latch adaptif — deteksi null lalu turn nyata membawa reasoning native', async () => {
  const native = 'LATCH-NATIVE reasoning streamed from the first real turn, evidence here.';
  const provider = new ScriptedProvider('mock', null, (_idx, options) => {
    options.onThought?.(native);
    options.onToken?.('Jawaban satu.');
    return 'Jawaban satu.';
  });
  const agent = makeAgent(provider);
  assert.equal(agent.sessionState.thoughtSource, undefined);
  await agent.handleInstruction('tugas pertama');
  assert.equal(agent.sessionState.thoughtSource, 'native', 'latch naik ke native setelah turn nyata');
  await agent.handleInstruction('tugas kedua');
  const secondPrompt = provider.receivedMessages[1].find((m) => m.role === 'system')?.content ?? '';
  assert.ok(!secondPrompt.includes(MANDATE), 'turn kedua memakai prompt native');
});

test('integrasi: kasus OpenAI Chat Completions → fallback <thought>', async () => {
  // OpenAI tidak mengembalikan isi reasoning sebagai teks di Chat
  // Completions — deteksi empiris (bukan nama model) menghasilkan false.
  const provider = new ScriptedProvider('openai-compatible', false, (_idx, options) => {
    const reply = '<thought>OpenAI fallback thought: plan the edit now please.</thought>\nSelesai.';
    options.onToken?.(reply);
    return reply;
  });
  const agent = makeAgent(provider);
  const result = await agent.handleInstruction('edit file');
  assert.equal(result, 'Selesai.');
  assert.equal(agent.sessionState.thoughtSource, 'thought-tag');
});

test('integrasi: kasus gpt-6-luna — klasifikasi dari bukti stream, bukan nama model', async () => {
  // Nama model 'gpt-6-luna' saja tidak membuktikan apa-apa; yang membuktikan
  // adalah field reasoning berisi teks ringkasan di stream nyata.
  const summary = 'GPT6-LUNA summary reasoning text from the live stream, visible here.';
  const provider = new ScriptedProvider('gpt-6-luna', null, (_idx, options) => {
    options.onThought?.(summary);
    options.onToken?.('Jawaban ringkas.');
    return 'Jawaban ringkas.';
  });
  const agent = makeAgent(provider);
  await agent.handleInstruction('tanya sesuatu');
  assert.equal(
    agent.sessionState.thoughtSource,
    'native',
    'stream dengan reasoning terlihat → native, apa pun nama modelnya',
  );
});

test('integrasi: episode campuran native+tag = 1 episode, breaker tidak menendang', async () => {
  const origDelay = process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
  process.env.RUKO_THOUGHT_LOOP_DELAY_MS = '10';
  try {
    const thought =
      'Mixed episode reasoning text, the same thought via native and tag channels.';
    const provider = new ScriptedProvider('mock', true, (_idx, options) => {
      options.onThought?.(thought);
      const reply = `<thought>${thought}</thought>`;
      options.onToken?.(reply);
      return reply;
    });
    const agent = makeAgent(provider, 6);
    const result = await agent.handleInstruction('berpikir panjang tanpa tool');
    assert.ok(
      result.includes('reached max tool iterations'),
      'episode campuran berakhir di batas iterasi, bukan breaker',
    );
    assert.ok(
      !result.includes('terjebak dalam thought loop'),
      'native + tag dalam satu giliran adalah satu episode, bukan dua',
    );
    // Helper dedup: containment >=40 karakter = duplikat, <40 bukan.
    const native =
      'This is a long native reasoning paragraph about checking files and planning the edit carefully.';
    assert.equal(thoughtSegmentDuplicatesNative(native, native), true, 'teks identik = duplikat');
    assert.equal(
      thoughtSegmentDuplicatesNative('short thought', native),
      false,
      'overlap pendek (<40) bukan duplikat',
    );
    assert.equal(
      thoughtSegmentDuplicatesNative(
        'A completely different analysis about the database schema and migrations.',
        native,
      ),
      false,
      'konten berbeda bukan duplikat',
    );
  } finally {
    if (origDelay !== undefined) process.env.RUKO_THOUGHT_LOOP_DELAY_MS = origDelay;
    else delete process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
  }
});
