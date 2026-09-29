/**
 * Cross-platform test helpers — ZERO dependency, `node:*` built-ins only
 * (`node:url`, `node:path`, `node:fs`, `node:os`, `node:process`,
 * `node:child_process`).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Test runs on Windows failed with:
 *
 *   TypeError [ERR_INVALID_URL]: Invalid URL
 *   input: 'file://C:UsersIkyRuko-agentdistindex.js'
 *
 * The cause was file URLs built by string concatenation (`'file://' + path`)
 * and then injected into a generated `.mjs` mock script through a template
 * literal. On Windows every backslash of `C:\Users\Iky\...` was consumed as a
 * JS escape (`\U`, `\I`, `\R`, `\d`, `\i`), so the drive letter became the URL
 * *host* (`file://C:Users...`) and `await import(...)` blew up with
 * ERR_INVALID_URL. On POSIX the same anti-pattern fails differently but just
 * as silently: `'file://' + '/tmp/a b#c.js'` loses `#c.js` (URL fragment) and
 * mis-encodes the space, so `fileURLToPath()` returns the wrong path.
 *
 * INVARIANTS ENFORCED HERE (regression-tested in `src/tests/platform_paths.test.ts`)
 * ---------------------------------------------------------------------------------
 * 1. File URLs are never concatenated — always `pathToFileURL()` (`node:url`),
 *    which percent-encodes spaces/`#`/`%`/unicode and emits `file:///C:/...`
 *    on Windows or `file:///home/...` on POSIX.
 * 2. Every path is made absolute *before* conversion, so results do not depend
 *    on the current working directory of the test runner.
 * 3. Values injected into generated scripts go through `JSON.stringify()`
 *    (escape-proof) — never raw template interpolation.
 * 4. Child processes are spawned with `execFile*` + `process.execPath` and an
 *    argv array — no implicit shell, therefore no cmd.exe/PowerShell/bash
 *    quoting or backslash mangling.
 */

import { execFile, execFileSync, type ExecFileException } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Absolute path of the repository root (derived from `import.meta.url`, never `process.cwd()`). */
export const PROJECT_ROOT: string = fileURLToPath(new URL('../../..', import.meta.url));

/** Absolute path of the TypeScript source tree (used by static/guard tests). */
export const SRC_DIR: string = join(PROJECT_ROOT, 'src');

/** Absolute path of the compiled CLI entry point (`npm run build` output). */
export const CLI_ENTRY: string = join(PROJECT_ROOT, 'dist', 'index.js');

/** Absolute path of the compiled test tree. */
export const DIST_TESTS_DIR: string = join(PROJECT_ROOT, 'dist', 'tests');

/**
 * Node executable currently running the suite. Using `process.execPath` instead
 * of the bare `'node'` command keeps spawned processes working on Windows
 * (and on any machine where Node is not on PATH).
 */
export const NODE_BIN: string = process.execPath;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Converts any (absolute or relative) filesystem path into a valid, absolute
 * `file:` URL string. This is the ONLY supported way to build a local module
 * URL in this repository.
 */
export function toFileUrl(targetPath: string): string {
  const absolute = isAbsolute(targetPath) ? targetPath : resolve(targetPath);
  return pathToFileURL(absolute).href;
}

/** Inverse of {@link toFileUrl}: accepts the URL as a string or `URL` object. */
export function fromFileUrl(fileUrl: string | URL): string {
  return fileURLToPath(typeof fileUrl === 'string' ? fileUrl : fileUrl.href);
}

/**
 * Dynamic import of a local module through a properly encoded file URL.
 * Works with paths containing spaces, `#`, `%`, unicode and Windows drive
 * letters (the exact combinations that broke the old concatenation approach).
 */
export function importLocalModule<T = unknown>(targetPath: string): Promise<T> {
  return import(toFileUrl(targetPath)) as Promise<T>;
}

export interface NodeRunOptions {
  /** Working directory for the child process. */
  cwd?: string;
  /** Extra environment variables (merged over a sanitized `process.env`). */
  env?: Record<string, string | undefined>;
  /** Data written to the child's stdin — closes stdin right after (EOF). */
  input?: string;
  /** Hard timeout, default 30s. */
  timeoutMs?: number;
}

