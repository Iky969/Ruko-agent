/**
 * Thought episode counting + streaming thought box (issue DeepSeek thought-loop).
 *
 * - Giliran thought-only berurutan tanpa output/tool di antaranya = SATU episode.
 *   Breaker menghitung episode (4 episode terpisah baru menendang), bukan giliran.
 * - Reasoning LENGKAP disimpan ke history sesi sebagai blok <thought>, supaya
 *   retry bisa membaca reasoning sepenuhnya dari awal.
 * - Thought di-render sebagai box Ruko yang di-streaming TERBUKA (garis atas +
 *   isi, tanpa garis bawah) — garis penutup baru dicetak saat segmen selesai.
 *   Garis box hijau, isi abu-abu, tag <thought>/<think> tidak pernah tercetak.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Agent, withStoredReasoning } from '../agent/agent.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';
import { Context } from '../core/context.js';
import {
  ReasoningPanel,
  renderReasoningBox,
  stripAnsi,
  visibleLength,
} from '../core/ui.js';
import { setWorkspaceRoot } from '../agent/tools.js';
import { ContextMessage, DEFAULT_CONFIG } from '../types.js';

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

/** Mock ala DeepSeek: reasoning lewat onThought (reasoning_content), content kosong. */
class MockNativeReasoningProvider implements LLMProvider {
  readonly name = 'mock-native-reasoning';
  readonly isConfigured = true;
  model = 'mock-deepseek-reasoner';
  lastFinishReason: string | null = 'stop';
  receivedMessages: ContextMessage[][] = [];
  private calls = 0;

  constructor(
    private readonly thoughts: string[],
    private readonly followUp: string,
  ) {}

  setModel(model: string): void {
    this.model = model;
  }

  async chat(messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    this.receivedMessages.push([...messages]);
    const idx = this.calls;
    this.calls += 1;
    if (idx < this.thoughts.length) {
      options?.onThought?.(this.thoughts[idx]);
      return '';
    }
    options?.onToken?.(this.followUp);
    return this.followUp;
  }
}

function withFastThoughtDelay<T>(fn: () => Promise<T>): Promise<T> {
  const orig = process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
  process.env.RUKO_THOUGHT_LOOP_DELAY_MS = '10';
  return fn().finally(() => {
    if (orig !== undefined) process.env.RUKO_THOUGHT_LOOP_DELAY_MS = orig;
    else delete process.env.RUKO_THOUGHT_LOOP_DELAY_MS;
  });
}

// ============================================================================
// 1. Episode counting: breaker menghitung episode, bukan giliran
// ============================================================================

