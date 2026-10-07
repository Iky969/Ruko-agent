import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { ExecResult } from '../types.js';
import { summarizeLog } from './summarizer.js';
import { sanitizeTerminalOutput } from './ui.js';
// Fase D (v1.9.0): satu sumber kebenaran pemilihan shell (envProfile.shellFamily).
import { getEnvProfile, type EnvProfile } from './env.js';
// Tree kill lintas platform (fix zombie grandchild Windows).
import { killProcessTree } from './treeKill.js';

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
 * every prompt (M4), as well as runtime loader/process injection variables
 * (ADIT.md §1.3, UCUP.md §1.3). They are stripped together with the `BASH_FUNC_*`
 * exports, because a caller-supplied value can hijack every command Ruko runs
 * (`BASH_ENV=/tmp/evil.sh sh -c "true"` executes the payload first).
 */
export const DANGEROUS_ENV_VARS = new Set([
  // POSIX shell startup hooks
  'BASH_ENV', // sourced by bash for every non-interactive shell
  'ENV', // sourced by sh/ksh at startup
  'PROMPT_COMMAND', // executed by bash before each prompt
  'CDPATH', // silently redirects `cd` to an attacker-controlled directory
  'BASH_RCFILE', // alternative bash rc file
  'ZDOTDIR',

  // Node runtime injection
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_PATH',
  'NODE_V8_COVERAGE',

  // OS dynamic linker / loader injection
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',

  // Interpreter startup / module-path injection lintas bahasa (issue #31).
  // Setiap variabel di bawah dibaca interpreter SEBELUM skrip user berjalan,
  // sehingga nilai dari caller/.env repo asing = eksekusi kode arbitrer pada
  // perintah `python`/`perl`/`ruby` apa pun yang dijalankan agen.
  'PYTHONSTARTUP', // file dieksekusi saat interpreter interaktif start
  'PYTHONPATH', // prepend sys.path → shadowing modul stdlib (mis. os.py palsu)
  'PYTHONWARNINGS', // filter `-W` → import kategori warning arbitrer (gadget RCE)
  'PERL5OPT', // opsi CLI implisit, mis. `-Mevil` / `-e` → RCE
  'PERL5LIB', // prepend @INC → shadowing modul Perl
  'RUBYOPT', // opsi CLI implisit, mis. `-revil` → require arbitrer
  'RUBYLIB', // prepend $LOAD_PATH → shadowing library Ruby
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
      if (DANGEROUS_ENV_VARS.has(k) || k.startsWith('DYLD_')) continue;
      cleanEnv[k] = v;
    }

    // Interleaved stream chunk collection for true sequential ordering of stdout & stderr
    const interleavedChunks: string[] = [];

    // Fase D: shell dipilih dari SATU sumber kebenaran (envProfile.shellFamily).
    // Non-win32 hasilnya bit-identik dengan perilaku lama: /bin/sh + ['-c', command].
    const envProfile = getEnvProfile();
    const shellSelection = resolveShellSelection(envProfile);
    let shellBinary = shellSelection.binary;
    let shellArgs = [...shellSelection.argsPrefix, command];

    // PERBAIKAN (Windows): cmd.exe dengan /S melepas SEPASANG kutip luar dari
    // command. Untuk perintah yang mengandung kutip (mis. `node -e "log('x')"`),
    // aturan strip kutip membuat `node` menerima argumen terpotong — tanpa
    // argumen skrip yang valid ia masuk mode REPL interaktif: menunggu stdin,
    // output kosong, proses TIDAK PERNAH exit (di CI = hang sampai timeout;
    // sumber hang 20 menit + 31 test gagal pada log job Windows).
    // Solusi standar Windows: tambahkan sepasang kutip luar EKSKLUSIF untuk
    // dikonsumsi aturan /S — command dalam sampai ke node utuh:
    //   cmd /d /s /c "node -e "log('x')""  →  node -e "log('x')"
    // Hanya diterapkan pada jalur runtime cmd; helper pure
    // `buildShellInvocation()` tidak berubah (test paritas tetap valid).
    if (
      process.platform === 'win32' &&
      envProfile.shellFamily === 'cmd' &&
      command.includes('"')
    ) {
      shellArgs = [...shellSelection.argsPrefix, `"${command}"`];
    }

    // Timeout di-OWN sendiri (bukan opsi `timeout` bawaan Node) supaya kill-nya
    // bisa tree-aware. Opsi bawaan Node hanya mengirim sinyal ke child shell,
    // sehingga grandchild-nya tertinggal hidup setelah timeout.
    let killTimer: NodeJS.Timeout | null = null;
    let timedOut = false;

    const child = execFile(
      shellBinary,
      shellArgs,
      {
        cwd: options.cwd,
        env: cleanEnv,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
        // Windows: kirim command VERBATIM ke cmd.exe — persis seperti
        // `cmd /d /s /c <command>` yang diketik manual. Tanpa flag ini Node
        // meng-escape argumen dengan aturan C-runtime (mis. `"` → `\"`)
        // yang tidak dikenali cmd.exe, sehingga quote di dalam perintah
        // (`node -e "..."`, `git commit -m "msg"`) rusak/terpotong saat
        // eksekusi di Windows.
        //
        // PERBAIKAN: flag ini HANYA untuk cmd.exe. powershell.exe justru
        // PECAH dengan windowsVerbatimArguments (melanggar aturan quoting
        // C-runtime-nya sendiri: inner quote hilang → `node -e "..."` gagal
        // dengan output kosong), dan flag ini diabaikan penuh di Linux/macOS.
        windowsVerbatimArguments:
          process.platform === 'win32' && envProfile.shellFamily === 'cmd',
      },
      (error, rawStdout, rawStderr) => {
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        const durationMs = Date.now() - started;
        // `error.code` is the process exit code; `null` when killed by timeout.
        let code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        let stdout = sanitizeTerminalOutput(rawStdout);
        let stderr = sanitizeTerminalOutput(rawStderr);
        let output = interleavedChunks.length > 0
          ? sanitizeTerminalOutput(interleavedChunks.join(''))
          : [stdout, stderr].filter(Boolean).join('\n');

        // Check if process was killed by timeout (flag internal lebih akurat;
        // heuristik lama dipertahankan sebagai jaring pengaman).
        const killedByTimeout =
          timedOut ||
          Boolean(
            error && (error.killed || (error as any).signal === 'SIGTERM') && durationMs >= Math.max(0, timeoutMs - 1500),
          );
        // Standard timeout exit code is 124.
        //
        // PERBAIKAN (Windows): `code` TIDAK selalu null saat timeout.
        //  1) taskkill (/F) mematikan shell secara paksa — di cmd.exe/some
        //     shell exit code proses yang di-terminate bisa 1 (bukan null);
        //  2) windowsVerbatimArguments cmd.exe bisa salah mengurai command
        //     kompleks (exit 1) — tanpa flag timedOut, kondisi race halus.
        // Tandai timeout bila timedOut ATAU (heuristik sinyal SIGTERM + durasi).
        if (killedByTimeout) {
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

    // Timeout tree-aware: membunuh grandchild, bukan hanya child shell.
    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        // execFile TIDAK detached → shell bukan pemimpin process group, jadi
        // `processGroup: false` menjaga perilaku non-win32 tetap `child.kill()`
        // (bit-identik dengan sebelumnya), sementara Windows memakai
        // `taskkill /PID <pid> /T /F` yang memang membunuh seluruh tree.
        void killProcessTree(child.pid ?? -1, { force: true, processGroup: false, child });
        // PENTING: callback execFile baru dipanggil setelah SEMUA pipe tertutup.
        // Di POSIX grandchild (mis. `sleep 5` di balik `/bin/sh -c`) bisa masih
        // memegang pipe itu, sehingga hasil timeout tertahan sampai proses itu
        // selesai sendiri. Opsi `timeout` bawaan Node dulu menutup pipe ini,
        // jadi penutupan eksplisit diperlukan agar semantik timeout tidak berubah
        // (durasi tetap ~timeoutMs, bukan durasi proses grandchild).
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, timeoutMs);
    }

    // v0.7: an interrupted turn kills its shell work instead of leaving it
    // running behind the REPL — the callback above still resolves with what was
    // captured. Track abort listener and remove it on child exit to prevent leak.
    //
    // KOREKSI KOMENTAR LAMA ("SIGKILL so grandchildren die too"): itu TIDAK
    // akurat — `child.kill()` hanya mengirim sinyal ke PID child, sehingga
    // grandchild TETAP hidup. Grandchild ikut mati lewat tree kill di Windows
    // (`taskkill /T /F`) di bawah; pada POSIX di sini perilaku lama dipertahankan
    // karena shell bukan group leader (execFile non-detached).
    let abortHandler: (() => void) | null = null;
    if (options.signal) {
      if (options.signal.aborted) {
        void killProcessTree(child.pid ?? -1, { force: true, processGroup: false, child });
      } else {
        abortHandler = () => {
          void killProcessTree(child.pid ?? -1, { force: true, processGroup: false, child });
        };
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