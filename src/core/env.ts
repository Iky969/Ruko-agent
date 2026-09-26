/**
 * env.ts — Environment Detection Module (Fase A, v1.9.0)
 *
 * Deteksi murni 3-dimensi: `os` → `shellFamily` → `flavor`.
 * TIDAK ada rule pack/pattern destruktif di sini — modul ini murni
 * deteksi (pure detection) agar tetap mudah di-review. Pattern
 * PowerShell masuk Fase C (approval.ts), pemilihan shell masuk
 * Fase D (executor.ts).
 *
 * Zero runtime dependency — hanya built-in `node:os`.
 *
 * ============================================================
 * ENV VAR YANG DICEK PER FLAVOR (dokumentasi fail-closed)
 * ============================================================
 *
 * COLAB (evaluasi SEBELUM Jupyter):
 *   - COLAB_GPU          : set ("1", "0", "true") pada runtime Colab
 *   - COLAB_RELEASE_TAG  : mis. "release-_2026-09-01" (set di Colab)
 *   - DATALAB_ENV        : set pada lingkungan Colab baru ("COLAB" / "AI_STUDIO")
 *   → Sinyal apa pun yang ter-set (nilai tidak kosong) → colab.
 *
 * JUPYTER (hanya indikator RESMI):
 *   - JPY_PARENT_PID     : PID parent Jupyter Notebook — resmi (official)
 *   - JPY_SESSION_NAME   : nama sesi Jupyter — resmi (official)
 *   → NB: SENGAJA TIDAK memakai indikator tidak resmi seperti
 *     `VSCODE_PID`, `SPYDER_ARGS`, `JPY_...` turunan lain, atau heuristik
 *     `*_URL` — rawan false positive. Fail-closed: hanya dua var resmi.
 *
 * TERMUX:
 *   - TERMUX_VERSION     : mis. "0.118" (set pada Termux)
 *   - PREFIX             : path instalasi Termux mengandung 'com.termux'
 *     (mis. /data/data/com.termux/files/usr)
 *
 * WSL:
 *   - Bukan env var: `os === 'linux'` DAN `os.release()` mengandung
 *     'microsoft'/'wsl' (case-insensitive). Platform guard: hanya
 *     dievaluasi ketika os === 'linux' agar platform lain fail-closed.
 *   - LIMITASI (dokumentasi): deteksi ini hanya untuk proses yang
 *     berjalan DI DALAM distro WSL. Windows native yang MEMANGGIL
 *     `wsl.exe ...` dari luar tetap terbaca sebagai win32 — bukan WSL.
 *
 * CI:
 *   - CI                 : konvensi universal hampir semua CI
 *   - GITHUB_ACTIONS     : GitHub Actions
 *   - GITLAB_CI          : GitLab CI
 *   - CIRCLECI           : CircleCI
 *   - TRAVIS             : Travis CI
 *   - BUILD_NUMBER       : Jenkins
 *   - TEAMCITY_VERSION   : TeamCity
 *   - CODEBUILD_BUILD_ID : AWS CodeBuild
 *   - BITBUCKET_BUILD_NUMBER : Bitbucket Pipelines
 *
 * FAIL-CLOSED: sinyal partial/ambigu/tidak yakin → flavor: 'none'.
 * Setiap checker hanya mengembalikan true pada sinyal high-confidence
 * (nilai env yang ter-set dan tidak kosong); tidak ada heuristik longgar.
 */

import * as os from 'node:os';

/** Sistem operasi yang terdeteksi. */
export type EnvOs = 'linux' | 'win32' | 'darwin' | 'unknown';

/** Keluarga shell untuk pemilihan binary shell (Fase D). */
export type EnvShellFamily = 'posix' | 'cmd' | 'powershell';

/** Flavor lingkungan runtime di atas OS dasar. */
export type EnvFlavor = 'none' | 'wsl' | 'colab' | 'jupyter' | 'termux' | 'ci';

