import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { ExecResult } from '../types.js';
import { summarizeLog } from './summarizer.js';
import { sanitizeTerminalOutput } from './ui.js';
// Fase D (v1.9.0): satu sumber kebenaran pemilihan shell (envProfile.shellFamily).
import { getEnvProfile, type EnvProfile } from './env.js';

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

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Environment variables that a POSIX shell evaluates at STARTUP or before
 * every prompt (M4). They are stripped together with the `BASH_FUNC_*`
 * exports, because a caller-supplied value can hijack every command Ruko runs
 * (`BASH_ENV=/tmp/evil.sh sh -c "true"` executes the payload first).
 */
const DANGEROUS_ENV_VARS = new Set([
  'BASH_ENV', // sourced by bash for every non-interactive shell
  'ENV', // sourced by sh/ksh at startup
  'PROMPT_COMMAND', // executed by bash before each prompt
  'CDPATH', // silently redirects `cd` to an attacker-controlled directory
  'BASH_RCFILE', // alternative bash rc file
]);

// ─────────────────────────────────────────────────────────────────────────────
// Fase D (v1.9.0) — Shell selection: SATU sumber kebenaran.
//
// Pemilihan shell binary kini hanya lewat `resolveShellSelection()` yang membaca
// `envProfile.shellFamily` (EnvProfile dari Fase A). TIDAK ada lagi cek
// `process.platform`/flavor tersebar di banyak tempat.
//
// KONTRAK NON-WIN32 (linux/darwin/wsl/colab/ci/unknown): BIT-IDENTIK dengan
// perilaku sebelum Fase D — binary `/bin/sh`, args `['-c', command]`. Flavor
// TIDAK mengubah pemilihan shell: Termux pun tetap `/bin/sh` (PATH `$PREFIX/bin`
// adalah urusan environment shell; resolusi skrip eksplisit lewat
// `resolveTermuxBin()` di bawah — no-op untuk environment lain).
//
// WIN32 (TAMBAHAN pilihan, perilaku cmd existing dipertahankan):
//  - shellFamily 'cmd'        → ComSpec (fallback cmd.exe) + ['/d','/s','/c', cmd].
//    Delta terdokumentasi: ComSpec kosong/whitespace kini fallback ke cmd.exe
//    (sebelumnya string kosong/whitespace dipakai mentah).
//  - shellFamily 'powershell' → powershell.exe (atau path pwsh bila ComSpec
//    menunjuk pwsh.exe — PS7 terdeteksi) dengan flags:
//    `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`.
//    SCOPE FLAGS: hanya berlaku untuk PROSES powershell child yang di-spawn
//    Ruko ini (process-scoped) — execution policy sistem/machine/user TIDAK
//    diubah. -NoProfile mencegah profil user dieksekusi; -NonInteractive
//    mencegah prompt interaktif menggantung proses; -ExecutionPolicy Bypass
//    agar tidak terhambat policy default Windows pada sesi child ini saja.
// ─────────────────────────────────────────────────────────────────────────────

export interface ShellSelection {
  /** Shell binary (path atau nama). */
  binary: string;
  /** Argumen SEBELUM `command`; command selalu menjadi elemen terakhir args. */
  argsPrefix: string[];
}

/**
 * Resolves shell binary + prefix args dari `envProfile.shellFamily`.
 * Pure — menerima profile & env eksplisit agar mudah dites.
 */
export function resolveShellSelection(
  profile: EnvProfile,
  env: NodeJS.ProcessEnv = process.env,
): ShellSelection {
  if (profile.os === 'win32') {
    if (profile.shellFamily === 'powershell') {
      const comspec = env.ComSpec?.trim() ?? '';
      // ComSpec menunjuk pwsh(.exe) → pakai path itu (PowerShell 7 terdeteksi).
      const isPwsh = /pwsh(?:\.exe)?$/i.test(comspec);
      return {
        binary: isPwsh ? comspec : 'powershell.exe',
        argsPrefix: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'],
      };
    }
    const comspec = env.ComSpec?.trim();
    return { binary: comspec ? comspec : 'cmd.exe', argsPrefix: ['/d', '/s', '/c'] };
  }
  // non-win32: kontrak bit-identik dengan kode sebelum Fase D.
  return { binary: '/bin/sh', argsPrefix: ['-c'] };
}

