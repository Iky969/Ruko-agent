import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import { runToolCall, setWorkspaceRoot } from '../agent/tools.js';
import {
  countDiffLines,
  formatFileMutationLogLine,
  isFileMutationLogLine,
  parseFileMutationLogLine,
  renderMutationSummary,
  stripMarker,
  DIFF_TOGGLE_HINT,
} from '../core/diffui.js';
import { WorkflowTree, stripAnsi } from '../core/ui.js';
import { LineEditor } from '../core/tui.js';
import { EventEmitter } from 'node:events';
import type { ReadStream, WriteStream } from 'node:tty';

// ============================================================================
// Fase 4: Diff ringkas untuk write_file, edit_file, patch_file
// ============================================================================

const testWorkspace = mkdtempSync(join(tmpdir(), 'ruko-ws-df4-'));
setWorkspaceRoot(testWorkspace);
process.env.RUKO_UNDO_DIR = mkdtempSync(join(tmpdir(), 'ruko-undo-df4-'));
after(() => {
  setWorkspaceRoot(null);
  rmSync(testWorkspace, { recursive: true, force: true });
  rmSync(process.env.RUKO_UNDO_DIR!, { recursive: true, force: true });
  delete process.env.RUKO_UNDO_DIR;
});

/** Menghitung +/- aktual dari render diff expanded (strip ANSI). */
function actualDiffCounts(oldText: string, newText: string): { plus: number; minus: number } {
  const expanded = renderMutationSummary({
    tool: 'edit_file',
    fileLabel: 'x.ts',
    stats: countDiffLines(oldText, newText),
    mode: 'expanded',
    oldText,
    newText,
  });
  let plus = 0;
  let minus = 0;
  for (const l of stripAnsi(expanded).split('\n').slice(1)) {
    if (l.startsWith('+ ')) plus += 1;
    else if (l.startsWith('- ')) minus += 1;
  }
  return { plus, minus };
}

test('countDiffLines: angka N/M selalu cocok dengan baris +/- pada diff aktual', () => {
  const cases: Array<[string, string]> = [
    ['alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\n'], // 1 ganti
    ['satu\n', 'satu\ndua\ntiga\n'], // 2 tambah
    ['satu\ndua\ntiga\n', 'tiga\n'], // 2 hapus
    ['a\nb\nc\nd\n', 'x\nb\ny\nd\n'], // 2 ganti terpisah
    ['', 'baru\nfile\n'], // file baru
    ['sama\n', 'sama\n'], // tanpa perubahan
  ];
  for (const [oldText, newText] of cases) {
    const stats = countDiffLines(oldText, newText);
    const actual = actualDiffCounts(oldText, newText);
    assert.equal(stats.added, actual.plus, `added harus cocok diff untuk: ${JSON.stringify(oldText)} -> ${JSON.stringify(newText)}`);
    assert.equal(stats.removed, actual.minus, `removed harus cocok diff untuk: ${JSON.stringify(oldText)} -> ${JSON.stringify(newText)}`);
  }
});

test('renderMutationSummary: format `✍️ <tool> <file> +N -M Xs` dengan hint ctrl+d', () => {
  const line = renderMutationSummary({
    tool: 'edit_file',
    fileLabel: 'src/a.ts',
    stats: { added: 3, removed: 1 },
    durationMs: 400,
  });
  const plain = stripAnsi(line);
  assert.ok(plain.startsWith('✍️ edit_file src/a.ts'), 'diawali marker ✍️ + tool + file');
  assert.ok(plain.includes('+3'), 'angka +N ada');
  assert.ok(plain.includes('-1'), 'angka -M ada');
  assert.ok(plain.includes('0.4s'), 'durasi Xs ada (400ms -> 0.4s, format Xs)');
  assert.ok(plain.includes(DIFF_TOGGLE_HINT), 'hint shortcut ctrl+d ada');
  // Warna: +3 hijau (32), -1 merah (31) saat TTY; non-TTY plain (wrap() auto-off).
  if (process.stdout.isTTY && !process.env.NO_COLOR) {
    assert.ok(line.includes('\u001b[32m+3'), '+N diwarnai hijau');
    assert.ok(line.includes('\u001b[31m-1'), '-M diwarnai merah');
  }
});

