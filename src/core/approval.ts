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
 *
 * Chain semantics: a command joined by ; && || | is split into segments.
 * Every segment is evaluated independently; the STRICTEST level wins
 * (BLOCKED beats DANGEROUS beats NONE). This prevents wrapping a blocked
 * command inside an innocent prefix to downgrade its risk level.
 *
 * Quote normalisation: each segment is also tested with shell quotes (", ', `)
 * stripped, so e.g. `bash -c "rm -rf /etc"` is still caught as BLOCKED.
 *
 * Interpreter inline flag: commands that invoke an interpreter with an inline
 * execution flag (python -c, node -e, perl -e, ruby -e, php -r, lua -e) are
 * automatically elevated to DANGEROUS because their payload cannot be
 * statically verified with regex.
 *
 * Known limitation: variable indirection ($X where X=/etc), eval/subshell
 * obfuscation (eval "$(…)"), and semantic analysis of interpreter payloads
 * (e.g. shutil.rmtree without literal "rm") cannot be reliably caught with
 * regex. Treat as a roadmap item for an LLM-based approval guardian.
 */

export type RiskLevel = 'none' | 'dangerous' | 'blocked';

export interface RiskVerdict {
  risk: RiskLevel;
  reason: string | null;
}

/** Numeric ordering for risk comparison. */
const RISK_RANK: Record<RiskLevel, number> = { none: 0, dangerous: 1, blocked: 2 };

// ─────────────────────────────────────────────────────────────────────────────
// BLOCKED_PATTERNS — always refused, no override possible
//
// rm coverage:
//   Flags  : -rf | -fr | -r -f | -f -r | --recursive [--force] | --force --recursive
//   Paths  : / | /* | /etc | /bin | /usr | /lib[64] | /boot | /sys | /proc |
//            /var | /dev | /home | /root | /run | /opt | /srv |
//            ~ | $HOME | $USER (and any sub-path thereof)
//   Special: --no-preserve-root (explicit bypass of root guard)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Matches `rm` with a recursive+force flag combination.
 * Flag forms:   -rf | -fr  (combined, any order, any extra letters e.g. -rfv)
 *               -r -f | -f -r  (separate short flags)
 *               --recursive [--force] | --force --recursive
 * Followed by any number of extra flags (--verbose, --interactive, …),
 * then a critical path.
 */
const RM_CRITICAL_RE =
  /\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|-[rR]\s+-[fF]|-[fF]\s+-[rR]|--recursive(?:\s+--force)?|--force\s+--recursive)(?:\s+--?\S+)*\s+(?:\/[*]?(?:\s|$)|\/(?:etc|bin|usr|lib(?:64)?|boot|sys|proc|var|dev|home|root|run|opt|srv)(?:[\/\s*]|$)|~(?:\/|\s|$)|\$(?:HOME|USER)(?:\/|\s|$))/i;

/** Always-refused patterns (hardline). */
const BLOCKED_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // rm destruktif ke root, wildcard root, atau direktori sistem/home kritis
  [RM_CRITICAL_RE, 'rm destruktif ke path sistem/home kritis'],
  // rm dengan --no-preserve-root (melewati perlindungan root secara eksplisit)
  [/\brm\b[^|;&\n]*--no-preserve-root/i, 'rm --no-preserve-root (melewati proteksi root)'],
  // Format filesystem
  [/\bmkfs\b/i, 'mkfs (memformat filesystem)'],
  // dd menimpa disk fisik
  [/\bdd\s+if=.*\bof=\/dev\/(sd|nvme|hd|disk)/i, 'dd menimpa disk fisik'],
  [/\bof=\/dev\/(sd|nvme|hd|disk)\S*/i, 'menulis langsung ke perangkat disk'],
  // Fork bomb — pola klasik :(){ :|:& };:
  [/:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;/i, 'fork bomb klasik'],
  // Fork bomb — nama fungsi kustom: f(){ f|f& };f  atau  bomb(){ bomb|bomb& };bomb
  [/\b(\w+)\s*\(\s*\)\s*\{\s*\1\s*[|]\s*\1\s*[&]\s*\}\s*;\s*\1/i, 'fork bomb (fungsi kustom)'],
  // Redirect (>, >>) ke perangkat disk — echo x > /dev/sda, cat y >> /dev/nvme0n1
  [/>{1,2}\s*\/dev\/(sd|nvme|hd|disk)\S*/i, 'redirect ke perangkat disk'],
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
  [/\bbase64\b[^|]*\|\s*(ba|z)?sh\b/i, 'base64 decode ke shell (eksekusi kode tersembunyi)'],
  // Interpreter dengan flag eksekusi inline — konten tidak dapat diverifikasi
  // oleh regex, jadi minimal minta konfirmasi manusia.
  [/\b(?:python[23]?\s+-c|(?:node|perl|ruby|lua)\s+-e|php\s+-r)\b/i, 'interpreter inline execution (konten tidak dapat diverifikasi)'],
];

/**
 * Splits a shell command on chain operators (;  &&  ||  |) into individual
 * segments. Both the full original command AND each extracted segment are
 * evaluated, so a destructive sub-command cannot hide inside an innocent
 * wrapper to lower its risk level.
 */
function chainedSegments(command: string): string[] {
  const parts = command.split(/\s*(?:&&|\|\|?|;)\s*/).map(s => s.trim()).filter(Boolean);
  // Include the full command too — catches patterns that span the join point
  // (e.g. existing DANGEROUS pattern for curl … | sh).
  return [command, ...parts];
}

/**
 * Returns the segment itself plus a quote-stripped variant (if different).
 * Shell quotes can hide destructive commands from regex detection
 * (e.g. bash -c "rm -rf /etc" — the quotes prevent the BLOCKED path
 * terminator from matching). By testing both the original and stripped
 * version, wrapped commands are properly classified.
 */
function testCandidates(segment: string): string[] {
  const stripped = segment.replace(/["'`]/g, '');
  return stripped !== segment ? [segment, stripped] : [segment];
}

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

  let worst: RiskVerdict = { risk: 'none', reason: null };

  for (const seg of chainedSegments(command)) {
    const candidates = testCandidates(seg);
    // BLOCKED is the highest level — return immediately if found.
    for (const candidate of candidates) {
      for (const [re, reason] of BLOCKED_PATTERNS) {
        if (re.test(candidate)) return { risk: 'blocked', reason };
      }
    }
    // Accumulate DANGEROUS only if we haven't already found something worse.
    if (RISK_RANK[worst.risk] < RISK_RANK.dangerous) {
      for (const candidate of candidates) {
        for (const [re, reason] of DANGEROUS_PATTERNS) {
          if (re.test(candidate)) {
            worst = { risk: 'dangerous', reason };
            break;
          }
        }
        if (worst.risk === 'dangerous') break;
      }
    }
  }

  return worst;
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
  /** v0.7: abort signal that kills the child when the turn is interrupted. */
  signal?: AbortSignal;
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
    signal: options.signal,
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