/** Gabungan selection + command → argumen final untuk spawn. */
export function buildShellInvocation(
  profile: EnvProfile,
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): { binary: string; args: string[] } {
  const sel = resolveShellSelection(profile, env);
  return { binary: sel.binary, args: [...sel.argsPrefix, command] };
}

/**
 * Termux: resolve nama skrip/binari telanjang terhadap `$PREFIX/bin`
 * (`profile.pathPrefix`). No-op untuk environment lain (flavor !== 'termux') —
 * path resolution environment lain TIDAK berubah. Nama yang sudah mengandung
 * separator (path eksplisit) dibiarkan apa adanya.
 */
export function resolveTermuxBin(script: string, profile: EnvProfile): string {
  if (profile.flavor !== 'termux' || !profile.pathPrefix) return script;
  if (!script || script.includes('/') || script.includes('\\')) return script;
  return join(profile.pathPrefix, 'bin', script);
}

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

    // Sanitize environment: discard shell function exports (BASH_FUNC_*) and
    // shell-startup hooks (BASH_ENV/ENV/PROMPT_COMMAND/CDPATH/BASH_RCFILE, M4)
    // that can hijack the command before it even runs.
    const rawEnv = options.env ? { ...process.env, ...options.env } : { ...process.env };
    const cleanEnv: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(rawEnv)) {
      if (k.startsWith('BASH_FUNC_')) continue;
      if (DANGEROUS_ENV_VARS.has(k)) continue;
      cleanEnv[k] = v;
    }

    // Interleaved stream chunk collection for true sequential ordering of stdout & stderr
    const interleavedChunks: string[] = [];

    // Fase D: shell dipilih dari SATU sumber kebenaran (envProfile.shellFamily).
    // Non-win32 hasilnya bit-identik dengan perilaku lama: /bin/sh + ['-c', command].
    const shellSelection = resolveShellSelection(getEnvProfile());
    const shellBinary = shellSelection.binary;
    const shellArgs = [...shellSelection.argsPrefix, command];

    const child = execFile(
      shellBinary,
      shellArgs,
      {
        cwd: options.cwd,
        env: cleanEnv,
        timeout: timeoutMs,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
      },
      (error, rawStdout, rawStderr) => {
        const durationMs = Date.now() - started;
        // `error.code` is the process exit code; `null` when killed by timeout.
        let code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        let stdout = sanitizeTerminalOutput(rawStdout);
        let stderr = sanitizeTerminalOutput(rawStderr);
        let output = interleavedChunks.length > 0
          ? sanitizeTerminalOutput(interleavedChunks.join(''))
          : [stdout, stderr].filter(Boolean).join('\n');

        // Check if process was killed by timeout
        const killedByTimeout = Boolean(
          error && (error.killed || (error as any).signal === 'SIGTERM') && durationMs >= Math.max(0, timeoutMs - 1500),
        );
        // Standard timeout exit code is 124
        if (killedByTimeout && code === null) {
          code = 124;
        }
        if (killedByTimeout) {
          const timeoutMsg =
            `\n[Command dihentikan: waktu eksekusi melebihi batas timeout ${timeoutMs}ms (${Math.round(timeoutMs / 1000)}s). ` +
            `Gunakan parameter timeoutMs lebih besar jika command membutuhkan waktu lebih lama, atau gunakan start_process untuk proses latar belakang.]`;
          output = output ? `${output}\n${timeoutMsg}` : timeoutMsg;
          stderr = stderr ? `${stderr}\n${timeoutMsg}` : timeoutMsg;
        }

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

    child.stdout?.on('data', (chunk) => {
      interleavedChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk) => {
      interleavedChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    // v0.7: an interrupted turn kills its shell child (SIGKILL so grandchildren
    // die too) — the callback above still resolves with what was captured.
    // Fix: track abort listener and remove it when child exits to prevent leak.
    let abortHandler: (() => void) | null = null;
    if (options.signal) {
      if (options.signal.aborted) {
        child.kill('SIGKILL');
      } else {
        abortHandler = () => child.kill('SIGKILL');
        options.signal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    // Cleanup abort listener when child finishes (success or error)
    const cleanupAbort = () => {
      if (abortHandler && options.signal) {
        try {
          options.signal.removeEventListener('abort', abortHandler);
        } catch {
          // ignore
        }
        abortHandler = null;
      }
    };

    child.on('exit', cleanupAbort);
    child.on('error', cleanupAbort);
  });
}