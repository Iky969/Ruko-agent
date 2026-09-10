import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listSnapshots, takeSnapshot, undoLast, defaultUndoDir } from '../core/undo.js';

/** Undo journal goes under <cwd>/.ruko/undo — isolate cwd per test. */
function inTempCwd<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-undo-'));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('takeSnapshot + undoLast restores an edited file', () => {
  inTempCwd(() => {
    const file = join(process.cwd(), 'a.txt');
    writeFileSync(file, 'lama\n', 'utf8');
    takeSnapshot(file);
    writeFileSync(file, 'baru\n', 'utf8');
    const result = undoLast();
    assert.equal(result?.action, 'restored');
    assert.equal(readFileSync(file, 'utf8'), 'lama\n');
    assert.equal(listSnapshots().length, 0, 'snapshot consumed');
  });
});

test('undoLast deletes a newly created file (existed=false)', () => {
  inTempCwd(() => {
    const file = join(process.cwd(), 'new.txt');
    takeSnapshot(file); // file does not exist yet
    writeFileSync(file, 'isi\n', 'utf8');
    const result = undoLast();
    assert.equal(result?.action, 'deleted');
    assert.ok(!existsSync(file));
  });
});

test('undoLast returns null on an empty journal and undoes newest-first', () => {
  inTempCwd(() => {
    assert.equal(undoLast(), null);
    const file = join(process.cwd(), 'b.txt');
    writeFileSync(file, 'v1\n', 'utf8');
    takeSnapshot(file);
    writeFileSync(file, 'v2\n', 'utf8');
    takeSnapshot(file);
    writeFileSync(file, 'v3\n', 'utf8');
    undoLast(); // back to v2
    assert.equal(readFileSync(file, 'utf8'), 'v2\n');
    undoLast(); // back to v1
    assert.equal(readFileSync(file, 'utf8'), 'v1\n');
  });
});
