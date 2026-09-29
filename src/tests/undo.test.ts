import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listSnapshots, revertFile, takeSnapshot, undoLast, validateSnapshotPath } from '../core/undo.js';
import { tryCreateSymlink } from './helpers/platform.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// Regresi macOS: `os.tmpdir()` di macOS = /var/folders/.. (symlink ke
// /private/var/folders/..) sementara `process.cwd()` selalu bentuk FISIK.
// Perbandingan lexical murni membuat /undo menolak berkas milik workspace
// sendiri dengan pesan "berada di luar workspace". Bug ini ketangkap oleh
// matriks CI macOS, bukan oleh runner Linux.
// ─────────────────────────────────────────────────────────────────────────────

test('validateSnapshotPath/undoLast: workspace yang diakses lewat symlink tetap dianggap DI DALAM workspace (kasus macOS /var → /private/var)', () => {
  const base = mkdtempSync(join(tmpdir(), 'ruko-undo-symlink-'));
  const realWs = join(base, 'real-ws');
  const linkWs = join(base, 'link-ws');
  mkdirSync(realWs, { recursive: true });

  // Windows tanpa hak symlink → lewati (konvensi yang sama dengan test lain).
  if (!tryCreateSymlink(realWs, linkWs)) {
    rmSync(base, { recursive: true, force: true });
    return;
  }

  try {
    const canonicalWs = realpathSync(realWs);
    const fileViaLink = join(linkWs, 'target.txt'); // bentuk symlink (seperti mkdtempSync(tmpdir()) di macOS)
    writeFileSync(fileViaLink, 'v1\n', 'utf8');

    // 1. Containment: target bentuk symlink + workspace bentuk fisik = tetap di dalam.
    assert.doesNotThrow(() => validateSnapshotPath(fileViaLink, canonicalWs));
    // Kebalikannya juga harus benar (target fisik, workspace symlink).
    assert.doesNotThrow(() => validateSnapshotPath(join(canonicalWs, 'target.txt'), linkWs));

    // 2. Alur undo nyata (takeSnapshot → ubah → undoLast) memakai kedua bentuk itu.
    const undoDir = join(canonicalWs, '.ruko', 'undo');
    takeSnapshot(fileViaLink, undoDir);
    writeFileSync(fileViaLink, 'v2\n', 'utf8');

    const result = undoLast(undoDir, canonicalWs);
    assert.equal(result?.action, 'restored', 'undo harus memulihkan berkas di workspace ber-symlink');
    assert.equal(readFileSync(fileViaLink, 'utf8'), 'v1\n');

    // 3. revertFile lewat jalur snapshot, workspace bentuk fisik.
    //    Snapshot dibuat saat isi = 'v1', jadi hasil revert harus 'v1' (bukan 'v2').
    assert.equal(readFileSync(fileViaLink, 'utf8'), 'v1\n', 'prasyarat: undo langkah 2 sudah mengembalikan v1');
    takeSnapshot(fileViaLink, undoDir);
    writeFileSync(fileViaLink, 'v3\n', 'utf8');
    const revert = revertFile(fileViaLink, { workspaceRoot: canonicalWs, dir: undoDir, mode: 'snapshot' });
    assert.equal(revert.ok, true, revert.error ?? '');
    assert.equal(readFileSync(fileViaLink, 'utf8'), 'v1\n');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('validateSnapshotPath tetap menolak escape lewat DIRECTORY symlink di dalam workspace', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-undo-escape-'));
  const outside = mkdtempSync(join(tmpdir(), 'ruko-undo-outside-'));
  const linkDir = join(ws, 'link-out');

  if (!tryCreateSymlink(outside, linkDir)) {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    return;
  }

  try {
    // Path ini LEXICAL di dalam workspace, tetapi FISIK di luar → wajib ditolak.
    assert.throws(
      () => validateSnapshotPath(join(linkDir, 'secret.txt'), ws),
      /di luar workspace/,
      'escape lewat symlink direktori harus tetap ditolak',
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
