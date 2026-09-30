/**
 * resourceGovernor.ts — Isolasi Subproses & Tata Kelola Resource (Blueprint §2.9)
 *
 * Mengatur pemanggilan subprocess dengan pembersihan environment agresif, limitasi alokasi
 * output/waktu, dan pembersihan hierarki proses anak (process tree).
 *
 * Invarian (PROGRESS2.md / QA.md §1.4 / Blueprint §2.9):
 *  1. Environment Aggressive Scrubbing: Menghapus NODE_OPTIONS, NODE_PATH,
 *     LD_PRELOAD, DYLD_INSERT_LIBRARIES (TC-GOV-02).
 *  2. DX-Preserving PATH Filtering: Mengizinkan direktori toolchain developer
 *     (nvm, cargo, nodejs, fnm, asdf) tanpa mengizinkan traversal `..`.
 *  3. Process Tree Termination: Pembunuhan tuntas seluruh pohon proses anak
 *     saat timeout atau overflow (TC-GOV-01).
 *  4. Streaming Byte Counter: Memutus stream seketika bila total output
 *     melebihi batas tanpa memory spike.
 *
 * ZERO dependency — hanya `node:*`.
 */

import { spawn, execSync } from 'node:child_process';
import * as path from 'node:path';

const IS_WIN = process.platform === 'win32';

const ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TERM',
  'SYSTEMROOT',
  'SystemRoot',
  'windir',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
]);

export interface ResourceLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}

const DEFAULT_LIMITS: ResourceLimits = {
  timeoutMs: 30_000,
  maxOutputBytes: 10 * 1024 * 1024, // 10 MB
};

export function sanitizePathEnv(rawPath: string): string {
  if (!rawPath) return IS_WIN ? 'C:\\Windows\\System32;C:\\Windows' : '/usr/local/bin:/usr/bin:/bin';
  const allowedDirs = rawPath.split(path.delimiter).filter((dir) => {
    return (
      !dir.includes('..') &&
      (dir.startsWith('/usr') ||
        dir.startsWith('/bin') ||
        dir.startsWith('/sbin') ||
        dir.includes('.nvm') ||
        dir.includes('.cargo') ||
        dir.includes('nodejs') ||
        dir.includes('.fnm') ||
        dir.includes('.asdf') ||
        dir.includes('.volta') ||
        dir.includes('npm') ||
        (IS_WIN && (dir.includes('Program Files') || dir.includes('AppData') || dir.includes('System32'))))
    );
  });
  return allowedDirs.length > 0
    ? allowedDirs.join(path.delimiter)
    : IS_WIN
      ? 'C:\\Windows\\System32;C:\\Windows'
      : '/usr/local/bin:/usr/bin:/bin';
}

export function buildIsolatedEnv(): NodeJS.ProcessEnv {
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (ENV_ALLOWLIST.has(key)) {
      cleanEnv[key] = process.env[key];
    }
  }

  // Wajib dihapus untuk mencegah eskalasi eksekusi kode lokal
  delete cleanEnv.NODE_OPTIONS;
  delete cleanEnv.NODE_PATH;
  delete cleanEnv.LD_PRELOAD;
  delete cleanEnv.DYLD_INSERT_LIBRARIES;

  cleanEnv.PATH = sanitizePathEnv(process.env.PATH || '');
  cleanEnv.RUKO_ENFORCED = '1';
  return cleanEnv;
}

export function killProcessTree(pid: number): void {
  if (IS_WIN) {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  } else {
    try {
      // Menghentikan seluruh process group jika detached
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

export function spawnIsolated(
  bin: string,
  args: string[],
  cwd: string,
  limits: Partial<ResourceLimits> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const finalLimits = { ...DEFAULT_LIMITS, ...limits };

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let byteCounter = 0;
    let settled = false;

    let child: import('node:child_process').ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd,
        shell: false,
        env: buildIsolatedEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !IS_WIN,
      });
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (child.pid) killProcessTree(child.pid);
        reject(new Error(`RESOURCE_TIMEOUT: Proses melampaui batas waktu ${finalLimits.timeoutMs}ms`));
      }
    }, finalLimits.timeoutMs);

    const onDataChunk = (chunk: Buffer, isStderr: boolean) => {
      byteCounter += chunk.length;
      if (byteCounter > finalLimits.maxOutputBytes && !settled) {
        settled = true;
        clearTimeout(timer);
        try {
          child.stdout?.destroy();
          child.stderr?.destroy();
        } catch {}
        if (child.pid) killProcessTree(child.pid);
        reject(new Error('RESOURCE_OVERFLOW: Output proses melebihi batas'));
        return;
      }
      if (isStderr) {
        stderr += chunk.toString('utf8');
      } else {
        stdout += chunk.toString('utf8');
      }
    };

    child.stdout?.on('data', (d: Buffer) => onDataChunk(d, false));
    child.stderr?.on('data', (d: Buffer) => onDataChunk(d, true));

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code });
      }
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}
