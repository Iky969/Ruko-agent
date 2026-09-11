import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { ReadStream, WriteStream } from 'node:tty';
import { LineEditor, MenuItem } from '../core/tui.js';

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

test('placeholder shows only while the buffer is empty (§3)', async () => {
  const { editor, input, output } = makeEditor();
  const line = editor.readLine({ prompt: '› ', placeholder: 'Ask anything' });
  assert.ok(output.data.includes('Ask anything'), 'placeholder visible when empty');
  output.data = '';
  input.send('h');
  assert.ok(!output.data.includes('Ask anything'), 'placeholder cleared after first keystroke');
  assert.ok(output.data.includes('h'), 'typed text is echoed');
  input.send('\r');
  await line;
});

test('live menu appears and filters per keystroke (§4)', async () => {
  const items = (buffer: string): MenuItem[] =>
    buffer.startsWith('/') && !buffer.includes(' ')
      ? [
          { label: '/config', detail: 'settings' },
          { label: '/context', detail: 'stats' },
        ].filter((m) => m.label.startsWith(buffer))
      : [];
  const { editor, input, output } = makeEditor();
  const line = editor.readLine({ prompt: '› ', getMenu: items });
  output.data = '';
  input.send('/');
  assert.ok(output.data.includes('/config'));
  assert.ok(output.data.includes('/context'));
  output.data = '';
  input.send('co');
  assert.ok(output.data.includes('/config') && output.data.includes('/context'));
  output.data = '';
  input.send('x'); // now "/cox" → no command matches
  assert.ok(!output.data.includes('/config'));
  assert.ok(!output.data.includes('/context'));
  input.send('\r');
  assert.equal(await line, '/cox');
});

test('Tab accepts the highlighted command (§4)', async () => {
  const menu = (buffer: string): MenuItem[] =>
    buffer.startsWith('/')
      ? [{ label: '/config', detail: 'settings', insert: '/config ' }]
      : [];
  const { editor, input } = makeEditor();
  const line = editor.readLine({ prompt: '› ', getMenu: menu });
  input.send('/');
  input.send('\t');
  input.send('\r');
  assert.equal(await line, '/config ');
});

test('masked input never echoes the secret, only the mask (§5)', async () => {
  const { editor, input, output } = makeEditor();
  const line = editor.readLine({ prompt: 'API Key: ', mask: true });
  input.send('sk' + '-secret');
  assert.ok(!output.data.includes('sk' + '-secret'), 'plaintext must not be rendered');
  assert.ok(output.data.includes('*********'), 'mask characters are shown');
  output.data = '';
  input.send('\r');
  assert.equal(await line, 'sk' + '-secret', 'value is returned intact');
  assert.ok(!output.data.includes('sk' + '-secret'), 'committed line stays masked');
});

test('leftover bytes after Enter are replayed on the next line (paste/CRLF)', async () => {
  const { editor, input } = makeEditor();
  const first = editor.readLine({ prompt: '› ' });
  input.send('one\r\ntwo\r\n');
  assert.equal(await first, 'one');
  const second = editor.readLine({ prompt: '› ' });
  assert.equal(await second, 'two', 'queued line is not dropped');
});

test('Ctrl+C resolves null (§5/abort)', async () => {
  const { editor, input } = makeEditor();
  const line = editor.readLine({ prompt: '› ' });
  input.send('aborted');
  input.send('\u0003');
  assert.equal(await line, null);
  assert.equal(input.rawMode, false, 'raw mode restored');
});

// --- wrapped-buffer redraw (feedback v0.5.1 #1) ----------------------------

