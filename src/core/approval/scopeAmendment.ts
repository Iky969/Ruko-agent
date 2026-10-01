/**
 * scopeAmendment.ts — F2-T2 + F3 TC-SCM-03 (Fase 2-3, Blueprint v2.0.0 §2.6)
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
 *  6. TC-SCM-03 Symlink Hardening: Resolusi fisik (realpathSync) pada parent
 *     directory target dan setiap entry allowedPaths untuk mendeteksi symlink
 *     escape. Fail-closed jika realpathSync gagal (dangling symlink dll).
 *     Pengecualian untuk symlink monorepo legit via monorepoRoots.
 *
 * ZERO dependency — hanya `node:*`.
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as fsSync from 'node:fs';
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
  /**
   * TC-SCM-03: Daftar root monorepo yang diizinkan sebagai pengecualian
   * symlink traversal. Symlink yang secara fisik mengarah ke salah satu
   * root monorepo ini (atau subfoldernya) dianggap legit dan tidak ditolak.
   * Contoh: ['/repo/packages', '/repo/node_modules/.pnpm']
   */
  monorepoRoots?: string[];
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

/**
 * Mencoba resolusi fisik (realpath) sebuah path secara sinkron.
 * Mengembalikan null jika gagal (ENOENT / dangling symlink / izin dll).
 * Fail-closed: pemanggil wajib menolak akses jika hasilnya null.
 */
function safeRealpathSync(p: string): string | null {
  try {
    return fsSync.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * TC-SCM-03: Memeriksa apakah `canonicalParent` berada di dalam salah satu
 * monorepo root yang terdaftar. Digunakan sebagai pengecualian untuk symlink
 * internal monorepo yang legit (pnpm store, npm workspace, dll).
 */
function isInsideMonorepoRoot(canonicalParent: string, monorepoRoots: string[]): boolean {
  for (const root of monorepoRoots) {
    const canonicalRoot = safeRealpathSync(root);
    if (!canonicalRoot) continue;
    const normParent = normalizeCasePath(canonicalParent);
    const normRoot = normalizeCasePath(canonicalRoot);
    if (normParent === normRoot || normParent.startsWith(normRoot + path.sep)) {
      return true;
    }
  }
  return false;
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

  /**
   * TC-SCM-03: Validasi fisik realpath pada parent directory target terhadap
   * setiap entry allowedPaths. Mendeteksi symlink yang secara visual berada
   * di subtree yang disetujui tetapi secara fisik mengarah ke luar workspace.
   *
   * Fail-closed: Jika realpathSync gagal pada parent target ATAU pada semua
   * entry allowedPaths, mutasi otomatis ditolak.
   *
   * Pengecualian: Symlink monorepo legit (pnpm store, npm workspace)
   * diizinkan jika path fisik berada di dalam salah satu monorepoRoots.
   */
  private isPhysicallyContained(targetPath: string): boolean {
    // Resolve target absolut, lalu ambil parent directory-nya
    const absTarget = path.resolve(this.workspaceRoot, targetPath);
    const parentDir = path.dirname(absTarget);

    // Resolve canonical parent via realpathSync.
    // Jika parent belum ada (ENOENT normal — file/dir baru), walk up ke
    // ancestor terdekat yang eksis. Jika komponen yang gagal adalah symlink
    // (dangling), tetap fail-closed.
    let canonicalParent = safeRealpathSync(parentDir);
    if (canonicalParent === null) {
      // Walk up: cari ancestor terdekat yang bisa di-resolve
      let current = parentDir;
      const segments: string[] = [];
      while (current !== path.dirname(current)) {
        // Cek apakah current path yang gagal adalah symlink (dangling)
        try {
          const stat = fsSync.lstatSync(current);
          if (stat.isSymbolicLink()) {
            // Ini dangling symlink — fail-closed
            return false;
          }
        } catch {
          // lstatSync juga gagal (ENOENT) — belum ada, naik ke parent
        }
        segments.unshift(path.basename(current));
        current = path.dirname(current);
        const resolved = safeRealpathSync(current);
        if (resolved !== null) {
          // Ditemukan ancestor yang bisa di-resolve.
          // Canonical parent = ancestor fisik + sisa segments (yang belum ada)
          canonicalParent = path.join(resolved, ...segments);
          break;
        }
      }
      if (canonicalParent === null) {
        // Tidak ada ancestor yang bisa di-resolve — fail-closed
        return false;
      }
    }

    // Resolve canonical workspace root
    const canonicalRoot = safeRealpathSync(this.workspaceRoot);
    if (canonicalRoot === null) {
      return false;
    }

    // Verifikasi bahwa canonical parent masih di dalam workspace root fisik
    const normParent = normalizeCasePath(canonicalParent);
    const normRoot = normalizeCasePath(canonicalRoot);
    if (normParent !== normRoot && !normParent.startsWith(normRoot + path.sep)) {
      // Parent fisik keluar dari workspace root — cek pengecualian monorepo
      const monorepoRoots = this.options.monorepoRoots ?? [];
      if (monorepoRoots.length > 0 && isInsideMonorepoRoot(canonicalParent, monorepoRoots)) {
        return true;
      }
      return false;
    }

    // Verifikasi bahwa canonical parent ATAU canonical target berada di dalam
    // canonical form dari setidaknya satu entry allowedPaths.
    // Kita perlu memeriksa keduanya karena:
    //  - Untuk file target (misal src/core/main.ts): parent (src/core) harus di dalam allowed
    //  - Untuk target yang = allowed path itu sendiri (misal src/core): target sendiri yang cocok
    if (!this.state.approvalScope) return false;

    // Resolve canonical target — bisa jadi target sendiri belum ada (file baru),
    // jadi ini opsional (null = file belum ada, periksa parent saja).
    const canonicalTarget = safeRealpathSync(absTarget);

    for (const allowed of this.state.approvalScope.allowedPaths) {
      const absAllowed = path.resolve(this.workspaceRoot, allowed);
      const canonicalAllowed = safeRealpathSync(absAllowed);
      // Jika allowedPath sendiri tidak bisa di-resolve, skip entry ini
      // (fail-closed per entry, coba entry lainnya)
      if (canonicalAllowed === null) continue;

      const normAllowed = normalizeCasePath(canonicalAllowed);

      // Cek 1: Parent target berada di dalam atau sama dengan allowedPath
      if (normParent === normAllowed || normParent.startsWith(normAllowed + path.sep)) {
        return true;
      }

      // Cek 2: Target sendiri berada di dalam atau sama dengan allowedPath
      // (menangani kasus target = direktori yang disetujui sendiri)
      if (canonicalTarget !== null) {
        const normTarget = normalizeCasePath(canonicalTarget);
        if (normTarget === normAllowed || normTarget.startsWith(normAllowed + path.sep)) {
          return true;
        }
      }
    }

    // Tidak ada entry allowedPaths yang secara fisik mengandung parent/target
    return false;
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
      // 2b. TC-SCM-03 — Symlink Hardening: Verifikasi fisik realpath
      // Meskipun secara visual target berada di subtree yang disetujui,
      // resolusi fisik parent directory wajib juga berada di dalam subtree.
      // Ini mendeteksi symlink pra-eksisting yang mengarah ke /tmp, root, dll.
      if (!this.isPhysicallyContained(targetPath)) {
        // Symlink escape terdeteksi — tolak mutasi (fail-closed).
        // TIDAK memunculkan prompt; ini bukan amandemen scope biasa,
        // ini adalah upaya pelarian hierarki.
        return false;
      }
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
