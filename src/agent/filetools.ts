import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Default number of lines a `read_file` call returns when not asked for. */
export const DEFAULT_READ_LIMIT = 200;

/** Hard cap per `read_file` call so one read cannot flood the context. */
export const MAX_READ_LIMIT = 2000;

/** Cap for a single line echoed back by read/search (defends vs minified files). */
const MAX_LINE_CHARS = 2_000;

export interface ReadFileOptions {
  /** 1-indexed line to start reading from. */
  offset?: number;
  /** Maximum number of lines to return. */
  limit?: number;
}

export interface ReadFileResult {
  ok: boolean;
  /** Text payload: numbered lines on success, error message on failure. */
  text: string;
  totalLines?: number;
  truncated?: boolean;
  nextOffset?: number;
}

/** Default number of file paths a `glob` call returns. */
export const DEFAULT_GLOB_LIMIT = 200;

/** Hard cap per `glob` call so one search does not flood the context. */
export const MAX_GLOB_LIMIT = 1000;

/** Default number of matches a `code_search` call returns. */
export const DEFAULT_SEARCH_LIMIT = 50;

/** Hard cap per `code_search` call. */
export const MAX_SEARCH_LIMIT = 200;

/** Default context lines before and after match in `code_search`. */
export const DEFAULT_CONTEXT_LINES = 1;

/** Max context lines before and after match in `code_search`. */
export const MAX_CONTEXT_LINES = 2;

/** Directories always ignored by file traversal to save tokens and avoid slow scans. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.ruko',
  'coverage',
]);

/** Common binary file extensions skipped during traversal. */
export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.bz2',
  '.exe', '.bin', '.dll', '.so', '.dylib', '.class', '.pyc', '.pyd',
  '.wasm', '.sqlite', '.db', '.iso', '.dmg',
  '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.lockb',
]);

/** Fast-path known text extensions. */
export const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.json5',
  '.md', '.markdown', '.txt',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.yaml', '.yml', '.toml', '.ini', '.xml', '.svg',
  '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1',
  '.py', '.rb', '.php', '.java', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.go', '.rs', '.swift', '.kt', '.kts', '.scala', '.lua', '.r',
  '.sql', '.graphql', '.gql', '.proto',
  '.env', '.gitignore', '.gitattributes', '.editorconfig', '.dockerignore',
  '.eslintrc', '.prettierrc',
]);

/**
 * Reads a text file with 1-indexed line numbers and pagination.
 *
 * Safety: rejects directories, character devices, and binary content; caps
 * the number of lines per call and clips absurdly long lines. Large files
 * are read lazily line-by-line so we never hold more than needed in memory.
 */
export async function readFileTool(
  filePath: string,
  opts: ReadFileOptions = {},
  cwd: string = process.cwd(),
): Promise<ReadFileResult> {
  const abs = path.resolve(cwd, filePath);
  const limit = clampInt(opts.limit, 1, MAX_READ_LIMIT, DEFAULT_READ_LIMIT);
  const offset = Math.max(1, Math.trunc(opts.offset ?? 1));

  let stat;
  try {
    stat = await fs.stat(abs);
  } catch (err) {
    return { ok: false, text: `read_file: tidak bisa membuka '${filePath}': ${errorMessage(err)}` };
  }
  if (stat.isDirectory()) {
    return { ok: false, text: `read_file: '${filePath}' adalah direktori, bukan file.` };
  }
  if (!stat.isFile()) {
    return { ok: false, text: `read_file: '${filePath}' bukan file reguler.` };
  }

  let content: string;
  try {
    content = await fs.readFile(abs, 'utf8');
  } catch (err) {
    return { ok: false, text: `read_file: gagal membaca '${filePath}': ${errorMessage(err)}` };
  }

  if (looksBinary(content)) {
    return { ok: false, text: `read_file: '${filePath}' terdeteksi sebagai file biner; tidak ditampilkan.` };
  }

  const lines = content.split('\n');
  // Drop the artifact empty line produced by a trailing newline.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

  const totalLines = lines.length;
  const start = offset - 1;
  if (start >= totalLines) {
    return {
      ok: true,
      text: `(offset melewati akhir file: file punya ${totalLines} baris)`,
      totalLines,
      truncated: false,
    };
  }

  const end = Math.min(totalLines, start + limit);
  const slice: string[] = [];
  for (let i = start; i < end; i += 1) {
    const line = lines[i].length > MAX_LINE_CHARS ? `${lines[i].slice(0, MAX_LINE_CHARS)}…` : lines[i];
    slice.push(`${i + 1}| ${line}`);
  }

  const truncated = end < totalLines;
  const header = `File: ${abs} (${totalLines} baris, menampilkan ${start + 1}-${end})${truncated ? ` — gunakan offset/limit untuk bagian lain` : ''}`;
  return {
    ok: true,
    text: `${header}\n${slice.join('\n')}`,
    totalLines,
    truncated,
    nextOffset: end < totalLines ? end + 1 : undefined,
  };
}

