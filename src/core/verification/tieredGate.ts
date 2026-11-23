/**
 * tieredGate.ts — F2-T4 (Fase 2, Blueprint v2.0.0 §2.12 / QA.md §1.9)
 *
 * Verifikasi Kompilator Mandiri (Direct Binary Tier 0 Compiler Gate):
 * Mengeksekusi kompilator TypeScript (node_modules/typescript/bin/tsc) langsung via
 * process.execPath tanpa wrapper skrip .bin/tsc.cmd atau manifest package.json
 * untuk mencegah pemalsuan kode keluar (exit-code spoofing) dan eksekusi batch
 * wrapper palsu di Windows (TC-GOV-03, TC-GOV-04).
 *
 * Invarian (PROGRESS2.md / Blueprint §2.12 / QA.md §1.9):
 *  1. Direct Binary Execution: Menggunakan process.execPath langsung menjalankan
 *     file JavaScript compiler asli di node_modules/typescript (anti-tsc.cmd spoofing).
 *  2. Lockfile Protection: Modifikasi lockfile (package-lock, pnpm, yarn) wajib
 *     ditolak dan memerlukan review manual.
 *  3. Tier 0 Typecheck: Menjalankan typecheck fail-closed sebelum kode disetujui.
 *  4. Argv Locking: Parameter kompilator dikunci secara absolut ke ['--noEmit'].
 *
 * ZERO dependency — hanya `node:*`.
 */

import { runCompilerGate } from '../executor/resourceGovernor.js';

export interface TieredGateResult {
  allowed: boolean;
  reason: string;
  /**
   * `true` bila gate TIDAK berlaku untuk perubahan ini (mis. workspace bukan
   * proyek TypeScript) sehingga `allowed: true` bukan berarti "lolos
   * typecheck" — melainkan "tidak ada yang perlu diverifikasi". Pemanggil
   * (securityPipeline) yang memutuskan skip; TieredGate sendiri tidak
   * pernah mengembalikan `skipped`.
   */
  skipped?: boolean;
}

/** Nama lockfile yang perubahannya wajib review manual (TC-GOV-03). */
const LOCKFILE_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];

/** `true` bila salah satu berkas yang diubah adalah lockfile. */
export function hasLockfileChange(changedFiles: string[]): boolean {
  return changedFiles.some((f) => LOCKFILE_NAMES.some((name) => f.includes(name)));
}

export class TieredGate {
  constructor(
    private changedFiles: string[],
    private workspaceRoot: string,
  ) {}

  async runTier0(customArgs?: string[]): Promise<boolean> {
    try {
      const result = await runCompilerGate(this.workspaceRoot, customArgs, { timeoutMs: 45_000 });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async evaluate(): Promise<TieredGateResult> {
    if (hasLockfileChange(this.changedFiles)) {
      return {
        allowed: false,
        reason: 'LOCKFILE_MODIFICATION_REQUIRES_MANUAL_REVIEW',
      };
    }

    const tier0Pass = await this.runTier0();
    if (!tier0Pass) {
      return {
        allowed: false,
        reason: 'TIER0_TYPECHECK_FAILED',
      };
    }

    return { allowed: true, reason: 'PASSED' };
  }
}
