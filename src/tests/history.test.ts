import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendHistory, loadHistory } from '../core/history.js';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('appendHistory and loadHistory maintain order and mode 0600', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ruko-hist-test-'));
  const histFile = join(tmpDir, 'history');
  try {
    assert.deepEqual(loadHistory(histFile), []);

    appendHistory('ls -la', histFile);
    appendHistory('git status', histFile);
    // Duplicate consecutive entry should be skipped
    appendHistory('git status', histFile);
    appendHistory('npm test', histFile);

    const loaded = loadHistory(histFile);
    assert.deepEqual(loaded, ['ls -la', 'git status', 'npm test']);

    const stat = statSync(histFile);
    assert.equal(stat.mode & 0o777, 0o600, 'history file must have 0600 mode');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('LineEditor navigates history with up and down arrow keys', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeInput extends EventEmitter {
    setRawMode() {}
    resume() {}
    pause() {}
    setEncoding() {}
    send(chunk: string) {
      this.emit('data', chunk);
    }
  }
  class FakeOutput {
    data = '';
    columns = 80;
    write(text: string): boolean {
      this.data += text;
      return true;
    }
  }

  const { LineEditor } = await import('../core/tui.js');
  const input = new FakeInput();
  const output = new FakeOutput();
  const appended: string[] = [];

  const editor = new LineEditor(
    input as unknown as import('node:tty').ReadStream,
    output as unknown as import('node:tty').WriteStream,
    {
      history: ['first command', 'second command'],
      onHistoryAppend: (cmd) => appended.push(cmd),
    },
  );

  const readPromise = editor.readLine({ prompt: '› ' });

  // Press Up arrow (\u001b[A) -> should load 'second command'
  input.send('\u001b[A');
  // Press Up arrow again -> should load 'first command'
  input.send('\u001b[A');
  // Press Down arrow (\u001b[B) -> should load 'second command'
  input.send('\u001b[B');
  // Submit with Enter (\r)
  input.send('\r');

  const result = await readPromise;
  assert.equal(result, 'second command');
  assert.equal(appended.length, 1);
  assert.equal(appended[0], 'second command');
});
