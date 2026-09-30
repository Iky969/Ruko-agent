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
});
