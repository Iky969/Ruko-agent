/**
 * fase3_scopeAmendment_symlink.test.ts — TC-SCM-03 (Fase 3, Blueprint v2.0.0 §2.6)
 *
 * Menguji Symlink Hardening pada ScopeAmendmentManager:
 *  - Skenario 1: Symlink escape ke /tmp (parent directory mengarah ke /tmp)
 *  - Skenario 2: Symlink escape ke root filesystem (parent → /)
 *  - Skenario 3: Hidden symlink (nama disguised, misal .cache → /etc)
 *  - Skenario 4: Kontrol positif — TC-SCM-01 subtree auto-approve TIDAK BOLEH regresi
 *  - Skenario 5: Dangling symlink (target symlink tidak ada → fail-closed)
 *  - Skenario 6: Windows junction simulation (junction ke luar workspace)
 *  - Skenario 7: Case-insensitive path matching (Darwin/Win32 semantics)
 *
 * Setiap skenario memvalidasi bahwa:
 *  - realpathSync pada path.dirname(targetPath) digunakan untuk parent target
 *  - realpathSync dijalankan pada setiap entry allowedPaths
 *  - Fail-closed jika realpathSync gagal
 *  - Pengecualian monorepo legit berfungsi
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { tryCreateSymlink } from './helpers/platform.js';
import {
  ScopeAmendmentManager,
} from '../core/approval/scopeAmendment.js';
import { saveHostState, type HostState } from '../core/state/hostState.js';

const tempDirs: string[] = [];

function createHostDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-scm03-host-'));
  tempDirs.push(dir);
  process.env.RUKO_HOST_STATE_DIR = dir;
  return dir;
}

function createWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-scm03-ws-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  delete process.env.RUKO_HOST_STATE_DIR;
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function createMockHostState(
  sessionId: string,
  allowedPaths: string[],
  planHash = 'hash-initial',
  activePlanHash: string | null = 'hash-initial',
): HostState {
  return {
    sessionId,
    mode: 'act',
    activePlanHash,
    approvalScope: {
      planHash,
      allowedPaths,
      approvedAt: new Date().toISOString(),
      correlationId: 'corr-scm03',
    },
    sessionTokenHash: 'token-scm03',
    updatedAt: new Date().toISOString(),
  };
}

describe('TC-SCM-03: Symlink Hardening pada ScopeAmendmentManager', () => {

  test('Skenario 1: Symlink escape ke /tmp — parent directory mengarah ke /tmp terdeteksi dan ditolak', async () => {
    createHostDir();
    const ws = createWorkspace();

    // Buat struktur: ws/src/core/ (folder riil yang disetujui)
    const realSrcCore = join(ws, 'src', 'core');
    mkdirSync(realSrcCore, { recursive: true });

    // Buat symlink: ws/src/core/link_to_tmp → /tmp
    const outsideTmpDir = mkdtempSync(join(tmpdir(), 'ruko-scm03-escape-'));
    tempDirs.push(outsideTmpDir);
    writeFileSync(join(outsideTmpDir, 'secret.txt'), 'sensitive data');

    const symlinkInCore = join(realSrcCore, 'link_to_tmp');
    const linkOk = tryCreateSymlink(outsideTmpDir, symlinkInCore);
    if (!linkOk) return; // Platform tanpa hak symlink → lewati

    const state = createMockHostState('sess-scm03-1', ['src/core']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // Target: src/core/link_to_tmp/secret.txt — secara visual di subtree 'src/core'
    // tetapi secara fisik mengarah ke /tmp/…/secret.txt
    const result = await manager.evaluateMutationTarget(
      'src/core/link_to_tmp/secret.txt',
      'escape via symlink ke /tmp',
      false,
    );
    assert.equal(result, false, 'Symlink escape ke /tmp wajib ditolak oleh resolusi realpath parent');
  });

  test('Skenario 2: Symlink escape ke root filesystem — parent mengarah ke / terdeteksi dan ditolak', async () => {
    createHostDir();
    const ws = createWorkspace();

    // Buat struktur: ws/project/
    const projectDir = join(ws, 'project');
    mkdirSync(projectDir, { recursive: true });

    // Buat symlink: ws/project/root_escape → / (root filesystem)
    // Menggunakan /usr sebagai target yang aman untuk test tapi tetap di luar workspace
    const outsideDir = mkdtempSync(join(tmpdir(), 'ruko-scm03-root-'));
    tempDirs.push(outsideDir);
    writeFileSync(join(outsideDir, 'passwd'), 'root:x:0:0');

    const rootEscapeLink = join(projectDir, 'root_escape');
    const linkOk = tryCreateSymlink(outsideDir, rootEscapeLink);
    if (!linkOk) return;

    const state = createMockHostState('sess-scm03-2', ['project']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // Target: project/root_escape/passwd — visual di 'project/', fisik di luar workspace
    const result = await manager.evaluateMutationTarget(
      'project/root_escape/passwd',
      'escape via symlink ke root',
      false,
    );
    assert.equal(result, false, 'Symlink escape ke root wajib ditolak');
  });

  test('Skenario 3: Hidden symlink (nama tersamar, misal .cache → direktori luar) terdeteksi dan ditolak', async () => {
    createHostDir();
    const ws = createWorkspace();

    // Buat struktur: ws/src/
    const srcDir = join(ws, 'src');
    mkdirSync(srcDir, { recursive: true });

    // Buat target di luar workspace
    const hiddenTarget = mkdtempSync(join(tmpdir(), 'ruko-scm03-hidden-'));
    tempDirs.push(hiddenTarget);
    writeFileSync(join(hiddenTarget, 'config.json'), '{"malicious": true}');

    // Buat symlink dengan nama tersembunyi: ws/src/.cache → hiddenTarget
    const cacheLink = join(srcDir, '.cache');
    const linkOk = tryCreateSymlink(hiddenTarget, cacheLink);
    if (!linkOk) return;

    const state = createMockHostState('sess-scm03-3', ['src']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // Target: src/.cache/config.json — nama tersamar sebagai cache directory
    const result = await manager.evaluateMutationTarget(
      'src/.cache/config.json',
      'mutasi lewat hidden symlink',
      false,
    );
    assert.equal(result, false, 'Hidden symlink yang mengarah ke luar workspace wajib ditolak');
  });

  test('Skenario 4: Kontrol positif — TC-SCM-01 subtree auto-approve TIDAK regresi', async () => {
    createHostDir();
    const ws = createWorkspace();

    // Buat folder riil (tanpa symlink) di dalam workspace
    const coreDir = join(ws, 'src', 'core');
    mkdirSync(coreDir, { recursive: true });
    const utilsDir = join(coreDir, 'utils');
    mkdirSync(utilsDir, { recursive: true });
    const docsDir = join(ws, 'docs');
    mkdirSync(docsDir, { recursive: true });

    const state = createMockHostState('sess-scm03-4', ['src/core', 'docs']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // 4a. Folder persis yang diizinkan — harus auto-approve
    const resExact = await manager.evaluateMutationTarget('src/core', 'ubah folder', false);
    assert.equal(resExact, true, 'Folder persis harus auto-approve (TC-SCM-01 regression check)');

    // 4b. File anak langsung di subtree — harus auto-approve
    const resChild = await manager.evaluateMutationTarget('src/core/main.ts', 'tambah file', false);
    assert.equal(resChild, true, 'Subfile dalam subtree harus auto-approved (TC-SCM-01 regression check)');

    // 4c. Nested subfolder — harus auto-approve
    const resNested = await manager.evaluateMutationTarget('src/core/utils/helper.ts', 'tambah util', false);
    assert.equal(resNested, true, 'Nested subfile harus auto-approved (TC-SCM-01 regression check)');

    // 4d. Subfolder docs — harus auto-approve
    const resDocs = await manager.evaluateMutationTarget('docs/guide.md', 'update docs', false);
    assert.equal(resDocs, true, 'Docs subfile harus auto-approved (TC-SCM-01 regression check)');
  });

  test('Skenario 5: Dangling symlink (target tidak ada) — fail-closed, mutasi ditolak', async () => {
    createHostDir();
    const ws = createWorkspace();

    // Buat folder yang disetujui
    const srcDir = join(ws, 'src');
    mkdirSync(srcDir, { recursive: true });

    // Buat symlink ke target yang TIDAK ADA (dangling symlink)
    const nonExistentTarget = join(tmpdir(), 'ruko-scm03-nonexistent-' + Date.now());
    // Target ini sengaja TIDAK dibuat agar symlink menjadi dangling

    const danglingLink = join(srcDir, 'dangling_link');
    try {
      // Buat symlink langsung — tryCreateSymlink memeriksa existsSync pada target,
      // jadi gunakan symlinkSync langsung untuk membuat dangling symlink
      symlinkSync(nonExistentTarget, danglingLink, 'dir');
    } catch {
      return; // Platform tidak mendukung
    }

    const state = createMockHostState('sess-scm03-5', ['src']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // Target: src/dangling_link/file.txt — parent directory mengarah ke symlink dangling
    // realpathSync akan gagal → fail-closed
    const result = await manager.evaluateMutationTarget(
      'src/dangling_link/file.txt',
      'mutasi lewat dangling symlink',
      false,
    );
    assert.equal(result, false, 'Dangling symlink wajib ditolak (fail-closed: realpathSync gagal)');
  });

  test('Skenario 6: Windows junction simulation — junction ke luar workspace ditolak', async () => {
    createHostDir();
    const ws = createWorkspace();

    // Buat folder di dalam workspace yang disetujui
    const appDir = join(ws, 'app');
    mkdirSync(appDir, { recursive: true });

    // Buat target junction di luar workspace
    const junctionTarget = mkdtempSync(join(tmpdir(), 'ruko-scm03-junction-'));
    tempDirs.push(junctionTarget);
    writeFileSync(join(junctionTarget, 'data.db'), 'database content');

    // Buat junction/symlink: ws/app/junction → junctionTarget
    // Pada Windows ini akan menjadi junction, pada POSIX menjadi symlink biasa
    const junctionLink = join(appDir, 'junction');
    const linkOk = tryCreateSymlink(junctionTarget, junctionLink);
    if (!linkOk) return;

    const state = createMockHostState('sess-scm03-6', ['app']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // Target: app/junction/data.db — secara visual di 'app/', fisik di luar workspace
    const result = await manager.evaluateMutationTarget(
      'app/junction/data.db',
      'escape via junction',
      false,
    );
    assert.equal(result, false, 'Junction/symlink ke luar workspace wajib ditolak');
  });

  test('Skenario 7: Case-insensitive path matching — folder riil dengan case berbeda tetap auto-approve', async () => {
    createHostDir();
    const ws = createWorkspace();

    // Buat folder riil
    const srcCore = join(ws, 'Src', 'Core');
    mkdirSync(srcCore, { recursive: true });

    // allowedPaths menggunakan lowercase
    const state = createMockHostState('sess-scm03-7', ['Src/Core']);
    await saveHostState(state);

    const manager = new ScopeAmendmentManager(state, ws, { isTTY: false });

    // Pada Linux (case-sensitive): 'Src/Core/Main.ts' harus cocok karena allowedPaths = ['Src/Core']
    // Pada macOS/Windows (case-insensitive): normalisasi case harus menangani variasi huruf
    const result = await manager.evaluateMutationTarget(
      'Src/Core/Main.ts',
      'case matching test',
      false,
    );
    assert.equal(result, true, 'Path dengan case yang cocok harus auto-approve');

    // Pada platform case-insensitive (macOS/Win32), case variasi harus juga lolos
    if (process.platform === 'darwin' || process.platform === 'win32') {
      const resultLower = await manager.evaluateMutationTarget(
        'src/core/main.ts',
        'case-insensitive test',
        false,
      );
      assert.equal(resultLower, true, 'Case-insensitive platform harus mencocokkan variasi case');
    }
  });

  test('TC-FSM-02 (pengecualian monorepo): Symlink monorepo legit di-allow jika terdaftar di monorepoRoots', async () => {
    createHostDir();
    const ws = createWorkspace();

    // Simulasi monorepo: ws/packages/shared/ (folder riil)
    const packagesDir = join(ws, 'packages');
    mkdirSync(packagesDir, { recursive: true });
    const sharedDir = join(ws, 'packages', 'shared');
    mkdirSync(sharedDir, { recursive: true });

    // Buat target monorepo di luar workspace (simulasi pnpm store)
    const monorepoStore = mkdtempSync(join(tmpdir(), 'ruko-scm03-monorepo-'));
    tempDirs.push(monorepoStore);
    const monorepoLib = join(monorepoStore, 'lib');
    mkdirSync(monorepoLib, { recursive: true });
    writeFileSync(join(monorepoLib, 'index.ts'), 'export default 42;');

    // Buat symlink: ws/packages/shared/linked_lib → monorepoStore/lib
    const linkedLib = join(sharedDir, 'linked_lib');
    const linkOk = tryCreateSymlink(monorepoLib, linkedLib);
    if (!linkOk) return;

    const state = createMockHostState('sess-scm03-mono', ['packages']);
    await saveHostState(state);

    // TANPA monorepoRoots: harus ditolak
    const managerNoMonorepo = new ScopeAmendmentManager(state, ws, { isTTY: false });
    const resDenied = await managerNoMonorepo.evaluateMutationTarget(
      'packages/shared/linked_lib/index.ts',
      'edit monorepo file',
      false,
    );
    assert.equal(resDenied, false, 'Tanpa monorepoRoots, symlink monorepo harus ditolak');

    // DENGAN monorepoRoots: harus diizinkan
    const managerWithMonorepo = new ScopeAmendmentManager(state, ws, {
      isTTY: false,
      monorepoRoots: [monorepoStore],
    });
    const resAllowed = await managerWithMonorepo.evaluateMutationTarget(
      'packages/shared/linked_lib/index.ts',
      'edit monorepo file legit',
      false,
    );
    assert.equal(resAllowed, true, 'Dengan monorepoRoots terdaftar, symlink monorepo legit harus diizinkan');
  });
});
