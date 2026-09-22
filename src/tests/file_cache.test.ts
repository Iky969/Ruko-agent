import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearFileReadCache, fileReadCache, readFileTool } from '../agent/filetools.js';
import { runToolCall } from '../agent/tools.js';

test('Item 3: in-memory tool result cache caches file read results in same turn/session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-cache-test-'));
  const filePath = join(dir, 'sample.txt');
  writeFileSync(filePath, 'line 1\nline 2\nline 3\n', 'utf8');

  try {
    clearFileReadCache();
    assert.equal(fileReadCache.size, 0);

    // First read: reads from disk and populates cache
    const res1 = await readFileTool(filePath, {}, dir);
    assert.equal(res1.ok, true);
    assert.ok(res1.text.includes('line 1'));
    assert.ok(fileReadCache.size > 0, 'Cache should contain an entry');

    // Second read: should hit in-memory cache directly
    const res2 = await readFileTool(filePath, {}, dir);
    assert.equal(res2.ok, true);
    assert.equal(res2.text, res1.text, 'Cached text must match');
    assert.equal(res2.totalLines, res1.totalLines);

    // Verify cache hit by mutating the cached result object directly
    const cacheKey = Array.from(fileReadCache.keys())[0];
    const cachedEntry = fileReadCache.get(cacheKey)!;
    assert.ok(cachedEntry, 'Cached entry must exist');
    cachedEntry.result.text = 'CACHED_CONTENT_SENTINEL';

    const res3 = await readFileTool(filePath, {}, dir);
    assert.equal(res3.text, 'CACHED_CONTENT_SENTINEL', 'Must return directly from in-memory cache without disk read');
  } finally {
    clearFileReadCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Item 3: mutating file tool invalidates in-memory cache and re-reads disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-cache-test-'));
  const filePath = join(dir, 'app.txt');
  writeFileSync(filePath, 'versi awal\n', 'utf8');

  try {
    clearFileReadCache();

    // Read initial content
    const res1 = await readFileTool(filePath, {}, dir);
    assert.ok(res1.text.includes('versi awal'));

    // Mutate file using edit_file tool
    await runToolCall(
      { tool: 'edit_file', path: filePath, content: 'versi terbaru\n' },
      { workspaceRoot: dir },
    );

    // Read again: must return updated content, not stale cache
    const res2 = await readFileTool(filePath, {}, dir);
    assert.ok(res2.text.includes('versi terbaru'), 'Must return newly edited content');
  } finally {
    clearFileReadCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