/**
 * Determines whether a file is binary using extension heuristics and content sampling.
 */
export async function isBinaryFile(absPath: string): Promise<boolean> {
  const ext = path.extname(absPath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;
  if (TEXT_EXTENSIONS.has(ext)) return false;

  try {
    const handle = await fs.open(absPath, 'r');
    try {
      const buf = Buffer.alloc(512);
      const { bytesRead } = await handle.read(buf, 0, 512, 0);
      if (bytesRead === 0) return false;
      return looksBinary(buf.toString('latin1', 0, bytesRead));
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

export interface WalkEntry {
  /** Relative path from base cwd, using forward slashes. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
}

/**
 * Traverses a directory tree recursively, ignoring IGNORED_DIRS and avoiding symlink loops.
 * Safe against permission errors and broken symlinks.
 */
export async function walkDirectory(
  dirPath: string,
  cwd: string = process.cwd(),
  visitedDirs: Set<string> = new Set(),
  maxFiles = 5000,
): Promise<WalkEntry[]> {
  const absRoot = path.resolve(cwd, dirPath);
  try {
    const realRoot = await fs.realpath(absRoot);
    if (visitedDirs.has(realRoot)) return [];
    visitedDirs.add(realRoot);
  } catch {
    return [];
  }

  const results: WalkEntry[] = [];
  const queue: string[] = [absRoot];

  while (queue.length > 0) {
    const currentDir = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      // Permission denied or missing — safely skip
      continue;
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) break;

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        try {
          const real = await fs.realpath(fullPath);
          if (visitedDirs.has(real)) continue;
          visitedDirs.add(real);
          queue.push(fullPath);
        } catch {
          // permission denied / broken link
          continue;
        }
      } else if (entry.isSymbolicLink()) {
        try {
          const real = await fs.realpath(fullPath);
          const stat = await fs.stat(real);
          if (stat.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name)) continue;
            if (visitedDirs.has(real)) continue;
            visitedDirs.add(real);
            queue.push(fullPath);
          } else if (stat.isFile()) {
            const rel = path.relative(cwd, fullPath).replace(/\\/g, '/');
            results.push({ relPath: rel, absPath: fullPath });
          }
        } catch {
          continue;
        }
      } else if (entry.isFile()) {
        const rel = path.relative(cwd, fullPath).replace(/\\/g, '/');
        results.push({ relPath: rel, absPath: fullPath });
      }
    }
  }

  return results;
}

/**
 * Compiles a simple glob pattern into a RegExp.
 * Supports:
 * - `*` (matches anything in single segment)
 * - `**` (matches across directories)
 * - `?` (single char)
 * - Trailing slash `dir/` -> matches everything inside `dir/`
 * - Patterns without slash match either basename or full relative path
 */
export function globToRegex(pattern: string): RegExp {
  let p = pattern.replace(/\\/g, '/').trim();
  if (p.startsWith('./')) p = p.slice(2);
  if (p.endsWith('/')) p = p + '**';
  if (!p || p === '*' || p === '**' || p === '**/*') {
    return /^.*$/;
  }

  const matchBasename = !p.includes('/');
  let regexStr = '';
  let i = 0;

  while (i < p.length) {
    const char = p[i];
    if (char === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          regexStr += '(?:.+/)?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        regexStr += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      regexStr += '[^/]';
      i += 1;
    } else if ('+()^$.{}|[]\\'.includes(char)) {
      regexStr += '\\' + char;
      i += 1;
    } else {
      regexStr += char;
      i += 1;
    }
  }

  if (matchBasename) {
    return new RegExp(`(?:^|/)${regexStr}$`, 'i');
  }
  return new RegExp(`^(?:\\./)?${regexStr}$`, 'i');
}

export interface GlobOptions {
  /** Starting directory relative to cwd (default "."). */
  path?: string;
  /** Maximum number of file paths to return (default 200). */
  limit?: number;
}

export interface GlobResult {
  ok: boolean;
  text: string;
  files: string[];
  totalFound: number;
  truncated: boolean;
}

/**
 * Discovers files matching a glob pattern from the current workspace.
 * Ignores node_modules, .git, dist, .ruko, coverage, and binary files.
 */
