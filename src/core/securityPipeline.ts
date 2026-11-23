/**
 * securityPipeline.ts — Fasad Keamanan Tunggal / Unified SecurityPipeline Facade
 * (Blueprint v2.0.0 PR-E1, UCUP.md §3.1)
 *
 * Mengikat secara deterministik (Composition Root):
 *  1. FileLock — mutex kernel exclusive ('wx' 0600) pada sesi.
 *  2. HostState — state kanonis host terisolasi di ~/.ruko/sessions/<id>/state.json (0600).
 *  3. ScopeAmendmentManager — evaluasi subtree auto-approval & anti-DoS circuit breaker.
 *  4. DispatcherGate — gerbang verifikasi mutasi dan subprocess di hulu pipeline.
 *
 * ZERO dependency — hanya node:*.
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { FileLock } from './state/fileLock.js';
import { HostState, loadHostState } from './state/hostState.js';
import { ScopeAmendmentManager, type HostStateMutator } from './approval/scopeAmendment.js';
import { evaluateDispatcherGate, DispatcherGateDecision } from './dispatcher/dispatcherGate.js';
import { TieredGate, hasLockfileChange, type TieredGateResult } from './verification/tieredGate.js';
import { resolveTscJsPath } from './executor/resourceGovernor.js';

export interface SecurityPipelineOptions {
  sessionId?: string;
  workspaceRoot?: string;
  resume?: boolean;
  timeoutMs?: number;
  forceUnlock?: boolean;
  isTTY?: boolean;
  monorepoRoots?: string[];
}

export interface SecurityPipeline {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly fileLock: FileLock;
  readonly hostState: HostState;
  readonly scopeManager: ScopeAmendmentManager;
  releaseLock: () => Promise<void>;
  evaluateToolCall: (
    tool: string,
    args?: Record<string, any>,
    isInteractive?: boolean,
  ) => Promise<DispatcherGateDecision>;
  /**
   * Verifikasi Tier 0 (temuan audit v2.2.0 #4): menjalankan TieredGate
   * terhadap berkas yang diubah agent pada satu turn — lockfile check +
   * typecheck `tsc --noEmit` fail-closed (TC-GOV-03/TC-GOV-04).
   *
   * Gate ini TIDAK dipanggil per tool call (tsc bisa makan 45 detik);
   * Agent memanggilnya sekali di akhir turn yang memutasi berkas.
   *
   * Skip (allowed: true, skipped: true) bila tidak ada yang relevan
   * diverifikasi: tidak ada perubahan lockfile, tidak ada perubahan kode
   * TS/JS, dan tidak ada compiler TypeScript yang terdeteksi. Skip BUKAN
   * lolos typecheck — alasan skip selalu tercatat di `reason`.
   */
  verifyTier0: (changedFiles: string[]) => Promise<TieredGateResult>;
}

/** Ekstensi berkas yang hasil typecheck-nya dipengaruhi perubahannya. */
const TIER0_CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** `true` bila perubahan ini layak menjalankan Tier 0 (kode TS/JS / tsconfig). */
export function isTier0RelevantChange(changedFiles: string[]): boolean {
  return changedFiles.some((f) => {
    const base = f.split(/[\\/]/).pop() ?? f;
    if (base === 'tsconfig.json' || /^tsconfig\..*\.json$/.test(base)) return true;
    const lower = f.toLowerCase();
    return TIER0_CODE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  });
}

/** Direktori state host: ~/.ruko/sessions (dapat dioverride untuk test). */
function resolveHostDir(): string {
  return process.env.RUKO_HOST_STATE_DIR
    ? path.resolve(process.env.RUKO_HOST_STATE_DIR)
    : path.join(os.homedir(), '.ruko', 'sessions');
}

/**
 * Mem-bootstrap pipeline keamanan v2.0.0 secara fail-closed:
 * 1. Akuisisi FileLock pada berkas state sesi.
 * 2. Memuat HostState sesi (0600).
 * 3. Menginisialisasi ScopeAmendmentManager.
 * 4. Menyediakan antarmuka evaluateToolCall terpadu ke DispatcherGate.
 */