export interface EnvProfile {
  os: EnvOs;
  shellFamily: EnvShellFamily;
  flavor: EnvFlavor;
  /** true hanya jika stdout DAN stdin keduanya TTY (REPL interaktif penuh). */
  isInteractiveTTY: boolean;
  /** false ketika NO_COLOR ter-set (nilai apa pun, termasuk string kosong). */
  supportsColor: boolean;
  /** Shell default yang diinferensi (string, bukan enum — bebas format path). */
  defaultShell: string;
  /** Path prefix Termux ($PREFIX), hanya terisi ketika flavor === 'termux'. */
  pathPrefix?: string;
}

/** Ambil string env yang "valid": ada, bukan string kosong setelah trim. */
function envStr(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Nilai dianggap "ter-set" bila ada dan tidak kosong setelah trim. */
function isSet(env: NodeJS.ProcessEnv, key: string): boolean {
  return envStr(env, key) !== undefined;
}

/** Deteksi os dari process.platform dengan fallback 'unknown'. */
function detectOs(platform: string): EnvOs {
  switch (platform) {
    case 'linux':
    case 'win32':
    case 'darwin':
      return platform;
    default:
      // freebsd, aix, android (bare), sunos, ... → unknown (fail-closed)
      return 'unknown';
  }
}

/** Case-insensitive, toleran whitespace, toleran `powershell.exe` vs `powershell`. */
function containsPowerShellToken(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v.length === 0) return false;
  return v === 'powershell' ||
    v === 'pwsh' ||
    v.endsWith('\\powershell.exe') ||
    v.endsWith('/powershell.exe') ||
    v.endsWith('\\pwsh.exe') ||
    v.endsWith('/pwsh.exe') ||
    v.includes('powershell.exe') ||
    v.includes('pwsh.exe');
}

/** Deteksi family shell. Di luar Windows selalu posix. */
function detectShellFamily(osName: EnvOs, env: NodeJS.ProcessEnv): EnvShellFamily {
  if (osName !== 'win32') return 'posix';

  // Di Windows: powershell bila ComSpec/PSModulePath menunjuk PowerShell.
  // - PSModulePath hanya ada di sesi PowerShell (sinyal kuat)
  // - ComSpec biasanya cmd.exe; kalau ditimpa menunjuk powershell.exe → powershell
  // Sisanya (ComSpec cmd.exe, tidak ada sinyal PS) → cmd.
  const comspec = envStr(env, 'ComSpec');
  const psModulePath = envStr(env, 'PSModulePath');
  if (comspec && containsPowerShellToken(comspec)) return 'powershell';
  if (psModulePath) return 'powershell';
  return 'cmd';
}

/** Colab dievaluasi SEBELUM Jupyter (kebijakan presisi eksekusi). */
function detectColab(env: NodeJS.ProcessEnv): boolean {
  // Sinyal resmi Colab: COLAB_GPU, COLAB_RELEASE_TAG, DATALAB_ENV
  return isSet(env, 'COLAB_GPU') || isSet(env, 'COLAB_RELEASE_TAG') || isSet(env, 'DATALAB_ENV');
}

function detectJupyter(env: NodeJS.ProcessEnv): boolean {
  // Indikator resmi Jupyter (JPY_PARENT_PID, JPY_SESSION_NAME).
  return isSet(env, 'JPY_PARENT_PID') || isSet(env, 'JPY_SESSION_NAME');
}

function detectTermux(env: NodeJS.ProcessEnv): boolean {
  // TERMUX_VERSION, atau PREFIX mengandung 'com.termux'
  if (isSet(env, 'TERMUX_VERSION')) return true;
  const prefix = envStr(env, 'PREFIX');
  return prefix !== undefined && prefix.toLowerCase().includes('com.termux');
}

function detectWsl(release: string, osName: EnvOs): boolean {
  // Platform guard: hanya linux yang bisa WSL. Case-insensitive.
  if (osName !== 'linux') return false;
  const r = release.toLowerCase();
  return r.includes('microsoft') || r.includes('wsl');
}

