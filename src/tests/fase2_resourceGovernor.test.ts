/**
 * fase2_resourceGovernor.test.ts — Test Isolasi Subproses & Resource Governor
 *
 * Menguji:
 *  - TC-GOV-01: Timeout subprocess membunuh hierarki proses (SIGKILL)
 *  - TC-GOV-02: Pembersihan NODE_OPTIONS, NODE_PATH, LD_PRELOAD
 *  - TC-GOV-03: Windows tsc.cmd spoofing bypass & direct JS execution
 *  - TC-GOV-04: Argv locking & sanitization (anti-outDir injection)
 *  - DX PATH Sanitization: Direktori toolchain diizinkan, traversal .. ditolak
 *  - Penanganan batas buffer output (RESOURCE_OVERFLOW)
 *  - Eksekusi normal subprocess terisolasi
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildIsolatedEnv,
  sanitizePathEnv,
  spawnIsolated,
  resolveTscJsPath,
  sanitizeCompilerArgs,
  runCompilerGate,
} from '../core/executor/resourceGovernor.js';

describe('Resource Governor Subprocess Isolation', () => {
  test('TC-GOV-02: process.env.NODE_OPTIONS dan variabel injeksi kode dihapus dari sandbox', () => {
    process.env.NODE_OPTIONS = '--require /tmp/malicious.js';
    process.env.NODE_PATH = '/tmp/malicious-modules';
    process.env.LD_PRELOAD = '/tmp/hook.so';
    process.env.DYLD_INSERT_LIBRARIES = '/tmp/hook.dylib';

    const env = buildIsolatedEnv();
    assert.equal(env.NODE_OPTIONS, undefined, 'NODE_OPTIONS wajib dihapus');
    assert.equal(env.NODE_PATH, undefined, 'NODE_PATH wajib dihapus');
    assert.equal(env.LD_PRELOAD, undefined, 'LD_PRELOAD wajib dihapus');
    assert.equal(env.DYLD_INSERT_LIBRARIES, undefined, 'DYLD_INSERT_LIBRARIES wajib dihapus');
    assert.equal(env.RUKO_ENFORCED, '1', 'RUKO_ENFORCED penanda sandbox harus aktif');

    delete process.env.NODE_OPTIONS;
    delete process.env.NODE_PATH;
    delete process.env.LD_PRELOAD;
    delete process.env.DYLD_INSERT_LIBRARIES;
  });

  test('TC-GOV-02 di subprocess nyata: proses anak tidak dapat mengakses NODE_OPTIONS', async () => {
    process.env.NODE_OPTIONS = '--expose-internals';
    const script = 'console.log(JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS || null }));';
    const result = await spawnIsolated(process.execPath, ['-e', script], process.cwd(), {
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.nodeOptions, null, 'Subprocess harus membaca NODE_OPTIONS sebagai null/undefined');
    delete process.env.NODE_OPTIONS;
  });

  test('TC-GOV-01: Eksekusi subprocess yang melebihi timeout dibunuh dengan RESOURCE_TIMEOUT', async () => {
    const t0 = Date.now();
    const script = 'setTimeout(() => {}, 10000);';
    await assert.rejects(
      () =>
        spawnIsolated(process.execPath, ['-e', script], process.cwd(), {
          timeoutMs: 250,
        }),
      (err: Error) => {
        assert.ok(err.message.includes('RESOURCE_TIMEOUT'));
        return true;
      },
    );
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, `Proses harus dibunuh cepat (<2s), memakan waktu: ${elapsed}ms`);
  });

  test('Output proses melebihi batas (RESOURCE_OVERFLOW) memutus stream seketika', async () => {
    const script = 'for (let i = 0; i < 5000; i++) process.stdout.write("A".repeat(100));';
    await assert.rejects(
      () =>
        spawnIsolated(process.execPath, ['-e', script], process.cwd(), {
          maxOutputBytes: 1024, // 1 KB limit
          timeoutMs: 5000,
        }),
      (err: Error) => {
        assert.ok(err.message.includes('RESOURCE_OVERFLOW'));
        return true;
      },
    );
  });

  test('DX-Preserving PATH: sanitasi menyaring traversal ".." dan menjaga direktori sah', () => {
    const rawPath = ['/usr/bin', '/tmp/../etc/bad', '/home/user/.nvm/versions/node/v20/bin'].join(':');
    const sanitized = sanitizePathEnv(rawPath);
    assert.ok(sanitized.includes('/usr/bin'));
    assert.ok(sanitized.includes('.nvm'));
    assert.equal(sanitized.includes('..'), false, 'Traversal ".." wajib disaring');
  });

  test('spawnIsolated berhasil menjalankan proses aman dan mengumpulkan stdout/exitCode', async () => {
    const result = await spawnIsolated(
      process.execPath,
      ['-e', 'console.log("hello isolated");'],
      process.cwd(),
      { timeoutMs: 5000 },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), 'hello isolated');
    assert.equal(result.stderr, '');
  });

  test('TC-GOV-03: Eksekusi Compiler Gate mengabaikan .bin/tsc.cmd dan mengeksekusi node_modules/typescript/bin/tsc via process.execPath', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruko-gov03-'));
    try {
      const binDir = path.join(tmpDir, 'node_modules', '.bin');
      const tsBinDir = path.join(tmpDir, 'node_modules', 'typescript', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(tsBinDir, { recursive: true });

      // Berkas spoof berbahaya di .bin/ (simulasi Windows tsc.cmd dan POSIX tsc)
      const evilMarker = path.join(tmpDir, 'EVIL_EXECUTED.txt');
      const evilCmd = path.join(binDir, 'tsc.cmd');
      fs.writeFileSync(evilCmd, `@echo off\r\necho SPOOFED > "${evilMarker}"\r\nexit 1\r\n`);
      const evilSh = path.join(binDir, 'tsc');
      fs.writeFileSync(evilSh, `#!/bin/sh\necho SPOOFED > "${evilMarker}"\nexit 1\n`);
      fs.chmodSync(evilSh, 0o755);

      // Berkas compiler JS yang sah di typescript/bin/tsc
      const legitMarker = path.join(tmpDir, 'LEGIT_EXECUTED.txt');
      const legitJs = path.join(tsBinDir, 'tsc');
      fs.writeFileSync(
        legitJs,
        `const fs = require('node:fs');\n` +
          `fs.writeFileSync(${JSON.stringify(legitMarker)}, 'LEGIT_OK');\n` +
          `console.log("TSC_LEGIT_OUTPUT");\n` +
          `process.exit(0);\n`,
      );

      const result = await runCompilerGate(tmpDir);

      assert.equal(result.exitCode, 0, 'Compiler gate harus berhasil keluar dengan exitCode 0');
      assert.equal(result.executedBin, process.execPath, 'Biner yang dieksekusi harus berupa process.execPath');
      assert.ok(result.stdout.includes('TSC_LEGIT_OUTPUT'), 'Stdout harus memuat output dari skrip JS yang sah');
      assert.equal(fs.existsSync(evilMarker), false, 'Berkas penanda evil tidak boleh ada (tsc.cmd tidak boleh dieksekusi)');
      assert.equal(fs.existsSync(legitMarker), true, 'Berkas penanda legit harus terbuat');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('TC-GOV-03: resolveTscJsPath mem-bypass direktori .bin/ dan memprioritaskan JS compiler sah', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruko-gov03-resolve-'));
    try {
      const binDir = path.join(tmpDir, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'tsc.cmd'), '@echo evil');
      fs.writeFileSync(path.join(binDir, 'tsc'), '#!/bin/sh\necho evil');

      // Sebelum typescript/bin/tsc ada di direktori mock, resolveTscJsPath tidak boleh mengembalikan .bin/
      const resolvedBefore = resolveTscJsPath(tmpDir);
      if (resolvedBefore) {
        assert.ok(!resolvedBefore.includes(path.join('node_modules', '.bin')), '.bin/ tidak boleh pernah diresolusi');
      }

      // Buat typescript/lib/tsc.js
      const libDir = path.join(tmpDir, 'node_modules', 'typescript', 'lib');
      fs.mkdirSync(libDir, { recursive: true });
      const libTsc = path.join(libDir, 'tsc.js');
      fs.writeFileSync(libTsc, '// legit lib');

      assert.equal(resolveTscJsPath(tmpDir), libTsc, 'Harus mendeteksi typescript/lib/tsc.js');

      // Buat typescript/bin/tsc
      const tsBinDir = path.join(tmpDir, 'node_modules', 'typescript', 'bin');
      fs.mkdirSync(tsBinDir, { recursive: true });
      const binTsc = path.join(tsBinDir, 'tsc');
      fs.writeFileSync(binTsc, '// legit bin');

      assert.equal(resolveTscJsPath(tmpDir), binTsc, 'Harus memprioritaskan typescript/bin/tsc');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('TC-GOV-04: sanitizeCompilerArgs menolak argumen asing dan mengunci hanya ke ["--noEmit"]', () => {
    // Injeksi argumen berbahaya
    assert.deepEqual(
      sanitizeCompilerArgs(['--noEmit', '--outDir', '/evil/path']),
      ['--noEmit'],
      'Flag --outDir dan path-nya wajib dibuang',
    );
    assert.deepEqual(
      sanitizeCompilerArgs(['--outDir', '/tmp/pwned']),
      ['--noEmit'],
      'Jika hanya memuat argumen asing, harus di-fallback ke ["--noEmit"]',
    );
    assert.deepEqual(
      sanitizeCompilerArgs(['--outFile', '/etc/passwd', '--noEmit']),
      ['--noEmit'],
      'Flag --outFile wajib dibuang',
    );
    assert.deepEqual(
      sanitizeCompilerArgs(['--noEmit']),
      ['--noEmit'],
      'Flag baku aman ["--noEmit"] dipertahankan',
    );
    assert.deepEqual(
      sanitizeCompilerArgs([]),
      ['--noEmit'],
      'Array kosong menghasilkan default ["--noEmit"]',
    );
    assert.deepEqual(
      sanitizeCompilerArgs(undefined),
      ['--noEmit'],
      'Undefined menghasilkan default ["--noEmit"]',
    );
  });

  test('TC-GOV-04: runCompilerGate menolak injeksi argumen berbahaya (--outDir) dan hanya meneruskan ["--noEmit"]', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruko-gov04-'));
    try {
      const tsBinDir = path.join(tmpDir, 'node_modules', 'typescript', 'bin');
      fs.mkdirSync(tsBinDir, { recursive: true });

      // Skrip mock compiler yang mencatat argv yang diterimanya
      const mockJs = path.join(tsBinDir, 'tsc');
      fs.writeFileSync(
        mockJs,
        `const args = process.argv.slice(2);\n` +
          `console.log(JSON.stringify({ receivedArgs: args }));\n` +
          `process.exit(0);\n`,
      );

      // Coba injeksi parameter jahat seperti --outDir dan --outFile
      const injectedArgs = ['--noEmit', '--outDir', '/tmp/should-not-exist', '--outFile', '/tmp/evil.js'];
      const result = await runCompilerGate(tmpDir, injectedArgs);

      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.executedArgs, ['--noEmit'], 'executedArgs wajib terkunci hanya pada ["--noEmit"]');

      const parsed = JSON.parse(result.stdout.trim());
      assert.deepEqual(
        parsed.receivedArgs,
        ['--noEmit'],
        'Proses anak hanya boleh menerima ["--noEmit"], bukan argumen injeksi',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