export async function bootstrapSecurityPipeline(
  options: SecurityPipelineOptions = {},
): Promise<SecurityPipeline> {
  const wsRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const sessionId = options.sessionId ?? crypto.randomBytes(8).toString('hex');

  // Path berkas state: ~/.ruko/sessions/<sessionId>/state.json
  const sessionDir = path.join(resolveHostDir(), sessionId);
  const stateFile = path.join(sessionDir, 'state.json');

  const fileLock = new FileLock(stateFile);
  const releaseLock = await fileLock.acquire({
    timeoutMs: options.timeoutMs ?? 5000,
    force: options.forceUnlock ?? false,
  });

  try {
    const hostState = await loadHostState(sessionId, { resume: options.resume ?? true });

    // Single-Writer State: mutasi state.json dari
    // ScopeAmendmentManager didelegasikan ke mutator terpusat ini dan
    // diserialkan oleh in-process mutex (promise chain). Manager tidak lagi
    // membuat FileLock baru, sehingga tidak ada self-deadlock LOCK_TIMEOUT
    // ketika pipeline sudah memegang lock sesi.
    let stateMutationChain: Promise<unknown> = Promise.resolve();
    const stateMutator: HostStateMutator = (targetSessionId, mutate) => {
      const task = stateMutationChain.then(async () => {
        // Issue #38-4: kontrak nonce yang jelas — kepemilikan divalidasi saat
        // masuk, lalu hook yang sama dipanggil mutator tepat sebelum & sesudah
        // saveHostState, sehingga load→apply→save berada di bawah lock sesi.
        const assertHeld = () => {
          const nonce = fileLock.getCurrentNonce();
          if (!nonce || fileLock.readMetadata()?.nonce !== nonce) {
            throw new Error('SCOPE_LOCK_DENIED: session lock tidak lagi dimiliki pipeline.');
          }
        };
        assertHeld();
        const freshState = await loadHostState(targetSessionId, { resume: false });
        return mutate(freshState, assertHeld);
      });
      stateMutationChain = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    };

    const scopeManager = new ScopeAmendmentManager(hostState, wsRoot, {
      isTTY: options.isTTY ?? process.stdin.isTTY,
      monorepoRoots: options.monorepoRoots,
      stateMutator,
    });

    const pipeline: SecurityPipeline = {
      sessionId,
      workspaceRoot: wsRoot,
      fileLock,
      hostState,
      scopeManager,
      releaseLock,
      evaluateToolCall: async (tool, args, isInteractive) => {
        return evaluateDispatcherGate({
          tool,
          args,
          hostState,
          scopeManager,
          isInteractive: isInteractive ?? (options.isTTY ?? process.stdin.isTTY),
          workspaceRoot: wsRoot,
        });
      },
      // Tier 0 — temuan audit v2.2.0 #4 (TieredGate sebelumnya hanya hidup
      // di test). Fail-closed: segala error saat evaluasi = tidak diizinkan.
      verifyTier0: async (changedFiles) => {
        try {
          // Perubahan lockfile selalu dievaluasi (gate menolaknya sebelum
          // menyentuh tsc) — tidak peduli ada/tidaknya compiler.
          if (hasLockfileChange(changedFiles)) {
            return await new TieredGate(changedFiles, wsRoot).evaluate();
          }
          // Bukan perubahan kode TS/JS → tidak ada yang diverifikasi.
          if (!isTier0RelevantChange(changedFiles)) {
            return { allowed: true, reason: 'SKIPPED_NO_TS_CHANGES', skipped: true };
          }
          // Tidak ada compiler yang terdeteksi → gate tidak berlaku di
          // workspace ini (bukan proyek TypeScript); bukan kegagalan.
          if (!resolveTscJsPath(wsRoot)) {
            return { allowed: true, reason: 'SKIPPED_NO_TYPESCRIPT', skipped: true };
          }
          return await new TieredGate(changedFiles, wsRoot).evaluate();
        } catch {
          return { allowed: false, reason: 'TIER0_GATE_ERROR' };
        }
      },
    };

    return pipeline;
  } catch (err) {
    await releaseLock().catch(() => {});
    throw err;
  }
}
