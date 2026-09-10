import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compressHistory } from '../core/compressor.js';
import { ContextMessage } from '../types.js';

function turn(role: ContextMessage['role'], text: string): ContextMessage {
  return { role, content: text, timestamp: '2026-01-01T00:00:00.000Z' };
}

function longTurn(role: ContextMessage['role'], i: number): ContextMessage {
  return turn(role, `pesan ke-${i} ` + 'x'.repeat(100));
}

test('compressHistory leaves short histories untouched', () => {
  const messages = [turn('user', 'a'), turn('assistant', 'b')];
  const opts = { targetChars: 500, keepLast: 2, maxPerMessageChars: 200 };
  assert.deepEqual(compressHistory(messages, opts), messages);
});

test('compressHistory folds old turns and protects the most recent ones', () => {
  const messages = Array.from({ length: 20 }, (_, i) =>
    longTurn(i % 2 === 0 ? 'user' : 'assistant', i),
  );
  const opts = { targetChars: 750, keepLast: 2, maxPerMessageChars: 200 };
  const result = compressHistory(messages, opts);

  assert.ok(result.length < messages.length, 'should fold some turns');
  assert.equal(result.at(-1), messages.at(-1), 'last turn preserved verbatim');
  assert.equal(result.at(-2), messages.at(-2), 'second-to-last turn preserved verbatim');
  assert.ok(result[0].content.startsWith('[compressed history'), 'digest message present');

  const total = result.reduce((n, m) => n + m.content.length, 0);
  assert.ok(total <= opts.targetChars, `fits the budget (${total})`);
});

test('compressHistory adapts excerpt size to reach the budget', () => {
  // 40 long turns cannot fit with 200-char excerpts — it must shrink further.
  const messages = Array.from({ length: 40 }, (_, i) => longTurn('user', i));
  const opts = { targetChars: 1100, keepLast: 2, maxPerMessageChars: 200 };
  const result = compressHistory(messages, opts);

  const total = result.reduce((n, m) => n + m.content.length, 0);
  assert.ok(total <= opts.targetChars, `fits the budget (${total})`);
  assert.ok(result.length < messages.length, 'should fold turns');
  assert.equal(result.at(-1), messages.at(-1));
  assert.equal(result.at(-2), messages.at(-2));
});

test('compressHistory gives up when folding cannot save space', () => {
  const short = Array.from({ length: 3 }, (_, i) => turn('user', `aa${i}`));
  const messages = [...short, turn('assistant', 'bb')];
  const opts = { targetChars: 10, keepLast: 2, maxPerMessageChars: 200 };
  assert.deepEqual(compressHistory(messages, opts), messages);
});