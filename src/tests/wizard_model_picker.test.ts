import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';
import { handleCommand } from '../agent/commands.js';
import { detectProviderKindDetailed } from '../agent/llm.js';
import {
  MODEL_MANUAL_ENTRY_ID,
  pickModelWithSelector,
  promptSetup,
  providerKindLabel,
  SetupResult,
} from '../core/wizard.js';
import { SelectorOptions } from '../core/tui.js';
import { ContextMessage, DEFAULT_CONFIG } from '../types.js';
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

/** Captures console.log lines for the duration of fn (tee: still prints). */
async function withCapturedLog<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const origLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(stripAnsi(args.map((a) => String(a)).join(' ')));
    origLog(...args);
  };
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = origLog;
  }
}

// --- Auto-deteksi base URL ---------------------------------------------------

test('deteksi: host anthropic/googleapis/chatgpt + path /responses = high', () => {
  assert.deepEqual(detectProviderKindDetailed('https://api.anthropic.com/v1', 'x'), {
    kind: 'anthropic',
    confidence: 'high',
    reason: 'host anthropic.com',
  });
  assert.deepEqual(detectProviderKindDetailed('https://generativelanguage.googleapis.com/v1beta', 'x'), {
    kind: 'gemini',
    confidence: 'high',
    reason: 'host googleapis.com',
  });
  assert.deepEqual(detectProviderKindDetailed('https://chatgpt.com/v1', 'gpt-5'), {
    kind: 'responses',
    confidence: 'high',
    reason: 'host chatgpt.com',
  });
  assert.deepEqual(detectProviderKindDetailed('https://example.com/v1/responses', 'gpt-5'), {
    kind: 'responses',
    confidence: 'high',
    reason: 'path base URL berakhir /responses',
  });
});

test('deteksi: prefix model + localhost = medium', () => {
  const a = detectProviderKindDetailed('https://example.com/v1', 'claude-3-5-sonnet-20241022');
  assert.equal(a.kind, 'anthropic');
  assert.equal(a.confidence, 'medium');
  const g = detectProviderKindDetailed('https://example.com/v1', 'gemini-2.0-flash');
  assert.equal(g.kind, 'gemini');
  assert.equal(g.confidence, 'medium');
  const l = detectProviderKindDetailed('http://localhost:11434/v1', 'llama3:8b');
  assert.equal(l.kind, 'openai-compatible');
  assert.equal(l.confidence, 'medium');
  assert.ok(l.reason.includes('localhost'));
});

test('deteksi: tanpa petunjuk = low + openai-compatible', () => {
  const d = detectProviderKindDetailed('https://llm.internal.example/v1', 'model-x');
  assert.equal(d.kind, 'openai-compatible');
  assert.equal(d.confidence, 'low');
});

test('deteksi: nama provider eksplisit menang dengan keyakinan high', () => {
  assert.equal(detectProviderKindDetailed('https://example.com/v1', 'gpt-5', 'codex').kind, 'responses');
  assert.equal(detectProviderKindDetailed('https://example.com/v1', 'gpt-5', 'codex').confidence, 'high');
  assert.equal(detectProviderKindDetailed('https://example.com/v1', 'x', 'claude').kind, 'anthropic');
  assert.equal(detectProviderKindDetailed('https://example.com/v1', 'x', 'google').kind, 'gemini');
});

// --- Wizard: auto-deteksi + override manual ----------------------------------

test('wizard: Enter memakai provider terdeteksi (anthropic)', async () => {
  const rl = fakeRl(['sk-1', 'https://api.anthropic.com/v1', 'claude-3-5-sonnet-20241022', '']);
  const { result, lines } = await withCapturedLog(() => promptSetup(rl, { askProvider: true }));
  assert.equal(result?.provider, 'anthropic');
  assert.ok(lines.some((l) => l.includes('Terdeteksi: anthropic')), 'baris auto-deteksi ditampilkan');
});

test('wizard: Enter memakai provider terdeteksi (responses, chatgpt.com)', async () => {
  const rl = fakeRl(['sk-1', 'https://chatgpt.com/v1', 'gpt-5', '']);
  const result = await promptSetup(rl, { askProvider: true });
  assert.equal(result?.provider, 'responses');
});

