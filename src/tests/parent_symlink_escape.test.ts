import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { assertPhysicalContainment, SecurityBoundaryError, runToolCall } from '../agent/tools.js';
import { readFileTool } from '../agent/filetools.js';

describe('P0-2: Parent Directory Symlink Traversal Escape (CVSS 9.3)', () => {
  let wsDir: string;
  let outsideDir: string;
  let symlinkDir: string;
  let isSymlinkSupported = true;

  beforeEach(() => {
    wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruko-ws-symlink-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruko-outside-target-'));
    symlinkDir = path.join(wsDir, 'evil_link');

    try {
      fs.symlinkSync(outsideDir, symlinkDir, 'dir');
    } catch {
      isSymlinkSupported = false;
    }
  });

  afterEach(() => {
    try {
      fs.rmSync(wsDir, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    } catch {}
  });

  test('assertPhysicalContainment: Normal file inside workspace passes', () => {
    const normalPath = path.join(wsDir, 'legit.txt');
    const result = assertPhysicalContainment('legit.txt', wsDir);
    assert.equal(result, normalPath);
  });

  test('assertPhysicalContainment: Non-existent file in new subdirectory inside workspace passes', () => {
    const normalSub = path.join(wsDir, 'nested', 'deep', 'file.txt');
    const result = assertPhysicalContainment('nested/deep/file.txt', wsDir);
    assert.equal(result, normalSub);
  });

  test('assertPhysicalContainment: Reject target inside parent directory symlink pointing outside', (t) => {
    if (!isSymlinkSupported) return t.skip('Symlinks not supported in environment');

    // 1. Non-existent file inside symlinked dir
    assert.throws(
      () => assertPhysicalContainment('evil_link/pwned.txt', wsDir),
      (err: any) => err instanceof SecurityBoundaryError && /symbolic link yang mengarah ke luar|berakar di luar/i.test(err.message),
      'Must throw SecurityBoundaryError on target in symlinked parent directory',
    );

    // 2. Existing file inside symlinked dir
    fs.writeFileSync(path.join(outsideDir, 'existing.txt'), 'secret');
    assert.throws(
      () => assertPhysicalContainment('evil_link/existing.txt', wsDir),
      (err: any) => err instanceof SecurityBoundaryError && /luar direktori kerja sah|mengarah ke luar workspace/i.test(err.message),
      'Must throw SecurityBoundaryError on existing file in symlinked parent directory',
    );

    // 3. Deeply nested non-existent path under symlinked dir
    assert.throws(
      () => assertPhysicalContainment('evil_link/sub1/sub2/deep.txt', wsDir),
      (err: any) => err instanceof SecurityBoundaryError,
      'Must throw SecurityBoundaryError on deeply nested path under symlinked parent',
    );
  });

  test('write_file: Write through parent symlink is blocked and leaves outside directory untouched', async (t) => {
    if (!isSymlinkSupported) return t.skip('Symlinks not supported in environment');

    const outsideTargetFile = path.join(outsideDir, 'leak.txt');

    const result = await runToolCall(
      {
        tool: 'write_file',
        path: 'evil_link/leak.txt',
        content: 'exploit payload',
      },
      { workspaceRoot: wsDir },
    );

    assert.ok(
      result.includes('symbolic link') || result.includes('di luar direktori kerja') || result.includes('di luar working directory'),
      `Expected security error, got: ${result}`,
    );

    // CRITICAL: File must NOT be created in outside target directory
    assert.equal(fs.existsSync(outsideTargetFile), false, 'Outside directory must NOT be written to');
  });

  test('readFileTool: Read through parent symlink is blocked', async (t) => {
    if (!isSymlinkSupported) return t.skip('Symlinks not supported in environment');

    // Place sensitive file in outside directory
    fs.writeFileSync(path.join(outsideDir, 'shadow.txt'), 'root:x:0:0::/root:/bin/bash');

    const readResult = await readFileTool('evil_link/shadow.txt', {}, wsDir);

    assert.equal(readResult.ok, false, 'Read through symlink parent must fail');
    assert.ok(
      readResult.text.includes('symbolic link') || readResult.text.includes('di luar') || readResult.text.includes('Akses ditolak'),
      `Expected error text, got: ${readResult.text}`,
    );
  });

  test('delete_file: Delete through parent symlink is blocked and file remains intact', async (t) => {
    if (!isSymlinkSupported) return t.skip('Symlinks not supported in environment');

    const outsideTarget = path.join(outsideDir, 'critical.conf');
    fs.writeFileSync(outsideTarget, 'do-not-delete');

    const deleteResult = await runToolCall(
      {
        tool: 'delete_file',
        path: 'evil_link/critical.conf',
      },
      { workspaceRoot: wsDir },
    );

    assert.ok(
      deleteResult.includes('symbolic link') || deleteResult.includes('di luar'),
      `Expected security error, got: ${deleteResult}`,
    );

    // CRITICAL: Target file must remain untouched
    assert.equal(fs.existsSync(outsideTarget), true, 'Outside file must not be deleted');
    assert.equal(fs.readFileSync(outsideTarget, 'utf8'), 'do-not-delete');
  });
});
