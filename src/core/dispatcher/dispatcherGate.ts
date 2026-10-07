/**
 * dispatcherGate.ts — F2-T1 (Fase 2, Blueprint v2.0.0)
 *
 * Dispatcher Gate Lock di Hulu Pipeline:
 * Gerbang evaluasi hulu paling awal pada dispatcher tool sebelum instruksi
 * diproses atau menyentuh sistem berkas / subprocess.
 *
 * Invarian (PROGRESS2.md / Blueprint DoD #1 & #2):
 *  1. Host-Governed Invariant: Seluruh mutasi disk dan eksekusi subprocess
 *     tertolak mekanis di level dispatcher selama Plan Mode aktif.
 *     Flag /yolo (approvalEnabled: false) terbukti TIDAK MAMPU membatalkan
 *     batasan plan mode ini.
 *  2. Kriptografi Kontrak Scope: Dalam mode 'act', mutasi berkas di luar
 *     subtree yang disetujui dievaluasi melalui ScopeAmendmentManager.
 *
 * ZERO dependency — hanya `node:*`.
 */

import { HostState } from '../state/hostState.js';
import { ScopeAmendmentManager } from '../approval/scopeAmendment.js';

export const MUTATION_AND_SUBPROCESS_TOOLS = new Set([
  'exec',
  'start_process',
  'write_file',
  'edit_file',
  'patch_file',
  'delete_file',
  'move_file',
  'revert_file',
  'remember',
  'save_skill',
  'delete_skill',
]);

export interface DispatcherGateOptions {
  tool: string;
  args?: Record<string, any>;
  hostState?: HostState | null;
  planMode?: boolean;
  yoloMode?: boolean;
  scopeManager?: ScopeAmendmentManager | null;
  isInteractive?: boolean;
  workspaceRoot?: string;
}

export interface DispatcherGateDecision {
  allowed: boolean;
  reason?: string;
}

export function isPlanModeBlockedTool(tool: string): boolean {
  return MUTATION_AND_SUBPROCESS_TOOLS.has(tool);
}

export async function evaluateDispatcherGate(
  opts: DispatcherGateOptions,
): Promise<DispatcherGateDecision> {
  const isPlanMode = opts.hostState ? opts.hostState.mode === 'plan' : Boolean(opts.planMode);

  // 1. Host-Governed Invariant (DoD #1):
  // Plan Mode memblokir mekanis seluruh mutasi disk dan eksekusi subprocess.
  // Flag /yolo (yoloMode: true / approvalEnabled: false) tidak dapat membypass ini.
  if (isPlanMode && isPlanModeBlockedTool(opts.tool)) {
    return {
      allowed: false,
      reason: `plan mode aktif: tool "${opts.tool}" diblok (hanya baca yang boleh). Matikan dengan /plan off setelah rencana disetujui.`,
    };
  }

  // 2. Evaluasi Scope Amendment jika ScopeAmendmentManager tersedia
  if (opts.scopeManager && isMutationTool(opts.tool)) {
    const targetPath = extractTargetPath(opts.tool, opts.args || {});
    if (targetPath) {
      const allowed = await opts.scopeManager.evaluateMutationTarget(
        targetPath,
        opts.args?.reason || `Mutasi berkas via ${opts.tool}`,
        Boolean(opts.isInteractive),
        // WP-05: binding persetujuan + tampilan fakta teknis memakai nama tool
        // dan muatan argumen asli (referensi, dibandingkan ulang pasca-konfirmasi).
        { tool: opts.tool, args: opts.args },
      );
      if (!allowed) {
        return {
          allowed: false,
          reason: `SECURITY_DENIED: Target mutasi di luar scope yang diizinkan (${targetPath})`,
        };
      }
    }
  }

  return { allowed: true };
}

function isMutationTool(tool: string): boolean {
  return (
    tool === 'write_file' ||
    tool === 'edit_file' ||
    tool === 'patch_file' ||
    tool === 'delete_file' ||
    tool === 'move_file' ||
    tool === 'revert_file'
  );
}

function extractTargetPath(tool: string, args: Record<string, any>): string | null {
  if (tool === 'move_file') {
    return args.destination || args.targetPath || args.path || null;
  }
  return args.path || args.file || args.targetPath || null;
}
