import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReasoningPanel } from '../core/ui.js';
import { LineEditor } from '../core/tui.js';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';
import { ContextMessage, DEFAULT_CONFIG } from '../types.js';
import { EventEmitter } from 'node:events';
import type { ReadStream, WriteStream } from 'node:tty';

// ============================================================================
// Fase 3: Panel Reasoning/Thinking terpisah + buffer streaming
// ============================================================================

test('ReasoningPanel default COLLAPSED: satu baris "• Thought for Xs" tanpa Y tokens bila usage tidak tersedia', () => {
  const permanent: string[] = [];
  const panel = new ReasoningPanel({
    onPermanent: (line) => permanent.push(line),
    getTokens: () => null,
  });

  panel.feed('menganalisis struktur kode\n');
  panel.feed('memeriksa loop detector\n');
  const summary = panel.finish();

  assert.ok(summary !== null, 'finish mengembalikan baris permanen');
  const plain = summary!.replace(/\u001b\[\d+m/g, '');
  assert.match(plain, /^• Thought for \d+(?:\.\d+)?s$/, 'format collapsed: Thought for Xs');
  assert.ok(!plain.includes('tokens'), 'Y tokens TIDAK dicetak bila usage API null');
  assert.equal(permanent.length, 1, 'tepat satu baris permanen');

  // Setiap segmen (<thought> berakhir) menghasilkan baris sendiri.
  panel.start();
  panel.feed('segmen kedua\n');
  panel.finish();
  assert.equal(permanent.length, 2, 'segmen kedua menghasilkan baris kedua');
});

test('ReasoningPanel mencetak "Y tokens" HANYA bila API usage tersedia', () => {
  const permanent: string[] = [];
  const panel = new ReasoningPanel({
    onPermanent: (line) => permanent.push(line),
    getTokens: () => 123,
  });

  panel.feed('analisis panjang tentang arsitektur\n');
  const summary = panel.finish();
  const plain = summary!.replace(/\u001b\[\d+m/g, '');
  assert.match(plain, /^• Thought for \d+(?:\.\d+)?s \(123 tokens\)$/, 'format dengan tokens');
});

test('ReasoningPanel mode expanded merender box terpisah dari log tool call', () => {
  const permanent: string[] = [];
  const panel = new ReasoningPanel({
    onPermanent: (line) => permanent.push(line),
    getMode: () => 'expanded',
  });

  panel.feed('langkah 1: baca file\nlangkah 2: analisis\n');
  panel.finish();

  assert.equal(permanent.length, 1);
  const box = permanent[0];
  assert.ok(box.includes('┌─ Reasoning'), 'box reasoning dengan border atas');
  assert.ok(box.includes('└'), 'box ditutup border bawah');
  assert.ok(box.includes('langkah 1'), 'isi reasoning ada di dalam box');
});

test('Ctrl+R toggle: re-render permanen expanded setelah finish, isi konsisten', () => {
  const permanent: string[] = [];
  let mode: 'collapsed' | 'expanded' = 'collapsed';
  const panel = new ReasoningPanel({
    onPermanent: (line) => permanent.push(line),
    getMode: () => mode,
  });

  panel.feed('bahan analisis utama\n');
  const collapsed = panel.finish();
  assert.ok(collapsed!.includes('• Thought for'), 'awal: collapsed');

  mode = 'expanded';
  panel.toggle('expanded');
  assert.equal(permanent.length, 2, 'toggle me-render ulang permanen');
  assert.ok(permanent[1].includes('┌─ Reasoning'), 'toggle: box expanded');
  assert.ok(permanent[1].includes('bahan analisis utama'), 'isi reasoning dipertahankan');

  mode = 'collapsed';
  panel.toggle('collapsed');
  assert.equal(permanent.length, 3);
  assert.ok(permanent[2].includes('• Thought for'), 'toggle balik: collapsed lagi');
});

test('Buffer streaming: render per-baris selesai dengan throttle waktu, sisa buffer di-flush saat finish', async () => {
  const live: string[] = [];
  const permanent: string[] = [];
  const panel = new ReasoningPanel({
    onLive: (line) => live.push(line),
    onPermanent: (line) => permanent.push(line),
    throttleMs: 50,
  });

  // Chunk pertama: render langsung (supaya user tidak melihat layar kosong).
  panel.feed('potongan tanpa newline');
  assert.equal(live.length, 1, 'render live pertama langsung');

  // Chunk berikutnya dalam jendela throttle: TIDAK render ulang (anti-banjir ANSI).
  panel.feed(' masih berlanjut');
  panel.feed(' dan bertambah lagi');
  assert.equal(live.length, 1, 'throttle menahan render berikutnya');

  await new Promise((r) => setTimeout(r, 60));
  panel.feed(' setelah jeda');
  assert.equal(live.length, 2, 'setelah throttle lewat, render ulang');

  // Tail tanpa newline tetap di-flush permanen oleh finish (tidak hilang).
  const summary = panel.finish();
  assert.ok(summary!.includes('• Thought for'), 'ringkasan collapsed tetap keluar');
  assert.equal(permanent.length, 1);
  // Live line tidak menumpuk permanen: alamat sink live berbeda dari permanen.
  assert.ok(live.every((l) => l.startsWith('\r')), 'live render in-place (carriage return)');
});

test('ReasoningPanel tanpa reasoning tidak menghasilkan apa pun', () => {
  const permanent: string[] = [];
  const panel = new ReasoningPanel({ onPermanent: (line) => permanent.push(line) });
  panel.start();
  assert.equal(panel.finish(), null);
  assert.equal(permanent.length, 0, 'tidak ada baris permanen tanpa reasoning');
});

// ============================================================================
// Ctrl+R di LineEditor (ambient & readLine) — tidak menimpa Ctrl+O
// ============================================================================

class FakeInput extends EventEmitter {
  isTTY = true;
  rawMode = false;
  setRawMode(mode: boolean): void {
    this.rawMode = mode;
  }
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  send(keys: string): void {
    this.emit('data', keys);
  }
}

class FakeOutput {
  data = '';
  isTTY = true;
  columns = 80;
  write(text: string): boolean {
    this.data += text;
    return true;
  }
}

function makeEditor(): { editor: LineEditor; input: FakeInput; output: FakeOutput } {
  const input = new FakeInput();
  const output = new FakeOutput();
  const editor = new LineEditor(input as unknown as ReadStream, output as unknown as WriteStream);
  return { editor, input, output };
}

test('Ctrl+R (\\u0012) saat ambient memicu onToggleReasoning, TIDAK onToggleTray', () => {
  const { editor, input } = makeEditor();
  let trayToggles = 0;
  let reasoningToggles = 0;
  editor.startAmbient({
    prompt: '› ',
    statusLine: () => 'BAR',
    onSubmit: () => {},
    onInterrupt: () => {},
    onToggleTray: () => {
      trayToggles += 1;
    },
    onToggleReasoning: () => {
      reasoningToggles += 1;
    },
  });

  input.send('\u0012\u0012\u0012');
  assert.equal(reasoningToggles, 3, 'setiap Ctrl+R men-toggle panel reasoning');
  assert.equal(trayToggles, 0, 'Ctrl+R tidak boleh menyentuh activity tray (Ctrl+O)');

  // Ctrl+O tetap jalur tray.
  input.send('\u000f');
  assert.equal(trayToggles, 1);
  assert.equal(reasoningToggles, 3);

  input.send('\u0003');
  editor.stopAmbient();
});

test('Ctrl+R saat readLine biasa juga ter-rute ke onToggleReasoning', async () => {
  const { editor, input } = makeEditor();
  let reasoningToggles = 0;
  const line = editor.readLine({
    prompt: '› ',
    onToggleReasoning: () => {
      reasoningToggles += 1;
    },
  });
  input.send('\u0012');
  input.send('halo\r');
  assert.equal(await line, 'halo');
  assert.equal(reasoningToggles, 1);
});

// ============================================================================
// Integrasi Agent: panel terpisah dari log tool call, reasoning tidak bocor
// ============================================================================

class MockReasoningProvider implements LLMProvider {
  readonly name = 'mock-reasoning';
  readonly isConfigured = true;
  model = 'mock-model';
  lastFinishReason: string | null = 'stop';
  constructor(private readonly reply: string) {}
  setModel(model: string): void {
    this.model = model;
  }
  async chat(messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    options?.onThought?.('RAHASIA_INTERNAL_PANEL_777 alasan pertama\n');
    options?.onToken?.('<think>RAHASIA_INTERNAL_PANEL_777 alasan pertama</think>');
    options?.onToken?.('Jawaban akhir.');
    return this.reply;
  }
}

async function captureAgentStdout(fn: () => Promise<void>): Promise<string[]> {
  const writes: string[] = [];
  const origWrite = process.stdout.write;
  const origLog = console.log;
  process.stdout.write = ((chunk: any) => {
    writes.push(String(chunk));
    return true;
  }) as any;
  console.log = ((...args: any[]) => {
    writes.push(args.map(String).join(' ') + '\n');
  }) as any;
  try {
    await fn();
  } finally {
    process.stdout.write = origWrite;
    console.log = origLog;
  }
  return writes;
}

test('Agent: reasoning masuk panel terpisah — baris permanen "• Thought for", default collapsed, tidak bocor', async () => {
  const provider = new MockReasoningProvider(
    '<think>RAHASIA_INTERNAL_PANEL_777 alasan pertama</think>Jawaban akhir.',
  );
  const agent = new Agent(new Context({ ...DEFAULT_CONFIG }), provider, { ...DEFAULT_CONFIG });

  const writes = await captureAgentStdout(async () => {
    const reply = await agent.handleInstruction('jawab cepat');
    assert.ok(reply.includes('Jawaban akhir.'), 'jawaban akhir utuh');
    assert.ok(!reply.includes('RAHASIA_INTERNAL_PANEL_777'), 'reasoning tidak bocor ke reply');
  });

  const permanent = writes.filter((w) => !w.startsWith('\r')).join('');
  assert.ok(permanent.includes('• Thought for'), 'panel reasoning permanen: Thought for Xs');
  assert.ok(!permanent.includes('RAHASIA_INTERNAL_PANEL_777'), 'isi reasoning tidak bocor ke history (collapsed)');
  assert.ok(!permanent.includes('┌─ Reasoning'), 'default COLLAPSED: tidak ada box');
  assert.ok(!permanent.includes('tokens'), 'tanpa API usage: tidak ada klaim token');
});

test('Agent: Ctrl+R capture saat turn berjalan → finish me-render box expanded', async () => {
  const provider = new MockReasoningProvider(
    '<think>RAHASIA_INTERNAL_PANEL_777 alasan pertama</think>Jawaban akhir.',
  );
  const agent = new Agent(new Context({ ...DEFAULT_CONFIG }), provider, { ...DEFAULT_CONFIG });

  const writes = await captureAgentStdout(async () => {
    const turn = agent.handleInstruction('jawab dengan panel terbuka');
    // Toggle "saat model berpikir" — persis jalur Ctrl+R dari loop.ts.
    agent.toggleReasoningExpanded();
    await turn;
  });

  assert.ok(agent.isReasoningExpanded, 'state expand tersimpan di agent');
  const permanent = writes.filter((w) => !w.startsWith('\r')).join('');
  assert.ok(permanent.includes('┌─ Reasoning'), 'panel di-render sebagai box expanded');
  assert.ok(permanent.includes('RAHASIA_INTERNAL_PANEL_777'), 'isi reasoning tampil di box (user minta expand)');
});

test('Agent: RUKO_SHOW_REASONING=1 memaksa expanded tanpa Ctrl+R', async () => {
  process.env.RUKO_SHOW_REASONING = '1';
  const provider = new MockReasoningProvider(
    '<think>RAHASIA_INTERNAL_PANEL_777 alasan pertama</think>Jawaban akhir.',
  );
  const agent = new Agent(new Context({ ...DEFAULT_CONFIG }), provider, { ...DEFAULT_CONFIG });

  try {
    const writes = await captureAgentStdout(async () => {
      await agent.handleInstruction('jawab dengan env show reasoning');
    });
    const permanent = writes.filter((w) => !w.startsWith('\r')).join('');
    assert.ok(permanent.includes('┌─ Reasoning'), 'env memaksa box expanded');
  } finally {
    delete process.env.RUKO_SHOW_REASONING;
  }
});
