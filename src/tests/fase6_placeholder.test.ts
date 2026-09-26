import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { ReadStream, WriteStream } from 'node:tty';
import { LineEditor } from '../core/tui.js';
import { renderStatusPanel, STATUS_PANEL_HINT, stripAnsi } from '../core/ui.js';

// ============================================================================
// Fase 6: Placeholder input field & Lokalisasi (feedback.txt)
// - Teks default placeholder Bahasa Indonesia: "/? untuk bantuan, tanya apa
//   saja..." (warna abu-abu/dim — diterapkan renderer via `dim()`).
// - Placeholder hilang TOTAL saat karakter pertama diketik, muncul KEMBALI
//   saat buffer input kosong (ketik ulang/backspace/Ctrl+U).
// ============================================================================

/** Kontrak teks Fase 6 — dipakai STATUS_PANEL_HINT (ui.ts) dan PROMPT_HINT (loop.ts). */
const PLACEHOLDER_ID = '/? untuk bantuan, tanya apa saja...';

/** Minimal TTY-ish stdin: we drive it by emitting 'data' events. */
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

test('Fase 6: STATUS_PANEL_HINT default memakai teks Indonesia', () => {
  assert.equal(STATUS_PANEL_HINT, PLACEHOLDER_ID);
});

test('Fase 6: status panel menampilkan hint Indonesia saat hint kustom tidak diberikan', () => {
  const panel = renderStatusPanel({ width: 100, model: 'gemini-3.8-flash' })
    .split('\n')
    .map(stripAnsi);
  assert.ok(panel.some((r) => r.includes(PLACEHOLDER_ID)), 'hint Indonesia tampil di panel');
  assert.ok(!panel.some((r) => r.includes('ask anything')), 'teks Inggris lama tidak lagi dipakai');
});

test('Fase 6: placeholder hilang total saat karakter pertama diketik, muncul kembali saat buffer kosong', async () => {
  const { editor, input, output } = makeEditor();
  const line = editor.readLine({ prompt: '› ', placeholder: STATUS_PANEL_HINT });

  // State awal: buffer kosong → placeholder tampil.
  assert.ok(output.data.includes(PLACEHOLDER_ID), 'placeholder muncul saat buffer kosong');

  // Karakter pertama → placeholder hilang TOTAL dari frame berikutnya.
  output.data = '';
  input.send('h');
  assert.ok(!output.data.includes(PLACEHOLDER_ID), 'placeholder hilang setelah karakter pertama');
  assert.ok(output.data.includes('h'), 'teks yang diketik ter-echo');

  // Backspace sampai buffer kosong lagi → placeholder muncul KEMBALI.
  output.data = '';
  input.send('\u007f');
  assert.ok(output.data.includes(PLACEHOLDER_ID), 'placeholder muncul kembali saat buffer kosong');

  // Ctrl+U (clear line) dari buffer berisi → kembali kosong → placeholder tampil.
  input.send('abc');
  output.data = '';
  input.send('\u0015');
  assert.ok(output.data.includes(PLACEHOLDER_ID), 'placeholder tampil setelah Ctrl+U mengosongkan buffer');

  input.send('\r');
  await line;
});

test('Fase 6: ambient input (saat AI bekerja) berperilaku sama — hilang saat mengetik, muncul saat kosong', () => {
  const { editor, input, output } = makeEditor();
  editor.startAmbient({
    prompt: '› ',
    placeholder: STATUS_PANEL_HINT,
    onSubmit: () => {},
    onInterrupt: () => {},
  });

  assert.ok(output.data.includes(PLACEHOLDER_ID), 'placeholder tampil di region ambient');

  input.send('tanya');
  output.data = '';
  assert.ok(!output.data.includes(PLACEHOLDER_ID), 'placeholder hilang saat buffer berisi');

  input.send('\u007f'.repeat(5));
  assert.ok(output.data.includes(PLACEHOLDER_ID), 'placeholder muncul kembali setelah buffer dikosongkan');

  editor.stopAmbient();
});
