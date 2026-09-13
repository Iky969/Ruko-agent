import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatTerminalMarkdown,
  inferStepDescription,
  stripAnsi,
  WorkflowTree,
} from '../core/ui.js';

test('formatTerminalMarkdown formats **bold** as bold cyan and strips asterisks', () => {
  const input = 'Ini adalah **fitur penting** dari Ruko-agent.';
  const colored = formatTerminalMarkdown(input, true);
  assert.ok(colored.includes('\u001b[1;36mfitur penting\u001b[0m'), 'must contain bold cyan escape code');
  assert.ok(!colored.includes('**'), 'raw asterisks must be removed');

  // When colors are disabled, asterisks are still cleanly removed
  const plain = formatTerminalMarkdown(input, false);
  assert.equal(plain, 'Ini adalah fitur penting dari Ruko-agent.');
});

test('formatTerminalMarkdown formats `inline code` as yellow and strips backticks', () => {
  const input = 'Gunakan perintah `npm test` untuk menguji.';
  const colored = formatTerminalMarkdown(input, true);
  assert.ok(colored.includes('\u001b[33mnpm test\u001b[0m'), 'must contain yellow escape code');
  assert.ok(!colored.includes('`'), 'raw backticks must be removed');

  // When colors are disabled, backticks are cleanly removed
  const plain = formatTerminalMarkdown(input, false);
  assert.equal(plain, 'Gunakan perintah npm test untuk menguji.');
});

test('formatTerminalMarkdown preserves fenced code blocks without inline transformations', () => {
  const input = [
    'Penjelasan di luar blok:',
    '```typescript',
    'const x = **not_bold**;',
    'const y = `template_literal`;',
    '```',
    'Penutup dengan **bold** di luar.',
  ].join('\n');

  const formatted = formatTerminalMarkdown(input, true);
  assert.ok(formatted.includes('const x = **not_bold**;'), 'code fence line 1 preserved');
  assert.ok(formatted.includes('const y = `template_literal`;'), 'code fence line 2 preserved');
  assert.ok(formatted.includes('\u001b[1;36mbold\u001b[0m'), 'outside bold formatted');
});

test('formatTerminalMarkdown inserts vertical spacing before bold section headers', () => {
  const input = [
    'Ringkasan pengerjaan tugas selesai.',
    '**Fitur yang Ditambahkan:**',
    '- **WorkflowTree:** Menampilkan hierarki langkah.',
  ].join('\n');

  const formatted = formatTerminalMarkdown(input, false);
  const lines = formatted.split('\n');
  assert.equal(lines[0], 'Ringkasan pengerjaan tugas selesai.');
  assert.equal(lines[1], '', 'empty line spacing before bold section');
  assert.equal(lines[2], 'Fitur yang Ditambahkan:');
  assert.equal(lines[3], '- WorkflowTree: Menampilkan hierarki langkah.');
});

test('inferStepDescription returns contextual descriptions based on tool calls', () => {
  // Read tools
  assert.equal(
    inferStepDescription([{ tool: 'read_file', path: 'p.json' }], 1),
    'Membaca konfigurasi & struktur berkas',
  );
  assert.equal(
    inferStepDescription([{ tool: 'glob', pattern: '**/*.ts' }], 1),
    'Membaca konfigurasi & struktur berkas',
  );

  // Write tools
  assert.equal(
    inferStepDescription([{ tool: 'edit_file', path: 'ui.ts' }], 2),
    'Modifikasi berkas proyek',
  );
  assert.equal(
    inferStepDescription([{ tool: 'patch_file', path: 'ui.ts' }], 2),
    'Modifikasi berkas proyek',
  );

  // Shell exec
  assert.equal(
    inferStepDescription([{ tool: 'exec', command: 'npm test' }], 3),
    'Menjalankan perintah shell',
  );

  // Memory
  assert.equal(
    inferStepDescription([{ tool: 'remember', content: 'note' }], 4),
    'Menyimpan catatan ke persistent memory',
  );

  // Mixed inspection and modification
  assert.equal(
    inferStepDescription(
      [{ tool: 'read_file', path: 'a.ts' }, { tool: 'write_file', path: 'b.ts' }],
      5,
    ),
    'Pemeriksaan dan modifikasi berkas proyek',
  );
});

test('WorkflowTree builds clean unicode box tree with status badges and indents logs', () => {
  const output: string[] = [];
  const tree = new WorkflowTree((line) => output.push(line));

  // Step 1: initial step
  tree.startStep('Membaca konfigurasi & struktur');
  assert.equal(tree.currentStep, 1);
  assert.equal(tree.isTreeActive, true);

  // Log tools in step 1
  tree.log('🟢 Read(package.json)');
  tree.log('🟢 Read(src/index.ts)');

  // Step 2: transition step
  tree.startStep('Modifikasi berkas');
  assert.equal(tree.currentStep, 2);

  // Log tools with multiline diff
  tree.log('🟡 Edit(src/core/ui.ts)\n--- a/ui.ts\n+++ b/ui.ts');

  // Error log
  tree.error('Gagal membaca cache');

  // Finish
  tree.finish('Semua langkah tuntas');
  assert.equal(tree.isTreeActive, false);

  const plainOutput = output.map(stripAnsi);

  // Check box drawing characters and status badges
  assert.ok(plainOutput[0].startsWith('┌─'), 'first step starts with ┌─');
  assert.ok(plainOutput[0].includes('● [Langkah 1]'), 'has step 1 badge');
  assert.ok(plainOutput[0].includes('Membaca konfigurasi & struktur'));

  assert.equal(plainOutput[1], '│  🟢 Read(package.json)');
  assert.equal(plainOutput[2], '│  🟢 Read(src/index.ts)');

  assert.ok(plainOutput[3].startsWith('├─'), 'second step starts with ├─');
  assert.ok(plainOutput[3].includes('● [Langkah 2]'), 'has step 2 badge');
  assert.ok(plainOutput[3].includes('Modifikasi berkas'));

  assert.equal(plainOutput[4], '│  🟡 Edit(src/core/ui.ts)');
  assert.equal(plainOutput[5], '│  --- a/ui.ts');
  assert.equal(plainOutput[6], '│  +++ b/ui.ts');

  assert.ok(plainOutput[7].includes('│  ✖ [Gagal] Gagal membaca cache'));

  assert.ok(plainOutput[8].startsWith('└─'), 'finish step starts with └─');
  assert.ok(plainOutput[8].includes('✓ [Selesai] Semua langkah tuntas'));
});
