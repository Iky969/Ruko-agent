/**
 * scopeAmendment.ts — F2-T2 + F3 TC-SCM-03 + TC-FSM-01 + TC-SCM-05 (Fase 2-3, Blueprint v2.0.0 §2.6)
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
 *  5. Mutasi host state menggunakan mutator serial Pipeline atau lock sesi
 *     milik pipeline — mencegah self-deadlock LOCK_TIMEOUT.
 *  5b. WP-05 (v2.1.0): Persetujuan amandemen terikat hash muatan argumen teknis
 *     dan menampilkan fakta riil (alat, jalur kanonikal, badge risiko, diff).
 *  6. TC-SCM-03 Symlink Hardening: Resolusi fisik (realpathSync) pada parent
 *     directory target dan setiap entry allowedPaths untuk mendeteksi symlink
 *     escape. Fail-closed jika realpathSync gagal (dangling symlink dll).
 *     Pengecualian untuk symlink monorepo legit via monorepoRoots.
 *  7. TC-FSM-01 Circuit Breaker: Lacak penolakan berturut-turut pada canonical
 *     path yang SAMA (pakai realpath). Setelah 3x penolakan identik berturut-turut
 *     pada path yang sama, trigger circuit-breaker: batalkan amandemen berikutnya
 *     ke path itu untuk sisa sesi, non-punitif, beri pesan jelas. Approval path
 *     lain, allow/reset/seed/kontraksi scope tidak membuka kembali path terblokir.
 *  8. TC-SCM-05 Scope Contraction: Method eksplisit untuk reset allowedPaths
 *     ke konfigurasi awal sesi (tanpa perlu sesi baru).
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

/**
 * Delegasi mutasi state.json ke pemilik lock tunggal.
 *
 * Manager TIDAK boleh membuat instance FileLock baru di dalam dirinya: pada
 * runtime nyata SecurityPipeline sudah memegang lock eksklusif kernel untuk
 * sesi yang sama, sehingga lock kedua di proses yang sama = self-deadlock
 * (LOCK_TIMEOUT). Pipeline menyerahkan mutator yang diserialisasi in-process.
 */
export type HostStateMutator = (
  sessionId: string,
  mutate: (fresh: HostState) => Promise<boolean>,
) => Promise<boolean>;

/**
 * WP-05 (v2.1.0): metadata binding persetujuan — nama alat mutasi + muatan
 * argumen teknis yang dipakai untuk token hash.
 */
export interface ApprovalBindingMeta {
  tool?: string;
  args?: Record<string, any>;
}

export interface ScopeAmendmentOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  isTTY?: boolean;
  promptTimeoutMs?: number;
  /** WP-04: mutator state terpusat (disediakan SecurityPipeline). */
  stateMutator?: HostStateMutator;
  /**
   * TC-SCM-03: Daftar root monorepo yang diizinkan sebagai pengecualian
   * symlink traversal. Symlink yang secara fisik mengarah ke salah satu
   * root monorepo ini (atau subfoldernya) dianggap legit dan tidak ditolak.
   * Contoh: ['/repo/packages', '/repo/node_modules/.pnpm']
   */
  monorepoRoots?: string[];
  /** Pipeline-owned lock: validate and reuse it instead of acquiring again. */
  sessionLock?: FileLock;
}