export async function globTool(
  pattern = '',
  opts: GlobOptions = {},
  cwd: string = process.cwd(),
): Promise<GlobResult> {
  const limit = clampInt(opts.limit, 1, MAX_GLOB_LIMIT, DEFAULT_GLOB_LIMIT);
  const startDir = opts.path ? path.resolve(cwd, opts.path) : cwd;

  try {
    const st = await fs.stat(startDir);
    if (!st.isDirectory()) {
      return {
        ok: false,
        text: `glob: '${opts.path ?? '.'}' bukan direktori.`,
        files: [],
        totalFound: 0,
        truncated: false,
      };
    }
  } catch (err) {
    return {
      ok: false,
      text: `glob: direktori '${opts.path ?? '.'}' tidak ditemukan: ${errorMessage(err)}`,
      files: [],
      totalFound: 0,
      truncated: false,
    };
  }

  const entries = await walkDirectory(startDir, cwd, new Set(), 5000);
  const regex = globToRegex(pattern);

  const matchedFiles: string[] = [];
  let totalFound = 0;

  for (const entry of entries) {
    const relNorm = entry.relPath.startsWith('./') ? entry.relPath.slice(2) : entry.relPath;
    const relToStart = path.relative(startDir, entry.absPath).replace(/\\/g, '/');

    if (regex.test(relNorm) || regex.test(relToStart)) {
      if (await isBinaryFile(entry.absPath)) {
        continue;
      }
      totalFound += 1;
      if (matchedFiles.length < limit) {
        matchedFiles.push(relNorm);
      }
    }
  }

  matchedFiles.sort();
  const truncated = totalFound > limit;

  if (totalFound === 0) {
    return {
      ok: true,
      text: pattern
        ? `Tidak ada file yang cocok dengan pola "${pattern}".`
        : 'Tidak ada file ditemukan.',
      files: [],
      totalFound: 0,
      truncated: false,
    };
  }

  const header = truncated
    ? `Menemukan ${totalFound} file (menampilkan ${matchedFiles.length} file pertama — hasil terpotong, persempit pola):`
    : `Menemukan ${matchedFiles.length} file (pola: "${pattern || '*'}"):`;

  return {
    ok: true,
    text: `${header}\n${matchedFiles.join('\n')}`,
    files: matchedFiles,
    totalFound,
    truncated,
  };
}

export interface CodeSearchOptions {
  /** Target directory or file to search, relative to cwd (default "."). */
  path?: string;
  /** File extension filter (e.g. "ts", ".ts", "ts,js"). */
  extension?: string;
  /** Treat query as regular expression (default false). */
  isRegex?: boolean;
  /** Case-sensitive match (default false). */
  caseSensitive?: boolean;
  /** Number of context lines before and after match (default 1, max 2). */
  contextLines?: number;
  /** Maximum number of matches to return (default 50). */
  limit?: number;
}

export interface CodeSearchResult {
  ok: boolean;
  text: string;
  totalMatches: number;
  totalFiles: number;
  truncated: boolean;
}

/**
 * Searches for text or regex across project files with context lines.
 * Ignores node_modules, .git, dist, .ruko, coverage, and binary files.
 */
