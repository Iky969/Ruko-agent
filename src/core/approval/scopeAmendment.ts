/**
 * scopeAmendment.ts — F2-T2 (Fase 2, Blueprint v2.0.0 §2.6)
 *
 * Kontrak Scope & Amandemen Terkendali:
 * Mengizinkan ekspansi otomatis pada subtree berkas yang sudah disetujui, dan
 * menyajikan micro-prompt terminal satu ketukan ([Y/n]) jika agen membutuhkan
 * berkas di luar folder yang disepakati.
 *
 * Invarian (PROGRESS2.md / QA.md §1.7 / Blueprint §2.6):
 *  1. Subtree Auto-Approve: Target di dalam subfolder yang disetujui langsung
 *     diizinkan tanpa memunculkan prompt interaktif.
 *  2. Kriptografi Kontrak Scope: Perubahan path di luar subtree memicu prompt
 *     konfirmasi interaktif; modifikasi hash rencana membatalkan izin eksekusi
 *     secara otomatis (fail-closed).
 *  3. Fail-Closed non-TTY / CI: Jika berada di lingkungan headless/CI tanpa
 *     TTY interaktif, amandemen otomatis ditolak tanpa menggantung sesi.
 *  4. Interactive Timeout 30 detik untuk sesi lokal agar tidak menggantung.
 *  5. Perlindungan atomic FileLock saat memperbarui host state di ~/.ruko/sessions/.
 *
 * ZERO dependency — hanya `node:*`.
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { HostState, saveHostState, loadHostState } from '../state/hostState.js';
import { FileLock } from '../state/fileLock.js';
import * as os from 'node:os';

export interface ScopeAmendmentOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  isTTY?: boolean;
  promptTimeoutMs?: number;
}

export function normalizeCasePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved;
}

export function canonicalize(obj: any): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalize).join(',')}]`;
  const sortedKeys = Object.keys(obj).sort();
  return `{${sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function computePlanHash(plan: any, allowedPaths: string[], workspaceRoot: string): string {
  const normWorkspace = normalizeCasePath(workspaceRoot);
  const targets = allowedPaths
    .map((p) => path.relative(normWorkspace, normalizeCasePath(path.resolve(normWorkspace, p))).replace(/\\/g, '/'))
    .sort();
  const payload = { plan, targets, workspaceRoot: normWorkspace };
  return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
}

export class ScopeAmendmentManager {
  constructor(
    private state: HostState,
    private workspaceRoot: string,
    private options: ScopeAmendmentOptions = {},
  ) {}

  private isWithinSubtree(target: string, parentSubtree: string): boolean {
    const normTarget = normalizeCasePath(path.resolve(this.workspaceRoot, target));
    const normParent = normalizeCasePath(path.resolve(this.workspaceRoot, parentSubtree));
    return normTarget === normParent || normTarget.startsWith(normParent + path.sep);
  }

  async evaluateMutationTarget(targetPath: string, reason: string, isInteractive: boolean): Promise<boolean> {
    if (!this.state.approvalScope) return false;

    // Kriptografi Kontrak Scope: jika activePlanHash diset dan berbeda dari approvalScope.planHash,
    // modifikasi hash rencana membatalkan izin eksekusi secara otomatis
    if (this.state.activePlanHash && this.state.approvalScope.planHash !== this.state.activePlanHash) {
      return false;
    }

    const normTarget = normalizeCasePath(path.resolve(this.workspaceRoot, targetPath));
    const normRoot = normalizeCasePath(this.workspaceRoot);

    // 1. Validasi batas root workspace (pelarian di luar root ditolak mutlak)
    if (!normTarget.startsWith(normRoot + path.sep) && normTarget !== normRoot) {
      return false;
    }

    // 2. Subtree Containment: Auto-approve jika target berada di dalam folder yang sudah disetujui
    const inSubtree = this.state.approvalScope.allowedPaths.some((allowed) =>
      this.isWithinSubtree(targetPath, allowed),
    );
    if (inSubtree) {
      return true;
    }

    // 3. Target baru di luar subtree membutuhkan otorisasi eksplisit pengembang.
    // Fail-Closed di lingkungan headless/CI tanpa TTY (QA.md §1.7)
    const effectiveTTY = this.options.isTTY ?? (Boolean(process.stdin.isTTY) && process.env.CI !== 'true');
    if (!isInteractive || !effectiveTTY) {
      return false;
    }

    // Micro-Prompt Terminal dengan timeout 30 detik
    const inStream = (this.options.input as any) ?? input;
    const outStream = (this.options.output as any) ?? output;
    const timeoutMs = this.options.promptTimeoutMs ?? 30_000;

    const rl = readline.createInterface({ input: inStream, output: outStream });
    let confirmed = false;
    let timer: NodeJS.Timeout | undefined;

    try {
      if (outStream && typeof outStream.write === 'function') {
        outStream.write(`\n[Ruko] AI mengusulkan amandemen scope untuk target baru: ${targetPath}\n`);
        outStream.write(`Alasan: ${reason}\n`);
      }

      const answerPromise = rl.question('Izinkan amandemen scope ini? [Y/n]: ');
      const timeoutPromise = new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SCOPE_AMENDMENT_TIMEOUT')), timeoutMs);
      });

      const answer = await Promise.race([answerPromise, timeoutPromise]);
      confirmed = answer.trim().toLowerCase() === '' || answer.trim().toLowerCase() === 'y';
    } catch {
      confirmed = false;
    } finally {
      if (timer) clearTimeout(timer);
      rl.close();
    }

    if (!confirmed) {
      return false;
    }

    // 4. Perbarui izin pada state host dengan perlindungan atomic FileLock
    const hostDir = process.env.RUKO_HOST_STATE_DIR
      ? path.resolve(process.env.RUKO_HOST_STATE_DIR)
      : path.join(os.homedir(), '.ruko', 'sessions');
    const stateFile = path.join(hostDir, this.state.sessionId, 'state.json');
    const lock = new FileLock(stateFile);
    const release = await lock.acquire();
    try {
      const freshState = await loadHostState(this.state.sessionId, { resume: false });
      if (!freshState.approvalScope) {
        return false;
      }
      if (!freshState.approvalScope.allowedPaths.includes(targetPath)) {
        freshState.approvalScope.allowedPaths.push(targetPath);
        await saveHostState(freshState);
        this.state = freshState;
      }
      return true;
    } finally {
      await release();
    }
  }

  getState(): HostState {
    return this.state;
  }
}
