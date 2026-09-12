import { exec } from 'node:child_process';
import { ExecResult } from '../types.js';
import { summarizeLog } from './summarizer.js';

export interface ExecOptions {
  timeoutMs?: number;
  /** Max bytes of captured output (stdout+stderr) before Node kills the pipe. */
  maxBuffer?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Apply the log summarizer to the captured output (default: true). */
  summarize?: boolean;
  maxLogChars?: number;
  /**
   * v0.7 live input: firing this kills the running child so an interrupted
   * turn stops its shell work instead of leaving it running behind the REPL.
   */
  signal?: AbortSignal;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Runs a shell command and returns its output, exit code and duration.
 *
 * The captured output is passed through the Log Summarizer by default so a
 * single huge log (e.g. a build log) never floods the agent's context.
 */
export function execute(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const started = Date.now();

    const child = exec(
      command,
      {
        cwd: options.cwd,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        timeout: timeoutMs,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - started;
        // `error.code` is the process exit code; `null` when killed by timeout.
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        let output = [stdout, stderr].filter(Boolean).join('\n');

        let truncated = false;

        if (options.summarize !== false) {
          const so = summarizeLog(stdout, options.maxLogChars);
          const se = summarizeLog(stderr, options.maxLogChars);
          const oo = summarizeLog(output, options.maxLogChars);
          if (so.truncated) {
            stdout = so.summary;
            truncated = true;
          }
          if (se.truncated) {
            stderr = se.summary;
            truncated = true;
          }
          if (oo.truncated) {
            output = oo.summary;
            truncated = true;
          }
        }

        resolve({
          command,
          code,
          stdout,
          stderr,
          output,
          durationMs,
          truncated,
        });
      },
    );

    // v0.7: an interrupted turn kills its shell child (SIGKILL so grandchildren
    // die too) — the callback above still resolves with what was captured.
    if (options.signal) {
      if (options.signal.aborted) child.kill('SIGKILL');
      else options.signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    }
  });
}