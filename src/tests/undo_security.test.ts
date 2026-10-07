/**
 * WP-02 (v2.1.0) — Persistence Hardening: Undo Journal Safety
 *
 * DoD: "Manipulasi nama id di meta.json tidak menghapus file di luar folder undo."
 *
 * Kolom `id` pada `.ruko/undo/*.meta.json` TIDAK PERNAH dipercaya: hanya id
 * berformat `^[A-Za-z0-9._-]{1,128}$` tanpa pola `..` yang diterima, dan berkas
 * konten snapshot wajib berada mutlak di dalam direktori penyimpanan undo.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSnapshots, takeSnapshot, undoLast } from '../core/undo.js';

function makeWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-undo-sec-'));
  mkdirSync(join(ws, '.ruko', 'undo'), { recursive: true });
  return ws;
}

test('WP-02: id meta.json dengan traversal (`..`) ditolak — berkas di luar folder undo aman', () => {
  const ws = makeWorkspace();
  const victim = join(tmpdir(), `ruko-undo-victim-${process.pid}-${Date.now()}.txt`);
  try {
    writeFileSync(victim, 'jangan dihapus', 'utf8');

    const undoDir = join(ws, '.ruko', 'undo');
    // meta palsu: id traversal diarahkan ke berkas victim di luar direktori undo
    const evilId = `../../../${victim.split('/').slice(1).join('/').replace(/\.txt$/, '')}`;
    writeFileSync(
      join(undoDir, 'evil.meta.json'),
      `${JSON.stringify({ id: evilId, abs: victim, existed: false })}\n`,
      'utf8',
    );
    // berkas konten yang seharusnya jadi korban bila join() tidak divalidasi
    writeFileSync(join(tmpdir(), `${victim.split('/').pop()!.replace(/\.txt$/, '')}.content`), '', 'utf8');

    assert.deepEqual(listSnapshots(undoDir), [], 'snapshot dengan id tidak valid harus dibuang');
    assert.equal(undoLast(undoDir, ws), null, 'tidak ada snapshot valid → undoLast mengembalikan null');
    assert.equal(existsSync(victim), true, 'berkas di luar folder undo tidak boleh terhapus');
    assert.equal(existsSync(ws), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(victim, { force: true });
  }
});

test('WP-02: id dengan pemisah path (`/`) juga ditolak', () => {
  const ws = makeWorkspace();
  const undoDir = join(ws, '.ruko', 'undo');
  try {
    writeFileSync(
      join(undoDir, 'evil2.meta.json'),
      `${JSON.stringify({ id: 'sub/dir/snap', abs: join(ws, 'target.txt'), existed: false })}\n`,
      'utf8',
    );
    assert.deepEqual(listSnapshots(undoDir), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('WP-02: meta dengan id valid tetapi target di luar workspace ditolak (fail-closed)', () => {
  const ws = makeWorkspace();
  const outside = join(tmpdir(), `ruko-undo-outside-${process.pid}-${Date.now()}.txt`);
  try {
    writeFileSync(outside, 'aman', 'utf8');
    const undoDir = join(ws, '.ruko', 'undo');
    writeFileSync(
      join(undoDir, '999-1.meta.json'),
      `${JSON.stringify({ id: '999-1', abs: outside, existed: false })}\n`,
      'utf8',
    );

    assert.equal(listSnapshots(undoDir).length, 1, 'id berformat sah tetap terbaca');
    assert.throws(() => undoLast(undoDir, ws), /di luar workspace/i);
    assert.equal(existsSync(outside), true, 'target di luar workspace tidak boleh tersentuh');
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test('WP-02: snapshot sah tetap dapat di-undo (tidak ada regresi)', () => {
  const ws = makeWorkspace();
  try {
    const target = join(ws, 'berkas.txt');
    writeFileSync(target, 'versi lama', 'utf8');
    const undoDir = join(ws, '.ruko', 'undo');
    const snap = takeSnapshot(target, undoDir);
    assert.equal(snap.existed, true);

    writeFileSync(target, 'versi baru', 'utf8');
    const result = undoLast(undoDir, ws);
    assert.ok(result);
    assert.equal(result!.restored, target);
    assert.equal(result!.action, 'restored');
    assert.equal(readFileSync(target, 'utf8'), 'versi lama');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
