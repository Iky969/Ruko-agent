/**
 * tieredGate.ts — F2-T4 (Fase 2, Blueprint v2.0.0 §2.12)
 *
 * Verifikasi Kompilator Mandiri (Direct Binary Tier 0 Compiler Gate):
 * Mengeksekusi kompilator TypeScript (./node_modules/.bin/tsc) langsung tanpa
 * wrapper skrip manifest package.json untuk mencegah pemalsuan kode keluar
 * (exit-code spoofing).
 *
 * Invarian (PROGRESS2.md / Blueprint §2.12):
 *  1. Direct Binary Execution: Menggunakan spawnIsolated langsung pada biner tsc.
 *  2. Lockfile Protection: Modifikasi lockfile (package-lock, pnpm, yarn) wajib
 *     ditolak dan memerlukan review manual.
 *  3. Tier 0 Typecheck: Menjalankan typecheck fail-closed sebelum kode disetujui.
 *
 * ZERO dependency — hanya `node:*`.
 */

import { spawnIsolated } from '../executor/resourceGovernor.js';
import * as path from 'node:path';
import * as fs from 'node:fs';

const IS_WIN = process.platform === 'win32';

export interface TieredGateResult {
  allowed: boolean;
  reason: string;
}

export class TieredGate {
  constructor(
    private changedFiles: string[],
    private workspaceRoot: string,
  ) {}

  private resolveTscBinary(): string {
    const localBin = path.resolve(this.workspaceRoot, 'node_modules', '.bin', IS_WIN ? 'tsc.cmd' : 'tsc');
    if (fs.existsSync(localBin)) {
      return localBin;
    }
    const localBinNoExt = path.resolve(this.workspaceRoot, 'node_modules', '.bin', 'tsc');
    if (fs.existsSync(localBinNoExt)) {
      return localBinNoExt;
    }
    // Fallback ke tsc sistem jika ada
    return IS_WIN ? 'tsc.cmd' : 'tsc';
  }

  async runTier0(): Promise<boolean> {
    const tscBin = this.resolveTscBinary();
    try {
      const result = await spawnIsolated(
        tscBin,
        ['--noEmit', '--skipLibCheck', 'true'],
        this.workspaceRoot,
        { timeoutMs: 45_000 },
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async evaluate(): Promise<TieredGateResult> {
    const hasLockfileChange = this.changedFiles.some(
      (f) =>
        f.includes('package-lock.json') ||
        f.includes('pnpm-lock.yaml') ||
        f.includes('yarn.lock') ||
        f.includes('bun.lockb'),
    );
    if (hasLockfileChange) {
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