test('backspace on a wrapped buffer redraws from the FIRST row of the region', async () => {
  const { editor, input, output } = makeEditor();
  output.columns = 20; // prompt '› ' (2) + 18 chars = row 1; rest wraps
  const line = editor.readLine({ prompt: '› ', mask: true });
  input.send('abcdefghijklmnopqrst'); // 20 chars → buffer spans 2 terminal rows
  output.data = '';
  input.send('\u007f'); // backspace while cursor sits on row 2
  const drawn = output.data;
  // Must climb back to the first row before clearing (cursor was on row 2).
  assert.match(drawn, /\u001b\[1A/, 'erase starts by moving up to the top row');
  assert.ok(drawn.includes('\u001b[0J'), 'clears from top row down');
  // Mask is reprinted at the shortened length — never longer than before.
  const stars = (drawn.match(/\*+/g) ?? []).join('').length;
  assert.ok(stars <= 19, `mask matches buffer (${stars} ≤ 19)`);
  input.send('\u007f'.repeat(19));
  output.data = '';
  input.send('\r');
  assert.equal(await line, '');
});

test('submitting a wrapped line commits from the top row (no stray rows)', async () => {
  const { editor, input, output } = makeEditor();
  output.columns = 20;
  const line = editor.readLine({ prompt: '› ' });
  input.send('hello world this is long enough to wrap');
  output.data = '';
  input.send('\r');
  assert.equal(await line, 'hello world this is long enough to wrap');
  const committed = output.data;
  assert.match(committed, /\u001b\[2A/, 'returns up to row 1 before erasing (cursor was on row 3)');
  assert.ok(committed.includes('\u001b[0J'));
  const nl = (committed.match(/\n/g) ?? []).length;
  assert.equal(nl, 1, 'exactly one newline — the rest of the wrap comes from the terminal');
});

// --- wrapped overlay rows (feedback v0.6: stale "/e / /ex / /exit" lines) ---

/** Menu whose single item is 38 visible chars → wraps to 2 rows at width 20. */
const wrappingMenu = (buffer: string): MenuItem[] =>
  buffer.startsWith('/')
    ? [{ label: '/exit', detail: 'Keluar (sesi disimpan otomatis).' }]
    : [];

test('redraw with a wrapped overlay climbs past every wrapped menu row', async () => {
  const { editor, input, output } = makeEditor();
  output.columns = 20;
  const line = editor.readLine({ prompt: '› ', getMenu: wrappingMenu });
  input.send('/e'); // line row 1, menu wraps 2 rows → cursor ends on line row 0
  output.data = '';
  input.send('x'); // redraw: must erase from the FIRST row of the region
  const drawn = output.data;
  assert.ok(drawn.startsWith('\r\u001b[0J'), 'cursor already at top row — no climb needed');
  // The previous draw must END on the input-line cursor row, i.e. climb back
  // up over ALL wrapped menu rows (2), not just count them as 1.
  assert.match(drawn, /\u001b\[2A/, 'returns up past 2 wrapped menu rows');
  assert.doesNotMatch(drawn, /\u001b\[\d*B/, 'never moves down after the menu');
  input.send('\u0003');
  assert.equal(await line, null);
});

// --- overlay close cycles (feedback v0.6: stale menu blocks in scrollback) --

test('submitting with the menu open erases the overlay BEFORE committing', async () => {
  const { editor, input, output } = makeEditor();
  const menu = (buffer: string): MenuItem[] =>
    buffer.startsWith('/')
      ? [
          { label: '/config', detail: 'settings' },
          { label: '/context', detail: 'stats' },
        ]
      : [];
  const line = editor.readLine({ prompt: '› ', getMenu: menu });
  input.send('/co'); // overlay shows 2 menu rows below the input row
  output.data = '';
  input.send('\r'); // submit while the overlay is open
  assert.equal(await line, '/co');
  const frame = output.data;
  // Frame must start at the top of the drawn region, erase DOWN the whole
  // region (menu included) via ESC[0J before writing anything else...
  assert.ok(frame.startsWith('\r\u001b[0J'), 'erase-from-top is the first write');
  const eraseIdx = frame.indexOf('\u001b[0J');
  const submitIdx = frame.indexOf('/co');
  assert.ok(submitIdx > eraseIdx && submitIdx - eraseIdx < 10, 'committed line written right after the erase');
  // ...and it must NOT move down to the menu before writing the final line
  // (the old bug: the commit landed on top of a live menu row).
  assert.doesNotMatch(frame.slice(eraseIdx), /\u001b\[\d*B/, 'no downward move before commit');
  // Exactly one newline (the commit); menu rows are gone, never echoed.
  assert.equal((frame.match(/\n/g) ?? []).length, 1);
  assert.ok(!frame.includes('settings') && !frame.includes('stats'), 'menu content never re-printed on close');
});

test('a lone "/" submit closes the overlay without committing any line', async () => {
  const { editor, input, output } = makeEditor();
  const menu = (buffer: string): MenuItem[] =>
    buffer === '/' ? [{ label: '/config', detail: 'settings' }] : [];
  const line = editor.readLine({
    prompt: '› ',
    getMenu: menu,
    menuOnlyClose: (buffer) => buffer.trim() === '/',
  });
  input.send('/'); // overlay opens
  output.data = '';
  input.send('\r'); // Enter closes the menu — "/" alone is never executed
  assert.equal(await line, '', 'menu-only Enter resolves empty, loop keeps reading');
  const frame = output.data;
  // The whole region (prompt + placeholder + menu) is erased...
  assert.ok(frame.includes('\u001b[0J'), 'erase-from-top runs');
  // ...and NOTHING is echoed after it — no "› /" commit line at all.
  assert.ok(!frame.includes('›'), 'no committed echo written');
  assert.ok(!frame.includes('settings'), 'menu text never re-printed on close');
  assert.equal((frame.match(/\n/g) ?? []).length, 0, 'no newline — nothing is appended to scrollback');
});

test('wrapped line + wrapped overlay: up-count covers both regions', async () => {
  const { editor, input, output } = makeEditor();
  output.columns = 20;
  const line = editor.readLine({ prompt: '› ', getMenu: wrappingMenu });
  input.send('/exit'); // '› /exit' = 7 → row 0; menu = 2 wrapped rows
  output.data = '';
  input.send('\u007f'); // buffer now '/exi'
  const drawn = output.data;
  assert.ok(drawn.startsWith('\r\u001b[0J'), 'erase starts from the top row of the region');
  assert.match(drawn, /\u001b\[2A/, 'previous frame climbed 2 menu rows');
  input.send('\u0003');
  assert.equal(await line, null);
});
