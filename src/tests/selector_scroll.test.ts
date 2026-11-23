import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { ReadStream, WriteStream } from 'node:tty';
import { LineEditor, SelectorItem } from '../core/tui.js';
import { stripAnsi } from '../core/ui.js';

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

function makeModels(n: number): SelectorItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `model-${i + 1}`,
    label: `Model ${i + 1}`,
    description: `Deskripsi model ${i + 1}`,
  }));
}

/** The final selector frame only: re-renders erase the previous frame with
 * `\u001b[<n>A\r\u001b[0J`, so split on that sequence and keep the tail. */
function lastRender(output: FakeOutput): string {
  const parts = output.data.split(/\u001b\[\d+A\r\u001b\[0J/);
  return stripAnsi(parts[parts.length - 1]);
}

test('windowing: 150 item, render awal menunjukkan 1–20 dari 150', async () => {
  const { editor, input, output } = makeEditor();
  const promise = editor.askSelector({ title: 'Pilih Model', items: makeModels(150) });
  const rendered = stripAnsi(output.data);
  assert.ok(rendered.includes('1–20 dari 150'), 'header menunjukkan posisi 1–20 dari 150');
  assert.ok(rendered.includes('Model 1'), 'baris pertama terlihat');
  assert.ok(rendered.includes('Model 20'), 'baris ke-20 terlihat');
  assert.ok(!/Model 21(?!\d)/.test(rendered), 'baris ke-21 belum terlihat (di luar jendela)');
  input.send('\u001b');
  assert.equal(await promise, null);
});

test('navigasi: jendela mengikuti pilihan saat bergerak ke bawah', async () => {
  const { editor, input, output } = makeEditor();
  const promise = editor.askSelector({ title: 'Pilih Model', items: makeModels(150) });
  output.data = '';
  for (let i = 0; i < 25; i += 1) input.send('\u001b[B');
  const rendered = lastRender(output);
  assert.ok(rendered.includes('7–26 dari 150'), 'jendela bergeser mengikuti pilihan ke-26');
  assert.ok(/Model 26(?!\d)/.test(rendered), 'Model 26 terlihat di jendela baru');
  assert.ok(!/Model 5(?!\d)/.test(rendered), 'Model 5 sudah keluar dari jendela');
  input.send('\r');
  assert.equal(await promise, 'model-26');
});

test('bungkus: Arrow Up dari item pertama melompat ke item terakhir', async () => {
  const { editor, input, output } = makeEditor();
  const promise = editor.askSelector({ title: 'Pilih Model', items: makeModels(150) });
  output.data = '';
  input.send('\u001b[A');
  const rendered = lastRender(output);
  assert.ok(rendered.includes('131–150 dari 150'), 'jendela melompat ke akhir daftar');
  assert.ok(rendered.includes('Model 150'), 'item terakhir terlihat');
  input.send('\r');
  assert.equal(await promise, 'model-150');
});

test('pageSize: pageSize 5 membatasi jendela jadi 5 baris', async () => {
  const { editor, input, output } = makeEditor();
  const promise = editor.askSelector({ title: 'Pilih', items: makeModels(12), pageSize: 5 });
  const rendered = stripAnsi(output.data);
  assert.ok(rendered.includes('1–5 dari 12'), 'header menunjukkan 1–5 dari 12');
  assert.ok(rendered.includes('Model 5'), 'baris ke-5 terlihat');
  assert.ok(!/Model 6(?!\d)/.test(rendered), 'baris ke-6 belum terlihat');
  input.send('\u001b');
  assert.equal(await promise, null);
});

test('filter: ketik-untuk-filter mempersempit daftar, Enter memilih hasil', async () => {
  const { editor, input, output } = makeEditor();
  const items: SelectorItem[] = [
    { id: 'gpt-4o', label: 'gpt-4o', description: 'OpenAI' },
    { id: 'gpt-4-turbo', label: 'gpt-4-turbo', description: 'OpenAI' },
    { id: 'claude-3-5-sonnet', label: 'claude-3-5-sonnet', description: 'Anthropic' },
    { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash', description: 'Google' },
  ];
  const promise = editor.askSelector({ title: 'Pilih Model', items, filterable: true });
  output.data = '';
  input.send('gpt-4');
  const rendered = lastRender(output);
  assert.ok(rendered.includes('gpt-4o'), 'hasil filter memuat gpt-4o');
  assert.ok(rendered.includes('gpt-4-turbo'), 'hasil filter memuat gpt-4-turbo');
  assert.ok(!rendered.includes('claude-3-5-sonnet'), 'hasil filter menyembunyikan claude');
  assert.ok(!rendered.includes('gemini-2.0-flash'), 'hasil filter menyembunyikan gemini');
  input.send('\r');
  assert.equal(await promise, 'gpt-4o');
});

test('kosong: daftar kosong dirender tanpa crash, Esc membatalkan', async () => {
  const { editor, input, output } = makeEditor();
  const promise = editor.askSelector({ title: 'Pilih Model', items: [] });
  assert.ok(stripAnsi(output.data).includes('tidak ada pilihan'), 'pesan kosong ditampilkan');
  input.send('\u001b');
  assert.equal(await promise, null);
});

test('non-filterable: ketikan biasa diabaikan, navigasi tetap jalan', async () => {
  const { editor, input, output } = makeEditor();
  const promise = editor.askSelector({
    title: 'Pilih Mode',
    items: [
      { id: 'default', label: 'Default', description: 'Bawaan.' },
      { id: 'research', label: 'Research', description: 'Riset.' },
      { id: 'code', label: 'Code', description: 'Kode.' },
    ],
  });
  output.data = '';
  input.send('hello world 123 !@#');
  assert.equal(output.data, '', 'ketikan biasa diabaikan tanpa filter');
  input.send('\u001b[B');
  assert.ok(stripAnsi(output.data).includes('Riset.'), 'Arrow Down tetap menggerakkan pilihan');
  input.send('\r');
  assert.equal(await promise, 'research');
});
