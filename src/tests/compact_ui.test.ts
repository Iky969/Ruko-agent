import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStatusBar, stripAnsi, WorkflowTree } from '../core/ui.js';
import { renderFileDiff } from '../core/diff.js';

test('Item 5: WorkflowTree compact mode formats actions into single-line format without tree characters', () => {
  const output: string[] = [];
  const tree = new WorkflowTree((line) => output.push(line), { compact: true });

  tree.startStep('Mulai langkah 1');
  tree.log('🟢 Edit(src/core/loop.ts)');
  tree.log('🟢 Read(package.json)');
  tree.log('🟢 Search(parseCliArgs)');
  tree.log('🟢 Bash(npm test)');
  tree.finish('Tuntas');

  const plain = output.map(stripAnsi);

  // Invariant 1: Tree characters that break on narrow mobile terminals must NOT be present
  for (const line of plain) {
    assert.ok(!line.includes('├──'), `Must not contain ├──: "${line}"`);
    assert.ok(!line.startsWith('│'), `Must not contain tree vertical line │: "${line}"`);
    assert.ok(!line.startsWith('┌─'), `Must not contain ┌─: "${line}"`);
    assert.ok(!line.startsWith('└─'), `Must not contain └─: "${line}"`);
  }

  // Invariant 2: Format matches single-line specifications
  assert.equal(plain[0], '[1] ✏️ Edit src/core/loop.ts');
  assert.equal(plain[1], '[2] 📖 Read package.json');
  assert.equal(plain[2], '[3] 🔎 Mencari parseCliArgs');
  assert.equal(plain[3], '[4] 🟢 npm test');
  assert.ok(plain[4].includes('Tuntas'));
});

test('Item 5: compact diff omits boilerplate "... baris tidak berubah ..." and displays only delta changes', () => {
  const oldText = Array.from({ length: 60 }, (_, i) => `baris ${i}`).join('\n');
  const newText = oldText.replace('baris 30', 'BARIS 30 TERBARU');

  // Full diff (default): includes boilerplate
  const fullDiff = stripAnsi(renderFileDiff('test.txt', oldText, newText));
  assert.ok(fullDiff.includes('tidak berubah'));

  // Compact diff (Item 5): removes boilerplate, only shows delta changes
  const compactDiff = stripAnsi(renderFileDiff('test.txt', oldText, newText, { compact: true }));
  assert.ok(!compactDiff.includes('tidak berubah'), 'Compact diff must not contain boilerplate text');
  assert.ok(compactDiff.includes('- baris 30'), 'Must contain deleted line');
  assert.ok(compactDiff.includes('+ BARIS 30 TERBARU'), 'Must contain added line');

  // Verify compact diff is concise
  const lines = compactDiff.split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'Compact diff should only contain the 2 delta lines');
});

test('Item 5: bottom status bar functionality is preserved', () => {
  const bar = buildStatusBar({
    width: 80,
    model: 'gemini-1.5-flash',
    usedChars: 1200,
    budgetChars: 30000,
    role: 'default',
    planMode: false,
    busy: false,
    pending: 0,
  });

  const plain = stripAnsi(bar);
  assert.ok(plain.includes('gemini-1.5-flash'), 'Status bar retains model name');
  assert.ok(plain.includes('%') || plain.includes('k'), 'Status bar retains context info');
});
