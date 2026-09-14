import { Context } from '../core/context.js';
import { Agent } from './agent.js';
import { AgentConfig } from '../types.js';
import { LLMProvider } from './llm.js';
import { Confirmer, decodePathSafely } from '../core/approval.js';

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
    return 'Maaf, subagent ditolak: tugas mencoba mengakses atau mereferensikan berkas sensitif (.ruko/config.json, .env, .git-credentials, atau kunci SSH). Akses ditolak demi keamanan kredensial.';
  }

  // Create an isolated subagent context
  const subConfig: AgentConfig = {
    ...deps.config,
    role: options.role ?? 'minimal',
    maxContextChars: Math.min(deps.config.maxContextChars, 20_000),
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

  try {
    const result = await subAgent.handleInstruction(prompt, controller.signal);
    if (isTimedOut) {
      return `(subagent execution timed out after ${timeoutMs}ms)`;
    }
    if (controller.signal.aborted && deps.signal?.aborted) {
      return '(subagent cancelled)';
    }
    return result.trim() || '(subagent finished without output)';
  } catch (err: unknown) {
    if (isTimedOut) {
      return `(subagent execution timed out after ${timeoutMs}ms)`;
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