/**
 * Sanitized child environment:
 *  - `NO_COLOR=1` so assertions never depend on ANSI escapes.
 *  - Every inherited `RUKO_*` variable is dropped, so a developer machine (or
 *    a Windows RDP session) with e.g. `RUKO_TRUST_FOLDER=1` exported cannot
 *    change CLI behaviour behind the tests' back. Explicit overrides win.
 */
export function rukoEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('RUKO_')) delete env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Runs the Node CLI (or any JS entry file) synchronously with an argv array.
 * Throws the raw `ExecFileException` on non-zero exit — use {@link childOutput}
 * to read the captured stdout/stderr inside a `catch` block.
 */
export function runNodeSync(args: readonly string[], options: NodeRunOptions = {}): string {
  return execFileSync(NODE_BIN, [...args], {
    cwd: options.cwd,
    input: options.input,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    encoding: 'utf8',
    env: rukoEnv(options.env),
    windowsHide: true,
  });
}

/**
 * Async twin of {@link runNodeSync}. Rejects with the captured output attached.
 *
 * `options.input` is written to the child's stdin and then closed (EOF) —
 * pass `''` when the child must see an immediately-closed stdin, exactly like
 * `< /dev/null` in CI. When `input` is omitted, stdin stays open (the child
 * must not depend on reading it).
 */
export function runNodeAsync(
  args: readonly string[],
  options: NodeRunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      NODE_BIN,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        encoding: 'utf8',
        env: rukoEnv(options.env),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          // Preserve captured output for assertions inside catch blocks
          // (same shape as child_process' own ExecFileException).
          const failure = error as ExecFileException & { stdout?: string; stderr?: string };
          failure.stdout = String(stdout ?? '');
          failure.stderr = String(stderr ?? '');
          rejectPromise(failure);
          return;
        }
        resolvePromise({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** Normalizes anything thrown by {@link runNodeSync}/{@link runNodeAsync}. */
export function childOutput(err: unknown): { stdout: string; stderr: string; code: number | null } {
  const e = (err ?? {}) as { stdout?: unknown; stderr?: unknown; status?: unknown; code?: unknown };
  const code = typeof e.status === 'number' ? e.status : typeof e.code === 'number' ? e.code : null;
  return { stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? ''), code };
}

/** Creates a temp workspace directory. The prefix may contain spaces/`#` — that is intentional. */
export function createTempWorkspace(prefix = 'ruko-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Removes a temp workspace, ignoring failures (best-effort cleanup). */
export function removeTempWorkspace(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Runs `fn` inside a fresh temp workspace and always cleans up afterwards.
 */
export async function inTempWorkspace<T>(
  prefix: string,
  fn: (dir: string) => T | Promise<T>,
): Promise<T> {
  const dir = createTempWorkspace(prefix);
  try {
    return await fn(dir);
  } finally {
    removeTempWorkspace(dir);
  }
}

/**
 * Writes a small ESM helper script into `dir` and returns both its path and its
 * file URL. The URL is produced by {@link toFileUrl} — never by concatenation.
 */
export function writeLocalModule(dir: string, fileName: string, source: string): { path: string; url: string } {
  const path = join(dir, fileName);
  writeFileSync(path, source, 'utf8');
  return { path, url: toFileUrl(path) };
}

/**
 * Creates a symlink for cross-platform tests.
 *
 * Windows specifics handled here:
 *  - directory links are created as **junctions** (`type: 'junction'`), which do
 *    not require Developer Mode / SeCreateSymbolicLinkPrivilege while still
 *    being reported as symlinks by `lstat()` and resolved by `realpath()` —
 *    so the sandbox-escape guards under test see identical semantics;
 *  - file links still need the symlink privilege on Windows.
 *
 * Returns `false` when the platform refuses to create the link, so the calling
 * test can skip itself instead of failing (same convention as
 * `filetools.test.ts` and `sensitive_protection.test.ts`).
 */
export function tryCreateSymlink(target: string, linkPath: string): boolean {
  try {
    const isDirectory = statSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false;
    if (isDirectory) {
      symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      symlinkSync(target, linkPath, 'file');
    }
    return true;
  } catch {
    return false;
  }
}

/** Recursively lists files under `dir` (absolute paths), sorted for determinism. */
export function listFilesRecursive(dir: string, predicate: (fileName: string) => boolean = () => true): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && predicate(entry.name)) found.push(full);
    }
  };
  walk(dir);
  return found;
}