const SCOPE_DENIAL_MESSAGES = {
  SCOPE_MISSING: 'approvalScope kosong (belum ada kontrak path). Gunakan /scope allow <path> atau /plan off setelah rencana disetujui.',
  SCOPE_PLAN_CHANGED: 'Rencana aktif berubah; izin scope lama tidak berlaku. Tinjau rencana, lalu /scope reset dan /scope allow <path> untuk menyetujui kontrak baru.',
  SCOPE_OUTSIDE_WORKSPACE: 'Target di luar workspace. Gunakan path di dalam workspace; amandemen scope tidak dapat mengizinkan pelarian path.',
  SCOPE_CONTAINMENT: 'Containment fisik gagal: symlink keluar dari subtree/workspace atau path tidak dapat di-resolve. Periksa path dan symlink; izin tidak diperluas.',
  SCOPE_OUTSIDE: 'Path di luar scope disetujui. Setujui prompt amandemen pada terminal interaktif atau gunakan /scope allow <path>.',
  SCOPE_AMENDMENT_DECLINED: 'Amandemen scope tidak disetujui (ditolak, timeout, atau input terputus). Izin tidak diperluas; tunggu otorisasi eksplisit pengguna.',
  SCOPE_CIRCUIT_BREAKER: 'Circuit breaker aktif setelah 3 penolakan pada path yang sama, permanen selama sesi. Jangan ulangi permintaan; mulai sesi baru untuk meninjau izin path ini.',
  SCOPE_PLAN_ACTIVE: 'Plan mode aktif kembali saat menunggu persetujuan; mutasi diblok. Gunakan /plan off hanya setelah rencana disetujui.',
};

export type ScopeMutationDecision =
  | { allowed: true }
  | { allowed: false; code: keyof typeof SCOPE_DENIAL_MESSAGES; reason: string };

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

/**
 * Token persetujuan deterministik berbasis hash dari muatan
 * argumen TEKNIS (nama alat + jalur target + argumen). Dipakai untuk membatalkan
 * eksekusi bila argumen berubah setelah tombol persetujuan ditekan.
 */
export function computeApprovalBindingToken(meta: ApprovalBindingMeta, targetPath: string): string {
  const payload = {
    tool: meta.tool ?? null,
    target: path.resolve(targetPath),
    args: meta.args ?? null,
  };
  return crypto.createHash('sha256').update(canonicalize(payload)).digest('hex');
}

/**
 * WP-05: badge risiko tinggi untuk target yang berdampak luas (alur kerja
 * CI/CD dan manifest build/script).
 */
export function highRiskTargetBadge(canonicalTarget: string): string | null {
  const normalized = canonicalTarget.replace(/\\/g, '/');
  const base = path.basename(normalized).toLowerCase();
  const isCiWorkflow = /(^|\/)\.github\/workflows\//.test(normalized) || /(^|\/)\.gitlab-ci/.test(normalized);
  const isManifest =
    base === 'package.json' ||
    base === 'package-lock.json' ||
    base === 'jenkinsfile' ||
    base === 'makefile' ||
    base === 'dockerfile';
  if (!isCiWorkflow && !isManifest) return null;
  return 'TARGET BERISIKO TINGGI: berkas CI/CD atau manifest build/script — perubahan di sini dapat mengeksekusi kode di pipeline.';
}

/**
 * WP-05: ringkasan diff faktual (jumlah baris lama → baru) untuk ditampilkan
 * pada prompt persetujuan. Bukan ringkasan buatan LLM.
 */
