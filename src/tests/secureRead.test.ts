import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, test, before, after } from 'node:test';
import { secureReadFile, SecurityViolation, isInsideWorkspace, MAX_FILE_SIZE } from '../core/tools/secureRead.js';

describe('PR-C1: secureReadFile & SecurityViolation', () => {
  let tempWs: string;
  let outsideDir: string;

  before(async () => {
    tempWs = await fs.mkdtemp(path.join(os.tmpdir(), 'ruko-secureread-ws-'));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruko-secureread-out-'));

    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'SUPER_SECRET_OUTSIDE');
    await fs.writeFile(path.join(tempWs, 'normal.txt'), 'NORMAL_SAFE_CONTENT');

    // Unicode accented filename (TC-SEC-03)
    await fs.mkdir(path.join(tempWs, 'docs'), { recursive: true });
    await fs.writeFile(path.join(tempWs, 'docs', 'panduan_résumé.md'), 'KONTEN_ACCENT_RÉSUMÉ');

    // Subdir with symlink inside (SYMLINK_IN_PATH)
    await fs.mkdir(path.join(tempWs, 'sub'), { recursive: true });
    await fs.symlink(outsideDir, path.join(tempWs, 'sub', 'outside_link'));

    // Leaf symlink to outside (TC-SEC-01)
    await fs.symlink(path.join(outsideDir, 'secret.txt'), path.join(tempWs, 'escaped_link.txt'));
  });

  after(async () => {
    await fs.rm(tempWs, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
  });

  test('TC-SEC-01: Symlink mengarah ke luar workspace root ditolak (SYMLINK_ESCAPE atau SYMLINK_BLOCKED)', async () => {
    await assert.rejects(
      () => secureReadFile(tempWs, 'escaped_link.txt'),
      (err: any) => {
        assert.ok(err instanceof SecurityViolation);
        assert.ok(['SYMLINK_BLOCKED', 'SYMLINK_ESCAPE', 'SYMLINK_IN_PATH'].includes(err.code));
        return true;
      }
    );
  });

  test('TC-SEC-02: Target path mengandung null byte ditolak seketika (NULL_BYTE)', async () => {
    await assert.rejects(
      () => secureReadFile(tempWs, 'normal.txt\0.js'),
      (err: any) => {
        assert.ok(err instanceof SecurityViolation);
        assert.equal(err.code, 'NULL_BYTE');
        return true;
      }
    );
  });

  test('TC-SEC-03: Path dengan karakter aksen UTF-8 sah terbaca utuh tanpa error', async () => {
    const buf = await secureReadFile(tempWs, 'docs/panduan_résumé.md');
    assert.equal(buf.toString('utf8'), 'KONTEN_ACCENT_RÉSUMÉ');
  });

  test('Normal file: Berkas reguler di dalam workspace terbaca utuh', async () => {
    const buf = await secureReadFile(tempWs, 'normal.txt');
    assert.equal(buf.toString('utf8'), 'NORMAL_SAFE_CONTENT');
  });

  test('Path traversal ../ ditolak seketika (PATH_TRAVERSAL)', async () => {
    await assert.rejects(
      () => secureReadFile(tempWs, '../outside_dir/secret.txt'),
      (err: any) => {
        assert.ok(err instanceof SecurityViolation);
        assert.equal(err.code, 'PATH_TRAVERSAL');
        return true;
      }
    );
  });

  test('Symlink di tengah segmen path ditolak (SYMLINK_IN_PATH)', async () => {
    await assert.rejects(
      () => secureReadFile(tempWs, 'sub/outside_link/secret.txt'),
      (err: any) => {
        assert.ok(err instanceof SecurityViolation);
        assert.ok(['SYMLINK_IN_PATH', 'SYMLINK_ESCAPE', 'PATH_TRAVERSAL'].includes(err.code));
        return true;
      }
    );
  });

  test('Target direktori bukan berkas reguler ditolak (NOT_A_FILE)', async () => {
    await assert.rejects(
      () => secureReadFile(tempWs, 'docs'),
      (err: any) => {
        assert.ok(err instanceof SecurityViolation);
        assert.equal(err.code, 'NOT_A_FILE');
        return true;
      }
    );
  });

  test('Berkas melebihi batas 5MB ditolak (FILE_TOO_LARGE)', async () => {
    const bigFile = path.join(tempWs, 'too_large.dat');
    const bigBuf = Buffer.alloc(MAX_FILE_SIZE + 1024, 0x61);
    await fs.writeFile(bigFile, bigBuf);

    await assert.rejects(
      () => secureReadFile(tempWs, 'too_large.dat'),
      (err: any) => {
        assert.ok(err instanceof SecurityViolation);
        assert.equal(err.code, 'FILE_TOO_LARGE');
        return true;
      }
    );
  });

  test('isInsideWorkspace utility mendeteksi path dalam dan luar workspace', () => {
    assert.equal(isInsideWorkspace(tempWs, path.join(tempWs, 'foo', 'bar.txt')), true);
    assert.equal(isInsideWorkspace(tempWs, tempWs), true);
    assert.equal(isInsideWorkspace(tempWs, outsideDir), false);
    assert.equal(isInsideWorkspace(tempWs, path.join(outsideDir, 'secret.txt')), false);
  });
});