test('wizard: keyakinan rendah ditampilkan eksplisit', async () => {
  const rl = fakeRl(['sk-1', 'https://llm.internal.example/v1', 'model-x', '']);
  const { result, lines } = await withCapturedLog(() => promptSetup(rl, { askProvider: true }));
  assert.equal(result?.provider, 'openai-compatible');
  assert.ok(lines.some((l) => l.includes('keyakinan rendah')), 'ketidakpastian low ditampilkan, bukan ditebak diam-diam');
});

test('wizard: override manual 1/4/nama menimpa hasil deteksi', async () => {
  const r1 = fakeRl(['sk-1', 'https://api.anthropic.com/v1', 'claude-3-5-sonnet-20241022', '1']);
  assert.equal((await promptSetup(r1, { askProvider: true }))?.provider, 'openai-compatible');
  const r2 = fakeRl(['sk-1', 'https://api.anthropic.com/v1', 'claude-3-5-sonnet-20241022', '4']);
  assert.equal((await promptSetup(r2, { askProvider: true }))?.provider, 'responses');
  const r3 = fakeRl(['sk-1', 'https://api.anthropic.com/v1', 'claude-3-5-sonnet-20241022', 'codex']);
  assert.equal((await promptSetup(r3, { askProvider: true }))?.provider, 'responses');
  const r4 = fakeRl(['sk-1', 'https://api.anthropic.com/v1', 'claude-3-5-sonnet-20241022', '2']);
  assert.equal((await promptSetup(r4, { askProvider: true }))?.provider, 'anthropic');
});

// --- pickModelWithSelector ----------------------------------------------------

test('picker: memilih model mengembalikan id-nya; ada entri manual di bawah', async () => {
  let seen: SelectorOptions | null = null;
  const chosen = await pickModelWithSelector(['m1', 'm2', 'm3'], 'm2', async (opts) => {
    seen = opts;
    return 'm3';
  });
  assert.equal(chosen, 'm3');
  assert.ok(seen, 'select hook dipanggil');
  assert.equal((seen as unknown as SelectorOptions).items.length, 4, '3 model + 1 entri manual');
  assert.equal((seen as unknown as SelectorOptions).items[3].id, MODEL_MANUAL_ENTRY_ID);
  assert.equal((seen as unknown as SelectorOptions).defaultId, 'm2', 'default = model saat ini');
  assert.equal((seen as unknown as SelectorOptions).filterable, true, 'ketik-untuk-filter aktif');
});

test('picker: batal mengembalikan null', async () => {
  assert.equal(await pickModelWithSelector(['m1', 'm2'], 'm1', async () => null), null);
});

test('picker: entri manual mengembalikan null (fallback ke model ketik)', async () => {
  assert.equal(
    await pickModelWithSelector(['m1', 'm2'], 'm1', async () => MODEL_MANUAL_ENTRY_ID),
    null,
  );
});

test('picker: daftar kosong mengembalikan null tanpa membuka selector', async () => {
  let called = false;
  const result = await pickModelWithSelector([], 'm1', async () => {
    called = true;
    return 'm1';
  });
  assert.equal(result, null);
  assert.equal(called, false, 'selector tidak dibuka untuk daftar kosong');
});

// --- Wizard: alur pemilih sesudah probe ---------------------------------------

test('wizard: sesudah probe sukses, model pilihan diverifikasi lalu dipakai', async () => {
  const probed: string[] = [];
  const probe = async (r: SetupResult) => {
    probed.push(r.model);
    return { ok: true, message: r.model };
  };
  const rl = fakeRl(['sk-1', 'https://example.com/v1', 'm1', '']);
  const result = await promptSetup(rl, {
    askProvider: true,
    probe,
    listModels: async () => ['m1', 'm2', 'm3'],
    selectModel: async () => 'm2',
  });
  assert.equal(result?.model, 'm2', 'model pilihan yang terverifikasi dipakai');
  assert.deepEqual(probed, ['m1', 'm2'], 'pilihan diverifikasi ulang dengan probe');
});