test('Episode: 4 episode thought-only yang dipisah tool call menendang breaker di episode ke-4', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-episode-test-'));
  setWorkspaceRoot(tmp);
  try {
    writeFileSync(join(tmp, 'f1.txt'), 'isi file 1', 'utf8');
    writeFileSync(join(tmp, 'f2.txt'), 'isi file 2', 'utf8');
    writeFileSync(join(tmp, 'f3.txt'), 'isi file 3', 'utf8');

    const thoughtOnly = '<thought>sedang memikirkan rencana langkah selanjutnya...</thought>';
    const tool = (f: string) =>
      `<thought>baca ${f}</thought>\n\`\`\`tool\n{"tool": "read_file", "path": "${f}"}\n\`\`\``;
    // Episode 1 thought → tool → episode 2 thought → tool → episode 3
    // thought → tool → episode 4 thought → breaker.
    const provider = new MockSequenceProvider([
      thoughtOnly,
      tool('f1.txt'),
      thoughtOnly,
      tool('f2.txt'),
      thoughtOnly,
      tool('f3.txt'),
      thoughtOnly,
    ]);

    const config = { ...DEFAULT_CONFIG, maxToolIterations: 10 };
    const agent = new Agent(new Context(config), provider, config);

    const result = await withFastThoughtDelay(() =>
      agent.handleInstruction('baca file bergantian dengan berpikir'),
    );

    assert.equal(
      result,
      'Agent terjebak dalam thought loop tanpa memanggil tool.',
      'Breaker harus menendang setelah 4 episode terpisah',
    );
    assert.equal(
      provider.receivedMessages.length,
      7,
      'Breaker di percobaan ke-7: 4 thought-only + 3 tool call',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Episode: tool call menutup episode — thought setelah tool adalah episode baru', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-episode-test-'));
  setWorkspaceRoot(tmp);
  try {
    writeFileSync(join(tmp, 'f1.txt'), 'isi file 1', 'utf8');
    const thoughtOnly = '<thought>memikirkan lagi...</thought>';
    const provider = new MockSequenceProvider([
      thoughtOnly,
      thoughtOnly,
      `<thought>baca file</thought>\n\`\`\`tool\n{"tool": "read_file", "path": "f1.txt"}\n\`\`\``,
      thoughtOnly,
      thoughtOnly,
      'Selesai membaca.',
    ]);

    const config = { ...DEFAULT_CONFIG, maxToolIterations: 10 };
    const agent = new Agent(new Context(config), provider, config);

    // 2 thought (episode 1) + tool + 2 thought (episode 2) + jawaban:
    // hanya 2 episode, breaker (4 episode) tidak boleh menendang.
    const result = await withFastThoughtDelay(() =>
      agent.handleInstruction('baca file lalu jawab'),
    );

    assert.ok(result.includes('Selesai membaca.'), 'Harus sampai ke jawaban akhir');
    assert.ok(!result.includes('terjebak dalam thought loop'), 'Breaker tidak boleh menendang');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ============================================================================
// 2. Reasoning lengkap disimpan ke history (bukan placeholder kosong)
// ============================================================================

test('withStoredReasoning: reasoning native disimpan sebagai blok <thought>', () => {
  assert.equal(
    withStoredReasoning('', 'analisis rahasia langkah demi langkah'),
    '<thought>\nanalisis rahasia langkah demi langkah\n</thought>',
    'reasoning native (raw kosong) disimpan lengkap sebagai blok thought',
  );
  assert.equal(
    withStoredReasoning('', ''),
    '<thought></thought>',
    'tanpa reasoning maupun raw, placeholder kosong dipertahankan',
  );
});

test('withStoredReasoning: blok thought di raw tidak diduplikasi', () => {
  assert.equal(
    withStoredReasoning('<thought>analisis rahasia</thought>', 'analisis rahasia'),
    '<thought>analisis rahasia</thought>',
    'isi thought yang sama tidak ditulis dua kali',
  );
  const both = withStoredReasoning(
    '<thought>rencana A dari content</thought>',
    'alasan native B yang berbeda',
  );
  assert.ok(both.includes('alasan native B'), 'reasoning native yang berbeda ikut disimpan');
  assert.ok(both.includes('rencana A dari content'), 'blok thought dari content tetap ada');
});

test('Agent: reasoning native DeepSeek tersimpan di history saat retry (bukan placeholder)', async () => {
  const provider = new MockNativeReasoningProvider(
    ['rencana rahasia: baca f1 dulu baru simpulkan'],
    '```tool\n{"tool": "read_file", "path": "f1.txt"}\n```',
  );
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-episode-test-'));
  setWorkspaceRoot(tmp);
  try {
    writeFileSync(join(tmp, 'f1.txt'), 'isi file 1', 'utf8');
    const config = { ...DEFAULT_CONFIG, maxToolIterations: 10 };
    const agent = new Agent(new Context(config), provider, config);

    await withFastThoughtDelay(() => agent.handleInstruction('baca f1'));

    // Pesan ke-2 (retry setelah giliran thought-only) harus memuat reasoning
    // lengkap di dalam blok <thought> pada pesan assistant.
    assert.ok(provider.receivedMessages.length >= 2, 'ada retry setelah thought-only');
    const retryMessages = provider.receivedMessages[1];
    const assistantMsg = retryMessages.find((m) => m.role === 'assistant');
    assert.ok(assistantMsg, 'pesan assistant tersimpan di history retry');
    assert.ok(
      assistantMsg!.content.includes('rencana rahasia: baca f1 dulu baru simpulkan'),
      'isi reasoning lengkap ada di history, bukan placeholder kosong',
    );
    assert.ok(
      assistantMsg!.content.includes('<thought>'),
      'reasoning disimpan sebagai blok <thought>',
    );
    assert.ok(
      assistantMsg!.content !== '<thought></thought>',
      'bukan placeholder kosong',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Agent: respons terpotong (finish_reason=length) mendapat nudge "lanjutkan dari tempat berhenti"', async () => {
  const provider = new MockNativeReasoningProvider(
    ['berpikir panjang yang terpotong di tengah jalan'],
    'Jawaban akhir setelah lanjut.',
  );
  provider.lastFinishReason = 'length';
  const config = { ...DEFAULT_CONFIG, maxToolIterations: 5 };
  const agent = new Agent(new Context(config), provider, config);

  const result = await withFastThoughtDelay(() =>
    agent.handleInstruction('jawab dengan penalaran panjang'),
  );

  assert.ok(result.includes('Jawaban akhir setelah lanjut.'), 'harus sampai ke jawaban');
  const retryMessages = provider.receivedMessages[1];
  const nudge = retryMessages[retryMessages.length - 1];
  assert.equal(nudge.role, 'user', 'nudge terakhir adalah pesan user internal');
  assert.ok(nudge.content.includes('terpotong'), 'nudge menyebut respons terpotong');
  assert.ok(
    nudge.content.includes('Lanjutkan dari tempat kamu berhenti'),
    'nudge meminta lanjut, bukan mengulang dari awal',
  );
});

// ============================================================================
// 3. Streaming thought box: terbuka saat berpikir, tertutup saat segmen selesai
// ============================================================================

function stripLive(writes: string[]): string {
  return stripAnsi(writes.join('')).replace(/\r/g, '');
}

test('renderReasoningBox: box Ruko, garis hijau, isi abu-abu, tag tidak tercetak', () => {
  const box = renderReasoningBox(
    '<thought>rahasia box baris satu</thought>\nbaris kedua biasa',
    70,
  );
  const plain = stripAnsi(box);
  const lines = plain.split('\n');

  assert.ok(lines[0].startsWith('┌─Ruko'), 'garis atas box Ruko');
  assert.ok(lines[0].endsWith('┐'), 'sudut kanan atas tertutup');
  assert.ok(lines[lines.length - 1].startsWith('└'), 'garis bawah penutup');
  assert.ok(lines[lines.length - 1].endsWith('┘'), 'sudut kanan bawah tertutup');
  assert.ok(plain.includes('rahasia box baris satu'), 'isi thought tampil');
  assert.ok(plain.includes('baris kedua biasa'), 'baris kedua tampil');
  assert.ok(!plain.includes('<thought>'), 'tag pembuka tidak tercetak');
  assert.ok(!plain.includes('</thought>'), 'tag penutup tidak tercetak');
  for (let i = 1; i < lines.length - 1; i++) {
    assert.ok(lines[i].startsWith('    '), 'isi di-indent 4 spasi');
  }
  for (const line of lines) {
    assert.ok(visibleLength(line) <= 70, `line exceeds max width: "${line}"`);
  }
  assert.equal(renderReasoningBox(''), '', 'box kosong untuk reasoning kosong');
});

test('renderReasoningBox: warna hijau (32) untuk garis, abu-abu (90) untuk isi', () => {
  const origIsTTY = (process.stdout as unknown as { isTTY?: boolean }).isTTY;
  try {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    const box = renderReasoningBox('isi thought berwarna', 60);
    assert.ok(box.includes('\u001b[32m'), 'garis box memakai hijau ANSI 32');
    assert.ok(box.includes('\u001b[90m'), 'isi thought memakai abu-abu ANSI 90');
  } finally {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: origIsTTY,
      configurable: true,
    });
  }
});

test('ReasoningPanel: box terbuka saat berpikir (tanpa garis bawah), tertutup saat finish', () => {
  const live: string[] = [];
  const panel = new ReasoningPanel({
    onLive: (line) => live.push(line),
    width: () => 60,
  });

  panel.feed('baris satu pemikiran\n');
  let shown = stripLive(live);
  assert.ok(shown.includes('┌─Ruko'), 'garis atas sudah tercetak saat berpikir');
  assert.ok(shown.includes('baris satu pemikiran'), 'isi sudah terlihat saat berpikir');
  assert.ok(!shown.includes('└'), 'TIDAK ada garis bawah selama masih berpikir');

  panel.feed('baris dua pemikiran\n');
  const summary = panel.finish();
  shown = stripLive(live);
  assert.ok(shown.includes('└'), 'garis bawah dicetak saat segmen selesai');
  assert.ok(shown.includes('┘'), 'sudut penutup ada');
  assert.ok(shown.includes('Thought for'), 'footer waktu ada di dalam box');
  assert.ok(summary !== null && stripAnsi(summary).includes('┌─Ruko'), 'finish mengembalikan teks box');
});

test('ReasoningPanel: tag <thought> tidak tercetak saat streaming', () => {
  const live: string[] = [];
  const panel = new ReasoningPanel({
    onLive: (line) => live.push(line),
    width: () => 60,
  });

  // Feed langsung (jalur onThought native): tag literal harus dihapus.
  panel.feed('<thought>rahasia streaming</thought>\n');
  panel.finish();
  const shown = stripLive(live);
  assert.ok(shown.includes('rahasia streaming'), 'isi thought tampil');
  assert.ok(!shown.includes('<thought>'), 'tag pembuka tidak tercetak');
  assert.ok(!shown.includes('</thought>'), 'tag penutup tidak tercetak');
});

test('ReasoningPanel: finishSegment menutup box, segmen berikut buka box baru', () => {
  const live: string[] = [];
  const panel = new ReasoningPanel({
    onLive: (line) => live.push(line),
    width: () => 60,
  });

  panel.feed('segmen pertama\n');
  panel.finishSegment();
  let shown = stripLive(live);
  assert.ok(shown.includes('└'), 'segmen pertama ditutup garis bawah');

  panel.feed('segmen kedua\n');
  panel.finish();
  shown = stripLive(live);
  assert.equal(
    (shown.match(/┌─Ruko/g) ?? []).length,
    2,
    'segmen kedua membuka box baru',
  );
  assert.equal((shown.match(/└/g) ?? []).length, 2, 'kedua box tertutup');
});

test('ReasoningPanel: toggle setelah finish me-render ulang box via onPermanent', () => {
  const live: string[] = [];
  const permanent: string[] = [];
  let mode: 'collapsed' | 'expanded' = 'collapsed';
  const panel = new ReasoningPanel({
    onLive: (line) => live.push(line),
    onPermanent: (line) => permanent.push(line),
    getMode: () => mode,
    width: () => 60,
  });

  panel.feed('baris satu\nbaris dua\nbaris tiga\nbaris empat\nbaris lima\n');
  panel.finish();
  assert.equal(permanent.length, 0, 'finish TIDAK me-render ulang via onPermanent (box sudah di layar)');

  mode = 'expanded';
  panel.toggle('expanded');
  assert.equal(permanent.length, 1, 'toggle expanded me-render ulang box penuh');
  assert.ok(permanent[0].includes('baris lima'), 'box expanded memuat semua baris');
  assert.ok(permanent[0].includes('┌─Ruko'), 'box expanded bergaris Ruko');

  mode = 'collapsed';
  panel.toggle('collapsed');
  assert.equal(permanent.length, 2, 'toggle collapsed me-render ulang box ringkas');
  assert.ok(permanent[1].includes('┌─Ruko'), 'box ringkas tetap box Ruko');
  assert.ok(permanent[1].includes('baris lagi'), 'box ringkas merangkum sisa baris');
  assert.ok(!permanent[1].includes('baris lima'), 'box ringkas memotong baris akhir');
});
