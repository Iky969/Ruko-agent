/**
 * Diff ringkas untuk tool mutasi berkas (Fase 4 — feedback.txt).
 *
 * Semua tool mutasi berkas (`write_file`, `edit_file`, `patch_file`) menampilkan
 * ringkasan satu baris di depan:
 *
 *   ✍️ edit_file src/core/ui.ts   +3 -1   0.4s   [ctrl+d untuk expand/collapse]
 *
 * (`+N` hijau, `-M` merah, durasi dim). Detail diff default COLLAPSED — hanya
 * hint `[ctrl+d untuk expand/collapse]` yang tampil — dan saat di-expand,
 * baris yang sama ditutup dengan block diff utuh ala git (`- beta` / `+ BETA`).
 *
 * Kabel data: writeWithDiff mengirim SATU baris log berformat
 * `\f<JSON>\f<render>` (marker form feed) via `onLog`. Parser UI
 * (`parseFileMutationLogLine`) mengenali baris ini secara EKSPISIT lewat
 * marker `\f` — bukan heuristik emoji — sehingga isi berkas/diff biasa yang
 * kebetulan memuat `✍️` tidak pernah salah terdeteksi sebagai log mutasi.
 * Payload JSON membawa oldText/newText agar Ctrl+D bisa me-render ulang
 * block detail persis tanpa baca disk ulang.
 */
import { diffLines, renderFileDiff, splitLines } from './diff.js';
import { dim, formatDuration, green, red, truncatePath, visibleLength } from './ui.js';

/** Tools mutasi berkas yang memakai format ringkasan diff (Fase 4). */
export const FILE_MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'patch_file']);

/** Marker visual di baris ringkasan (`✍️ <tool> <file> +N -M Xs`). */
export const FILE_MUTATION_MARKER = '✍️';

/** Hint shortcut expand/collapse detail diff (alternatif: bukan Ctrl+O tray). */
export const DIFF_TOGGLE_HINT = '[ctrl+d untuk expand/collapse]';

/** Marker form feed yang membingkai payload baris mutasi (`\fJSON\frender`). */
const MARKER_F = '\u000c';

/**
 * Format durasi ringkasan sesuai spesifikasi Fase 4 (`Xs`): <1 detik tetap
 * ditampilkan dalam detik desimal (0.4s), sisanya mewarisi formatDuration
 * (1.2s, 1m 24s).
 */
function formatSec(ms?: number): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 1000) {
    const s = Math.max(0.1, Number((ms / 1000).toFixed(1)));
    return `${s}s`;
  }
  return formatDuration(ms);
}

export interface MutationDiffStats {
  /** Baris yang ditambahkan oleh perubahan (diff aktual). */
  added: number;
  /** Baris yang dihapus oleh perubahan (diff aktual). */
  removed: number;
}

/**
 * Menghitung jumlah baris yang benar-benar ditambahkan/dihapus oleh perubahan
 * `oldText -> newText` memakai algoritma diff yang SAMA dengan renderer diff
 * (LCS di core/diff.ts) — jadi angka pada ringkasan selalu cocok dengan isi
 * diff aktual yang ditampilkan saat block di-expand. File baru dihitung
 * `removed: 0`; isi identik menghasilkan `0/0`.
 */
export function countDiffLines(oldText: string, newText: string): MutationDiffStats {
  const ops = diffLines(splitLines(oldText), splitLines(newText));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added += 1;
    else if (op.type === 'del') removed += 1;
  }
  return { added, removed };
}

export interface MutationSummaryInput {
  /** Nama tool mutasi (`write_file` / `edit_file` / `patch_file`). */
  tool: string;
  /** Label berkas relatif workspace (ala log `Edit(...)` yang lama). */
  fileLabel: string;
  /** Hasil countDiffLines(oldText, newText). */
  stats: MutationDiffStats;
  /** Durasi eksekusi tool (ms) — `0s` saat tidak tersedia. */
  durationMs?: number;
  /** Mode block detail (default COLLAPSED sesuai Fase 4). */
  mode?: 'collapsed' | 'expanded';
  /** Terminal width untuk truncation responsif (default terminalWidth()). */
  width?: number;
  /** Batas baris render diff expanded (mewarisi default renderer diff). */
  maxLines?: number;
  /** Teks lama/berkas (untuk block expanded); wajib saat mode expanded. */
  oldText?: string;
  newText?: string;
}

