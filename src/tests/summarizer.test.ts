import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractHighlights, summarizeLog } from '../core/summarizer.js';

test('summarizeLog keeps short logs untouched', () => {
  const log = 'hello world';
  const result = summarizeLog(log, 1000);
  assert.equal(result.truncated, false);
  assert.equal(result.summary, log);
  assert.equal(result.originalLength, log.length);
});

test('summarizeLog truncates long logs and keeps head + tail', () => {
  const log = Array.from({ length: 500 }, (_, i) => `line ${i} something`).join('\n');
  const result = summarizeLog(log, 1000);
  assert.equal(result.truncated, true);
  assert.ok(result.summary.length < 2000, `summary too long: ${result.summary.length}`);
  assert.ok(result.summary.startsWith('line 0'), 'summary should start at the head');
  assert.ok(result.summary.includes('TRUNCATED'), 'summary should contain the marker');
  assert.ok(result.summary.endsWith('line 499 something'), 'summary should end at the tail');
});

test('summarizeLog respects the 1000-char spec threshold', () => {
  const log = 'x'.repeat(1001);
  const result = summarizeLog(log);
  assert.equal(result.truncated, true);
});

test('extractHighlights finds error/warning lines', () => {
  const lines = extractHighlights('ok line\nERROR: boom\nwarning here\nfine', 8);
  assert.deepEqual(lines, ['ERROR: boom', 'warning here']);
});

test('extractHighlights caps the number of highlights', () => {
  const log = Array.from({ length: 20 }, () => 'ERROR something').join('\n');
  const lines = extractHighlights(log, 3);
  assert.equal(lines.length, 3);
});