export async function codeSearchTool(
  query: string,
  opts: CodeSearchOptions = {},
  cwd: string = process.cwd(),
): Promise<CodeSearchResult> {
  if (!query || typeof query !== 'string' || query.trim() === '') {
    return {
      ok: false,
      text: 'code_search: missing "query" field',
      totalMatches: 0,
      totalFiles: 0,
      truncated: false,
    };
  }

  let allowedExts: Set<string> | null = null;
  if (opts.extension && typeof opts.extension === 'string') {
    const parts = opts.extension
      .split(',')
      .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean);
    if (parts.length > 0) {
      allowedExts = new Set(parts);
    }
  }

  let matcher: RegExp;
  const flags = opts.caseSensitive ? '' : 'i';
  if (opts.isRegex) {
    try {
      matcher = new RegExp(query, flags);
    } catch (err) {
      return {
        ok: false,
        text: `code_search: regex tidak valid "${query}": ${errorMessage(err)}`,
        totalMatches: 0,
        totalFiles: 0,
        truncated: false,
      };
    }
  } else {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    matcher = new RegExp(escaped, flags);
  }

  const contextLines = clampInt(opts.contextLines, 0, MAX_CONTEXT_LINES, DEFAULT_CONTEXT_LINES);
  const limit = clampInt(opts.limit, 1, MAX_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);

  const targetPath = opts.path ? path.resolve(cwd, opts.path) : cwd;

  let candidateFiles: WalkEntry[] = [];
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isFile()) {
      const ext = path.extname(targetPath).slice(1).toLowerCase();
      if (!allowedExts || allowedExts.has(ext)) {
        candidateFiles = [{
          relPath: path.relative(cwd, targetPath).replace(/\\/g, '/'),
          absPath: targetPath,
        }];
      }
    } else if (stat.isDirectory()) {
      const entries = await walkDirectory(targetPath, cwd, new Set(), 5000);
      candidateFiles = entries.filter((e) => {
        if (BINARY_EXTENSIONS.has(path.extname(e.absPath).toLowerCase())) return false;
        if (!allowedExts) return true;
        const ext = path.extname(e.absPath).slice(1).toLowerCase();
        return allowedExts.has(ext);
      });
    } else {
      return {
        ok: false,
        text: `code_search: path '${opts.path ?? '.'}' bukan file atau direktori reguler.`,
        totalMatches: 0,
        totalFiles: 0,
        truncated: false,
      };
    }
  } catch (err) {
    return {
      ok: false,
      text: `code_search: path '${opts.path ?? '.'}' tidak ditemukan: ${errorMessage(err)}`,
      totalMatches: 0,
      totalFiles: 0,
      truncated: false,
    };
  }

  candidateFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));

  let totalMatches = 0;
  let displayedMatches = 0;
  const fileOutputs: string[] = [];
  let truncated = false;

  for (const candidate of candidateFiles) {
    if (displayedMatches >= limit) {
      truncated = true;
      break;
    }

    let content: string;
    try {
      content = await fs.readFile(candidate.absPath, 'utf8');
    } catch {
      continue;
    }

    if (looksBinary(content)) continue;

    const lines = content.split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

    const matchIndices: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (matcher.test(lines[i])) {
        matchIndices.push(i);
      }
    }

    if (matchIndices.length === 0) continue;

    totalMatches += matchIndices.length;
    const remainingQuota = limit - displayedMatches;
    const matchesToDisplay = matchIndices.slice(0, remainingQuota);
    displayedMatches += matchesToDisplay.length;

    if (matchIndices.length > remainingQuota) {
      truncated = true;
    }

    const matchSet = new Set(matchesToDisplay);
    interface Range {
      start: number;
      end: number;
    }
    const ranges: Range[] = [];
    for (const idx of matchesToDisplay) {
      const start = Math.max(0, idx - contextLines);
      const end = Math.min(lines.length - 1, idx + contextLines);
      if (ranges.length > 0 && start <= ranges[ranges.length - 1].end + 1) {
        ranges[ranges.length - 1].end = Math.max(ranges[ranges.length - 1].end, end);
      } else {
        ranges.push({ start, end });
      }
    }

    const fileBlocks: string[] = [];
    for (const range of ranges) {
      const blockLines: string[] = [];
      for (let lineNum = range.start; lineNum <= range.end; lineNum += 1) {
        const isMatch = matchSet.has(lineNum);
        const prefix = isMatch ? '> ' : '  ';
        const rawLine = lines[lineNum];
        const clipped = rawLine.length > MAX_LINE_CHARS ? `${rawLine.slice(0, MAX_LINE_CHARS)}…` : rawLine;
        blockLines.push(`${prefix}${String(lineNum + 1).padStart(4)}| ${clipped}`);
      }
      fileBlocks.push(blockLines.join('\n'));
    }

    fileOutputs.push(`${candidate.relPath}:\n${fileBlocks.join('\n  ---\n')}`);
  }

  if (totalMatches === 0) {
    return {
      ok: true,
      text: `Tidak ditemukan kecocokan untuk "${query}".`,
      totalMatches: 0,
      totalFiles: 0,
      truncated: false,
    };
  }

  const header = truncated
    ? `Menemukan ${totalMatches >= limit ? `${limit}+` : totalMatches} kecocokan di ${fileOutputs.length} file untuk "${query}" (menampilkan ${displayedMatches} kecocokan pertama — hasil terpotong):`
    : `Menemukan ${totalMatches} kecocokan di ${fileOutputs.length} file untuk "${query}":`;

  const footer = truncated
    ? `\n[... Hasil dibatasi ${limit} kecocokan pertama — persempit query, target path, atau extension ...]`
    : '';

  return {
    ok: true,
    text: `${header}\n\n${fileOutputs.join('\n\n')}${footer}`,
    totalMatches,
    totalFiles: fileOutputs.length,
    truncated,
  };
}

/** Heuristic: NUL byte in the first 8 KiB, or too many control chars. */
export function looksBinary(text: string): boolean {
  const sample = text.slice(0, 8192);
  if (sample.includes('\u0000')) return true;
  let control = 0;
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) control += 1;
  }
  return sample.length > 0 && control / sample.length > 0.3;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