test('formatFileMutationLogLine: payload ter-enkode bisa di-parse balik utuh', () => {
  const oldText = 'l1\nl2\nl3\n';
  const newText = 'l1\nL2\nl3\nl4\n';
  const line = formatFileMutationLogLine({
    tool: 'patch_file',
    fileLabel: 'p.txt',
    oldText,
    newText,
  });
  assert.ok(isFileMutationLogLine(line), 'baris dikenali parser');
  const info = parseFileMutationLogLine(line)!;
  assert.equal(info.tool, 'patch_file');
  assert.equal(info.fileLabel, 'p.txt');
  assert.equal(info.oldText, oldText);
  assert.equal(info.newText, newText);
  assert.equal(info.added, 2);
  assert.equal(info.removed, 1);
  assert.ok(!stripMarker(line).includes('\u000c'), 'marker di-strip dari tampilan');
  assert.ok(stripAnsi(info.summary).includes('✍️ patch_file p.txt'), 'bentuk tampilan collapsed ada');
});

test('Baris log biasa / isi file yang memuat emoji ✍️ TIDAK dikenali sebagai log mutasi', () => {
  assert.equal(isFileMutationLogLine('teks biasa'), false);
  assert.equal(isFileMutationLogLine('🟢 Edit(src/a.ts)'), false);
  // Isi berkas yang kebetulan memuat ✍️ tapi tanpa marker \f -> bukan log mutasi.
  assert.equal(isFileMutationLogLine('✍️ edit_file palsu   +1 -1   0.1s'), false);
});

test('write_file menghasilkan log ringkasan; angka N/M cocok dengan diff file baru', async () => {
  const abs = join(testWorkspace, 'df4-new.txt');
  const logs: string[] = [];
  const content = 'satu\ndua\ntiga\n';
  await runToolCall({ tool: 'write_file', path: abs, content }, { onLog: (l) => logs.push(l) });
  assert.equal(readFileSync(abs, 'utf8'), content);

  const mutLine = logs.find((l) => isFileMutationLogLine(l));
  assert.ok(mutLine, 'log mutasi berkas ada');
  const info = parseFileMutationLogLine(mutLine!)!;
  assert.equal(info.tool, 'write_file');
  assert.equal(info.added, 3, 'file baru 3 baris = +3');
  assert.equal(info.removed, 0, 'file baru removed = 0');
  const plain = stripAnsi(stripMarker(mutLine!));
  assert.ok(plain.includes('+3'), 'ringkasan menampilkan +3');
  assert.ok(plain.includes('-0'), 'ringkasan menampilkan -0');
  assert.ok(plain.includes(DIFF_TOGGLE_HINT), 'hint ctrl+d tampil saat collapsed');
});

test('edit_file: angka pada ringkasan cocok dengan baris +/- diff aktual (wajib Fase 4)', async () => {
  const abs = join(testWorkspace, 'df4-edit.txt');
  writeFileSync(abs, 'alpha\nbeta\ngamma\n', 'utf8');
  const logs: string[] = [];
  const result = await runToolCall(
    { tool: 'edit_file', path: abs, content: 'alpha\nBETA\ngamma\ndelta\n' },
    { onLog: (l) => logs.push(l) },
  );
  assert.ok((JSON.parse(result) as { ok: boolean }).ok);

  const mutLine = logs.find((l) => isFileMutationLogLine(l))!;
  assert.ok(mutLine, 'log mutasi ada');
  const info = parseFileMutationLogLine(mutLine)!;

  // Bandingkan dengan diff aktual dari payload (render expanded).
  const expanded = renderMutationSummary({
    tool: info.tool,
    fileLabel: info.fileLabel,
    stats: { added: info.added, removed: info.removed },
    mode: 'expanded',
    oldText: info.oldText,
    newText: info.newText,
  });
  const body = stripAnsi(expanded).split('\n').slice(1);
  let plus = 0;
  let minus = 0;
  for (const l of body) {
    if (l.startsWith('+ ')) plus += 1;
    else if (l.startsWith('- ')) minus += 1;
  }
  assert.equal(info.added, plus, 'N pada ringkasan = baris + di diff aktual');
  assert.equal(info.removed, minus, 'M pada ringkasan = baris - di diff aktual');
  assert.equal(info.added, 2); // +BETA, +delta
  assert.equal(info.removed, 1); // -beta
  assert.ok(stripAnsi(expanded).includes('- beta'));
  assert.ok(stripAnsi(expanded).includes('+ BETA'));
});

