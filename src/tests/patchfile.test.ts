import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import { applySearchReplace, capToolResult, runToolCall, TOOL_RESULT_CHAR_LIMIT } from '../agent/tools.js';

// Keep undo snapshots out of the repo during tests.
const undoDir = mkdtempSync(join(tmpdir(), 'ruko-undo-env-'));
process.env.RUKO_UNDO_DIR = undoDir;
after(() => {
  delete process.env.RUKO_UNDO_DIR;
  rmSync(undoDir, { recursive: true, force: true });
});

test('applySearchReplace replaces a unique snippet (§5 search-replace)', () => {
  const out = applySearchReplace('a\nb target c\nd', 'b target c', 'B FIXED');
  assert.equal(out, 'a\nB FIXED\nd');
});

test('applySearchReplace rejects missing and ambiguous matches', () => {
  assert.throws(() => applySearchReplace('abc', 'zzz', 'x'), /tidak ditemukan/);
  assert.throws(() => applySearchReplace('x x x', 'x', 'y'), /lebih dari satu/);
  assert.equal(applySearchReplace('x x', 'x', 'y', true), 'y y');
});

test('applySearchReplace rejects identical old/new', () => {
  assert.throws(() => applySearchReplace('same', 'same', 'same'), /identik/);
});

test('patch_file tool applies and writes the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-patch-'));
  const file = join(dir, 'p.txt');
  writeFileSync(file, 'halo dunia\nbaris dua\n', 'utf8');
  const logs: string[] = [];
  const result = await runToolCall(
    { tool: 'patch_file', path: file, oldText: 'halo dunia', newText: 'hai dunia' },
    { onLog: (l) => logs.push(l) },
  );
  assert.equal(readFileSync(file, 'utf8'), 'hai dunia\nbaris dua\n');
  assert.ok((JSON.parse(result) as { ok: boolean }).ok);
  rmSync(dir, { recursive: true, force: true });
});

test('patch_file surfaces a helpful error when oldText is stale', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-patch-'));
  const file = join(dir, 'q.txt');
  writeFileSync(file, 'isi asli\n', 'utf8');
  const result = JSON.parse(
    await runToolCall({ tool: 'patch_file', path: file, oldText: 'tidak ada', newText: 'x' }, {}),
  ) as { error?: string };
  assert.match(result.error ?? '', /tidak ditemukan/);
  assert.equal(readFileSync(file, 'utf8'), 'isi asli\n', 'file untouched on failed patch');
  rmSync(dir, { recursive: true, force: true });
});

test('capToolResult head+tail caps huge results (§5.31)', () => {
  const huge = 'x'.repeat(TOOL_RESULT_CHAR_LIMIT * 3);
  const capped = capToolResult(huge);
  assert.ok(capped.length < TOOL_RESULT_CHAR_LIMIT + 200);
  assert.ok(capped.includes('TRUNCATED'));
  assert.ok(capped.startsWith('xxx'));
  assert.ok(capped.endsWith('xxx'));
  assert.equal(capToolResult('kecil'), 'kecil');
});

test('plan mode blocks mutating tools in CODE (§6.38)', async () => {
  for (const tool of ['exec', 'write_file', 'edit_file', 'patch_file']) {
    const result = await runToolCall({ tool }, { planMode: true });
    assert.match(result, /plan mode aktif/, `${tool} should be blocked`);
  }
  // read_file stays allowed (probe: error must NOT be the plan-mode message)
  const read = await runToolCall({ tool: 'read_file', path: '__nope__' }, { planMode: true });
  assert.ok(!read.includes('plan mode aktif'));
});
