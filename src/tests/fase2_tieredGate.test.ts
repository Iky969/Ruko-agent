/**
 * fase2_tieredGate.test.ts — Test F2-T4 (Fase 2, Blueprint v2.0.0 §2.12)
 *
 * Menguji Verifikasi Kompilator Mandiri (Direct Binary Tier 0 Compiler Gate):
 *  - Penolakan modifikasi lockfile (package-lock, pnpm-lock, yarn.lock)
 *  - Eksekusi biner kompilator langsung tanpa wrapper npm script
 *  - Hasil evaluasi tier 0 typecheck
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TieredGate } from '../core/verification/tieredGate.js';

describe('F2-T4 Direct Binary Tier 0 Compiler Gate', () => {
  test('Modifikasi package-lock.json memerlukan review manual', async () => {
    const gate = new TieredGate(['src/app.ts', 'package-lock.json'], process.cwd());
    const res = await gate.evaluate();
    assert.equal(res.allowed, false);
    assert.equal(res.reason, 'LOCKFILE_MODIFICATION_REQUIRES_MANUAL_REVIEW');
  });

  test('Modifikasi pnpm-lock.yaml atau yarn.lock juga memerlukan review manual', async () => {
    for (const lockfile of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']) {
      const gate = new TieredGate(['src/app.ts', lockfile], process.cwd());
      const res = await gate.evaluate();
      assert.equal(res.allowed, false, `Lockfile ${lockfile} harus ditolak`);
      assert.equal(res.reason, 'LOCKFILE_MODIFICATION_REQUIRES_MANUAL_REVIEW');
    }
  });

  test('Tier 0 typecheck berhasil pada codebase yang valid', async () => {
    // Jalankan pada workspace root proyek saat ini (yang valid typecheck)
    const gate = new TieredGate(['src/core/state/hostState.ts'], process.cwd());
    const res = await gate.evaluate();
    assert.equal(res.allowed, true, `Evaluasi harus lolos: ${res.reason}`);
    assert.equal(res.reason, 'PASSED');
  });

  test('runTier0 mengembalikan boolean secara deterministik', async () => {
    const gate = new TieredGate([], process.cwd());
    const result = await gate.runTier0();
    assert.equal(typeof result, 'boolean');
    assert.equal(result, true, 'runTier0 pada codebase ruko harus menghasilkan true');
  });

  test('TC-GOV-03: TieredGate runTier0 mengabaikan berkas palsu .bin/tsc.cmd dan memvalidasi via biner JS asli', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruko-tg-gov03-'));
    try {
      const binDir = path.join(tmpDir, 'node_modules', '.bin');
      const tsBinDir = path.join(tmpDir, 'node_modules', 'typescript', 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(tsBinDir, { recursive: true });

      // Berkas palsu .bin/tsc.cmd (simulasi exploit Windows)
      const evilCmd = path.join(binDir, 'tsc.cmd');
      fs.writeFileSync(evilCmd, '@echo off\r\nexit 1\r\n');

      // Berkas TypeScript JS yang sah
      const legitJs = path.join(tsBinDir, 'tsc');
      fs.writeFileSync(legitJs, 'console.log("OK"); process.exit(0);');

      const gate = new TieredGate([], tmpDir);
      const passed = await gate.runTier0();
      assert.equal(passed, true, 'runTier0 harus lolos karena mengeksekusi JS asli dan mengabaikan .bin/tsc.cmd');

      const evalRes = await gate.evaluate();
      assert.equal(evalRes.allowed, true);
      assert.equal(evalRes.reason, 'PASSED');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('TC-GOV-04: TieredGate runTier0 kebal terhadap injeksi argumen berbahaya (--outDir)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruko-tg-gov04-'));
    try {
      const tsBinDir = path.join(tmpDir, 'node_modules', 'typescript', 'bin');
      fs.mkdirSync(tsBinDir, { recursive: true });

      // Skrip mock yang gagal jika menerima flag selain --noEmit
      const legitJs = path.join(tsBinDir, 'tsc');
      fs.writeFileSync(
        legitJs,
        `const args = process.argv.slice(2);\n` +
          `if (args.includes('--outDir')) { process.exit(1); }\n` +
          `process.exit(0);\n`,
      );

      const gate = new TieredGate([], tmpDir);
      // Coba suntikkan argumen jahat
      const passed = await gate.runTier0(['--noEmit', '--outDir', '/evil/dest']);
      assert.equal(passed, true, 'runTier0 harus menyaring --outDir sehingga mock JS tidak gagal');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('TieredGate gagal aman (fail-closed) jika TypeScript JS compiler tidak ditemukan', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruko-tg-notfound-'));
    try {
      // Workspace kosong tanpa node_modules/typescript
      const gate = new TieredGate([], tmpDir);
      const passed = await gate.runTier0();
      assert.equal(passed, false, 'runTier0 harus mengembalikan false secara aman jika kompilator tidak ditemukan');

      const evalRes = await gate.evaluate();
      assert.equal(evalRes.allowed, false);
      assert.equal(evalRes.reason, 'TIER0_TYPECHECK_FAILED');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