export function summarizeProposedDiff(
  args: Record<string, any> | undefined,
  canonicalTarget: string,
): string | null {
  if (!args) return null;
  const content =
    typeof args.content === 'string'
      ? args.content
      : typeof args.newText === 'string'
        ? args.newText
        : typeof args.new_string === 'string'
          ? args.new_string
          : null;
  if (content === null) return null;

  const newLines = content.split('\n').length;
  let oldLines: number | null = null;
  try {
    if (fsSync.existsSync(canonicalTarget) && fsSync.statSync(canonicalTarget).isFile()) {
      oldLines = fsSync.readFileSync(canonicalTarget, 'utf8').split('\n').length;
    }
  } catch {
    oldLines = null;
  }
  return oldLines === null ? `berkas baru (${newLines} baris)` : `penggantian isi: ${oldLines} → ${newLines} baris`;
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

/** Resolve a not-yet-created path through its nearest existing ancestor. */
function resolveScopePath(p: string): string | null {
  let current = path.resolve(p);
  const segments: string[] = [];
  while (true) {
    try {
      fsSync.lstatSync(current);
      const canonical = safeRealpathSync(current);
      return canonical ? path.join(canonical, ...segments) : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    segments.unshift(path.basename(current));
    current = parent;
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
  ) {
    // TC-FSM-01: Track consecutive rejections per canonical path
    this.consecutiveRejections = new Map<string, number>();
    // Store initial allowedPaths for scope contraction (TC-SCM-05)
    this.initialAllowedPaths = this.state.approvalScope?.allowedPaths.slice() ?? [];
  }

  private consecutiveRejections: Map<string, number>;
  private initialAllowedPaths: string[];

  /** Seed only at a host-controlled, explicitly user-authorized ACT transition. */
  seedWorkspaceScope(userAuthorized: boolean = false): void {
    if (this.state.approvalScope) return;
    if (userAuthorized !== true) {
      throw new Error('SCOPE_BOOTSTRAP_DENIED: seed implisit ditolak; gunakan /plan off atau /scope allow <path>.');
    }
    if (!safeRealpathSync(this.workspaceRoot)) {
      throw new Error('SCOPE_BOOTSTRAP_DENIED: workspace tidak dapat di-resolve.');
    }
    this.state.approvalScope = {
      planHash: this.state.activePlanHash ?? computePlanHash(null, ['.'], this.workspaceRoot),
      allowedPaths: ['.'],
      approvedAt: new Date().toISOString(),
      correlationId: crypto.randomUUID(),
    };
    this.initialAllowedPaths = ['.'];
  }

  /** Explicit user authorization; never called from model tool arguments. */
  async allowPath(targetPath: string): Promise<boolean> {
    const absTarget = path.resolve(this.workspaceRoot, targetPath);
    const normRoot = normalizeCasePath(this.workspaceRoot);
    const normTarget = normalizeCasePath(absTarget);
    const canonicalRoot = safeRealpathSync(this.workspaceRoot);
    const canonicalTarget = resolveScopePath(absTarget);
    if (
      !targetPath ||
      (normTarget !== normRoot && !normTarget.startsWith(normRoot + path.sep)) ||
      !canonicalRoot || !canonicalTarget
    ) {
      throw new Error('SCOPE_PATH_DENIED: path harus berada di dalam workspace yang sah.');
    }
    const physicalRoot = normalizeCasePath(canonicalRoot);
    const physicalTarget = normalizeCasePath(canonicalTarget);
    if (physicalTarget !== physicalRoot && !physicalTarget.startsWith(physicalRoot + path.sep)) {
      throw new Error('SCOPE_PATH_DENIED: symlink mengarah ke luar workspace.');
    }
    const allowedPath = path.relative(this.workspaceRoot, absTarget).replace(/\\/g, '/') || '.';
    let initialized = false;
    const updated = await this.updateScope((freshState) => {
      initialized = !freshState.approvalScope;
      if (!freshState.approvalScope) {
        freshState.approvalScope = {
          planHash: freshState.activePlanHash ?? computePlanHash(null, [allowedPath], this.workspaceRoot),
          allowedPaths: [],
          approvedAt: new Date().toISOString(),
          correlationId: crypto.randomUUID(),
        };
      }
      if (!freshState.approvalScope.allowedPaths.includes(allowedPath)) {
        freshState.approvalScope.allowedPaths.push(allowedPath);
      }
      return true;
    });
    if (updated) {
      if (initialized) this.initialAllowedPaths = this.state.approvalScope!.allowedPaths.slice();
    }
    return updated;
  }

  /** Revoke all path authorization until the user explicitly approves again. */
  async resetScope(): Promise<void> {
    await this.updateScope((freshState) => {
      freshState.approvalScope = null;
      return true;
    });
    this.initialAllowedPaths = [];
  }

  /** Persist scope changes through the pipeline mutator or its owned lock. */
  private async updateScope(update: (state: HostState) => boolean): Promise<boolean> {
    const apply = async (freshState: HostState): Promise<boolean> => {
      Object.assign(this.state, {
        ...freshState,
        approvalScope: freshState.approvalScope
          ? { ...freshState.approvalScope, allowedPaths: freshState.approvalScope.allowedPaths.slice() }
          : null,
      });
      if (!update(freshState)) return false;
      await saveHostState(freshState);
      Object.assign(this.state, freshState);
      return true;
    };

    if (this.options.stateMutator) {
      return this.options.stateMutator(this.state.sessionId, apply);
    }

    let release: (() => Promise<void>) | undefined;
    if (this.options.sessionLock) {
      const lock = this.options.sessionLock;
      const nonce = lock.getCurrentNonce();
      if (!nonce || lock.readMetadata()?.nonce !== nonce) {
        throw new Error('SCOPE_LOCK_DENIED: session lock tidak lagi dimiliki pipeline.');
      }
    } else {
      const hostDir = process.env.RUKO_HOST_STATE_DIR
        ? path.resolve(process.env.RUKO_HOST_STATE_DIR)
        : path.join(os.homedir(), '.ruko', 'sessions');
      release = await new FileLock(path.join(hostDir, this.state.sessionId, 'state.json')).acquire();
    }
    try {
      return await apply(await loadHostState(this.state.sessionId, { resume: false }));
    } finally {
      await release?.();
    }
  }

  /**
   * Get canonical path for circuit breaker tracking (TC-FSM-01).
   * Uses realpathSync to ensure consistent tracking regardless of symlinks.
   */
  private getCanonicalPathForTracking(targetPath: string): string | null {
    const absTarget = path.resolve(this.workspaceRoot, targetPath);
    const parentDir = path.dirname(absTarget);
    let canonicalParent = safeRealpathSync(parentDir);
    if (canonicalParent === null) {
      // Walk up to find nearest resolvable ancestor
      let current = parentDir;
      const segments: string[] = [];
      while (current !== path.dirname(current)) {
        try {
          const stat = fsSync.lstatSync(current);
          if (stat.isSymbolicLink()) {
            return null; // dangling symlink
          }
        } catch {
          // ENOENT - continue walking up
        }
        segments.unshift(path.basename(current));
        current = path.dirname(current);
        const resolved = safeRealpathSync(current);
        if (resolved !== null) {
          canonicalParent = path.join(resolved, ...segments);
          break;
        }
      }
      if (canonicalParent === null) return null;
    }
    // Return canonical parent + target basename for path-specific tracking
    const targetBasename = path.basename(absTarget);
    return path.join(canonicalParent, targetBasename);
  }

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

    // File/subtree baru di-resolve melalui ancestor yang eksis; kegagalan
    // resolusi (termasuk dangling symlink) tetap fail-closed.
    const canonicalTarget = resolveScopePath(absTarget);

    for (const allowed of this.state.approvalScope.allowedPaths) {
      const absAllowed = path.resolve(this.workspaceRoot, allowed);
      const canonicalAllowed = resolveScopePath(absAllowed);
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

  private denyMutation(code: keyof typeof SCOPE_DENIAL_MESSAGES, targetPath: string): ScopeMutationDecision {
    return {
      allowed: false,
      code,
      reason: `SECURITY_DENIED: [${code}] ${SCOPE_DENIAL_MESSAGES[code]}\n` +
        `  Mode: ${this.state.mode.toUpperCase()} · Scope: ${this.state.approvalScope?.allowedPaths.join(', ') || '(none)'}\n` +
        `  Target: ${targetPath}`,
    };
  }

  /** Boolean compatibility for callers that only need the authorization result. */
  async evaluateMutationTarget(
    targetPath: string,
    reason: string,
    isInteractive: boolean,
    meta?: ApprovalBindingMeta,
  ): Promise<boolean> {
    return (await this.evaluateMutationDecision(targetPath, reason, isInteractive, meta)).allowed;
  }

  /** Return the cause with its decision, never via mutable last-error state. */
  async evaluateMutationDecision(
    targetPath: string,
    reason: string,
    isInteractive: boolean,
    meta?: ApprovalBindingMeta,
  ): Promise<ScopeMutationDecision> {
    if (!this.state.approvalScope) return this.denyMutation('SCOPE_MISSING', targetPath);

    // WP-05: token binding dihitung SEBELUM prompt — dibandingkan ulang setelah
    // pengguna menyetujui. Argumen teknis yang berubah di tengah proses
    // membatalkan eksekusi (deterministic approval binding).
    const bindingToken = meta ? computeApprovalBindingToken(meta, targetPath) : null;

    // Kriptografi Kontrak Scope: jika activePlanHash diset dan berbeda dari approvalScope.planHash,
    // modifikasi hash rencana membatalkan izin eksekusi secara otomatis
    if (this.state.activePlanHash && this.state.approvalScope.planHash !== this.state.activePlanHash) {
      return this.denyMutation('SCOPE_PLAN_CHANGED', targetPath);
    }

    const normTarget = normalizeCasePath(path.resolve(this.workspaceRoot, targetPath));
    const normRoot = normalizeCasePath(this.workspaceRoot);

    // 1. Validasi batas root workspace (pelarian di luar root ditolak mutlak)
    if (!normTarget.startsWith(normRoot + path.sep) && normTarget !== normRoot) {
      return this.denyMutation('SCOPE_OUTSIDE_WORKSPACE', targetPath);
    }

    // TC-FSM-01: Session-lifetime breaker wins over new subtree grants too.
    // Track by canonical path to be consistent with TC-SCM-03 symlink hardening
    const canonicalPath = this.getCanonicalPathForTracking(targetPath);
    if (canonicalPath !== null) {
      const rejectionCount = this.consecutiveRejections.get(canonicalPath) ?? 0;
      if (rejectionCount >= 3) {
        // Circuit breaker triggered: block further amendment requests to this path
        // Non-punitif: return false without prompt, clear message to user/log
        if (this.options.output && typeof this.options.output.write === 'function') {
          this.options.output.write(
            `\n[Ruko] Circuit breaker aktif: amandemen scope ke path yang sama ('${targetPath}') telah ditolak 3x berturut-turut. ` +
            `Permintaan selanjutnya ke path ini diblokir untuk sisa sesi ini.\n`,
          );
        }
        return this.denyMutation('SCOPE_CIRCUIT_BREAKER', targetPath);
      }
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
        return this.denyMutation('SCOPE_CONTAINMENT', targetPath);
      }
      return { allowed: true };
    }

    // 3. Target baru di luar subtree membutuhkan otorisasi eksplisit pengembang.
    // Fail-Closed di lingkungan headless/CI tanpa TTY (QA.md §1.7)
    const effectiveTTY = this.options.isTTY ?? (Boolean(process.stdin.isTTY) && process.env.CI !== 'true');
    if (!isInteractive || !effectiveTTY) {
      return this.denyMutation('SCOPE_OUTSIDE', targetPath);
    }

    // Micro-Prompt Terminal dengan timeout 30 detik
    const inStream = (this.options.input as any) ?? input;
    const outStream = (this.options.output as any) ?? output;
    const timeoutMs = this.options.promptTimeoutMs ?? 30_000;

    const rl = readline.createInterface({ input: inStream, output: outStream });
    let confirmed = false;
    let timer: NodeJS.Timeout | undefined;

    // WP-05: tampilkan FAKTA TEKNIS riil (bukan ringkasan buatan LLM): nama alat
    // mutasi, jalur kanonikal target, badge risiko, dan ringkasan diff.
    const canonicalTargetDisplay = canonicalPath ?? path.resolve(this.workspaceRoot, targetPath);

    try {
      if (outStream && typeof outStream.write === 'function') {
        outStream.write(`\n[Ruko] AI mengusulkan amandemen scope untuk target baru: ${targetPath}\n`);
        outStream.write(`Alasan: ${reason}\n`);
        outStream.write(`  • Alat mutasi    : ${meta?.tool ?? '(tidak diketahui)'}\n`);
        outStream.write(`  • Jalur kanonikal: ${canonicalTargetDisplay}\n`);
        const badge = highRiskTargetBadge(canonicalTargetDisplay);
        if (badge) {
          outStream.write(`  ⚠ ${badge}\n`);
        }
        const diff = summarizeProposedDiff(meta?.args, canonicalTargetDisplay);
        if (diff) {
          outStream.write(`  • Ringkasan diff : ${diff}\n`);
        }
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

    // A concurrent rejection can latch this path while its prompt is open.
    // Revalidate before an old approval can reset the counter or persist scope.
    if (canonicalPath !== null && (this.consecutiveRejections.get(canonicalPath) ?? 0) >= 3) {
      return this.denyMutation('SCOPE_CIRCUIT_BREAKER', targetPath);
    }

    // TC-FSM-01: Track rejection/approval
    if (canonicalPath !== null) {
      if (confirmed) {
        // Only this path's pre-threshold chain can end. A latched path never
        // reaches the prompt; approval B must not reset or reopen path A.
        this.consecutiveRejections.delete(canonicalPath);
      } else {
        // On rejection: increment counter for this canonical path
        const newCount = (this.consecutiveRejections.get(canonicalPath) ?? 0) + 1;
        this.consecutiveRejections.set(canonicalPath, newCount);
      }
    }

    if (!confirmed) {
      return this.denyMutation('SCOPE_AMENDMENT_DECLINED', targetPath);
    }

    // Approval must still describe the exact tool payload that the user saw.
    if (bindingToken !== null && meta && computeApprovalBindingToken(meta, targetPath) !== bindingToken) {
      if (outStream && typeof outStream.write === 'function') {
        outStream.write(
          '[Ruko] Argumen teknis berubah setelah persetujuan → eksekusi DIBATALKAN (approval binding mismatch).\n',
        );
      }
      return this.denyMutation('SCOPE_AMENDMENT_DECLINED', targetPath);
    }

    // 4. Persist under the pipeline mutator or owned session lock.
    const updated = await this.updateScope((freshState) => {
      if (
        freshState.mode !== 'act' || !freshState.approvalScope ||
        (freshState.activePlanHash && freshState.approvalScope.planHash !== freshState.activePlanHash)
      ) {
        return false;
      }
      if (!freshState.approvalScope.allowedPaths.includes(targetPath)) {
        freshState.approvalScope.allowedPaths.push(targetPath);
      }
      return true;
    });
    if (updated) return { allowed: true };
    if (this.state.mode !== 'act') return this.denyMutation('SCOPE_PLAN_ACTIVE', targetPath);
    if (!this.state.approvalScope) return this.denyMutation('SCOPE_MISSING', targetPath);
    if (this.state.activePlanHash && this.state.approvalScope.planHash !== this.state.activePlanHash) {
      return this.denyMutation('SCOPE_PLAN_CHANGED', targetPath);
    }
    return this.denyMutation('SCOPE_OUTSIDE', targetPath);
  }

  /**
   * TC-SCM-05: Scope Contraction Utility
   * Reset allowedPaths kembali ke konfigurasi awal sesi (initial state).
   * Dipanggil manual oleh user (command eksplisit) atau otomatis pasca-circuit-breaker.
   */
  async contractScope(): Promise<boolean> {
    if (!this.state.approvalScope) return false;

    const contracted = await this.updateScope((freshState) => {
      if (!freshState.approvalScope) {
        return false;
      }
      // Reset to initial allowedPaths
      freshState.approvalScope.allowedPaths = this.initialAllowedPaths.slice();
      return true;
    });
    return contracted;
  }

  /**
   * Get current circuit breaker status for a path (for testing/debugging)
   */
  getCircuitBreakerStatus(targetPath: string): { canonicalPath: string | null; rejectionCount: number; isBlocked: boolean } {
    const canonicalPath = this.getCanonicalPathForTracking(targetPath);
    if (canonicalPath === null) {
      return { canonicalPath: null, rejectionCount: 0, isBlocked: false };
    }
    const rejectionCount = this.consecutiveRejections.get(canonicalPath) ?? 0;
    return {
      canonicalPath,
      rejectionCount,
      isBlocked: rejectionCount >= 3,
    };
  }

  /**
   * Get initial allowedPaths snapshot (for testing)
   */
  getInitialAllowedPaths(): string[] {
    return this.initialAllowedPaths.slice();
  }

  getState(): HostState {
    return this.state;
  }
}
