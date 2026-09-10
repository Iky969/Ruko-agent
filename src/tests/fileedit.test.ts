import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import { runToolCall } from '../agent/tools.js';
import { stripAnsi } from '../core/ui.js';

// Route undo snapshots to a temp dir so repo stays clean.
process.env.RUKO_UNDO_DIR = mkdtempSync(join(tmpdir(), 'ruko-undo-fe-'));
after(() => {
  rmSync(process.env.RUKO_UNDO_DIR!, { recursive: true, force: true });
  delete process.env.RUKO_UNDO_DIR;
});

function tmpFile(name: string, content = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-tools-'));
  const abs = join(dir, name);
  if (content) writeFileSync(abs, content, 'utf8');
  return abs;
}

test('write_file creates a new file and logs an Edit line', async () => {
  const abs = tmpFile('new.txt');
  const logs: string[] = [];
  const result = await runToolCall(
    { tool: 'write_file', path: abs, content: 'hello\n' },
    { onLog: (l) => logs.push(l) },
  );
  assert.equal(readFileSync(abs, 'utf8'), 'hello\n');
  const parsed = JSON.parse(result) as { ok: boolean };
  assert.equal(parsed.ok, true);
  assert.ok(logs.some((l) => stripAnsi(l).includes(`🟢 Edit(${abs})`) || stripAnsi(l).includes('🟢 Edit(')));
});

test('write_file refuses to silently overwrite an existing file', async () => {
  const abs = tmpFile('exists.txt', 'old\n');
  const result = await runToolCall(
    { tool: 'write_file', path: abs, content: 'new\n' },
    {},
  );
  assert.ok(result.includes('edit_file'), 'error should point to edit_file');
  assert.equal(readFileSync(abs, 'utf8'), 'old\n', 'file must be untouched');
});

test('edit_file replaces content and logs a red/green diff', async () => {
  const abs = tmpFile('app.txt', 'alpha\nbeta\ngamma\n');
  const logs: string[] = [];
  const result = await runToolCall(
    { tool: 'edit_file', path: abs, content: 'alpha\nBETA\ngamma\n' },
    { onLog: (l) => logs.push(l) },
  );
  assert.equal(readFileSync(abs, 'utf8'), 'alpha\nBETA\ngamma\n');
  assert.ok((JSON.parse(result) as { ok: boolean }).ok);
  const all = logs.join('\n');
  assert.ok(stripAnsi(all).includes('- beta'));
  assert.ok(stripAnsi(all).includes('+ BETA'));
  const hasRed = logs.some((l) => l.includes('\u001b[31m') && l.includes('- beta'));
  const hasGreen = logs.some((l) => l.includes('\u001b[32m') && l.includes('+ BETA'));
  if (process.stdout.isTTY) {
    assert.ok(hasRed, 'deleted line should be red');
    assert.ok(hasGreen, 'added line should be green');
  }
});

test('edit_file on identical content is a no-op', async () => {
  const abs = tmpFile('same.txt', 'x\n');
  const logs: string[] = [];
  const result = await runToolCall(
    { tool: 'edit_file', path: abs, content: 'x\n' },
    { onLog: (l) => logs.push(l) },
  );
  assert.ok((JSON.parse(result) as { note?: string }).note);
  assert.ok(logs.some((l) => stripAnsi(l).includes('🟡')));
});

test('edit_file requires content field', async () => {
  const abs = tmpFile('req.txt', 'x\n');
  const result = JSON.parse(await runToolCall({ tool: 'edit_file', path: abs }, {})) as { error?: string };
  assert.ok(result.error?.includes('missing "content"'));
});
