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

// --- live status line (feedback v0.6.2: green bar piled up in scrollback) ---

test('statusLine draws above the prompt and redraws IN PLACE each frame', async () => {
  const { editor, input, output } = makeEditor();
  let ctx = 0;
  const line = editor.readLine({
    prompt: '› ',
    statusLine: () => `BAR ctx ${ctx}%`,
  });
  const first = output.data;
  assert.ok(first.includes('BAR ctx 0%'), 'status line drawn on first frame');
  assert.ok(first.indexOf('BAR ctx 0%') < first.indexOf('› '), 'status line sits ABOVE the prompt');
  ctx = 1; // the turn "finished" — bar value changes
  output.data = '';
  input.send('h');
  const frame = output.data;
  // The redraw must CLIMB over the status row before erasing (ESC[1A + ESC[0J),
  // otherwise the old bar would stay on screen and the new one print below it.
  assert.match(frame, /^\u001b\[1A\r\u001b\[0J/, 'frame climbs 1 status row then erases from the top');
  assert.ok(frame.includes('BAR ctx 1%'), 'fresh bar value redrawn in place');
  assert.ok(!frame.includes('ctx 0%'), 'stale bar value never re-printed');
  input.send('\u0003');
  assert.equal(await line, null);
});

test('submit erases the live status bar — no stale version settles in scrollback', async () => {
  const { editor, input, output } = makeEditor();
  const line = editor.readLine({ prompt: '› ', statusLine: () => 'BAR ctx 0%' });
  output.data = '';
  input.send('hi\r');
  assert.equal(await line, 'hi');
  const frame = output.data;
  // Climb over status row + erase-to-end BEFORE committing the echoed input:
  // after this frame the screen holds only '› hi' — the bar is gone until the
  // next readLine redraws it in place.
  assert.match(frame, /^\u001b\[1A\r\u001b\[0J/, 'submit climbs over the status row and erases it');
  assert.ok(!frame.includes('BAR'), 'status bar text not re-printed on commit');
  assert.equal((frame.match(/\n/g) ?? []).length, 1, 'exactly one newline — only the echo commits');
});

test('menu-only close and cancel also erase the status row', async () => {
  const { editor, input, output } = makeEditor();
  const close = editor.readLine({
    prompt: '› ',
    statusLine: () => 'BAR',
    menuOnlyClose: (b) => b.trim() === '/',
  });
  input.send('/');
  output.data = '';
  input.send('\r');
  assert.equal(await close, '');
  assert.match(output.data, /^\u001b\[1A\r\u001b\[0J/, 'close climbs over status row, erases all');
  assert.equal((output.data.match(/\n/g) ?? []).length, 0, 'nothing committed to scrollback');

  const { editor: e2, input: i2, output: o2 } = makeEditor();
  const cancel = e2.readLine({ prompt: '› ', statusLine: () => 'BAR' });
  o2.data = '';
  i2.send('\u0003');
  assert.equal(await cancel, null);
  assert.match(o2.data, /^\u001b\[1A\r\u001b\[0J/, 'cancel climbs over status row before erasing');
  assert.ok(!o2.data.includes('BAR'), 'bar erased on cancel too');
});

test('status line is clamped so it can never wrap and break the rewind math', async () => {
  const { editor, input, output } = makeEditor();
  output.columns = 30;
  const line = editor.readLine({ prompt: '› ', statusLine: () => 'X'.repeat(100) });
  const drawn = output.data;
  const bar = drawn.slice(drawn.indexOf('X'), drawn.indexOf('\n'));
  assert.ok(bar.length <= 29, `bar clamped to width-1 (got ${bar.length})`);
  input.send('\u0003');
  assert.equal(await line, null);
});

// --- ambient live input while the AI works (feedback v0.7) -------------------

function makeAmbient(opts?: Partial<{ status: string }>) {
  const { editor, input, output } = makeEditor();
  const submitted: string[] = [];
  let interrupts = 0;
  editor.startAmbient({
    prompt: '› ',
    placeholder: 'AI sibuk…',
    statusLine: () => opts?.status ?? 'BAR busy',
    onSubmit: (line) => submitted.push(line),
    onInterrupt: () => {
      interrupts += 1;
    },
  });
  return { editor, input, output, submitted, interrupts: () => interrupts };
}

test('ambient mode keeps a live input region with status line (v0.7 #1)', () => {
  const { editor, output } = makeAmbient();
  assert.ok(output.data.includes('BAR busy'), 'status line drawn in ambient region');
  assert.ok(output.data.includes('AI sibuk…'), 'placeholder shown while buffer empty');
  assert.ok(editor.isActive === false, 'ambient is not a blocking readLine');
  editor.stopAmbient();
});

test('ambient Enter hands the line to onSubmit and redraws empty (v0.7 #2)', async () => {
  const { editor, input, output, submitted } = makeAmbient();
  output.data = '';
  input.send('tambahkan X');
  assert.ok(output.data.includes('tambahkan X'), 'typing echoes live while AI works');
  output.data = '';
  input.send('\r');
  assert.deepEqual(submitted, ['tambahkan X'], 'Enter routes the line to the loop, not execution');
  // The region was erased (climb over status row) and redrawn with an empty buffer.
  assert.match(output.data, /^\u001b\[1A\r\u001b\[0J/, 'erase from top of region');
  assert.ok(output.data.includes('AI sibuk…'), 'empty prompt redrawn after submit');
  editor.stopAmbient();
});

test('ambient Ctrl+C interrupts the turn, not the session (v0.7 #3)', async () => {
  const { editor, input, output } = makeAmbient();
  let count = 0;
  (editor as unknown as { ambient: { onInterrupt: () => void } }).ambient.onInterrupt = () => {
    count += 1;
  };
  output.data = '';
  input.send('\u0003');
  assert.equal(count, 1, 'onInterrupt fired once');
  assert.ok(output.data.includes('^'), '^ marker echoed for the user');
  editor.stopAmbient();
});

test('askModal answers with a single key; Enter takes the default (v0.7 #2)', async () => {
  const { editor, input } = makeAmbient();
  const modal = editor.askModal({ prompt: 'Pilih [1/2]:', keys: ['1', '2'], defaultKey: '2' });
  assert.ok(editor.modalActive, 'modal is open');
  input.send('1');
  assert.equal(await modal, '1', 'key 1 resolves immediately');

  const modal2 = editor.askModal({ prompt: 'Pilih [1/2]:', keys: ['1', '2'], defaultKey: '2' });
  input.send('\r');
  assert.equal(await modal2, '2', 'bare Enter takes the safer default (queue)');
  editor.stopAmbient();
});

test('modal owns the keyboard: buffer frozen, other keys ignored (v0.7 #6)', async () => {
  const { editor, input, output, submitted } = makeAmbient();
  input.send('halo'); // type into the ambient buffer first
  const modal = editor.askModal({ prompt: 'Pilih [1/2]:', keys: ['1', '2'], defaultKey: '2' });
  output.data = '';
  input.send('9x\r'); // junk keys must not leak into the buffer or submit
  assert.equal(await modal, '2', 'Enter still answers the modal default');
  assert.deepEqual(submitted, [], 'no ambient submit happened while modal open');
  assert.ok(!output.data.includes('9x'), 'junk keys never echoed');
  editor.stopAmbient();
});

test('stdout writes land ABOVE the ambient region and keep it alive (v0.7)', () => {
  const { editor, input, output } = makeAmbient();
  const before = output.data;
  assert.ok(before.includes('BAR busy'));
  // Simulate streamed agent output (the editor patches its own output stream):
  // a completed line + a partial line.
  output.write('jawaban AI baris 1\njawaban AI mengetik');
  // The region was erased, output written, region redrawn below it.
  assert.ok(output.data.includes('jawaban AI baris 1'), 'completed line committed');
  assert.ok(output.data.includes('jawaban AI mengetik'), 'partial line shown');
  const tail = output.data.slice(output.data.indexOf('jawaban AI baris 1'));
  assert.ok(tail.includes('BAR busy'), 'status bar redrawn BELOW streamed output');
  assert.ok(tail.includes('AI sibuk…'), 'input region still alive after output');
  // Typing still works after output interleaving.
  output.data = '';
  input.send('x');
  assert.ok(output.data.includes('x'), 'input still echoes after output');
  editor.stopAmbient();
});

test('stopAmbient leaves the committed output line and erases the region', () => {
  const { editor, output } = makeAmbient();
  output.write('teks belum newline');
  // The intercepted write already committed the partial line (with a newline)
  // above the region — stopAmbient must not duplicate it.
  assert.ok(output.data.includes('teks belum newline\n'), 'partial line committed once, during write');
  output.data = '';
  editor.stopAmbient();
  assert.match(output.data, /\u001b\[0J/, 'live region erased on stop');
  assert.ok(!output.data.includes('BAR busy'), 'no region redrawn after stop');
  assert.ok(!output.data.includes('teks belum newline'), 'output line not re-printed');
});