function detectCi(env: NodeJS.ProcessEnv): boolean {
  // Indikator CI umum (lihat tabel komentar di atas).
  return (
    isSet(env, 'CI') ||
    isSet(env, 'GITHUB_ACTIONS') ||
    isSet(env, 'GITLAB_CI') ||
    isSet(env, 'CIRCLECI') ||
    isSet(env, 'TRAVIS') ||
    isSet(env, 'BUILD_NUMBER') ||
    isSet(env, 'TEAMCITY_VERSION') ||
    isSet(env, 'CODEBUILD_BUILD_ID') ||
    isSet(env, 'BITBUCKET_BUILD_NUMBER')
  );
}

/**
 * Susun profil dari bagian-bagian yang sudah di-mock (testability).
 * Eksport internal agar test bisa memverifikasi fail-closed per dimensi.
 */
export function buildEnvProfile(parts: {
  platform: string;
  release: string;
  env: NodeJS.ProcessEnv;
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  home?: string;
}): EnvProfile {
  const osName = detectOs(parts.platform);
  const shellFamily = detectShellFamily(osName, parts.env);

  let flavor: EnvFlavor = 'none';
  if (detectColab(parts.env)) flavor = 'colab';
  else if (detectJupyter(parts.env)) flavor = 'jupyter';
  else if (detectTermux(parts.env)) flavor = 'termux';
  else if (detectWsl(parts.release, osName)) flavor = 'wsl';
  else if (detectCi(parts.env)) flavor = 'ci';

  const isInteractiveTTY = parts.stdoutIsTTY && parts.stdinIsTTY;

  // Konsisten dengan konvensi existing src/core/ui.ts:43 (`!process.env.NO_COLOR`):
  // berbasis KEHADIRAN var (nilai apa pun, termasuk string kosong) menonaktifkan
  // warna — sesuai standar no-color.org.
  const supportsColor = parts.env.NO_COLOR === undefined;

  let defaultShell: string;
  if (shellFamily === 'powershell') {
    defaultShell = 'powershell.exe';
  } else if (shellFamily === 'cmd') {
    defaultShell = envStr(parts.env, 'ComSpec') ?? 'cmd.exe';
  } else {
    // posix: SHELL bila ter-set, fallback /bin/sh (prilaku executor saat ini).
    defaultShell = envStr(parts.env, 'SHELL') ?? '/bin/sh';
  }

  const profile: EnvProfile = {
    os: osName,
    shellFamily,
    flavor,
    isInteractiveTTY,
    supportsColor,
    defaultShell,
  };

  // pathPrefix khusus termux.
  if (flavor === 'termux') {
    profile.pathPrefix = envStr(parts.env, 'PREFIX') ?? '/data/data/com.termux/files/usr';
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Cache singleton — panggilan kedua mengembalikan objek yang identik.
// ---------------------------------------------------------------------------

let cachedProfile: EnvProfile | null = null;

/**
 * Kembalikan EnvProfile singleton (cache). Panggilan kedua mengembalikan
 * objek yang sama persis (identitas referensi sama).
 */
export function getEnvProfile(): EnvProfile {
  if (cachedProfile === null) {
    cachedProfile = buildEnvProfile({
      platform: process.platform,
      release: os.release(),
      env: process.env,
      stdoutIsTTY: process.stdout.isTTY === true,
      stdinIsTTY: process.stdin.isTTY === true,
    });
  }
  return cachedProfile;
}

/**
 * Hapus cache — khusus untuk testing. Panggilan `getEnvProfile()` berikutnya
 * akan mendeteksi ulang dari kondisi lingkungan saat itu.
 */
export function resetEnvCache(): void {
  cachedProfile = null;
}

// ---------------------------------------------------------------------------
// Helper predikat ringkas.
// ---------------------------------------------------------------------------

export function isTermuxEnv(): boolean {
  return getEnvProfile().flavor === 'termux';
}

export function isColabEnv(): boolean {
  return getEnvProfile().flavor === 'colab';
}

export function isWslEnv(): boolean {
  return getEnvProfile().flavor === 'wsl';
}

export function isCiEnv(): boolean {
  return getEnvProfile().flavor === 'ci';
}