test('patch_file: log ringkasan memakai nama tool patch_file dan angka cocok', async () => {
  const abs = join(testWorkspace, 'df4-patch.txt');
  writeFileSync(abs, 'halo dunia\nbaris dua\n', 'utf8');
  const logs: string[] = [];
  await runToolCall(
    { tool: 'patch_file', path: abs, oldText: 'halo dunia', newText: 'hai dunia' },
    { onLog: (l) => logs.push(l) },
  );
  const mutLine = logs.find((l) => isFileMutationLogLine(l))!;
  assert.ok(mutLine, 'log mutasi ada');
  const info = parseFileMutationLogLine(mutLine)!;
  assert.equal(info.tool, 'patch_file');
  assert.equal(info.added, 1);
  assert.equal(info.removed, 1);
});

test('edit_file tanpa perubahan tetap no-op (tidak ada log mutasi)', async () => {
  const abs = join(testWorkspace, 'df4-same.txt');
  writeFileSync(abs, 'x\n', 'utf8');
  const logs: string[] = [];
  await runToolCall({ tool: 'edit_file', path: abs, content: 'x\n' }, { onLog: (l) => logs.push(l) });
  assert.ok(logs.some((l) => stripAnsi(l).includes('🟡')), 'log tidak-ada-perubahan tetap ada');
  assert.ok(!logs.some((l) => isFileMutationLogLine(l)), 'tanpa perubahan = tanpa ringkasan mutasi');
});

test('WorkflowTree: baris mutasi masuk detail branch, tidak menimpa baris tool', () => {
  const out: string[] = [];
  const tree = new WorkflowTree((l) => out.push(l), { branch: true });
  tree.startStep('langkah');
  tree.beginAction();
  tree.log('🟢 Edit(src/a.ts)');
  tree.log(formatFileMutationLogLine({
    tool: 'edit_file',
    fileLabel: 'src/a.ts',
    oldText: 'a\n',
    newText: 'a\nb\n',
  }));
  tree.completeAction('🟢 Edit(src/a.ts)', 120);
  tree.finish();

  const plain = out.map((l) => stripAnsi(l));
  // Baris action terformat oleh formatActionLogLine: `├── [1] ✏️ Edit src/a.ts (0.1s)`
  const actionLine = plain.find((l) => l.includes('├──') && l.includes('Edit src/a.ts'));
  assert.ok(actionLine, 'baris action tool tetap ada');
  const summaryLine = plain.find((l) => l.includes('✍️ edit_file src/a.ts'));
  assert.ok(summaryLine, 'ringkasan ✍️ ada sebagai detail');
  assert.ok(summaryLine!.includes('+1 -0'), 'ringkasan memuat angka N/M');
  assert.ok(summaryLine!.includes(DIFF_TOGGLE_HINT), 'hint ctrl+d di baris detail');
  // Baris detail ada SETELAH baris action (di bawah branch).
  assert.ok(plain.indexOf(summaryLine!) > plain.indexOf(actionLine!));
});

// ============================================================================
// Ctrl+D di LineEditor — tidak menimpa Ctrl+O (activity tray) / Ctrl+R
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

test('Ctrl+D (\\u0004) saat ambient memicu onToggleDiffDetail, bukan onToggleTray/onToggleReasoning', () => {
  const { editor, input } = makeEditor();
  let trayToggles = 0;
  let reasoningToggles = 0;
  let diffToggles = 0;
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
    onToggleDiffDetail: () => {
      diffToggles += 1;
    },
  });
  input.send('\u0004\u0004\u0004');
  assert.equal(diffToggles, 3, 'setiap Ctrl+D men-toggle detail diff');
  assert.equal(trayToggles, 0, 'Ctrl+D tidak menyentuh activity tray (Ctrl+O)');
  assert.equal(reasoningToggles, 0, 'Ctrl+D tidak menyentuh panel reasoning (Ctrl+R)');

  // Ctrl+O tetap jalur tray; Ctrl+R tetap jalur reasoning.
  input.send('\u000f\u0012');
  assert.equal(trayToggles, 1);
  assert.equal(reasoningToggles, 1);
  assert.equal(diffToggles, 3);

  input.send('\u0003');
  editor.stopAmbient();
});

test('Ctrl+D saat readLine biasa juga ter-rute ke onToggleDiffDetail', async () => {
  const { editor, input } = makeEditor();
  let diffToggles = 0;
  const line = editor.readLine({
    prompt: '› ',
    onToggleDiffDetail: () => {
      diffToggles += 1;
    },
  });
  input.send('\u0004');
  input.send('halo\r');
  assert.equal(await line, 'halo');
  assert.equal(diffToggles, 1);
});
