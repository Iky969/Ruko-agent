import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RevealFilter } from '../core/ui.js';

function runFeed(chunks: string[]): string {
  let out = '';
  const f = new RevealFilter((t) => {
    out += t;
  });
  for (const c of chunks) f.feed(c);
  f.end();
  return out;
}

test('reveal filter passes plain text through', () => {
  assert.equal(runFeed(['Hello ', 'world']), 'Hello world');
});

test('reveal filter hides complete tool blocks', () => {
  const text = runFeed(['Before\n', '```tool\n{"tool":"exec","command":"ls"}\n```\n', 'After']);
  assert.equal(text, 'Before\nAfter');
});

test('reveal filter hides tool blocks split across tiny chunks', () => {
  const full = 'X```tool\n{"tool":"exec","command":"pwd"}\n```Y';
  const chunks: string[] = [];
  for (let i = 0; i < full.length; i += 3) chunks.push(full.slice(i, i + 3));
  assert.equal(runFeed(chunks), 'XY');
});

test('reveal filter keeps ordinary code fences visible', () => {
  const out = runFeed(['See:\n', '```js\nconst a = 1;\n```', '\nDone']);
  assert.ok(out.includes('```js'));
  assert.ok(out.includes('const a = 1;'));
  assert.ok(out.includes('Done'));
});

test('reveal filter drops an unterminated tool block at end of stream', () => {
  const out = runFeed(['Hi\n```tool\n{"tool":"exec"']);
  assert.equal(out, 'Hi\n');
});
