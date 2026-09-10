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
