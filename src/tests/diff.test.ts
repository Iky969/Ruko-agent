import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffLines, renderFileDiff, splitLines } from '../core/diff.js';
import { stripAnsi } from '../core/ui.js';

test('splitLines drops the trailing-newline artifact', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a'), ['a']);
});

test('diffLines marks add/del/eq correctly', () => {
  const ops = diffLines(['a', 'b', 'c'], ['a', 'x', 'c']);
  assert.deepEqual(
    ops.map((o) => `${o.type}:${o.line}`),
    ['eq:a', 'del:b', 'add:x', 'eq:c'],
  );
});

test('diffLines handles pure insert and pure delete', () => {
  assert.deepEqual(diffLines([], ['a']).map((o) => o.type), ['add']);
  assert.deepEqual(diffLines(['a'], []).map((o) => o.type), ['del']);
  assert.deepEqual(diffLines(['a'], ['a']).map((o) => o.type), ['eq']);
});

test('renderFileDiff shows changed lines with +/- markers', () => {
  const out = stripAnsi(renderFileDiff('f.txt', 'l1\nl2\nl3\n', 'l1\nL2\nl3\n'));
  assert.ok(out.includes('- l2'));
  assert.ok(out.includes('+ L2'));
  assert.ok(out.includes('  l1'), 'context line kept');
});

test('renderFileDiff collapses far-away unchanged regions', () => {
  const oldText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
  const newText = oldText.replace('line 25', 'LINE 25');
  const out = stripAnsi(renderFileDiff('big.txt', oldText, newText));
  assert.ok(out.includes('- line 25'));
  assert.ok(out.includes('+ LINE 25'));
  assert.ok(out.includes('tidak berubah'), 'should collapse the long middle');
  assert.ok(out.split('\n').length < 20, 'rendered diff must stay small');
});
