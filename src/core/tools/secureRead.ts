import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

/**
 * SecurityViolation: Kesalahan khusus pelanggaran pembatasan I/O berkas (PR-C1, Blueprint §2.4)
 */
export class SecurityViolation extends Error {
  constructor(public code: string, msg: string) {
    super(msg);
    this.name = 'SecurityViolation';
  }
}

export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB batas aman

const O_NOFOLLOW = fsSync.constants.O_NOFOLLOW ?? 0;
const O_RDONLY = fsSync.constants.O_RDONLY;
const O_CLOEXEC = (fsSync.constants as any).O_CLOEXEC ?? 0;

function stripExtendedPrefix(p: string): string {
  return p.startsWith('\\\\?\\') ? p.slice(4) : p;
}

/**
 * Memvalidasi apakah target berada di dalam workspace root secara kanonikal.
 */
export function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const normWs = process.platform === 'win32'
    ? stripExtendedPrefix(path.resolve(workspaceRoot)).toLowerCase()
    : stripExtendedPrefix(path.resolve(workspaceRoot));
  const normTarget = process.platform === 'win32'
    ? stripExtendedPrefix(path.resolve(target)).toLowerCase()
    : stripExtendedPrefix(path.resolve(target));
  if (normWs === normTarget) return true;
  const relative = path.relative(normWs, normTarget);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export interface SecureReadOptions {
  maxBytes?: number;
}

/**
 * secureReadFile — Pembacaan Berkas Bebas TOCTOU (src/core/tools/secureRead.ts)
 *
 * Mengamankan I/O berkas melalui:
 *  1. Validasi null byte injection dan NTFS Alternate Data Streams (ADS).
 *  2. Resolusi kanonikal workspace dan containment check.
 *  3. Validasi segmen bertahap (lstat) untuk mendeteksi symlink di tengah jalur dan tipe berkas berbahaya (FIFO/socket).
 *  4. Pembukaan via File Descriptor kernel atomik (O_RDONLY | O_NOFOLLOW | O_CLOEXEC).
 *  5. Validasi fstat kernel (isFile, batas ukuran).
 *  6. Post-open cross-check: resolusi realpath dan verifikasi kesesuaian inode/dev.
 *  7. Verifikasi post-read stat (mtimeNs dan size) untuk mendeteksi race mutasi selama pembacaan.
 *  8. Pelepasan handle di blok finally.
 */
