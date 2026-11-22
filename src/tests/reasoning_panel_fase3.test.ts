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

test('ReasoningPanel default COLLAPSED: box ringkas (bukan satu baris) tanpa Y tokens bila usage tidak tersedia', () => {
  const live: string[] = [];
  const permanent: string[] = [];
  const panel = new ReasoningPanel({
    onLive: (line) => live.push(line),
    onPermanent: (line) => permanent.push(line),
    getTokens: () => null,
  });

  panel.feed('menganalisis struktur kode\n');
  panel.feed('memeriksa loop detector\n');
  const summary = panel.finish();

  assert.ok(summary !== null, 'finish mengembalikan teks box');
  const plain = summary!.replace(/\u001b\[\d+m/g, '');
  assert.ok(plain.startsWith('┌─Ruko'), 'box ringkas tetap box Ruko');
  assert.ok(plain.includes('Thought for'), 'footer waktu ada di dalam box');
  assert.ok(!plain.includes('tokens'), 'Y tokens TIDAK dicetak bila usage API null');
  assert.equal(permanent.length, 0, 'finish TIDAK me-render ulang via onPermanent — box sudah di layar dari streaming');

  // Setiap segmen (<thought> berakhir) membuka box sendiri.
  panel.start();
  panel.feed('segmen kedua\n');
  panel.finish();
  const shown = live.join('').replace(/\u001b\[\d+m/g, '').replace(/\r/g, '');
  assert.equal((shown.match(/┌─Ruko/g) ?? []).length, 2, 'segmen kedua membuka box kedua');
});

test('ReasoningPanel mencetak "Y tokens" HANYA bila API usage tersedia', () => {
  const panel = new ReasoningPanel({
    onPermanent: () => {},
    getTokens: () => 123,
  });

  panel.feed('analisis panjang tentang arsitektur\n');
  const summary = panel.finish();
  const plain = summary!.replace(/\u001b\[\d+m/g, '');
  assert.ok(plain.includes('Thought for'), 'footer waktu ada');
  assert.ok(plain.includes('(123 tokens)'), 'token usage API tercetak di footer');
});

test('ReasoningPanel mode expanded merender box terpisah dari log tool call', () => {
  const live: string[] = [];
  const panel = new ReasoningPanel({
    onLive: (line) => live.push(line),
    getMode: () => 'expanded',
  });

  panel.feed('langkah 1: baca file\nlangkah 2: analisis\n');
  panel.finish();

  const shown = live.join('').replace(/\u001b\[\d+m/g, '').replace(/\r/g, '');
  assert.ok(shown.includes('┌─Ruko'), 'box reasoning dengan border atas');
  assert.ok(shown.includes('└'), 'box ditutup border bawah');
  assert.ok(shown.includes('langkah 1'), 'isi reasoning ada di dalam box');
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
  assert.ok(collapsed!.includes('┌─Ruko'), 'awal: box ringkas Ruko');
  assert.equal(permanent.length, 0, 'finish tidak memakai onPermanent');

  mode = 'expanded';
  panel.toggle('expanded');
  assert.equal(permanent.length, 1, 'toggle me-render ulang permanen');
  assert.ok(permanent[0].includes('┌─Ruko'), 'toggle: box expanded');
  assert.ok(permanent[0].includes('bahan analisis utama'), 'isi reasoning dipertahankan');

  mode = 'collapsed';
  panel.toggle('collapsed');
  assert.equal(permanent.length, 2);
  assert.ok(permanent[1].includes('┌─Ruko'), 'toggle balik: box ringkas Ruko lagi');
  assert.ok(permanent[1].includes('baris lagi') || permanent[1].includes('bahan analisis utama'), 'box ringkas tetap menampilkan isi');
});

test('Buffer streaming: box terbuka per-baris dengan throttle waktu, sisa buffer di-flush saat finish', async () => {
  const live: string[] = [];
  const permanent: string[] = [];
  const panel = new ReasoningPanel({
    onLive: (line) => live.push(line),
    onPermanent: (line) => permanent.push(line),
    throttleMs: 50,
  });

  // Chunk pertama: garis atas box + baris parsial langsung tampil.
  panel.feed('potongan tanpa newline');
  let shown = live.join('').replace(/\u001b\[\d+m/g, '').replace(/\r/g, '');
  assert.ok(shown.includes('┌─Ruko'), 'garis atas box langsung tercetak');
  assert.ok(shown.includes('potongan tanpa newline'), 'baris parsial langsung tampil');
  assert.ok(!shown.includes('└'), 'box tetap terbuka selama berpikir');

  // Chunk berikutnya dalam jendela throttle: TIDAK render ulang (anti-banjir ANSI).
  panel.feed(' masih berlanjut');
  panel.feed(' dan bertambah lagi');
  shown = live.join('').replace(/\u001b\[\d+m/g, '').replace(/\r/g, '');
  assert.ok(!shown.includes('masih berlanjut'), 'throttle menahan render parsial berikutnya');

  await new Promise((r) => setTimeout(r, 60));
  panel.feed(' setelah jeda');
  shown = live.join('').replace(/\u001b\[\d+m/g, '').replace(/\r/g, '');
  assert.ok(shown.includes('masih berlanjut'), 'setelah throttle lewat, parsial diperbarui');
  assert.ok(shown.includes('dan bertambah lagi'), 'teks sebelumnya tidak hilang');
  assert.ok(live.some((l) => l.startsWith('\r')), 'render ulang parsial in-place (carriage return)');

  // Tail tanpa newline di-flush sebagai baris lengkap oleh finish, lalu box ditutup.
  const summary = panel.finish();
  shown = live.join('').replace(/\u001b\[\d+m/g, '').replace(/\r/g, '');
  assert.ok(shown.includes('└'), 'finish menutup box dengan garis bawah');
  assert.ok(summary!.includes('┌─Ruko'), 'ringkasan finish adalah teks box');
  assert.ok(summary!.includes('Thought for'), 'footer waktu ada di box');
  assert.equal(permanent.length, 0, 'finish tidak memakai onPermanent');
});

test('ReasoningPanel tanpa reasoning tidak menghasilkan apa pun', () => {
  const live: string[] = [];
  const permanent: string[] = [];
  const panel = new ReasoningPanel({
    onLive: (line) => live.push(line),
    onPermanent: (line) => permanent.push(line),
  });
  panel.start();
  assert.equal(panel.finish(), null);
  assert.equal(permanent.length, 0, 'tidak ada baris permanen tanpa reasoning');
  assert.equal(live.length, 0, 'tidak ada render live tanpa reasoning');
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

test('Agent: reasoning masuk box Ruko terpisah — isi tampil di box, tidak bocor ke reply', async () => {
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
  const plain = permanent.replace(/\u001b\[\d+m/g, '');
  // Box Ruko HANYA tampil di layar (bukan satu baris collapsed) — isi reasoning
  // terlihat di dalam box, tapi TIDAK di luar box dan TIDAK di reply.
  assert.ok(plain.includes('┌─Ruko'), 'panel reasoning di-render sebagai box Ruko');
  assert.ok(plain.includes('Thought for'), 'footer waktu ada di dalam box');
  assert.ok(plain.includes('RAHASIA_INTERNAL_PANEL_777'), 'isi reasoning tampil di dalam box');
  assert.ok(!plain.includes('<think>'), 'tag <think> tidak tercetak ke layar');
  assert.ok(!plain.includes('<thought>'), 'tag <thought> tidak tercetak ke layar');
  assert.ok(!plain.includes('tokens'), 'tanpa API usage: tidak ada klaim token');
  const beforeBox = plain.slice(0, plain.indexOf('┌─Ruko'));
  const afterBox = plain.slice(plain.lastIndexOf('┘') + 1);
  assert.ok(!beforeBox.includes('RAHASIA_INTERNAL_PANEL_777'), 'isi reasoning tidak muncul sebelum box');
  assert.ok(!afterBox.includes('RAHASIA_INTERNAL_PANEL_777'), 'isi reasoning tidak muncul setelah box');
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
  assert.ok(permanent.includes('┌─Ruko'), 'panel di-render sebagai box expanded');
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
    assert.ok(permanent.includes('┌─Ruko'), 'env memaksa box expanded');
  } finally {
    delete process.env.RUKO_SHOW_REASONING;
  }
});
