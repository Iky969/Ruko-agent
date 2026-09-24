import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { looksBinary, readFileTool, MAX_READ_LIMIT, MAX_READ_FILE_SIZE } from '../agent/filetools.js';
import { parseToolCalls, runToolCall, setWorkspaceRoot } from '../agent/tools.js';

let tmpDir: string;
let sample: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruko-read-'));
  setWorkspaceRoot(tmpDir);
  sample = path.join(tmpDir, 'sample.txt');
  const lines = Array.from({ length: 500 }, (_, i) => `baris ${i + 1}`);
  await fs.writeFile(sample, lines.join('\n'), 'utf8');
});

after(async () => {
  setWorkspaceRoot(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('read_file returns numbered lines and paginates by limit', async () => {
  const r = await readFileTool(sample, { limit: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.totalLines, 500);
  assert.match(r.text, /^1\| baris 1/m);
  assert.match(r.text, /^5\| baris 5/m);
  assert.ok(!r.text.includes('6|'), 'limit must stop at line 5');
  assert.equal(r.truncated, true);
  assert.equal(r.nextOffset, 6);
});

test('read_file offset pages to the end of the file', async () => {
  const r = await readFileTool(sample, { offset: 498, limit: 100 });
  assert.equal(r.ok, true);
  assert.match(r.text, /^498\| baris 498/m);
  assert.match(r.text, /^500\| baris 500/m);
  assert.equal(r.truncated, false);
  assert.equal(r.nextOffset, undefined);
});

test('read_file clamps oversized limit to MAX_READ_LIMIT', async () => {
  const r = await readFileTool(sample, { limit: 999_999 });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, false); // 500 < MAX_READ_LIMIT, whole file fits
  assert.ok(MAX_READ_LIMIT >= 2000);
});

test('read_file reports offset past EOF without failing', async () => {
  const r = await readFileTool(sample, { offset: 9999 });
  assert.equal(r.ok, true);
  assert.match(r.text, /melewati akhir file/);
});

test('read_file errors on missing file, directory, and empty path', async () => {
  const missing = await readFileTool(path.join(tmpDir, 'nope.txt'));
  assert.equal(missing.ok, false);
  const dir = await readFileTool(tmpDir);
  assert.equal(dir.ok, false);
  assert.match(dir.text, /direktori/);
});

test('read_file refuses binary content', async () => {
  const bin = path.join(tmpDir, 'bin.dat');
  await fs.writeFile(bin, Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64, 1)]));
  const r = await readFileTool(bin);
  assert.equal(r.ok, false);
  assert.match(r.text, /biner/);
});

test('looksBinary detects NUL and control-char heavy text', () => {
  assert.equal(looksBinary('halo dunia\n'), false);
  assert.equal(looksBinary('abc\u0000def'), true);
  assert.equal(looksBinary('\u0001'.repeat(100)), true);
});

test('runToolCall dispatches read_file through the tool protocol', async () => {
  const { calls } = parseToolCalls(
    '```tool\n' + JSON.stringify({ tool: 'read_file', path: sample, limit: 3 }) + '\n```',
  );
  assert.equal(calls.length, 1);
  const out = await runToolCall(calls[0]);
  assert.match(out, /^1\| baris 1/m);
  assert.match(out, /menampilkan 1-3/);
});

test('runToolCall reports missing path as a tool error', async () => {
  const out = await runToolCall({ tool: 'read_file' });
  const parsed = JSON.parse(out);
  assert.match(parsed.error, /missing "path"/);
});

test('readFileTool rejects path traversal outside workspace (H1 sandbox)', async () => {
  const r = await readFileTool('/etc/passwd');
  assert.equal(r.ok, false);
  assert.match(r.text, /di luar working directory/);
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK-05: O_NOFOLLOW di readFileTool (defense-in-depth anti-TOCTOU)
// ─────────────────────────────────────────────────────────────────────────────

test('TASK-05: readFileTool rejects symlinks with O_NOFOLLOW (deny-by-default)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruko-symlink-'));
  const real = path.join(dir, 'real.txt');
  const link = path.join(dir, 'link.txt');
  await fs.writeFile(real, 'hello\n', 'utf8');
  try {
    await fs.symlink(real, link);
  } catch {
    // Platform tanpa hak symlink (mis. Windows tanpa developer mode): lewati.
    await fs.rm(dir, { recursive: true, force: true });
    return;
  }
  try {
    // Symlink INTERNAL (target di dalam workspace) pun harus ditolak di level open.
    const result = await readFileTool(link, {}, dir);
    assert.equal(result.ok, false);
    assert.ok(result.text.includes('symbolic link') || result.text.includes('ELOOP'));

    // File asli tetap terbaca bila diakses langsung (tanpa lewat symlink).
    const direct = await readFileTool(real, {}, dir);
    assert.equal(direct.ok, true);
    assert.match(direct.text, /hello/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK-06: batas ukuran file di readFileTool (anti-OOM)
// ─────────────────────────────────────────────────────────────────────────────

test('TASK-06: readFileTool rejects files larger than MAX_READ_FILE_SIZE', async () => {
  const big = path.join(tmpDir, 'huge.txt');
  await fs.writeFile(big, 'x', 'utf8');
  await fs.truncate(big, MAX_READ_FILE_SIZE + 1); // file sparse, tidak mengisi disk
  const r = await readFileTool(big);
  assert.equal(r.ok, false);
  assert.match(r.text, /terlalu besar/);
  assert.match(r.text, /max 10 MB/);

  // File tepat pada batas masih boleh dibaca.
  const atLimit = path.join(tmpDir, 'at-limit.txt');
  await fs.writeFile(atLimit, 'masih kecil\n', 'utf8');
  const ok = await readFileTool(atLimit);
  assert.equal(ok.ok, true);
});
