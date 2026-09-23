import { Context } from '../core/context.js';
import type { ActivityTray } from '../core/activity.js';
import { Agent } from './agent.js';
import { AgentConfig } from '../types.js';
import { LLMProvider } from './llm.js';
import { Confirmer, decodePathSafely } from '../core/approval.js';
import { listSnapshots, undoLast } from '../core/undo.js';

/**
 * Subagent delegation runner (Roadmap #3).
 *
 * Spawns an isolated subagent instance with its own fresh Context to solve
 * a self-contained sub-problem or research query, and returns the final
 * condensed answer back to the parent turn to conserve context window.
 */

export interface SubagentOptions {
  /** Maximum tool iterations for the subagent (default 5). */
  maxIterations?: number;
  /** Role for the subagent (default: 'minimal' for concise token-efficient output). */
  role?: string;
  /** Workspace root directory boundary. */
  workspaceRoot?: string;
  /** Plan mode inheritance. */
  planMode?: boolean;
  /** Delegation nesting depth. */
  depth?: number;
  /** Cumulative timeout limit in ms (default: 60_000ms). */
  timeoutMs?: number;
}

export interface SubagentDeps {
  config: AgentConfig;
  llmProvider: LLMProvider;
  confirm?: Confirmer | null;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
  /** Parent's live activity tray (feedback §4) — inherited, never replaced. */
  activityTray?: ActivityTray;
}

/**
 * Checks if a string or subagent task attempts to access sensitive files.
 * Handles URL-encoding and escape sequences.
 */
export function containsSensitiveFilePattern(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const decoded = decodePathSafely(text).toLowerCase();
  const unescaped = decoded.replace(/\\([^\s])/g, '$1');
  const candidates = [decoded, unescaped];

  for (const c of candidates) {
    if (/\.ruko[/\\]config\.json\b/i.test(c)) return true;
    if (/\.ruko[/\\]trusted\b/i.test(c)) return true;
    if (/\.git-credentials\b/i.test(c)) return true;
    if (/(?:^|\s|["'/\\])\.env(?:\.[a-zA-Z0-9_-]+)?\b/i.test(c)) return true;
    if (/\b(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)\b/i.test(c)) return true;
    if (/\.(?:pem|key)\b/i.test(c)) return true;
    if (/\.git[/\\]config\b/i.test(c)) return true;
    if (/(?:^|\s|["'/\\])\.(?:bashrc|bash_profile|bash_login|bash_logout|zshrc|zprofile|zshenv|zlogin|zlogout|profile)(?:\.[a-zA-Z0-9_-]+)?\b/i.test(c)) return true;
  }
  return false;
}

export async function runSubagent(
  task: string,
  deps: SubagentDeps,
  options: SubagentOptions = {},
): Promise<string> {
  // Security interceptor: reject tasks that attempt to access or exfiltrate sensitive files
  if (containsSensitiveFilePattern(task)) {
    return 'Maaf, subagent ditolak: tugas mencoba mengakses atau mereferensikan berkas sensitif (.ruko/config.json, .ruko/trusted, .env, .git-credentials, atau kunci SSH). Akses ditolak demi keamanan kredensial.';
  }

  // Create an isolated subagent context
  const subConfig: AgentConfig = {
    ...deps.config,
    role: options.role ?? 'minimal',
    maxContextChars: Math.min(deps.config.maxContextChars, 20_000),
    maxToolIterations: options.maxIterations ?? deps.config.maxToolIterations,
  };

  const subCtx = new Context(subConfig);
  const subAgent = new Agent(
    subCtx,
    deps.llmProvider,
    subConfig,
    deps.confirm,
    options.workspaceRoot,
    options.depth ?? 1,
  );
  if (options.planMode) {
    subAgent.planMode = true;
  }
  // Feedback §4: the subagent's running tools show up in the PARENT's tray,
  // so delegation is visible live instead of silently occupying the terminal.
  if (deps.activityTray) {
    subAgent.activityTray = deps.activityTray;
  }

  const prompt =
    `You are a delegated subagent working on a focused task.\n` +
    `Task: ${task}\n` +
    `Instructions: Solve the task using tools if necessary and provide a concise, direct summary of your findings or results.`;

  const timeoutMs = options.timeoutMs ?? 60_000;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let isTimedOut = false;

  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timer = setTimeout(() => {
      isTimedOut = true;
      controller.abort(new Error(`Subagent exceeded timeout limit of ${timeoutMs}ms`));
    }, timeoutMs);
  }

  const onParentAbort = () => {
    controller.abort(deps.signal?.reason);
  };

  if (deps.signal) {
    if (deps.signal.aborted) {
      controller.abort(deps.signal.reason);
    } else {
      deps.signal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  // Item 5: Track file modifications via undo snapshots — capture state before subagent runs
  const snapshotsBefore = new Set(listSnapshots().map(s => s.id));

  try {
    const result = await subAgent.handleInstruction(prompt, controller.signal);
    if (isTimedOut) {
      return buildTimeoutReport(timeoutMs, snapshotsBefore, deps.onLog);
    }
    if (controller.signal.aborted && deps.signal?.aborted) {
      return '(subagent cancelled)';
    }
    return result.trim() || '(subagent finished without output)';
  } catch (err: unknown) {
    if (isTimedOut) {
      return buildTimeoutReport(timeoutMs, snapshotsBefore, deps.onLog);
    }
    if (controller.signal.aborted && deps.signal?.aborted) {
      return '(subagent cancelled)';
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (deps.signal) {
      deps.signal.removeEventListener('abort', onParentAbort);
    }
  }
}

/**
 * Item 5: Builds a detailed timeout report listing files modified during
 * a timed-out subagent execution and advising on rollback options.
 *
 * Uses the undo snapshot system to compare pre- and post-execution state.
 * This eliminates the need for manual `git status` / `git diff` inspection.
 */
function buildTimeoutReport(
  timeoutMs: number,
  snapshotsBefore: Set<string>,
  onLog?: (line: string) => void,
): string {
  const snapshotsAfter = listSnapshots();
  const newSnapshots = snapshotsAfter.filter(s => !snapshotsBefore.has(s.id));

  const lines: string[] = [
    `(subagent execution timed out after ${timeoutMs}ms)`,
  ];

  if (newSnapshots.length === 0) {
    lines.push('Tidak ada file yang termodifikasi selama subagent berjalan — tidak perlu rollback.');
  } else {
    // Deduplicate by absolute path (multiple edits to same file → one entry)
    const modifiedFiles = [...new Set(newSnapshots.map(s => s.abs))];

    lines.push('');
    lines.push(`⚠ ${modifiedFiles.length} file termodifikasi oleh subagent sebelum timeout:`);
    for (const f of modifiedFiles) {
      lines.push(`  • ${f}`);
    }
    lines.push('');
    lines.push('Opsi rollback:');
    lines.push('  • Ketik /undo untuk membatalkan perubahan terakhir satu per satu.');
    lines.push(`  • Ketik /undo <path> untuk membatalkan perubahan file spesifik.`);
    lines.push('  • Atau periksa perubahan dengan: git diff (jika menggunakan Git).');

    // Also log to the parent's activity tree if available
    if (onLog) {
      onLog(`⚠ Subagent timeout — ${modifiedFiles.length} file berubah: ${modifiedFiles.join(', ')}`);
    }
  }

  return lines.join('\n');
}

