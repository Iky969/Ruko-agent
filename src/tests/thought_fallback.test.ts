/**
 * Thought-block fallback (Hermes-style): saat provider tidak mendukung
 * parameter reasoning native, Ruko memerintahkan model bernalar di dalam
 * <thought>...</thought> lewat prompt — dan thought yang tidak tertutup
 * di tiap langkah TIDAK BOLEH bocor menjadi jawaban ke user.
 *
 * Mencakup:
 * - Addendum fallback per level memuat instruksi <thought> (high = ultra).
 * - stripThoughtBlocks / extractThoughts menangani blok tak tertutup.
 * - parseToolCalls mengabaikan tool call di dalam thought.
 * - ThoughtStreamParser multi-blok + tag terbelah antar chunk.
 * - Agent loop: giliran thought tak tertutup mendapat nudge penutup
 *   eksplisit, dan isi thought tidak menjadi jawaban akhir.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Agent } from '../agent/agent.js';
import { ChatOptions, LLMProvider, reasoningPromptAddendum, withReasoningDirective } from '../agent/llm.js';
import { parseToolCalls } from '../agent/tools.js';
import { Context } from '../core/context.js';
import { extractThoughts, stripThoughtBlocks, ThoughtStreamParser } from '../core/ui.js';
import { ContextMessage, DEFAULT_CONFIG, ReasoningLevel } from '../types.js';

// ============================================================================
// 1. Addendum fallback per level
// ============================================================================

test('Fallback addendum per level memerintahkan reasoning di dalam <thought>', () => {
  for (const level of ['low', 'medium', 'high'] as ReasoningLevel[]) {
    const addendum = reasoningPromptAddendum(level);
    assert.ok(addendum.includes('REASONING DEPTH'), `level ${level} teridentifikasi sebagai instruksi reasoning`);
    assert.ok(addendum.includes('<thought>'), `level ${level} memerintahkan blok <thought>`);
    assert.ok(addendum.includes('</thought>'), `level ${level} memerintahkan penutup </thought>`);
    assert.ok(
      addendum.includes('Never put tool calls') || addendum.includes('DILARANG'),
      `level ${level} melarang format tool di dalam thought`,
    );
  }
  const seen = new Set(['low', 'medium', 'high'].map((l) => reasoningPromptAddendum(l as ReasoningLevel)));
  assert.equal(seen.size, 3, 'tiga template berbeda untuk tiga level');
});

test('Fallback addendum high (ultra): jangan buru-buru menutup </thought>', () => {
  const addendum = reasoningPromptAddendum('high');
  assert.ok(addendum.includes('Do NOT close </thought>'), 'high melarang penutupan prematur');
  assert.ok(addendum.includes('alternatives'), 'high mempertimbangkan alternatif');
  assert.ok(addendum.includes('edge cases'), 'high mempertimbangkan edge case');
  // Alias legacy tetap dipetakan ke high.
  assert.equal(reasoningPromptAddendum('xhigh'), addendum);
  assert.equal(reasoningPromptAddendum('extreme'), addendum);
});

test('Fallback addendum low: thought singkat, langsung bertindak', () => {
  const addendum = reasoningPromptAddendum('low');
  assert.ok(addendum.includes('briefly'), 'low meminta thought singkat');
  assert.ok(!addendum.includes('Do NOT close'), 'low tidak menahan penutupan thought');
});

test('withReasoningDirective menyisipkan instruksi <thought> ke system prompt', () => {
  const msgs: ContextMessage[] = [
    { role: 'system', content: 'You are Ruko.', timestamp: '' },
    { role: 'user', content: 'halo', timestamp: '' },
  ];
  const out = withReasoningDirective(msgs, 'high');
  assert.ok(out[0].content.includes('<thought>'), 'system prompt membawa instruksi thought');
  assert.ok(out[0].content.includes('Do NOT close </thought>'), 'instruksi high (ultra) ikut tersisip');
  assert.equal(out.length, 2, 'tidak menambah pesan baru');
});

// ============================================================================
// 2. stripThoughtBlocks / extractThoughts dengan blok tak tertutup
// ============================================================================

test('stripThoughtBlocks menghapus blok thought yang tidak tertutup', () => {
  assert.equal(
    stripThoughtBlocks('Jawaban pendahuluan.\n<thought>Rencana rahasia yang belum selesai'),
    'Jawaban pendahuluan.',
    'thought tak tertutup tidak boleh bocor ke jawaban',
  );
  assert.equal(
    stripThoughtBlocks('<thought>Hanya berpikir, belum menjawab'),
    '',
    'seluruh output adalah thought tak tertutup → jawaban kosong',
  );
  assert.equal(
    stripThoughtBlocks('Awal.\n<thought>tertutup</thought>\nTengah.\n<think>tak tertutup'),
    'Awal.\n\nTengah.',
    'blok tertutup dan tak tertutup sama-sama dihapus',
  );
});

test('extractThoughts menangkap blok tak tertutup sampai akhir teks', () => {
  assert.deepEqual(extractThoughts('<thought>Rencana 1</thought> teks <think>Rencana 2'), [
    'Rencana 1',
    'Rencana 2',
  ]);
});

// ============================================================================
// 3. parseToolCalls mengabaikan tool call di dalam thought
// ============================================================================

test('parseToolCalls: tool call di dalam <thought> tertutup tidak dieksekusi', () => {
  const res = parseToolCalls(
    '<thought>Saya akan membaca file.\n```tool\n{"tool": "read_file", "path": "secret.txt"}\n```\n</thought>',
  );
  assert.equal(res.calls.length, 0, 'tool di dalam thought harus diabaikan');
});

test('parseToolCalls: tool call di dalam <thought> tak tertutup tidak dieksekusi', () => {
  const res = parseToolCalls(
    '<thought>Saya akan membaca file.\n```tool\n{"tool": "read_file", "path": "secret.txt"}\n```',
  );
  assert.equal(res.calls.length, 0, 'tool di dalam thought tak tertutup harus diabaikan');
});

test('parseToolCalls: tool call di luar thought tetap dieksekusi', () => {
  const res = parseToolCalls(
    '<thought>Rencana: baca file dulu.</thought>\n```tool\n{"tool": "read_file", "path": "note.txt"}\n```',
  );
  assert.equal(res.calls.length, 1, 'tool di luar thought tetap jalan');
  assert.equal(res.calls[0].tool, 'read_file');
});

// ============================================================================
// 4. ThoughtStreamParser: multi-blok dan tag terbelah antar chunk
// ============================================================================

test('ThoughtStreamParser: banyak blok thought per langkah, teks di antaranya ke user', () => {
  let thoughts: string[] = [];
  let text = '';
  let segments = 0;
  const parser = new ThoughtStreamParser({
    onText: (t) => {
      text += t;
    },
    onThought: (th) => {
      thoughts.push(th);
    },
    onThoughtEnd: () => {
      segments += 1;
    },
  });
  // Tag pembuka terbelah antar chunk; dua blok thought dalam satu stream.
  for (const c of ['<tho', 'ught>Langkah 1: baca</thought> teks tengah <think>Langkah 2: edit</think> selesai.']) {
    parser.feed(c);
  }
  parser.end();
  assert.deepEqual(thoughts, ['Langkah 1: baca', 'Langkah 2: edit']);
  assert.equal(segments, 2, 'dua segmen thought ditutup');
  assert.equal(text, ' teks tengah  selesai.');
});

test('ThoughtStreamParser: thought tak tertutup di akhir stream tidak bocor ke teks user', () => {
  let thoughts = '';
  let text = '';
  const parser = new ThoughtStreamParser({
    onText: (t) => {
      text += t;
    },
    onThought: (th) => {
      thoughts += th;
    },
  });
  parser.feed('Jawaban awal. <thought>Masih berpikir tentang langkah berikut');
  parser.end();
  assert.equal(text, 'Jawaban awal. ');
  assert.equal(thoughts, 'Masih berpikir tentang langkah berikut');
  assert.equal(parser.isInThought(), false, 'parser selesai dalam keadaan bersih');
});

// ============================================================================
// 5. Agent loop: thought tak tertutup mendapat nudge penutup eksplisit
// ============================================================================

class MockSequenceProvider implements LLMProvider {
  readonly name = 'mock-sequence';
  readonly isConfigured = true;
  model = 'mock-model';
  lastFinishReason: string | null = 'stop';
  receivedMessages: ContextMessage[][] = [];
  private calls = 0;

  constructor(private readonly replies: string[]) {}

  setModel(model: string): void {
    this.model = model;
  }

  async chat(messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    this.receivedMessages.push([...messages]);
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    options?.onToken?.(reply);
    return reply;
  }
}

test('Agent: giliran thought tak tertutup tidak menjadi jawaban; nudge penutup dikirim', async () => {
  const origDelay = process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
  process.env.RUKO_THOUGHT_LOOP_DELAY_MS = '10';
  try {
    const provider = new MockSequenceProvider([
      '<thought>Saya akan memeriksa file rahasia dulu',
      'Selesai memeriksa, tidak ada masalah.',
    ]);
    const ctx = new Context({ ...DEFAULT_CONFIG });
    const agent = new Agent(ctx, provider, { ...DEFAULT_CONFIG });
    const result = await agent.handleInstruction('periksa sesuatu');
    assert.equal(result, 'Selesai memeriksa, tidak ada masalah.');
    assert.ok(!result.includes('file rahasia'), 'isi thought tak tertutup tidak boleh bocor ke jawaban');
    assert.equal(provider.receivedMessages.length, 2, 'agent memanggil model sekali lagi setelah nudge');
    const nudge = provider.receivedMessages[1].at(-1);
    assert.equal(nudge?.role, 'user');
    assert.ok(
      nudge?.content.includes('belum ditutup') && nudge?.content.includes('</thought>'),
      'nudge meminta menutup </thought> dulu',
    );
  } finally {
    if (origDelay === undefined) delete process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
    else process.env.RUKO_THOUGHT_LOOP_DELAY_MS = origDelay;
  }
});