export async function secureReadFile(
  workspaceRoot: string,
  userPath: string,
  opts: SecureReadOptions = {},
): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? MAX_FILE_SIZE;
  // 1. Validasi masukan dasar
  if (typeof userPath !== 'string' || userPath.includes('\0')) {
    throw new SecurityViolation('NULL_BYTE', 'Null byte injection terdeteksi');
  }

  const rawWsReal = await fs.realpath(workspaceRoot);
  const workspaceReal = stripExtendedPrefix(rawWsReal);
  const workspaceLex = stripExtendedPrefix(path.resolve(workspaceRoot));
  const cleanUserPath = stripExtendedPrefix(userPath);

  let resolved: string;
  if (!path.isAbsolute(cleanUserPath)) {
    resolved = path.resolve(workspaceReal, cleanUserPath);
  } else {
    const isInsideRel = (rel: string) => rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    const relReal = path.relative(workspaceReal, cleanUserPath);
    const relLex = path.relative(workspaceLex, cleanUserPath);

    if (cleanUserPath === workspaceReal || cleanUserPath === workspaceLex) {
      resolved = workspaceReal;
    } else if (isInsideRel(relReal)) {
      resolved = path.resolve(workspaceReal, relReal);
    } else if (isInsideRel(relLex)) {
      resolved = path.resolve(workspaceReal, relLex);
    } else {
      resolved = cleanUserPath;
    }
  }

  // Containment check visual/awal
  if (!isInsideWorkspace(workspaceReal, resolved)) {
    throw new SecurityViolation('PATH_TRAVERSAL', `Target melarikan diri dari workspace: ${userPath}`);
  }

  // Windows-specific: NTFS Alternate Data Streams (e.g. file.txt:stream)
  if (process.platform === 'win32') {
    const rel = path.relative(workspaceReal, resolved);
    if (rel.includes(':')) {
      throw new SecurityViolation('NTFS_ADS_BLOCKED', `NTFS Alternate Data Stream terdeteksi pada path: ${userPath}`);
    }
  }

  // 2. Pre-check segmen path untuk memblokir symlink di tengah jalur dan tipe berkas tak aman
  const segments = path.relative(workspaceReal, resolved).split(path.sep);
  let currentSegmentPath = workspaceReal;
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    currentSegmentPath = path.join(currentSegmentPath, seg);
    try {
      const segStat = await fs.lstat(currentSegmentPath);
      if (segStat.isSymbolicLink()) {
        throw new SecurityViolation('SYMLINK_IN_PATH', `Symlink terdeteksi pada segmen path: ${currentSegmentPath}`);
      }
      if (segStat.isFIFO() || segStat.isSocket()) {
        throw new SecurityViolation('UNSAFE_FILE_TYPE', `Tipe berkas tidak diizinkan: ${currentSegmentPath}`);
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') break;
      throw e;
    }
  }

  // 3. Pembukaan file handle via kernel flag defensif
  let handle: fs.FileHandle | null = null;
  try {
    const flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC;
    handle = await fs.open(resolved, flags);
  } catch (e: any) {
    if (e.code === 'ELOOP' || e.code === 'EMLINK') {
      throw new SecurityViolation('SYMLINK_BLOCKED', `Symlink diblokir (O_NOFOLLOW): ${userPath}`);
    }
    // Graceful fallback untuk Windows jika O_NOFOLLOW tidak disupport kernel
    if (O_NOFOLLOW === 0 && process.platform === 'win32') {
      handle = await fs.open(resolved, O_RDONLY | O_CLOEXEC);
    } else {
      throw e;
    }
  }

  try {
    // 4. Validasi langsung via File Descriptor kernel (fstat dengan BigInt precision)
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) {
      throw new SecurityViolation('NOT_A_FILE', 'Target bukan berkas reguler');
    }
    if (stat.size > BigInt(maxBytes)) {
      throw new SecurityViolation('FILE_TOO_LARGE', `Ukuran berkas melebihi ${(maxBytes / 1024 / 1024).toFixed(0)}MB`);
    }

    // 5. Post-open cross-check: resolusi realpath dan inode/device matching
    const rawReal = await fs.realpath(resolved);
    const realPath = stripExtendedPrefix(rawReal);
    if (!isInsideWorkspace(workspaceReal, realPath)) {
      throw new SecurityViolation('SYMLINK_ESCAPE', 'Jalur fisik symlink keluar dari workspace root');
    }

    const realStat = await fs.lstat(realPath, { bigint: true });
    const isWindowsZeroIno = process.platform === 'win32' && stat.ino === 0n;
    if (!isWindowsZeroIno) {
      if (stat.ino !== realStat.ino || stat.dev !== realStat.dev) {
        throw new SecurityViolation('TOCTOU_RACE', 'Inode/device mismatch (indikasi race condition)');
      }
    }

    // 6. Pembacaan data dari file descriptor yang sudah terverifikasi
    const data = await handle.readFile();

    // 7. Verifikasi post-read stat (memastikan berkas tidak dimutasi saat dibaca)
    const postStat = await handle.stat({ bigint: true });
    if (postStat.mtimeNs !== stat.mtimeNs || postStat.size !== stat.size) {
      throw new SecurityViolation('TOCTOU_MUTATION', 'Berkas termutasi selama proses pembacaan');
    }

    return data;
  } finally {
    await handle?.close().catch(() => {});
  }
}
