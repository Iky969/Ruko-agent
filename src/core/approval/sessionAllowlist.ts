import { lstatSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { containsShellOperators, detectRisk, isHighRiskDangerousCommand } from '../approval.js';
import { DEFAULT_CONFIG } from '../../types.js';

/** Host-supplied execution context, never taken from model approval flags. */
export interface ApprovalRequest {
  kind: 'exec' | 'start_process';
  cwd: string;
  /** Host workspace boundary; legacy callers use their execution cwd. */
  workspaceRoot?: string;
  command: string;
}

/**
 * Fisik-resolve sebuah path: `realpathSync` pada ancestor terdekat yang eksis
 * plus sisa segmen yang belum ada (file/direktori baru).
 * Issue #38-1: containment grant `always` memakai resolusi fisik, bukan
 * `path.resolve` leksikal — symlink di dalam workspace yang menunjuk ke luar
 * tidak boleh dianggap berada di dalam workspace.
 * Fail-closed: gagal resolve (EACCES/ELOOP/dangling symlink) → null → tolak.
 */
function canonicalizePath(target: string): string | null {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      // ENOENT pada path yang lstat-nya berhasil = dangling symlink: fail-closed.
      try {
        lstatSync(current);
        return null;
      } catch {
        // Benar-benar tidak ada — naik ke ancestor berikutnya.
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    tail.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * Issue #38-3: wrapper prefix yang hanya membungkus program nyata. Tanpa
 * normalisasi ini, `nohup git push origin main` / `FOO=bar bash x.sh`
 * menyembunyikan executable dari denylist interpreter dan git-push guard.
 * Token di sini sudah melewati charset guard (tanpa kutipan/operator shell).
 */
const LAUNCHER_PREFIXES = new Set([
  'nohup', 'env', 'timeout', 'nice', 'ionice', 'setsid', 'stdbuf', 'time',
  'command', 'exec', 'builtin', 'chroot', 'unshare', 'nsenter',
]);

/** Opsi wrapper yang membutuhkan argumen terpisah (bukan yang menempel). */
const LAUNCHER_VALUE_OPTS: Record<string, { short: string; long: string[] }> = {
  env: { short: 'uSC', long: ['unset', 'split-string', 'chdir'] },
  timeout: { short: 'sk', long: ['signal', 'kill-after'] },
  nice: { short: 'n', long: ['adjustment'] },
  stdbuf: { short: 'ioe', long: ['input', 'output', 'error'] },
  ionice: { short: 'cn', long: ['class', 'priority'] },
  time: { short: 'fo', long: ['format', 'output'] },
  chroot: { short: '', long: ['userspec'] },
  nsenter: { short: 't', long: ['target', 'root', 'wd', 'pid'] },
  unshare: { short: '', long: ['map-users', 'map-groups'] },
};

/** Wrapper dengan argumen path/wajib sebelum program nyata. */
const LAUNCHER_WITH_PATH_ARG = new Set(['chroot']);

/** Batas wrapper bertingkat (mis. `timeout 5 nohup git status`). */
const MAX_LAUNCHER_STEPS = 8;

/**
 * Kembalikan perintah efektif setelah prefix launcher/env-assignment dilepas,
 * atau null bila tidak tersisa program sama sekali (fail-closed).
 * Argumen opsi hanya dilepas bila terdefinisi untuk wrapper tersebut; nilai
 * yang menempel (`-oL`, `--flag=v`) tidak meng-consume token berikutnya.
 */
function effectiveCommand(trimmed: string): string | null {
  let tokens = trimmed.split(/\s+/).filter(Boolean);
  for (let step = 0; step < MAX_LAUNCHER_STEPS; step++) {
    if (tokens.length === 0) return null;
    // Env-assignment sebelum program: `FOO=bar cmd`.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens = tokens.slice(1);
      continue;
    }
    const name = (tokens[0].split('/').pop() ?? '').replace(/\.exe$/i, '').toLowerCase();
    if (!LAUNCHER_PREFIXES.has(name)) break;

    let index = 1;
    if (LAUNCHER_WITH_PATH_ARG.has(name) && index < tokens.length && !tokens[index].startsWith('-')) {
      index += 1; // chroot <newroot> <program>
    }
    while (index < tokens.length && tokens[index].startsWith('-')) {
      const opt = tokens[index++];
      if (opt.includes('=')) continue; // nilai menempel: `--flag=value`
      const spec = LAUNCHER_VALUE_OPTS[name];
      if (!spec) continue; // wrapper tanpa opsi bernilai dikenal
      const takesValue = opt.startsWith('--')
        ? spec.long.includes(opt.slice(2))
        : opt.length === 2 && spec.short.includes(opt.slice(1));
      if (takesValue && index < tokens.length) index += 1;
    }
    // Argumen numerik wrapper (`timeout 5 …`, `nice -n 5 …`, `ionice -c 3 …`).
    while (index < tokens.length && /^(?:[0-9]+(?:\.[0-9]+)?)$/.test(tokens[index])) index += 1;
    tokens = tokens.slice(index);
    if (tokens.length === 0) return null;
  }
  return tokens.length > 0 ? tokens.join(' ') : null;
}

/** Exact command + operation + physical cwd grants; never persisted or prefix-matched. */
export class SessionApprovalAllowlist {
  private readonly entries = new Set<string>();

  private commandPathsStayInWorkspace(command: string, cwd: string, workspaceRoot: string): boolean {
    // Issue #38-1: kedua sisi dibandingkan dalam bentuk fisik (realpath),
    // konsisten dengan ScopeAmendmentManager.isPhysicallyContained.
    const root = canonicalizePath(path.resolve(workspaceRoot));
    if (root === null) return false;
    const inside = (candidate: string): boolean => {
      const canonical = canonicalizePath(candidate);
      if (canonical === null) return false;
      const relative = path.relative(root, canonical);
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    if (!inside(path.resolve(cwd))) return false;
    return command.split(/\s+/).every((part) => {
      // Inspect option values too (--file=../x), and normalize Windows
      // separators even on POSIX so foreign traversal cannot be remembered.
      const value = part.slice(part.indexOf('=') + 1).replace(/\\/g, '/');
      const candidate = value.replace(/^-[a-zA-Z]+(?=\/|\.{1,2}\/)/, '');
      // Shell-leading tilde forms expand before command execution; embedded
      // tildes (for example Windows 8.3 `RUNNER~1`) are ordinary path bytes.
      if (/^~(?:\/|$)|=~(?:\/|$)/.test(part)) return false;
      // A foreign drive path would otherwise look relative on POSIX.
      // Drive-relative paths also depend on ambient per-drive cwd on Windows.
      if (/^[a-zA-Z]:/.test(candidate) &&
        (process.platform !== 'win32' || !path.win32.isAbsolute(candidate))) return false;
      const resolved = path.isAbsolute(candidate)
        ? path.resolve(candidate)
        : path.resolve(cwd, candidate);
      return inside(resolved);
    });
  }

  private isDirectGitPush(command: string): boolean {
    const parts = command.trim().split(/\s+/);
    if ((parts[0].split('/').pop() ?? '').replace(/\.exe$/i, '').toLowerCase() !== 'git') return false;
    let index = 1;
    while (index < parts.length && parts[index].startsWith('-')) {
      const option = parts[index++];
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(option)) index += 1;
    }
    return parts[index]?.toLowerCase() === 'push';
  }

  private key(command: string, request?: ApprovalRequest): string | null {
    if (!request || !['exec', 'start_process'].includes(request.kind)) return null;
    const display = request.kind === 'start_process' ? `start_process ${request.command}` : request.command;
    if (command !== display) return null;
    const trimmed = request.command.trim();
    // Resolve from the host execution cwd against the host workspace boundary.
    // One-shot approvals remain separate; "always" must not authorize escapes.
    if (!this.commandPathsStayInWorkspace(trimmed, request.cwd, request.workspaceRoot ?? request.cwd)) return null;
    // Reject shell expansion, quoting, control characters and dynamic interpreters.
    // Complex commands remain available through one-shot approval, not "always".
    if (!trimmed || !/^[a-zA-Z0-9_./:@=,+~ -]+$/.test(trimmed) || containsShellOperators(command)) return null;
    // Issue #38-3: lepas wrapper `nohup`/`env`/`VAR=val` agar guard di bawah
    // menilai program efektif, bukan token pembungkusnya.
    const effective = effectiveCommand(trimmed);
    if (!effective) return null;
    // Denylist interpreter/shell diterapkan pada program efektif setelah prefix
    // `nohup`/`env`/`VAR=val` dilepas, bukan pada token pembungkusnya.
    const executable = effective.split(/\s+/)[0].split('/').pop()!.replace(/\.exe$/i, '').toLowerCase();
    if (/^(?:sudo|doas|su|env|sh|bash|dash|zsh|ksh|fish|cmd|powershell|pwsh|node|python[\d.]*|perl|ruby|lua|php|eval|xargs)$/.test(executable)) return null;
    const risk = detectRisk(trimmed, { ...DEFAULT_CONFIG, approvalEnabled: true, approvalAllowlist: [] }).risk;
    if (risk === 'blocked' || (request.kind === 'exec' && risk !== 'dangerous')) return null;
    if (isHighRiskDangerousCommand(trimmed).isHighRisk) return null;
    if (/\b(?:rm|rmdir|del|erase|rd|ri|remove-item|clear-content|remove-content|stop-computer|restart-computer|clear-eventlog|invoke-expression|iex)\b/i.test(trimmed)) return null;
    // Direct `git push` guard evaluates the effective program: `nohup git push`
    // / `FOO=bar git push` must not become rememberable through a wrapper.
    if (this.isDirectGitPush(effective)) return null;
    try {
      return JSON.stringify([
        request.kind, realpathSync(request.cwd),
        realpathSync(request.workspaceRoot ?? request.cwd), request.command,
      ]);
    } catch {
      return null; // unresolved execution context cannot carry a reusable grant
    }
  }

  canRemember(command: string, request?: ApprovalRequest): boolean {
    return this.key(command, request) !== null;
  }

  allows(command: string, request?: ApprovalRequest): boolean {
    const key = this.key(command, request);
    return key !== null && this.entries.has(key);
  }

  remember(command: string, request?: ApprovalRequest): boolean {
    const key = this.key(command, request);
    if (key === null) return false;
    this.entries.add(key);
    return true;
  }
}