/**
 * Satu baris ringkasan mutasi berkas:
 * `✍️ <tool> <file>   +N -M   Xs   [ctrl+d untuk expand/collapse]`
 * N diwarnai hijau dan M merah (ANSI hilang otomatis pada output non-TTY /
 * NO_COLOR lewat helper wrap() di ui.ts). Saat `mode: 'expanded'`, block diff
 * utuh ala git ditambahkan di bawah baris ringkasan.
 */
export function renderMutationSummary(input: MutationSummaryInput): string {
  const { tool, fileLabel, stats } = input;
  const secStr = formatSec(input.durationMs);
  const plus = green(`+${stats.added}`);
  const minus = red(`-${stats.removed}`);

  // Path truncation responsif: `src/core/ui.ts` tampil utuh di layar lebar,
  // jatuh ke middle-truncation/basename di layar sempit (ala branch label).
  let file = fileLabel;
  if (input.width !== undefined) {
    const overhead =
      visibleLength(`${FILE_MUTATION_MARKER} ${tool}     ${plus} ${minus}   ${secStr}  ${DIFF_TOGGLE_HINT}`) + 4;
    file = truncatePath(fileLabel, Math.max(16, input.width - overhead), { terminalCols: input.width });
  }

  const head = `${FILE_MUTATION_MARKER} ${tool} ${file}   ${plus} ${minus}   ${secStr}  ${dim(DIFF_TOGGLE_HINT)}`;
  if (input.mode === 'expanded' && input.oldText !== undefined && input.newText !== undefined) {
    const diffBody = renderFileDiff(fileLabel, input.oldText, input.newText, {
      compact: true,
      maxLines: input.maxLines ?? 120,
    });
    return `${head}\n${diffBody}`;
  }
  return head;
}

/**
 * Memformat payload ter-enkode untuk onLog dari writeWithDiff:
 * `\f{"tool":...,"file":...,"old":...,"new":...}\f<render awal>`.
 * Render awal selalu COLLAPSED (default Fase 4); expand/collapse dikelola
 * agent.ts lewat toggle Ctrl+D yang membaca payload ini tanpa baca disk.
 */
export function formatFileMutationLogLine(params: {
  tool: string;
  fileLabel: string;
  oldText: string;
  newText: string;
  /** Durasi eksekusi tool (ms) — dirender ke baris ringkasan. */
  durationMs?: number;
}): string {
  const { tool, fileLabel, oldText, newText, durationMs } = params;
  const stats = countDiffLines(oldText, newText);
  const payload = JSON.stringify({
    tool,
    file: fileLabel,
    old: oldText,
    new: newText,
    a: stats.added,
    r: stats.removed,
  });
  const render = renderMutationSummary({ tool, fileLabel, stats, durationMs });
  return `${MARKER_F}${payload}${MARKER_F}${render}`;
}

export interface ParsedFileMutationLogLine {
  tool: string;
  fileLabel: string;
  /** oldText/newText dari payload — sumber re-render block Ctrl+D. */
  oldText: string;
  newText: string;
  added: number;
  removed: number;
  /** Bentuk tampilan awal (collapsed) yang di-decode dari bagian render. */
  summary: string;
}

/**
 * Parser baris mutasi berkas: return metadata + payload untuk re-render, atau
 * `null` untuk baris biasa. Marker `\f` di-strip dari `summary`.
 */
export function parseFileMutationLogLine(raw: string): ParsedFileMutationLogLine | null {
  if (!raw.includes(MARKER_F)) return null;
  const parts = raw.split(MARKER_F);
  if (parts.length < 3) return null;
  const payloadStr = parts[1];
  const summary = parts.slice(2).join(MARKER_F);
  try {
    const p = JSON.parse(payloadStr) as {
      tool?: string;
      file?: string;
      old?: string;
      new?: string;
      a?: number;
      r?: number;
    };
    if (typeof p.tool !== 'string' || typeof p.file !== 'string') return null;
    return {
      tool: p.tool,
      fileLabel: p.file,
      oldText: typeof p.old === 'string' ? p.old : '',
      newText: typeof p.new === 'string' ? p.new : '',
      added: typeof p.a === 'number' ? p.a : 0,
      removed: typeof p.r === 'number' ? p.r : 0,
      summary,
    };
  } catch {
    return null;
  }
}

/** Predikat baris mutasi berkas (dipakai WorkflowTree.log dan agent.ts). */
export function isFileMutationLogLine(line: string): boolean {
  return line.includes(MARKER_F) && parseFileMutationLogLine(line) !== null;
}

/** Menghapus kedua marker `\f` dari baris log sebelum ditampilkan. */
export function stripMarker(line: string): string {
  return line.split(MARKER_F).join('');
}
