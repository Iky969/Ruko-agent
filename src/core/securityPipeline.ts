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
import { HostState, loadHostState, saveHostState } from './state/hostState.js';
import { ScopeAmendmentManager } from './approval/scopeAmendment.js';
import { evaluateDispatcherGate, DispatcherGateDecision } from './dispatcher/dispatcherGate.js';

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
    const scopeManager = new ScopeAmendmentManager(hostState, wsRoot, {
      isTTY: options.isTTY ?? process.stdin.isTTY,
      monorepoRoots: options.monorepoRoots,
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
    };

    return pipeline;
  } catch (err) {
    await releaseLock().catch(() => {});
    throw err;
  }
}
