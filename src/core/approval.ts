import { AgentConfig, ExecResult } from '../types.js';
import { execute } from './executor.js';

/**
 * Approval gate — blocks or asks before running risky shell commands.
 *
 * Three risk levels:
 *  - 'none'      → run immediately
 *  - 'dangerous' → ask the user (y/N) via the provided Confirmer
 *  - 'blocked'   → always refuse (destructive patterns like rm -rf /, mkfs, dd)
 *
 * Bypasses: `approvalEnabled: false`, `RUKO_YOLO_MODE=1`, or an allowlist match.
 */

export type RiskLevel = 'none' | 'dangerous' | 'blocked';

export interface RiskVerdict {
  risk: RiskLevel;
  reason: string | null;
}

/** Always-refused patterns (hardline). */
const BLOCKED_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\brm\s+-rf\s+\/(\s|$)/i, 'rm -rf / (menghapus seluruh filesystem)'],
  [/\bmkfs\b/i, 'mkfs (memformat filesystem)'],
  [/\bdd\s+if=.*\bof=\/dev\/(sd|nvme|hd)/i, 'dd menimpa disk fisik'],
  [/\bof=\/dev\/(sd|nvme|hd)[a-z0-9]*/i, 'menulis langsung ke perangkat disk'],
  [/:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;/i, 'fork bomb'],
];

/** Ask-the-user patterns (dangerous but sometimes legitimate). */
const DANGEROUS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\brm\s+-[a-z]*r[a-z]*f?/i, 'rm -r* (menghapus file secara permanen)'],
  [/\bsudo(\s|$)/i, 'sudo (privilege escalation)'],
  [/\bgit\s+push(\s|$)/i, 'git push (mengubah remote repository)'],
  [/\bgit\s+reset\s+--hard\b/i, 'git reset --hard (menghapus kerja lokal)'],
  [/\bgit\s+clean\s+-f[d]*\b/i, 'git clean -f (menghapus file untracked)'],
  [/\bchmod\s+-R\s+[0-7]{3}\b/i, 'chmod -R (permission massal)'],
  [/\bkill\s+-9\b/i, 'kill -9 (memaksa mematikan proses)'],
  [/\b(shutdown|poweroff|reboot|halt)(\s|$)/i, 'mematikan/men-restart mesin'],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/i, 'pipe ke shell (eksekusi kode tak dikenal)'],
];

/** Classifies a shell command. */
export function detectRisk(command: string, config: AgentConfig): RiskVerdict {
  if (!config.approvalEnabled || isYoloMode()) {
    return { risk: 'none', reason: null };
  }
  for (const allow of config.approvalAllowlist) {
    if (command.trim() === allow || command.includes(allow)) {
      return { risk: 'none', reason: null };
    }
  }
  for (const [re, reason] of BLOCKED_PATTERNS) {
    if (re.test(command)) return { risk: 'blocked', reason };
  }
  for (const [re, reason] of DANGEROUS_PATTERNS) {
    if (re.test(command)) return { risk: 'dangerous', reason };
  }
  return { risk: 'none', reason: null };
}

/** True when RUKO_YOLO_MODE is set to a truthy value. */
export function isYoloMode(): boolean {
  return /^(1|true|yes|on|y)$/i.test(process.env.RUKO_YOLO_MODE ?? '');
}

/** User confirmation hook; returns true to allow execution. */
export type Confirmer = (command: string, reason: string) => Promise<boolean>;

export interface GuardOptions {
  /** Prompt hook; when null/absent, dangerous commands are refused. */
  confirm?: Confirmer | null;
  timeoutMs?: number;
  summarize?: boolean;
}

/**
 * Runs a command through the approval gate, then executes it.
 * Denied/blocked commands resolve with a synthetic non-zero result.
 */
export async function guardedExecute(
  command: string,
  options: GuardOptions,
  config: AgentConfig,
): Promise<ExecResult> {
  const verdict = detectRisk(command, config);
  if (verdict.risk !== 'none') {
    const reason = verdict.reason ?? 'unknown risk';
    if (verdict.risk === 'blocked' || !options.confirm) {
      return denialResult(command, reason, verdict.risk);
    }
    const ok = await options.confirm(command, reason);
    if (!ok) return denialResult(command, reason, verdict.risk);
  }
  return execute(command, {
    timeoutMs: options.timeoutMs,
    summarize: options.summarize,
  });
}

function denialResult(command: string, reason: string, level: RiskLevel): ExecResult {
  const message =
    level === 'blocked'
      ? `[BLOCKED oleh Ruko: ${reason}]`
      : `[Persetujuan ditolak: ${reason}]`;
  return {
    command,
    code: null,
    stdout: '',
    stderr: message,
    output: message,
    durationMs: 0,
    truncated: false,
  };
}