test('wizard: model pilihan gagal verifikasi → model terverifikasi semula dipertahankan', async () => {
  const probe = async (r: SetupResult) =>
    r.model === 'm2'
      ? { ok: false, message: 'Model tidak ditemukan (404)' }
      : { ok: true, message: r.model };
  const rl = fakeRl(['sk-1', 'https://example.com/v1', 'm1', '']);
  const result = await promptSetup(rl, {
    askProvider: true,
    probe,
    listModels: async () => ['m1', 'm2'],
    selectModel: async () => 'm2',
  });
  assert.equal(result?.model, 'm1', 'model semula dipertahankan saat verifikasi gagal');
});

test('wizard: daftar model kosong/gagal → model ketik dipakai', async () => {
  const probe = async (r: SetupResult) => ({ ok: true, message: r.model });
  let selectCalled = false;
  const rl = fakeRl(['sk-1', 'https://example.com/v1', 'm1', '']);
  const result = await promptSetup(rl, {
    askProvider: true,
    probe,
    listModels: async () => [],
    selectModel: async () => {
      selectCalled = true;
      return 'm2';
    },
  });
  assert.equal(result?.model, 'm1');
  assert.equal(selectCalled, false, 'selector tidak dibuka saat daftar kosong');
});

// --- Helper + /model -----------------------------------------------------------

test('helper: providerKindLabel untuk setiap kind', () => {
  assert.ok(providerKindLabel('anthropic').startsWith('anthropic'));
  assert.ok(providerKindLabel('gemini').startsWith('gemini'));
  assert.ok(providerKindLabel('responses').includes('Codex'));
  assert.ok(providerKindLabel('openai-compatible').includes('Ollama'));
});

class MockListProvider implements LLMProvider {
  readonly name = 'mock-list';
  readonly isConfigured = true;
  model = 'm1';
  lastFinishReason: string | null = 'stop';
  setModelCalled: string[] = [];
  constructor(private readonly models: string[]) {}
  setModel(model: string): void {
    this.model = model;
    this.setModelCalled.push(model);
  }
  async listModels(): Promise<string[]> {
    return [...this.models];
  }
  async chat(_messages: ContextMessage[], _options?: ChatOptions): Promise<string> {
    return 'ok';
  }
}

function modelEnv(provider: MockListProvider, select?: (opts: SelectorOptions) => Promise<string | null>) {
  const config = { ...DEFAULT_CONFIG };
  const ctx = new Context(config);
  const agent = new Agent(ctx, provider, config);
  const patches: Array<Partial<typeof config>> = [];
  return {
    env: {
      ctx,
      config,
      llm: provider,
      agent,
      sessionState: agent.sessionState,
      confirm: async () => true,
      ...(select ? { select } : {}),
      updateConfig: (patch: Partial<typeof config>) => {
        patches.push(patch);
      },
      handle: { stop: () => {}, getSessionId: () => null, setSessionId: () => {} },
    } as Parameters<typeof handleCommand>[1],
    patches,
  };
}

test('/model: tanpa argumen + hook selector → pemilih dipakai, model diganti', async () => {
  const provider = new MockListProvider(['m1', 'm2', 'm3']);
  const { env, patches } = modelEnv(provider, async () => 'm3');
  await handleCommand('/model', env);
  assert.deepEqual(provider.setModelCalled, ['m3']);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].model, 'm3');
});

test('/model: tanpa hook selector → perilaku lama (kotak 20 pertama)', async () => {
  const models = Array.from({ length: 25 }, (_, i) => `model-${i + 1}`);
  const provider = new MockListProvider(models);
  const { env } = modelEnv(provider);
  const { lines } = await withCapturedLog(() => handleCommand('/model', env));
  assert.deepEqual(provider.setModelCalled, [], 'model tidak berubah tanpa pilihan');
  assert.ok(
    lines.some((l) => l.includes('25') && l.includes('20 pertama')),
    'kotak lama menampilkan 20 pertama dari 25',
  );
});
