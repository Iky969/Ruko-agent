/**
 * Tiny zero-dependency ANSI terminal UI toolkit for Ruko.
 *
 * Provides color helpers (auto-disabled when stdout is not a TTY or when
 * NO_COLOR is set), unicode box drawing, the REPL status bar, a thinking
 * spinner, and a fence-aware streaming reveal filter.
 */

import path from 'node:path';
import { isFileMutationLogLine, stripMarker as stripMutationMarker } from './diffui.js';

/**
 * Matches ANSI escape sequences: CSI with any parameter bytes (`?`, `<`, `=`,
 * `>`, `:`, digits, `;`), optional intermediate bytes and a final byte.
 * The old pattern only covered SGR (`ESC [ 0-9; m`), so private-mode CSI such
 * as `ESC[?25l` (hide cursor) or `ESC[?1049h` (alt screen) survived both
 * `stripAnsi` and `sanitizeTerminalOutput` (M8).
 */
const ANSI_RE = /\u001b\[[0-9;:?<=>]*[ -/]*[@-~]/g;

/**
 * Matches dangerous terminal escape sequences:
 * - OSC sequences: \u001b] ... (\u0007 | \u001b\\) (e.g. title changes, hyperlinks)
 * - DCS / APC / PM: \u001b[P_^] ... \u001b\\
 * - CSI with PRIVATE parameters (M8): \u001b[?25l, \u001b[?1049h, \u001b[>…  —
 *   terminal state manipulation, never legitimate page content
 * - Control characters: \u0007 (bell), \u000c (form feed)
 */
const DANGEROUS_TERMINAL_RE =
  /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[P_^][^\u001b]*\u001b\\|\[[?<=>][0-9;:]*[ -/]*[@-~]|\[[0-9;:]*[ -/][@-~])|[\u0007\u000c]/g;

/**
 * Sanitizes terminal output by stripping dangerous OSC, DCS, and device control sequences
 * while preserving standard safe color codes.
 */
export function sanitizeTerminalOutput(text: string): string {
  if (!text || typeof text !== 'string') return '';
  return text.replace(DANGEROUS_TERMINAL_RE, '');
}

/** Colors are dropped automatically for non-TTY output (tests, pipes). */
export function colorsEnabled(): boolean {
  return !!process.stdout.isTTY && !process.env.NO_COLOR;
}

function wrap(code: string, text: string): string {
  if (!colorsEnabled()) return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

export const bold = (s: string): string => wrap('1', s);
export const dim = (s: string): string => wrap('2', s);
export const red = (s: string): string => wrap('31', s);
export const green = (s: string): string => wrap('32', s);
export const yellow = (s: string): string => wrap('33', s);
export const cyan = (s: string): string => wrap('36', s);
export const magenta = (s: string): string => wrap('35', s);
export const whiteBright = (s: string): string => wrap('97', s);
export const bgBlue = (s: string): string => wrap('44', s);
export const bgGreen = (s: string): string => wrap('42', s);
/**
 * Dim, dark-green status bar: light text on 256-color dark green (§3 — the
 * old bright `42` background was glaring; this is muted and easy on the eyes).
 */
export const onDarkGreen = (s: string): string => wrap('38;5;252;48;5;22', s);

/** Strips all ANSI escape sequences and terminal control codes from a string. */
export function stripAnsi(text: string): string {
  return text.replace(DANGEROUS_TERMINAL_RE, '').replace(ANSI_RE, '');
}

/**
 * Zero-width code points (wcwidth subset, M5): combining marks, variation
 * selectors, ZWJ/ZWNJ and other format characters occupy no cell of their own.
 */
function isZeroWidthCodePoint(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // Combining Diacritical Marks
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x06df && cp <= 0x06e4) ||
    (cp >= 0x0730 && cp <= 0x074a) ||
    (cp >= 0x07a6 && cp <= 0x07b0) ||
    (cp >= 0x0900 && cp <= 0x0903) ||
    (cp >= 0x093a && cp <= 0x094f) ||
    (cp >= 0x0951 && cp <= 0x0957) ||
    (cp >= 0x0e31 && cp <= 0x0e31) ||
    (cp >= 0x0e34 && cp <= 0x0e3a) ||
    (cp >= 0x0eb1 && cp <= 0x0eb1) ||
    (cp >= 0x0eb4 && cp <= 0x0eb9) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) || // Combining Diacritical Marks Extended
    (cp >= 0x1dc0 && cp <= 0x1dff) || // Combining Diacritical Marks Supplement
    (cp >= 0x200b && cp <= 0x200f) || // ZWSP / ZWNJ / ZWJ / LRM / RLM
    (cp >= 0x202a && cp <= 0x202e) || // bidi embedding controls
    (cp >= 0x2060 && cp <= 0x206f) || // word joiner / invisible operators
    (cp >= 0x20d0 && cp <= 0x20ff) || // Combining Diacritical Marks for Symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) || // Variation Selectors (emoji presentation)
    (cp >= 0xfe20 && cp <= 0xfe2f) || // Combining Half Marks
    cp === 0xfeff // BOM / zero width no-break space
  );
}

/** Regional Indicator Symbol (the two halves of a flag emoji). */
function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

/**
 * Terminal cell width of one code point (wcwidth subset): 2 for East-Asian
 * Wide/Fullwidth and the emoji-presentation blocks, 0 for combining marks /
 * ZWJ / variation selectors, 1 otherwise. Terminals (and pyte) render ⚡ ⏳ 🟢
 * and CJK as TWO columns — counting them as one is what let the status bar
 * overflow its clamp and wrap (feedback v0.7 audit; closes Known Bugs #7's
 * double-width caveat). M5 closed the remaining gaps: the emoji range
 * U+1F800–U+1FFFF and the zero-width classes above.
 */
export function charWidth(cp: number): number {
  if (isZeroWidthCodePoint(cp)) return 0;
  if (cp < 0x1100) return 1;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x231a && cp <= 0x231b) ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 || cp === 0x23f3 || // ⏳
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f || cp === 0x2693 || cp === 0x26a1 || // ⚡
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26bf) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce || cp === 0x26d4 || cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) || cp === 0x26f5 ||
    cp === 0x26fa || cp === 0x26fd || cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) || cp === 0x2728 ||
    cp === 0x274c || cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) || cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) || cp === 0x27b0 || cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) || cp === 0x2b50 || cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f7ff) || // emoji + colored circles 🟢🟡
    (cp >= 0x1f800 && cp <= 0x1ffff) || // M5: supplemental symbols & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/**
 * Splits a string into grapheme clusters (M5).
 *
 * Deliberately dependency-free and deterministic: `Intl.Segmenter` was tried
 * first, but ICU builds vary — the small-icu runtime available here silently
 * DROPS ZWJ code points, so `👨👩👧` came back as three separate glyphs.
 * The rules implemented here are the ones that matter for terminal widths:
 *   - two adjacent Regional Indicators  → one flag cluster (2 columns)
 *   - combining marks / variation selectors / ZWJ → glued to the base
 *   - a cluster containing ZWJ pulls in the following base character too
 */
function splitGraphemes(text: string): string[] {
  const cps = Array.from(text); // code points
  const clusters: string[] = [];
  let i = 0;
  while (i < cps.length) {
    const cp = cps[i].codePointAt(0)!;
    // Flag emoji: a pair of regional indicators renders as one 2-column glyph.
    if (isRegionalIndicator(cp) && i + 1 < cps.length && isRegionalIndicator(cps[i + 1].codePointAt(0)!)) {
      clusters.push(cps[i] + cps[i + 1]);
      i += 2;
      continue;
    }
    let cluster = cps[i];
    i += 1;
    let joinNext = false;
    for (;;) {
      if (i >= cps.length) break;
      const nextCp = cps[i].codePointAt(0)!;
      if (isZeroWidthCodePoint(nextCp)) {
        if (nextCp === 0x200d) joinNext = true; // ZWJ glues the next base too
        cluster += cps[i];
        i += 1;
        continue;
      }
      if (joinNext) {
        cluster += cps[i];
        i += 1;
        joinNext = false;
        continue;
      }
      break;
    }
    clusters.push(cluster);
  }
  return clusters;
}

/** Terminal cell width of ONE grapheme cluster (emoji ZWJ sequences = 2). */
export function graphemeWidth(cluster: string): number {
  const cps = [...cluster].map((c) => c.codePointAt(0)!);
  if (cps.length === 0) return 0;
  // Flag emoji: two regional indicators render as a single 2-column glyph.
  if (cps.length === 2 && cps.every(isRegionalIndicator)) return 2;
  // Emoji presentation selector: the cluster is rendered as a wide emoji.
  if (cps.includes(0xfe0f)) return 2;
  const visible = cps.filter((cp) => !isZeroWidthCodePoint(cp));
  if (visible.length === 0) return 0;
  // A cluster joined by ZWJ / variation selectors collapses into one glyph;
  // if any of its code points is wide, the whole cluster is wide.
  if (visible.length > 1 && visible.some((cp) => charWidth(cp) === 2)) return 2;
  return charWidth(visible[0]);
}

/** Visible terminal columns of a string (ANSI codes do not count). */
export function visibleLength(text: string): number {
  let width = 0;
  for (const cluster of splitGraphemes(stripAnsi(text))) width += graphemeWidth(cluster);
  return width;
}

/**
 * Right-pads to `width` visible columns. M9: any SGR run still open at the end
 * of the text is closed BEFORE the padding spaces, so the padding never
 * inherits the previous color (the padding used to be painted with it).
 */
export function padVisible(text: string, width: number): string {
  const safe = sanitizeTerminalOutput(text);
  const gap = width - visibleLength(safe);
  if (gap <= 0) return safe;
  const hasOpenSgr = /\u001b\[[0-9;]*m/.test(safe) && !safe.endsWith('\u001b[0m');
  return `${safe}${hasOpenSgr ? '\u001b[0m' : ''}${' '.repeat(gap)}`;
}

/** Usable terminal width (fallback 80 when stdout is not a TTY). */
export function terminalWidth(): number {
  const envCols = process.env.COLUMNS ? parseInt(process.env.COLUMNS, 10) : NaN;
  const cols = (Number.isFinite(envCols) && envCols > 0 ? envCols : undefined) ?? process.stdout.columns ?? 80;
  return Math.max(20, cols);
}

/**
 * Truncates a string to `width` VISIBLE characters. ANSI escape sequences are
 * copied through without counting toward the width, and a reset is appended
 * when the cut lands inside a colored run — so borders never drift.
 *
 * M9: the input is sanitized FIRST (dangerous OSC/DCS/private-mode CSI are
 * dropped even when no truncation happens) — the old early return handed the
 * raw string straight back.
 */
export function truncateVisible(text: string, width: number): string {
  const source = sanitizeTerminalOutput(text);
  if (visibleLength(source) <= width) return source;
  let out = '';
  let count = 0;
  let i = 0;
  let colored = false;
  while (i < source.length && count < width) {
    if (source[i] === '\u001b') {
      const m = /^\u001b\[[0-9;]*m/.exec(source.slice(i));
      if (m) {
        out += m[0];
        colored = m[0] !== '\u001b[0m';
        i += m[0].length;
        continue;
      }
    }
    const cp = source.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (count + w > width) break; // don't split a double-width cell
    out += ch;
    count += w;
    i += ch.length;
  }
  if (colored) out += '\u001b[0m';
  return out;
}

/**
 * THE single box renderer (feedback v0.6.1 audit): every panel in the codebase
 * — splash, beginner guide, slash menu, /help-style listings — must go through
 * `renderBox`/`printBox` so width clamping lives in exactly one place.
 *
 *   ┌────────────┐
 *   │ title      │
 *   ├────────────┤
 *   │ line       │
 *   └────────────┘
 *
 * Lines may contain ANSI colors; padding is computed on visible width. The
 * total width is CLAMPED to the terminal (minus a 1-col safety margin): a box
 * as wide as the terminal triggers the pending-wrap glitch and its borders
 * pile up as separate rows — the recurring bug this helper exists to kill.
 */
export function renderBox(title: string, lines: string[]): string {
  const maxInner = Math.max(10, terminalWidth() - 4);
  const needed = Math.max(visibleLength(title), ...lines.map(visibleLength), 1) + 2;
  const inner = Math.min(needed, maxInner);
  const fit = (t: string): string => truncateVisible(t, inner - 2);
  const top = `┌${'─'.repeat(inner)}┐`;
  const titleRow = `│ ${padVisible(fit(title), inner - 2)} │`;
  const sep = `├${'─'.repeat(inner)}┤`;
  const body = lines.map((l) => `│ ${padVisible(fit(l), inner - 2)} │`);
  const bottom = `└${'─'.repeat(inner)}┘`;
  return [top, titleRow, sep, ...body, bottom].join('\n');
}

/** Renders a box through `renderBox` and commits it as ONE write. */
export function printBox(title: string, lines: string[]): void {
  console.log(renderBox(title, lines));
}

/**
 * Renders a thin responsive horizontal divider line across the terminal.
 * Responsive to terminal width (fallback process.stdout.columns ?? 80).
 */
export function renderDivider(char = '─', colorFn: (s: string) => string = dim): string {
  const cols = terminalWidth();
  const width = Math.max(20, cols - 1);
  return colorFn(char.repeat(width));
}

/**
 * Label teks kotak approval (L3). Sebelumnya hardcoded di dalam
 * `renderApprovalBox`; dikumpulkan di satu tempat supaya tampilan bisa
 * di-lokalkan tanpa menyentuh logika render.
 */
export const APPROVAL_LABELS = {
  header: '⚠ KONFIRMASI BERISIKO',
  reason: 'Alasan  :',
  command: 'Perintah:',
  prompt: '  Jalankan? ',
  approved: '  ✓ Disetujui',
  denied: '  ✗ Ditolak',
} as const;

/**
 * feedback.txt item 2: ANSI helpers for the approval prompt. The confirmation
 * line used to be committed verbatim to scrollback (the `y/n` prompt stayed in
 * the terminal history after Enter). These sequences let the caller erase that
 * row and replace it with one clean decision line.
 */
/** Erase the row the cursor currently sits on, in place. */
export const CLEAR_CURRENT_LINE = '\r\u001b[2K';
/** Climb one row and erase it — removes a just-committed prompt line. */
export const ERASE_PREVIOUS_LINE = '\u001b[1A\r\u001b[2K';

/** One-line approval result (replaces the cleared `y/n` prompt row). */
export function renderApprovalDecision(approved: boolean): string {
  return approved ? green(APPROVAL_LABELS.approved) : red(APPROVAL_LABELS.denied);
}

/**
 * Renders a high-visibility ANSI red/yellow bordered box for approval gate confirmations.
 * Clamped responsively to terminal width (fallback process.stdout.columns ?? 80).
 */
export function renderApprovalBox(command: string, reason: string): string {
  const cols = terminalWidth();
  const maxInner = Math.max(16, cols - 4);
  const headerText = APPROVAL_LABELS.header;
  const reasonText = `${APPROVAL_LABELS.reason} ${reason}`;
  const cmdText = `${APPROVAL_LABELS.command} ${command}`;
  const needed = Math.max(visibleLength(headerText), visibleLength(reasonText), visibleLength(cmdText)) + 4;
  const inner = Math.min(Math.max(needed, 28), maxInner);

  const fit = (t: string): string => truncateVisible(t, inner - 2);

  const border = (s: string) => yellow(s);
  const alertHeader = bold(red(headerText));

  const top = border(`┌${'─'.repeat(inner)}┐`);
  const headerRow = `${border('│')} ${padVisible(fit(alertHeader), inner - 2)} ${border('│')}`;
  const sep = border(`├${'─'.repeat(inner)}┤`);
  const reasonRow = `${border('│')} ${padVisible(fit(`${bold(APPROVAL_LABELS.reason)} ${yellow(reason)}`), inner - 2)} ${border('│')}`;
  const cmdRow = `${border('│')} ${padVisible(fit(`${bold(APPROVAL_LABELS.command)} ${cyan(command)}`), inner - 2)} ${border('│')}`;
  const bottom = border(`└${'─'.repeat(inner)}┘`);

  return [top, headerRow, sep, reasonRow, cmdRow, bottom].join('\n');
}

/**
 * In-place redraw helper for ANIMATED multi-row blocks (splash aquarium).
 * `draw()` prints the block on the first call and rewinds + overwrites it on
 * every later call, so frames update in place instead of stacking. `clear()`
 * rewinds and erases the region before the final static block is committed.
 * Callers MUST keep every line ≤ terminalWidth()-1 visible chars (use
 * `truncateVisible`) or the rewind math breaks on wrapped rows.
 */
export interface InPlaceBlock {
  draw(lines: string[]): void;
  clear(): void;
}

export function createInPlaceBlock(): InPlaceBlock {
  let drawn = 0;
  return {
    draw(lines: string[]): void {
      const out = process.stdout;
      if (drawn > 0) out.write(`\u001b[${drawn}A`);
      for (const l of lines) out.write(`\u001b[2K${l}\r\n`);
      drawn = lines.length;
    },
    clear(): void {
      const out = process.stdout;
      if (drawn > 0) out.write(`\u001b[${drawn}A\u001b[0J`);
      drawn = 0;
    },
  };
}

/** 30000 → "30k", 32500 → "32.5k", 900 → "900". */
export function formatK(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  const label = Number.isInteger(k) ? String(k) : k.toFixed(1).replace(/\.0$/, '');
  return `${label}k`;
}

/** Formats milliseconds into human-readable duration (e.g. 500ms, 4.2s, 1m 24s). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const mins = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  return `${mins}m ${remSec}s`;
}

export interface StatusBarInput {
  model: string;
  usedChars: number;
  budgetChars: number;
  /** Custom terminal width for responsive status bar layout / testing. */
  width?: number;
  /** Active role name (dim, right of the model). */
  role?: string;
  /** Plan mode flag shows `⏸ PLAN` in the bar so the block state is visible. */
  planMode?: boolean;
  /** YOLO mode flag shows `[YOLO]` in the bar when confirmation is bypassed. */
  yoloMode?: boolean;
  /** True while the AI is thinking/executing tools (v0.7 live input). */
  busy?: boolean;
  /**
   * Char counts of the most recent turn (§8). Merged into the bar instead of
   * printed as its own output line, so usage stats never look like noise.
   */
  turn?: { promptChars: number; completionChars: number; durationMs?: number };
  /** Queued messages waiting for the AI to finish (v0.7 badge, feedback #4). */
  pending?: number;
  /** Active background processes. */
  activeProcesses?: Array<{ id?: string; command?: string }>;
  /** Fase 5: mode sesi aktif — indikator `mode:<aktif>` di bar. */
  mode?: string;
  /** Fase 5: level reasoning aktif — indikator `reasoning:<level>` di bar. */
  reasoning?: string;
  /**
   * Fase B (v1.9.0): flavor lingkungan runtime (`wsl`/`colab`/`jupyter`/`termux`/`ci`).
   * Opsional — kosong/undefined berarti tidak dirender (perilaku lama utuh).
   * Flavor 'none' sengaja tidak ditampilkan (bukan informasi).
   */
  flavor?: string;
}

/**
 * Ringkasan proses aktif untuk status bar.
 * Format normal: "2 proc (sleep 301, vite)"
 * Format ringkas / layar sempit: "2 proc"
 */
export function formatProcessSummary(
  processes?: Array<{ command?: string }>,
  compact = false,
): string {
  if (!processes || processes.length === 0) return '';
  const count = processes.length;
  if (compact) {
    return `${count} proc`;
  }
  const names = processes
    .map((p) => {
      const cmd = String(p.command ?? '').trim();
      const parts = cmd.split(/\s+/);
      const short = parts.length > 2 ? `${parts[0]} ${parts[1]}` : cmd;
      return short.length > 15 ? `${short.slice(0, 12)}…` : short;
    })
    .filter(Boolean)
    .slice(0, 3);
  return names.length > 0 ? `${count} proc (${names.join(', ')})` : `${count} proc`;
}

/** `⚡ [model] | ctx 41% (12.3k/30k) · ↑3.2k ↓800 | / perintah` dark-green bar. */
export function buildStatusBar(input: StatusBarInput): string {
  const w = input.width ?? terminalWidth();
  const targetWidth = Math.max(16, w - 1);
  const isNarrow = w < 60;
  const isVeryNarrow = w < 48;

  const pct = input.budgetChars > 0
    ? Math.min(100, Math.round((input.usedChars / input.budgetChars) * 100))
    : 0;

  const procCount = input.activeProcesses?.length ?? 0;

  if (!isNarrow) {
    const plan = input.planMode ? '⏸ PLAN · ' : '';
    const yolo = input.yoloMode ? '[YOLO] · ' : '';
    const busy = input.busy ? '⏳ AI bekerja · ' : '';
    const role = input.role && input.role !== 'default' ? ` · ${input.role}` : '';
    // Fase 5: indikator mode + reasoning ditempel setelah badge mode lain.
    const modeInd = input.mode ? `mode:${input.mode} · ` : '';
    const reasoningInd = input.reasoning ? `reasoning:${input.reasoning} · ` : '';
    // Fase B (v1.9.0): indikator flavor lingkungan (opsional, '' bila tidak ada).
    // Flavor 'none' sengaja tidak dirender (bukan informasi yang berguna).
    const flavorInd = input.flavor && input.flavor !== 'none' ? `${input.flavor} · ` : '';
    const turn = input.turn
      ? ` · ↑${formatK(input.turn.promptChars)} ↓${formatK(input.turn.completionChars)}${input.turn.durationMs ? ` · ${formatDuration(input.turn.durationMs)}` : ''}`
      : '';
    const waiting = input.pending && input.pending > 0 ? ` · ⏳ ${input.pending} menunggu ` : '';
    const detailCtx = ` (${formatK(input.usedChars)}/${formatK(input.budgetChars)})`;
    const hint = ' | / perintah · Ctrl+C batal ';

    let procStr = '';
    if (procCount > 0) {
      const summary = formatProcessSummary(input.activeProcesses, isVeryNarrow);
      procStr = ` | ⚙️ ${summary}`;
    }

    // Try full string first
    const full = ` ⚡ [${input.model}${role}]${procStr} | ${busy}${plan}${yolo}${modeInd}${reasoningInd}${flavorInd}ctx ${pct}%${detailCtx}${turn}${hint}${waiting}`;
    if (visibleLength(full) <= targetWidth) {
      return onDarkGreen(full);
    }
    // Drop hint
    const noHint = ` ⚡ [${input.model}${role}]${procStr} | ${busy}${plan}${yolo}${modeInd}${reasoningInd}${flavorInd}ctx ${pct}%${detailCtx}${turn}${waiting ? waiting : ' '}`;
    if (visibleLength(noHint) <= targetWidth) {
      return onDarkGreen(noHint);
    }
    // Drop turn stats
    const noTurn = ` ⚡ [${input.model}${role}]${procStr} | ${busy}${plan}${yolo}${modeInd}${reasoningInd}${flavorInd}ctx ${pct}%${detailCtx}${waiting ? waiting : ' '}`;
    if (visibleLength(noTurn) <= targetWidth) {
      return onDarkGreen(noTurn);
    }
    // Drop detailCtx
    const noDetail = ` ⚡ [${input.model}${role}]${procStr} | ${busy}${plan}${yolo}${modeInd}${reasoningInd}${flavorInd}ctx ${pct}%${waiting ? waiting : ' '}`;
    if (visibleLength(noDetail) <= targetWidth) {
      return onDarkGreen(noDetail);
    }
  }

  // Narrow terminal responsive layout (< 60, e.g. Termux mobile):
  const busyNarrow = input.busy ? (isVeryNarrow ? '⏳ ' : '⏳ AI bekerja · ') : '';
  const planNarrow = input.planMode ? (isVeryNarrow ? '⏸ ' : '⏸ PLAN · ') : '';
  const yoloNarrow = input.yoloMode ? (isVeryNarrow ? '[YOLO] ' : '[YOLO] · ') : '';
  // Fase B (v1.9.0): flavor hanya pada layar narrow yang cukup lega (>=48) agar
  // layout very-narrow (Termux 40 cols) tidak berubah sama sekali.
  const flavorNarrow = input.flavor && input.flavor !== 'none' && w >= 48 ? `${input.flavor} · ` : '';
  const waitNarrow = input.pending && input.pending > 0
    ? (isVeryNarrow ? ` ⏳${input.pending}` : ` · ⏳ ${input.pending} menunggu `)
    : '';

  const right = `${busyNarrow}${planNarrow}${yoloNarrow}${flavorNarrow}ctx ${pct}%${waitNarrow ? waitNarrow : ' '}`;

  let proc = '';
  if (procCount > 0) {
    if (w >= 48) {
      proc = ` | ⚙️ ${formatProcessSummary(input.activeProcesses, true)}`;
    } else if (w >= 38) {
      proc = ` | ⚙️ ${procCount} proc`;
    } else {
      proc = ` | ⚙️${procCount}`;
    }
  }

  let role = (w >= 50 && input.role && input.role !== 'default') ? ` · ${input.role}` : '';
  const isCompactLayout = w < 38;
  let prefix = isCompactLayout ? '[' : ' ⚡ [';
  let suffix = ']';
  let sep = isCompactLayout ? '|' : ' | ';

  let fixedLen = visibleLength(prefix) + visibleLength(role) + visibleLength(suffix) + visibleLength(proc) + visibleLength(sep) + visibleLength(right);

  if (fixedLen + visibleLength(input.model) > targetWidth && role) {
    role = '';
    fixedLen = visibleLength(prefix) + visibleLength(suffix) + visibleLength(proc) + visibleLength(sep) + visibleLength(right);
  }

  // If still too tight on narrow screens, drop proc to prioritize model + ctx
  if (fixedLen + visibleLength(input.model) > targetWidth && w < 40 && proc) {
    proc = '';
    fixedLen = visibleLength(prefix) + visibleLength(suffix) + visibleLength(proc) + visibleLength(sep) + visibleLength(right);
  }

  let modelText = input.model;
  let availForModel = targetWidth - fixedLen;
  if (availForModel < visibleLength(modelText)) {
    if (availForModel >= 7) {
      modelText = modelText.slice(0, availForModel - 1) + '…';
    } else if (availForModel >= 4) {
      modelText = modelText.slice(0, availForModel - 1) + '…';
    } else if (availForModel > 0) {
      modelText = modelText.slice(0, availForModel);
    } else {
      modelText = '';
      if (prefix === '[') prefix = '';
      if (suffix === ']') suffix = '';
      if (sep === '|') sep = '';
    }
  }

  let assembled = `${prefix}${modelText}${role}${suffix}${proc}${sep}${right}`;
  if (visibleLength(assembled) > targetWidth) {
    assembled = truncateVisible(assembled, targetWidth);
  }

  return onDarkGreen(assembled);
}

// ─────────────────────────────────────────────────────────────
// feedback (UI revamp): model-name truncation, responsive status
// panel, and the `├── ` action-log history renderer.
// ─────────────────────────────────────────────────────────────

/**
 * Compact display name for the status panel.
 *
 * Long ids such as `nvidia/nemotron-3-ultra-550b-a55b:free` wrapped the status
 * line into 3 rows on Termux; only the core family name survives here:
 * provider prefix, quantisation tag and version digits are dropped.
 *   gemini-3.8-flash  → gemini      claude-opus-3.7 → claude
 *   qwen3.8-flash     → qwen        nvidia/nemotron-3-ultra-550b-a55b:free → nemotron
 * The FULL id stays one command away (`/config`, `/settings`).
 */
export function shortModelName(model: string, maxLen = 16): string {
  const raw = String(model ?? '').trim();
  if (!raw) return 'no-model';
  const base = raw.split('/').pop() ?? raw; // nvidia/nemotron-… → nemotron-…
  const noTag = base.split(':')[0]; // llama3.1:70b → llama3.1
  const head = noTag.split(/[-_]/)[0]; // gemini-3.8-flash → gemini3.8
  const core = head.replace(/[0-9][0-9.]*$/, ''); // qwen3.8 → qwen
  const candidate = (core.length >= 2 ? core : head) || noTag || raw;
  return candidate.length > maxLen ? `${candidate.slice(0, maxLen - 1)}…` : candidate;
}

/** Default hint row printed inside the status panel (the input line's hint). */
export const STATUS_PANEL_HINT = '/? untuk bantuan, tanya apa saja...';

export interface StatusPanelInput {
  model: string;
  /** Custom terminal width for responsive layout / testing. */
  width?: number;
  usedChars?: number;
  budgetChars?: number;
  /** YOLO badge — hidden entirely when confirmation is still enforced. */
  yoloMode?: boolean;
  planMode?: boolean;
  busy?: boolean;
  role?: string;
  /** Last turn's char counts (rendered as token estimates). */
  turn?: { promptChars: number; completionChars: number };
  /** Queued messages waiting for the AI (badge). */
  pending?: number;
  /** Number of active background processes (badge). */
  processes?: number;
  /** Bottom hint row (defaults to `STATUS_PANEL_HINT`). */
  hint?: string;
  /** Fase 5: mode sesi aktif (default/research/code/build) — indikator status bar. */
  mode?: string;
  /** Fase 5: level reasoning aktif (high/xhigh/max/extreme) — indikator status bar. */
  reasoning?: string;
  /**
   * Fase B (v1.9.0): flavor lingkungan runtime — badge dim di panel status.
   * Opsional; 'none'/undefined tidak dirender (perilaku lama utuh).
   */
  flavor?: string;
}

/**
 * THE responsive status + input box (feedback: "Format Kotak Status & Input").
 *
 *   ┌──────────┬──────┬─────────────┐
 *   │ gemini   │ YOLO │ ↑ 3.2kt ↓ 800t │
 *   ├──────────┴──────┴─────────────┤
 *   │ /? untuk bantuan, tanya apa saja... │
 *   └───────────────────────────────┘
 *
 * Every horizontal run is computed from the live terminal width — there are no
 * static column widths, and the frame is clamped to `cols - 1` so it can never
 * trigger the pending-wrap glitch that used to stack border rows in scrollback.
 * Optional columns (badges, stats) drop before the model cell is truncated.
 */
export function buildStatusPanel(input: StatusPanelInput): string[] {
  const cols = Math.max(20, input.width ?? terminalWidth());
  const maxOuter = Math.max(16, cols - 1); // never paint the last cell
  const pct =
    input.budgetChars && input.budgetChars > 0
      ? Math.min(100, Math.round(((input.usedChars ?? 0) / input.budgetChars) * 100))
      : 0;

  const modelCell = cyan(bold(`⚡ ${shortModelName(input.model)}`));

  const badges: string[] = [];
  if (input.planMode) badges.push(yellow('PLAN'));
  if (input.yoloMode) badges.push(yellow('YOLO'));
  if (input.busy) badges.push(yellow('⏳'));
  if (input.pending && input.pending > 0) badges.push(yellow(`⏳${input.pending}`));
  if (input.processes && input.processes > 0) badges.push(dim(`⚙️${input.processes}`));
  if (input.role && input.role !== 'default') badges.push(dim(input.role));
  // Fase 5: indikator `mode:<aktif>` + `reasoning:<level>` — selalu tampil,
  // duty dim (kecuali non-default) agar panel tetap tenang.
  if (input.mode) {
    badges.push(input.mode !== 'default' ? cyan(`mode:${input.mode}`) : dim(`mode:${input.mode}`));
  }
  if (input.reasoning) {
    badges.push(dim(`reasoning:${input.reasoning}`));
  }
  // Fase B (v1.9.0): badge flavor lingkungan (opsional, dim — panel tetap tenang).
  if (input.flavor && input.flavor !== 'none') {
    badges.push(dim(input.flavor));
  }
  const badgeCell = badges.join(' ');

  const statsCell = input.turn
    ? dim(`↑ ${formatK(Math.round(input.turn.promptChars / 4))}t ↓ ${formatK(Math.round(input.turn.completionChars / 4))}t`)
    : dim(`ctx ${pct}%`);

  // Column candidates, widest → leanest: optional columns are dropped before
  // the model cell shrinks, so the family name stays readable on 30-col screens.
  const candidates: string[][] = badgeCell
    ? [
        [modelCell, badgeCell, statsCell],
        [modelCell, badgeCell],
        [modelCell, statsCell],
        [modelCell],
      ]
    : [
        [modelCell, statsCell],
        [modelCell],
      ];

  const hint = input.hint ?? STATUS_PANEL_HINT;
  const build = (cells: string[], widths: number[]): string[] => {
    // Fill the terminal: the border runs are computed from the live width, so
    // the frame is dynamic (never a fixed column length) and still ends one
    // cell short of the edge, which is what keeps it from wrap-stacking.
    const needed = widths.reduce((a, b) => a + b, 0) + 3 * cells.length + 1;
    if (needed < maxOuter) widths[widths.length - 1] += maxOuter - needed;
    const inner = widths.reduce((a, b) => a + b, 0) + 3 * cells.length - 1;
    const top = `┌${widths.map((w) => '─'.repeat(w + 2)).join('┬')}┐`;
    const content = `│${cells
      .map((c, i) => ` ${padVisible(truncateVisible(c, widths[i]), widths[i])} `)
      .join('│')}│`;
    const sep = `├${widths.map((w) => '─'.repeat(w + 2)).join('┴')}┤`;
    const hintRow = `│ ${padVisible(truncateVisible(hint, inner - 2), inner - 2)} │`;
    const bottom = `└${'─'.repeat(inner)}┘`;
    return [top, content, sep, hintRow, bottom].map((l) => dim(l));
  };

  // Widest layout first; a leaner candidate is preferred over truncating the
  // model cell, and truncation is only the last resort (feedback §1).
  let truncated: { cells: string[]; widths: number[] } | null = null;
  for (const cells of candidates) {
    const overhead = 3 * cells.length + 1;
    const widths = cells.map((c) => Math.max(2, visibleLength(c)));
    const total = widths.reduce((a, b) => a + b, 0) + overhead;
    if (total <= maxOuter) return build(cells, widths);
    // Too wide: the model column may take whatever room is left after the rest.
    const rest = widths.slice(1).reduce((a, b) => a + b, 0);
    const allowed = maxOuter - overhead - rest;
    if (allowed >= 3 && (!truncated || allowed > truncated.widths[0])) {
      truncated = { cells, widths: [allowed, ...widths.slice(1)] };
    }
  }
  if (truncated) return build(truncated.cells, truncated.widths);

  // Last resort (absurdly narrow terminal): a single clamped column.
  const widths = [Math.max(3, maxOuter - 4)];
  return build([modelCell], widths);
}

/** `buildStatusPanel` joined into the multi-row block the editor draws. */
export function renderStatusPanel(input: StatusPanelInput): string {
  return buildStatusPanel(input).join('\n');
}

/**
 * True for the per-tool "start" log lines emitted by `runToolCall`
 * (`🟢 Read(x)`, `🟡 Edit(x) — tidak ada perubahan`, `🔴 Delete(x)`, …).
 *
 * The branch renderer captures these instead of printing them: a tool call is
 * committed to scrollback ONCE, when it finishes (feedback §3/§4).
 */
export function isToolStartLine(text: string): boolean {
  const plain = stripAnsi(text).trim();
  if (!/^(?:🟢|🟡|🔴|🔵|🟣|↩)\s*\S/.test(plain)) return false;
  return /^\S+\s+\S/.test(plain);
}

/** Branch labels per tool name (feedback §3: `├── 🔍 find PROGRESS.md`). */
const BRANCH_LABELS: Record<string, (arg: string) => string> = {
  read: (a) => `📖 Read ${a}`,
  readfile: (a) => `📖 Read ${a}`,
  read_file: (a) => `📖 Read ${a}`,
  edit: (a) => `✏️ Edit ${a}`,
  write: (a) => `✏️ Edit ${a}`,
  patch: (a) => `✏️ Edit ${a}`,
  bash: (a) => `🖥️ Bash(${a})`,
  exec: (a) => `🖥️ Bash(${a})`,
  glob: (a) => `🔍 find ${a}`,
  search: (a) => `🔍 grep ${a}`,
  listdir: (a) => `📁 List(${a})`,
  delete: (a) => `🔴 Delete(${a})`,
  move: (a) => `📦 Move(${a})`,
  revert: (a) => `↩ Revert(${a})`,
  remember: (a) => `🧠 Remember(${a})`,
  skill: (a) => `🧩 Skill(${a})`,
  saveskill: (a) => `🧩 SaveSkill(${a})`,
  deleteskill: (a) => `🧩 DeleteSkill(${a})`,
  skills: () => '🧩 Skills()',
  fetch: (a) => `🌐 Fetch(${a})`,
  searchsessions: (a) => `🗂️ SearchSessions(${a})`,
  startprocess: (a) => `🟢 StartProcess(${a})`,
  stopprocess: (a) => `🟡 StopProcess(${a})`,
  readlogs: (a) => `🔵 ReadLogs(${a})`,
  status: (a) => `🔵 Status(${a})`,
  subagent: (a) => `🟣 Subagent "${a}"`,
};

export interface TruncatePathOptions {
  cwd?: string;
  isNarrow?: boolean;
  terminalCols?: number;
}

/**
 * Smart path truncation utility:
 *  - Relative Path First: normalized relative to cwd (workspace root).
 *  - Middle Truncation: keeps root folder and filename, collapses middle to `...`
 *    (e.g. `src/agent/subagent/tools/processManager.ts` -> `src/.../processManager.ts`).
 *  - Narrow Terminal (< 45 cols / isNarrow): falls back to basename (`processManager.ts`),
 *    with trailing truncate if still exceeding limit.
 */
export function truncatePath(filePath: string, maxLen: number, options?: TruncatePathOptions): string {
  if (!filePath || maxLen <= 0) return '';
  const cwd = options?.cwd ?? process.cwd();
  let normalized = filePath.trim();

  // Normalize path separators to forward slash
  normalized = normalized.replace(/\\/g, '/');

  // Relative path first: if path is inside cwd, normalize relative to cwd
  if (path.isAbsolute(normalized)) {
    const rel = path.relative(cwd, filePath).replace(/\\/g, '/');
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      normalized = rel;
    }
  }

  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  const isNarrow = Boolean(
    options?.isNarrow ||
      (typeof options?.terminalCols === 'number' && options.terminalCols < 45),
  );

  // If path already fits and not in narrow mode, return as-is
  if (normalized.length <= maxLen && !isNarrow) {
    return normalized;
  }

  // Narrow fallback (< 45 cols / isNarrow): basename only
  if (isNarrow) {
    const base = path.posix.basename(normalized);
    if (base.length <= maxLen) {
      return base;
    }
    const ext = path.posix.extname(base);
    if (ext && ext.length < maxLen - 4) {
      const stem = base.slice(0, -ext.length);
      const availStem = maxLen - ext.length - 3;
      return `${stem.slice(0, Math.max(1, availStem))}...${ext}`;
    }
    return base.slice(0, Math.max(3, maxLen - 3)) + '...';
  }

  // Middle Truncation: root/.../file
  const isAbs = normalized.startsWith('/');
  const prefixSlash = isAbs ? '/' : '';
  const parts = normalized.split('/').filter(Boolean);

  if (parts.length >= 3) {
    const root = prefixSlash + parts[0];
    const file = parts[parts.length - 1];
    const basic = `${root}/.../${file}`;
    if (basic.length <= maxLen) {
      // Try expanding intermediate folders if space permits
      let leftIdx = 1;
      let rightIdx = parts.length - 2;
      let leftAcc = root;
      let rightAcc = file;
      while (leftIdx <= rightIdx) {
        const nextRight = `${parts[rightIdx]}/${rightAcc}`;
        const tryWithRight = `${leftAcc}/.../${nextRight}`;
        if (tryWithRight.length <= maxLen && rightIdx > leftIdx) {
          rightAcc = nextRight;
          rightIdx--;
          continue;
        }
        const nextLeft = `${leftAcc}/${parts[leftIdx]}`;
        const tryWithLeft = `${nextLeft}/.../${rightAcc}`;
        if (tryWithLeft.length <= maxLen) {
          leftAcc = nextLeft;
          leftIdx++;
          continue;
        }
        break;
      }
      return `${leftAcc}/.../${rightAcc}`;
    }

    // basic root/.../file exceeds maxLen: fallback to basename
    if (file.length <= maxLen) {
      return file;
    }
    const ext = path.posix.extname(file);
    if (ext && ext.length < maxLen - 4) {
      const stem = file.slice(0, -ext.length);
      const availStem = maxLen - ext.length - 3;
      return `${stem.slice(0, Math.max(1, availStem))}...${ext}`;
    }
    return file.slice(0, Math.max(3, maxLen - 3)) + '...';
  }

  // parts.length === 2 (e.g. "src/file.ts")
  if (parts.length === 2) {
    const file = parts[1];
    if (file.length <= maxLen) {
      return file;
    }
  }

  return normalized.slice(0, Math.max(3, maxLen - 3)) + '...';
}

/** Maps one captured tool line onto its `├── ` branch label. */
function branchLabel(plain: string, maxPathLen?: number, isNarrow?: boolean): string | null {
  const withParens = /^(\S+)\s+([A-Za-z_][\w]*)\(([^)]*)\)\s*(.*)$/.exec(plain);
  if (withParens) {
    const toolName = withParens[2];
    let arg = withParens[3].trim();
    const tail = withParens[4].trim();

    const lower = toolName.toLowerCase();
    const isPathTool = ['read', 'readfile', 'read_file', 'edit', 'write', 'patch', 'delete', 'revert'].includes(lower);
    if (isPathTool && arg && maxPathLen !== undefined) {
      arg = truncatePath(arg, maxPathLen, { isNarrow });
    }

    const render = BRANCH_LABELS[lower];
    const head = render ? render(arg) : `🔧 ${toolName}(${arg})`;
    return tail ? `${head} ${tail}` : head;
  }
  // Bare command form: `🟢 npm test` → `🖥️ Bash(npm test)`
  const direct = /^(\S+)\s+(.+)$/.exec(plain);
  if (direct && /^(?:🟢|🟡|🔴|🔵|🟣|↩)$/.test(direct[1])) {
    return `🖥️ Bash(${direct[2].trim()})`;
  }
  return null;
}

/**
 * Action-log history row (feedback §3): one branch per finished tool call.
 *
 *   ├── [1] 🔍 find PROGRESS.md (12ms)
 *   ├── [2] 🖥️ Bash(npm test) (4.2s)
 *   ├── [3] 🟣 Subagent "read file halo.md"
 *
 * Returns `null` for lines that are not tool invocations.
 */
export function formatActionLogLine(no: number, rawText: string, durationMs?: number, maxCols?: number): string | null {
  const plain = stripAnsi(rawText).trim();
  if (!plain) return null;

  const cols = maxCols ?? terminalWidth();
  const isNarrow = cols < 45;

  const suffix =
    durationMs != null && Number.isFinite(durationMs) && durationMs >= 0
      ? ` (${formatDuration(durationMs)})`
      : '';

  const prefix = `${dim('├──')} ${cyan(`[${no}]`)} `;
  const prefixLen = visibleLength(prefix);
  const suffixLen = visibleLength(suffix);

  // Compute overhead width: prefix + tool badge + tail note + suffix
  const match = /^(\S+)\s+([A-Za-z_][\w]*)\(([^)]*)\)\s*(.*)$/.exec(plain);
  let overheadWidth = prefixLen + suffixLen + 8;
  if (match) {
    const toolName = match[2].toLowerCase();
    const tailNote = match[4].trim();
    const dummyHead = BRANCH_LABELS[toolName] ? BRANCH_LABELS[toolName]('') : `🔧 ${match[2]}()`;
    overheadWidth = prefixLen + visibleLength(dummyHead) + (tailNote ? visibleLength(tailNote) + 1 : 0) + suffixLen;
  }

  const maxPathLen = Math.max(16, cols - overheadWidth);
  const label = branchLabel(plain, maxPathLen, isNarrow);
  if (!label) return null;

  let finalLabel = label;
  const availForLabel = cols - prefixLen - suffixLen;
  if (visibleLength(finalLabel) > availForLabel) {
    const maxLen = Math.max(8, availForLabel);
    finalLabel = truncateVisible(finalLabel, maxLen - 1) + '…';
  }

  const coloredSuffix = suffix ? dim(suffix) : '';
  return `${prefix}${finalLabel}${coloredSuffix}`;
}

/** First non-empty string value among `keys` (structural ToolCall accessor). */
function toolArg(call: ToolCallLike, ...keys: string[]): string {
  for (const k of keys) {
    const v = call[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Rebuilds the raw tool log line from the call itself — the fallback used when
 * a tool logged nothing of its own (the branch renderer prefers the captured
 * line, which carries extra notes such as `[30s]` or `— tidak ada perubahan`).
 */
export function describeToolCallForLog(call: ToolCallLike): string {
  const path = toolArg(call, 'path', 'file', 'file_path', 'target');
  switch (call.tool) {
    case 'read_file':
      return `🟢 Read(${clip(path, 60)})`;
    case 'write_file':
    case 'edit_file':
    case 'patch_file':
      return `🟢 Edit(${clip(path, 60)})`;
    case 'glob':
      return `🟢 Glob(${clip(toolArg(call, 'pattern', 'query'), 60)})`;
    case 'code_search':
      return `🟢 Search(${clip(toolArg(call, 'query', 'pattern'), 60)})`;
    case 'list_dir':
      return `🟢 ListDir(${clip(path || toolArg(call, 'dir'), 60)})`;
    case 'exec':
      return `🟢 Bash(${clip(toolArg(call, 'command', 'cmd'), 80)})`;
    case 'delete_file':
      return `🔴 Delete(${clip(path, 60)})`;
    case 'move_file':
      return `🟢 Move(${clip(toolArg(call, 'source', 'from'), 40)} -> ${clip(toolArg(call, 'destination', 'to'), 40)})`;
    case 'revert_file':
      return `↩ Revert(${clip(path, 60)})`;
    case 'remember':
      return `🟢 Remember(${clip(toolArg(call, 'text', 'note', 'content', 'key'), 60)})`;
    case 'load_skill':
      return `🟢 Skill(${toolArg(call, 'name')})`;
    case 'save_skill':
      return `🟢 SaveSkill(${toolArg(call, 'name')})`;
    case 'delete_skill':
      return `🔴 DeleteSkill(${toolArg(call, 'name')})`;
    case 'list_skills':
      return '🟢 Skills()';
    case 'web_fetch':
      return `🟢 Fetch(${clip(toolArg(call, 'url'), 60)})`;
    case 'search_sessions':
      return `🟢 SearchSessions(${clip(toolArg(call, 'query'), 60)})`;
    case 'start_process':
      return `🟢 StartProcess(${clip(toolArg(call, 'command'), 60)})`;
    case 'stop_process':
      return `🟡 StopProcess(${toolArg(call, 'process_id', 'id')})`;
    case 'read_process_logs':
      return `🔵 ReadLogs(${toolArg(call, 'process_id', 'id')})`;
    case 'get_status':
      return `🔵 Status(${toolArg(call, 'process_id', 'id')})`;
    case 'delegate':
      return `🟣 Subagent(${clip(toolArg(call, 'task', 'prompt'), 60)})`;
    default:
      return `🟢 ${call.tool}()`;
  }
}

/**
 * Bottom-tray label for a running tool (feedback §4):
 * `🟣 Subagent (read_file) halo.md`, `🟢 npm test`, `📖 Read package.json`.
 */
export function activityLabelForTool(call: ToolCallLike): string {
  const path = toolArg(call, 'path', 'file', 'file_path', 'target');
  switch (call.tool) {
    case 'delegate': {
      const task = toolArg(call, 'task', 'prompt');
      const m = /^(\S+)\s+(.+)$/.exec(task);
      return m ? `Subagent (${m[1]}) ${clip(m[2], 40)}` : `Subagent ${clip(task, 44)}`;
    }
    case 'exec':
      return clip(toolArg(call, 'command', 'cmd'), 44);
    case 'read_file':
      return `Read ${clip(path, 40)}`;
    case 'write_file':
    case 'edit_file':
    case 'patch_file':
      return `Edit ${clip(path, 40)}`;
    case 'glob':
      return `find ${clip(toolArg(call, 'pattern', 'query'), 40)}`;
    case 'code_search':
      return `grep ${clip(toolArg(call, 'query', 'pattern'), 40)}`;
    case 'list_dir':
      return `List ${clip(path || toolArg(call, 'dir'), 40)}`;
    case 'web_fetch':
      return `Fetch ${clip(toolArg(call, 'url'), 40)}`;
    default:
      return `${call.tool} ${clip(path, 36)}`.trim();
  }
}

/** Tray icon for a running tool (🟣 delegation, 🔴 destructive, 🟢 otherwise). */
export function activityIconForTool(call: ToolCallLike): string {
  if (call.tool === 'delegate') return '🟣';
  if (call.tool === 'delete_file' || call.tool === 'delete_skill') return '🔴';
  if (call.tool === 'stop_process' || call.tool === 'revert_file') return '🟡';
  return '🟢';
}

/**
 * Per-turn usage line (§7.47 transparency): `↑ 3.2k ↓ 0.8k · cache — · ctx 41%`
 * Char-based (provider-agnostic); token counts need API usage reporting.
 */
export function buildUsageLine(u: {
  promptChars: number;
  completionChars: number;
  usedChars: number;
  budgetChars: number;
}): string {
  const pct = u.budgetChars > 0 ? Math.min(100, Math.round((u.usedChars / u.budgetChars) * 100)) : 0;
  return `↑ ${formatK(u.promptChars)} ↓ ${formatK(u.completionChars)} · ctx ${pct}%`;
}

/** Green prompt glyph for the REPL. */
export function promptGlyph(): string {
  return green(bold('› '));
}

export interface Spinner {
  stop(): void;
  update?(label: string): void;
}

export interface SpinnerOptions {
  // Options for spinner customization
}

/**
 * `▸ Thinking...` minimal dot spinner.
 * Redrawn in place on a single line via carriage return (`\r`) so it integrates
 * with LineEditor's shared redraw engine without stacking lines in scrollback.
 * Auto-disabled when stdout is not a TTY or colors are disabled.
 * Always call `stop()` when the operation completes.
 */
export function createSpinner(label = 'Thinking', _options: SpinnerOptions = {}): Spinner {
  if (!colorsEnabled()) return { stop() {}, update() {} };

  let dots = 0;
  let currentLabel = label;
  let maxCleared = Math.max(24, label.length + 6);
  const render = () => {
    const text = `▸ ${currentLabel}${'.'.repeat(dots)}`;
    if (text.length + 2 > maxCleared) maxCleared = text.length + 2;
    process.stdout.write(`\r${dim(text)}`.padEnd(maxCleared, ' '));
  };
  render();
  const timer = setInterval(() => {
    dots = (dots + 1) % 4;
    render();
  }, 200);
  return {
    update(newLabel: string) {
      currentLabel = newLabel;
      render();
    },
    stop() {
      clearInterval(timer);
      process.stdout.write(`\r\u001b[2K${' '.repeat(maxCleared)}\r`);
    },
  };
}

/** Longest suffix of `text` that is a strict prefix of the fence marker. */
function fencePrefixHold(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (text.slice(-len) === marker.slice(0, len)) return len;
  }
  return 0;
}

const FENCE = '```';
const TOOL_FENCE_RE = /^```[ \t]*tool\b/i;
const JSON_TOOL_CALL_RE = /["'](?:tool|name|function|action)["']\s*:\s*["'](?:read_file|read|readfile|edit_file|edit|editfile|write_file|write|writefile|patch_file|patch|patchfile|exec|bash|shell|sh|cmd|terminal|execute_command|executecommand|run_command|code_search|search|codesearch|grep|search_files|find_in_files|glob|find_files|glob_files|list_files|list_dir|listdir|list_directory|delete_file|delete|move_file|move|web_fetch|fetch|remember|save_skill|get_skill|subagent|start_process|stop_process)\b/i;

/**
 * Line-buffered sink that holds the trailing line back until either another
 * line arrives or the stream ends.
 *
 * Why: when the model writes a short preamble (e.g. "dengan: melihat daftar
 * perintah") immediately before a ```` ```tool ```` block, the reveal filter
 * hides the block but the dangling half-sentence used to leak to the screen.
 * Because tool blocks always sit after that trailing text, the agent can call
 * `finish(false)` on a tool iteration to drop it — while final answers use
 * `finish(true)` and are flushed (per-line streaming preserved).
 */
export class LineGate {
  private pending = '';
  private held: string[] = [];
  private emitted = false;

  constructor(private readonly sink: (text: string) => void) {}

  push(chunk: string): void {
    if (!chunk) return;
    this.pending += chunk;
    for (;;) {
      const nl = this.pending.indexOf('\n');
      if (nl === -1) break;
      this.held.push(this.pending.slice(0, nl + 1));
      this.pending = this.pending.slice(nl + 1);
    }
    // Emit everything but the most recent line so one line is always in reserve.
    while (this.held.length > 1) {
      this.emitted = true;
      this.sink(this.held.shift()!);
    }
  }

  /**
   * Ends the gate. `keepTrailing` true flushes the reserved line (final answer);
   * false drops it (it was a preamble to a hidden tool block).
   * Returns true when anything was written to the sink.
   */
  finish(keepTrailing: boolean): boolean {
    if (keepTrailing) {
      for (const line of this.held) {
        this.emitted = true;
        this.sink(line);
      }
      if (this.pending) {
        this.emitted = true;
        this.sink(this.pending);
      }
    }
    this.held = [];
    this.pending = '';
    return this.emitted;
  }
}

/**
 * Options for ThoughtSlidingWindow.
 */
export interface ThoughtSlidingWindowOptions {
  /** Maximum number of recent words kept in the sliding window buffer (default: 12). */
  maxWords?: number;
  /** Custom render hook (defaults to stdout write with carriage return). */
  onRender?: (line: string) => void;
  /** Custom clear hook (defaults to stdout line erase with \r\u001b[2K). */
  onClear?: () => void;
}

/**
 * Word-based sliding window renderer for live reasoning thought streams.
 *
 * Displays the latest N words prefixed with `[berpikir] ` in dim gray (\x1b[90m),
 * updating in place using \r\u001b[2K so the terminal screen stays clean and unpolluted.
 */
export class ThoughtSlidingWindow {
  private words: string[] = [];
  private currentPartialWord = '';
  private readonly maxWords: number;
  private readonly onRender?: (line: string) => void;
  private readonly onClear?: () => void;
  private active = false;

  constructor(options: ThoughtSlidingWindowOptions = {}) {
    this.maxWords = options.maxWords ?? 12;
    this.onRender = options.onRender;
    this.onClear = options.onClear;
  }

  feed(chunk: string): void {
    if (!chunk) return;
    this.active = true;
    const combined = this.currentPartialWord + chunk;
    this.currentPartialWord = '';

    const endsWithWhitespace = /\s$/.test(combined);
    const tokens = combined.trim().split(/\s+/).filter(Boolean);

    if (!endsWithWhitespace && tokens.length > 0) {
      this.currentPartialWord = tokens.pop()!;
    }

    for (const w of tokens) {
      this.words.push(w);
      if (this.words.length > this.maxWords) {
        this.words.shift();
      }
    }

    this.emit();
  }

  getWords(): string[] {
    const list = [...this.words];
    if (this.currentPartialWord) {
      list.push(this.currentPartialWord);
      if (list.length > this.maxWords) {
        list.shift();
      }
    }
    return list;
  }

  render(): string {
    const displayWords = this.getWords();
    if (displayWords.length === 0) return '';
    return `\r\u001b[2K${dim(`[berpikir] ${displayWords.join(' ')}`)}`;
  }

  private emit(): void {
    const rendered = this.render();
    if (rendered) {
      if (this.onRender) {
        this.onRender(rendered);
      } else {
        process.stdout.write(rendered);
      }
    }
  }

  clear(): void {
    if (this.active) {
      if (this.onClear) {
        this.onClear();
      } else if (this.onRender) {
        this.onRender('\r\u001b[2K');
      } else {
        process.stdout.write('\r\u001b[2K');
      }
      this.active = false;
    }
    this.words = [];
    this.currentPartialWord = '';
  }

  isActive(): boolean {
    return this.active;
  }

  reset(): void {
    this.clear();
  }
}

/**
 * Options for ThinkingTicker.
 */
export interface ThinkingTickerOptions {
  /** Optional custom output sink (defaults to stdout write with carriage return). */
  onRender?: (line: string) => void;
  /** Optional clear hook (defaults to stdout erase with \r\u001b[2K). */
  onClear?: () => void;
  /** Width provider for responsive truncation (defaults to terminalWidth()). */
  width?: () => number;
}

/**
 * Ephemeral Thinking Ticker (feedback §1).
 *
 * Renders in-flight reasoning chunks as a single dynamic line:
 *   `• Thinking: <cuplikan_teks_terkini>...` (dim/gray ANSI \x1b[90m)
 * updated in-place via `\r\u001b[2K` and auto-truncated to terminal width so it never wraps.
 *
 * When reasoning finishes (final flush):
 *  1. Clears the dynamic line (`\r\u001b[2K`).
 *  2. Returns exactly ONE permanent summary line:
 *     `• Thought for <detik>s (<perkiraan_tokens> tokens)`
 */
export class ThinkingTicker {
  private buffered = '';
  private startTime = 0;
  private active = false;
  private finished = false;

  constructor(private readonly options: ThinkingTickerOptions = {}) {}

  start(): void {
    if (this.finished || this.active) return;
    this.startTime = Date.now();
    this.active = true;
    const line = dim('• Thinking...');
    if (this.options.onRender) {
      this.options.onRender(`\r\u001b[2K${line}`);
    } else {
      process.stdout.write(`\r\u001b[2K${line}`);
    }
  }

  feed(chunk: string): void {
    if (!chunk || this.finished) return;
    if (!this.startTime) {
      this.startTime = Date.now();
    }
    this.buffered += chunk;
    this.active = true;

    const cols = this.options.width ? this.options.width() : terminalWidth();
    const cleaned = this.buffered.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    const prefix = '• Thinking: ';
    const suffix = '...';
    const overhead = prefix.length + suffix.length;
    const maxSnippet = Math.max(10, cols - 1 - overhead);
    const snippet = cleaned.length > maxSnippet ? cleaned.slice(-maxSnippet).trimStart() : cleaned;
    const line = dim(`${prefix}${snippet}${suffix}`);
    const clamped = truncateVisible(line, Math.max(10, cols - 2));

    if (this.options.onRender) {
      this.options.onRender(`\r\u001b[2K${clamped}`);
    } else {
      process.stdout.write(`\r\u001b[2K${clamped}`);
    }
  }

  flush(): string | null {
    if (this.finished) return null;
    this.finished = true;

    if (!this.buffered && !this.active) {
      return null;
    }

    if (this.options.onClear) {
      this.options.onClear();
    } else if (this.options.onRender) {
      this.options.onRender('\r\u001b[2K');
    } else {
      process.stdout.write('\r\u001b[2K');
    }

    if (!this.buffered) {
      this.active = false;
      return null;
    }

    const elapsed = Math.max(0, Date.now() - this.startTime);
    const secNum = elapsed / 1000;
    const secStr = secNum < 1
      ? Math.max(0.1, Number(secNum.toFixed(1))).toString()
      : secNum.toFixed(1).replace(/\.0$/, '');
    const tokens = Math.max(1, Math.round(this.buffered.length / 4));
    const summary = dim(`• Thought for ${secStr}s (${tokens} tokens)`);
    this.active = false;
    return summary;
  }

  isActive(): boolean {
    return this.active;
  }

  isFinished(): boolean {
    return this.finished;
  }

  getBuffered(): string {
    return this.buffered;
  }

  renderFramedReasoning(width?: number): string {
    return renderReasoningBox(this.buffered, width);
  }
}

/**
 * Bungkus blok reasoning/thinking dengan frame pembatas garis tipis (ala Hermes CLI):
 *
 * ┌─ Reasoning ─────────────────────────────────────────
 * │ <isi teks reasoning berwarna ANSI gray / dim \x1b[90m>
 * └─────────────────────────────────────────────────────
 *
 * Panjang garis horizontal atas (`┌─ Reasoning ───`) dibuat responsif menyesuaikan
 * process.stdout.columns / terminalWidth atau dipotong rapi tanpa penutup kanan kaku
 * agar tidak patah di layar ponsel.
 */
export function renderReasoningBox(reasoning: string, width?: number): string {
  const plain = reasoning.trim();
  if (!plain) return '';

  const cols = width ?? terminalWidth();
  const prefix = '┌─ Reasoning ';
  const prefixLen = visibleLength(prefix); // 13
  const targetWidth = Math.max(prefixLen + 5, Math.min(cols, 80));
  const topDashes = '─'.repeat(Math.max(3, targetWidth - prefixLen));
  const bottomDashes = '─'.repeat(Math.max(prefixLen + 5, targetWidth - 1));

  const topBorder = dim(`${prefix}${topDashes}`);
  const bottomBorder = dim(`└${bottomDashes}`);

  // Inside max width for wrapping
  const maxInner = Math.max(10, cols - 3);

  const lines = plain.split(/\r?\n/);
  const framedLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      framedLines.push(dim('│'));
      continue;
    }

    if (visibleLength(trimmed) <= maxInner) {
      framedLines.push(`${dim('│')} ${dim(trimmed)}`);
    } else {
      const words = trimmed.split(' ');
      let cur = '';
      for (const w of words) {
        if (!cur) {
          cur = w;
        } else if (visibleLength(cur + ' ' + w) <= maxInner) {
          cur += ' ' + w;
        } else {
          framedLines.push(`${dim('│')} ${dim(cur)}`);
          cur = w;
        }
      }
      if (cur) {
        framedLines.push(`${dim('│')} ${dim(cur)}`);
      }
    }
  }

  return [topBorder, ...framedLines, bottomBorder].join('\n');
}

export const formatReasoningBox = renderReasoningBox;

/** Level expand/collapse panel reasoning (Fase 3). */
export type ReasoningExpandMode = 'collapsed' | 'expanded';

/**
 * Panel Reasoning/Thinking terpisah (Fase 3) — section box sendiri yang
 * TIDAK mencampur log tool call. Default COLLAPSED; toggle via Ctrl+R.
 *
 * Rute tampilan:
 *  - `onLive`    : dipakai SAAT model masih berpikir — satu baris in-place
 *                  (\r\u001b[2K) ala ThinkingTicker, hilang total saat beres.
 *  - `onPermanent`: dipakai saat reasoning selesai — menghasilkan TEPAT SATU
 *                  baris permanen (collapsed) atau box penuh (expanded).
 *
 * Alasan buffer streaming (Fase 3): render per-baris selesai DENGAN throttle
 * waktu. Per-baris menjaga blok logis reasoning tetap utuh dan tidak terpotong
 * di tengah kata; throttle 100ms mencegah banjir redraw ANSI pada chunk SSE
 * kecil (jitter frame 10x lebih cepat dari refresh mata) tanpa terasa lag.
 */
export class ReasoningPanel {
  private buffer = '';
  private startTime = 0;
  private finished = false;
  private lastRenderMs = 0;
  private renderedOnce = false;
  private lastElapsedSec = 0;
  private lastTokens: number | null = null;

  constructor(
    private readonly options: {
      /** Output in-place saat reasoning masih berjalan (default stdout). */
      onLive?: (line: string) => void;
      /** Hook pembersih baris live (default: kirim '\r\u001b[2K' ke onLive/stdout). */
      onClear?: () => void;
      /** Output permanen saat reasoning selesai (default console.log). */
      onPermanent?: (line: string) => void;
      /** Pemilih mode expand/collapse (dipanggil ulang tiap render/toggle). */
      getMode?: () => ReasoningExpandMode;
      /** Throttle render live dalam ms (default 100). */
      throttleMs?: number;
      /** Width provider responsif (default terminalWidth()). */
      width?: () => number;
      /** Token usage reasoning dari API; return null jika tidak tersedia. */
      getTokens?: () => number | null;
    } = {},
  ) {}

  /** Dipanggil setiap reasoning dimulai (mendukung beberapa segmen per turn). */
  start(): void {
    if (this.finished && !this.buffer.trim()) {
      // Segmen baru setelah segmen sebelumnya selesai di-permanenkan.
      this.finished = false;
      this.segmentEmitted = false;
      this.renderedOnce = false;
    }
    if (this.finished) return;
    this.startTime = Date.now();
  }

  feed(chunk: string): void {
    if (!chunk) return;
    if (this.finished) {
      // Chunk baru setelah finish = segmen reasoning BARU pada turn yang sama
      // (model bisa mengirim <thought> berkali-kali). Segmen sebelumnya sudah
      // jadi baris/box permanen sendiri; mulai buffer segar.
      this.finished = false;
      this.segmentEmitted = false;
      this.renderedOnce = false;
      this.buffer = '';
      this.startTime = Date.now();
    }
    if (!this.startTime) this.startTime = Date.now();
    this.buffer += chunk;

    const now = Date.now();
    const throttle = this.options.throttleMs ?? 100;
    if (!this.renderedOnce || now - this.lastRenderMs >= throttle) {
      this.renderLive();
    }
  }

  /** Toggle expand/collapse (Ctrl+R). Me-render ulang permanen jika sudah beres. */
  toggle(mode?: ReasoningExpandMode): void {
    this.expandMode = mode ?? (this.expandMode === 'expanded' ? 'collapsed' : 'expanded');
    this.emitPermanentIfFinished();
  }

  private expandMode: ReasoningExpandMode = 'collapsed';

  private getMode(): ReasoningExpandMode {
    return this.options.getMode?.() ?? this.expandMode;
  }

  private writeLive(text: string): void {
    if (this.options.onLive) this.options.onLive(text);
    else process.stdout.write(text);
  }

  private clearLive(): void {
    if (this.options.onClear) {
      this.options.onClear();
    } else {
      this.writeLive('\r\u001b[2K');
    }
  }

  private renderLive(): void {
    this.renderedOnce = true;
    this.lastRenderMs = Date.now();

    const cols = this.options.width ? this.options.width() : terminalWidth();
    const cleaned = this.buffer.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    const prefix = '┌─ Reasoning: ';
    const suffix = '...';
    const overhead = prefix.length + suffix.length;
    const maxSnippet = Math.max(10, cols - 1 - overhead);
    const snippet = cleaned.length > maxSnippet ? cleaned.slice(-maxSnippet).trimStart() : cleaned;
    const line = dim(`${prefix}${snippet}${suffix}`);
    const clamped = truncateVisible(line, Math.max(10, cols - 2));
    this.writeLive(`\r\u001b[2K${clamped}`);
  }

  /**
   * Satu baris selesai (\n) atau reasoning berakhir. Permanen TEPAT SEKALI;
   * bentuk tergantung mode: collapsed = satu baris ringkas, expanded = box.
   */
  finish(): string | null {
    if (!this.buffer.trim()) {
      this.finished = true;
      this.startTime = 0;
      return null;
    }
    // Segmen yang sudah di-permanenkan oleh finishSegment TIDAK di-render ulang.
    if (this.segmentEmitted) return stripAnsi(this.lastPermanentLine ?? '');
    this.finished = true;
    this.lastElapsedSec = Math.max(0, (Date.now() - (this.startTime || Date.now())) / 1000);
    // Token usage dari API (jika provider menyediakan); null = tidak tersedia.
    this.lastTokens = this.options.getTokens?.() ?? null;
    this.clearLive();
    this.emitPermanent();
    return stripAnsi(this.lastPermanentLine ?? '');
  }

  private lastPermanentLine: string | null = null;

  /**
   * Satu blok <thought> berakhir di tengah turn — segmen ini di-permanenkan
   * sekarang (baris collapsed / box). Segmen berikutnya buka section baru.
   */
  finishSegment(): void {
    if (this.segmentEmitted || !this.buffer.trim()) return;
    this.finished = true;
    this.lastElapsedSec = Math.max(0, (Date.now() - (this.startTime || Date.now())) / 1000);
    this.lastTokens = this.options.getTokens?.() ?? null;
    this.clearLive();
    this.emitPermanent();
    this.startTime = 0;
  }

  /** Bentuk baris permanen collapsed: "Thought for Xs" (+ "(Y tokens)" jika tersedia). */
  collapsedLine(): string | null {
    if (!this.buffer.trim()) return null;
    const secNum = this.lastElapsedSec;
    const secStr = secNum < 1
      ? Math.max(0.1, Number(secNum.toFixed(1))).toString()
      : secNum.toFixed(1).replace(/\.0$/, '');
    const tokens = this.lastTokens;
    const base = `• Thought for ${secStr}s`;
    const detail = tokens != null ? ` (${tokens} tokens)` : '';
    return dim(`${base}${detail}`);
  }

  private segmentEmitted = false;

  private emitPermanent(): void {
    const mode = this.getMode();
    const line = mode === 'expanded'
      ? renderReasoningBox(this.buffer, this.options.width?.() ?? undefined)
      : this.collapsedLine() ?? '';
    this.lastPermanentLine = line;
    this.segmentEmitted = true;
    if (!line) return;
    if (this.options.onPermanent) this.options.onPermanent(line);
    else console.log(line);
  }

  /** Re-render permanen (dipakai toggle Ctrl+R setelah finish). */
  private emitPermanentIfFinished(): void {
    if (this.finished && this.buffer.trim()) this.emitPermanent();
  }

  isActive(): boolean {
    return !this.finished && this.startTime > 0;
  }

  isFinished(): boolean {
    return this.finished;
  }

  getBuffered(): string {
    return this.buffer;
  }

  get lastPermanent(): string | null {
    return this.lastPermanentLine;
  }
}

/**
 * Options for ThoughtStreamParser.
 */
export interface ThoughtStreamParserOptions {
  onText: (text: string) => void;
  onThought: (thought: string) => void;
  onThoughtEnd?: () => void;
}

/**
 * Streaming parser that routes reasoning `<thought>...</thought>` or `<think>...</think>`
 * to thought handlers while forwarding regular content to user text sinks.
 */
export class ThoughtStreamParser {
  private buffer = '';
  private inThought = false;
  private thoughtTagClose = '';

  constructor(private readonly options: ThoughtStreamParserOptions) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    this.drain();
  }

  isInThought(): boolean {
    return this.inThought;
  }

  private drain(): void {
    for (;;) {
      if (this.inThought) {
        const closeIdx = this.buffer.indexOf(this.thoughtTagClose);
        if (closeIdx === -1) {
          const hold = fencePrefixHold(this.buffer, this.thoughtTagClose);
          const emitThought = this.buffer.slice(0, this.buffer.length - hold);
          this.buffer = hold ? this.buffer.slice(this.buffer.length - hold) : '';
          if (emitThought) {
            this.options.onThought(emitThought);
          }
          return;
        }

        const thoughtContent = this.buffer.slice(0, closeIdx);
        if (thoughtContent) {
          this.options.onThought(thoughtContent);
        }
        this.options.onThoughtEnd?.();
        this.inThought = false;
        let rest = this.buffer.slice(closeIdx + this.thoughtTagClose.length);
        if (rest.startsWith('\n')) rest = rest.slice(1);
        this.buffer = rest;
        this.thoughtTagClose = '';
        continue;
      }

      const thoughtOpen = this.buffer.indexOf('<thought>');
      const thinkOpen = this.buffer.indexOf('<think>');

      let openIdx = -1;
      let openTag = '';
      let closeTag = '';

      if (thoughtOpen !== -1 && (thinkOpen === -1 || thoughtOpen < thinkOpen)) {
        openIdx = thoughtOpen;
        openTag = '<thought>';
        closeTag = '</thought>';
      } else if (thinkOpen !== -1) {
        openIdx = thinkOpen;
        openTag = '<think>';
        closeTag = '</think>';
      }

      if (openIdx === -1) {
        const holdThought = fencePrefixHold(this.buffer, '<thought>');
        const holdThink = fencePrefixHold(this.buffer, '<think>');
        const hold = Math.max(holdThought, holdThink);
        const emitText = this.buffer.slice(0, this.buffer.length - hold);
        this.buffer = hold ? this.buffer.slice(this.buffer.length - hold) : '';
        if (emitText) {
          this.options.onText(emitText);
        }
        return;
      }

      if (openIdx > 0) {
        this.options.onText(this.buffer.slice(0, openIdx));
      }
      this.inThought = true;
      this.thoughtTagClose = closeTag;
      this.buffer = this.buffer.slice(openIdx + openTag.length);
    }
  }

  end(): void {
    if (this.inThought) {
      if (this.buffer) {
        this.options.onThought(this.buffer);
      }
      this.options.onThoughtEnd?.();
      this.inThought = false;
    } else if (this.buffer) {
      this.options.onText(this.buffer);
    }
    this.buffer = '';
    this.thoughtTagClose = '';
  }
}

/** Strips all <thought>...</thought> and <think>...</think> reasoning blocks. */
export function stripThoughtBlocks(text: string): string {
  if (!text) return '';
  return text
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\*Thought:[\s\S]*?\*/gi, '')
    .trim();
}

/** Extracts text within <thought> or <think> tags. */
export function extractThoughts(text: string): string[] {
  if (!text) return [];
  const results: string[] = [];
  for (const m of text.matchAll(/<thought>([\s\S]*?)<\/thought>/gi)) {
    results.push(m[1].trim());
  }
  for (const m of text.matchAll(/<think>([\s\S]*?)<\/think>/gi)) {
    results.push(m[1].trim());
  }
  return results;
}

const DSML_PREFIX_MARKERS = [
  '<||DSML||',
  '<｜｜DSML｜｜',
  '<|DSML||',
  '<｜DSML｜｜',
  '<|DSML|',
  '<｜DSML｜',
  '</||DSML||',
  '</｜｜DSML｜｜',
  '</|DSML||',
  '</｜DSML｜｜',
  '</|DSML|',
  '</｜DSML｜',
];

function dsmlPrefixHold(text: string): number {
  let max = 0;
  for (const m of DSML_PREFIX_MARKERS) {
    const h = fencePrefixHold(text, m);
    if (h > max) max = h;
  }
  return max;
}

/**
 * feedback.txt item 1: hold partial bare-XML invoke tags back until the whole
 * opening tag has arrived. Without this, `<invoke name=` was flushed to the
 * terminal character by character BEFORE the filter could recognise the block
 * (the exact leak: `.github/workflows</parameter></invoke>`).
 */
const INVOKE_TAG_MARKERS = [
  '<invoke',
  '</invoke',
  '<parameter',
  '</parameter',
  '<function_calls',
  '</function_calls',
];

function invokeTagPrefixHold(text: string): number {
  let max = 0;
  for (const m of INVOKE_TAG_MARKERS) {
    const h = fencePrefixHold(text, m);
    if (h > max) max = h;
  }
  return max;
}

function malformedPrefixHold(text: string): number {
  const lastLt = Math.max(text.lastIndexOf('<'), text.lastIndexOf('＜'));
  if (lastLt === -1) return 0;
  const tail = text.slice(lastLt);
  if (tail.includes('>')) return 0;
  if (tail.length > 256) return 0;

  if (!/\s/.test(tail)) return tail.length;
  if (/[^\x00-\x7F]/.test(tail)) return tail.length;
  if (/\b(?:name|tool|query|path|command|action)\b/i.test(tail)) {
    return tail.length;
  }
  return 0;
}

/**
 * Protocol-aware streaming reveal filter.
 *
 * Feeds raw LLM tokens through `feed()`; emits only human-visible text to
 * the sink while hiding tool blocks:
 *   - ```tool ... ```
 *   - <|DSML|... / <｜DSML｜... / <|DSML||calls>... / <｜｜DSML｜｜ calls>...
 *   - <tool_call>...</tool_call>
 */
export class RevealFilter {
  private buffer = '';
  private hiddenType:
    | 'tool_fence'
    | 'dsml_calls'
    | 'dsml_invoke'
    | 'xml_parameter'
    | 'tool_call'
    | 'tool_tag'
    | null = null;
  private skipNextNewline = false;

  constructor(private readonly sink: (text: string) => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    this.drain();
  }

  /** Flush any pending visible text once the stream has ended. */
  end(): void {
    if (!this.hiddenType && this.buffer) {
      if (!/[<＜]\s*[^\s>]+\s+[^>]*?\b(?:name|tool|query|path|command|action)\s*=/i.test(this.buffer)) {
        this.sink(this.buffer);
      }
    }
    this.buffer = '';
    this.hiddenType = null;
    this.skipNextNewline = false;
  }

  private drain(): void {
    if (this.skipNextNewline) {
      if (this.buffer.startsWith('\r\n')) {
        this.buffer = this.buffer.slice(2);
        this.skipNextNewline = false;
      } else if (this.buffer.startsWith('\n')) {
        this.buffer = this.buffer.slice(1);
        this.skipNextNewline = false;
      } else if (this.buffer.length > 0) {
        this.skipNextNewline = false;
      }
    }

    for (;;) {
      if (this.hiddenType === 'tool_fence') {
        const close = this.buffer.indexOf(FENCE);
        if (close === -1) {
          const hold = fencePrefixHold(this.buffer, FENCE);
          this.buffer = hold ? this.buffer.slice(this.buffer.length - hold) : '';
          return;
        }
        let rest = this.buffer.slice(close + FENCE.length);
        if (rest.startsWith('\r\n')) {
          rest = rest.slice(2);
        } else if (rest.startsWith('\n')) {
          rest = rest.slice(1);
        } else if (rest.length === 0) {
          this.skipNextNewline = true;
        }
        this.buffer = rest;
        this.hiddenType = null;
        continue;
      }

      if (this.hiddenType === 'dsml_calls') {
        const closeMatch = /<\/\s*(?:\||｜)+DSML(?:\||｜)+\s*(?:calls|tool_calls)[^>]*>/i.exec(this.buffer);
        if (!closeMatch) {
          return;
        }
        let rest = this.buffer.slice(closeMatch.index + closeMatch[0].length);
        if (rest.startsWith('\r\n')) {
          rest = rest.slice(2);
        } else if (rest.startsWith('\n')) {
          rest = rest.slice(1);
        } else if (rest.length === 0) {
          this.skipNextNewline = true;
        }
        this.buffer = rest;
        this.hiddenType = null;
        continue;
      }

      if (this.hiddenType === 'dsml_invoke') {
        // feedback.txt item 1: the closing tag may drop the DSML prefix even
        // when the opening tag carried it (`<|DSML|invoke ...></invoke>`), so
        // the prefix is OPTIONAL here — otherwise the filter stayed in hide
        // mode and swallowed every later chunk of the reply.
        const closeMatch = /<\/\s*(?:(?:\||｜)+DSML(?:\||｜)+\s*)?invoke[^>]*>/i.exec(this.buffer);
        if (!closeMatch) {
          return;
        }
        let rest = this.buffer.slice(closeMatch.index + closeMatch[0].length);
        if (rest.startsWith('\r\n')) {
          rest = rest.slice(2);
        } else if (rest.startsWith('\n')) {
          rest = rest.slice(1);
        } else if (rest.length === 0) {
          this.skipNextNewline = true;
        }
        this.buffer = rest;
        this.hiddenType = null;
        continue;
      }

      if (this.hiddenType === 'xml_parameter') {
        // Bare `<parameter name="...">value</parameter>` outside an invoke block.
        const closeMatch = /<\/\s*(?:(?:\||｜)+DSML(?:\||｜)+\s*)?parameter[^>]*>/i.exec(this.buffer);
        if (!closeMatch) {
          return;
        }
        let rest = this.buffer.slice(closeMatch.index + closeMatch[0].length);
        if (rest.startsWith('\r\n')) {
          rest = rest.slice(2);
        } else if (rest.startsWith('\n')) {
          rest = rest.slice(1);
        } else if (rest.length === 0) {
          this.skipNextNewline = true;
        }
        this.buffer = rest;
        this.hiddenType = null;
        continue;
      }

      if (this.hiddenType === 'tool_call') {
        const closeIdx = this.buffer.indexOf('</tool_call>');
        if (closeIdx === -1) {
          const hold = fencePrefixHold(this.buffer, '</tool_call>');
          this.buffer = hold ? this.buffer.slice(this.buffer.length - hold) : '';
          return;
        }
        let rest = this.buffer.slice(closeIdx + 12);
        if (rest.startsWith('\r\n')) {
          rest = rest.slice(2);
        } else if (rest.startsWith('\n')) {
          rest = rest.slice(1);
        } else if (rest.length === 0) {
          this.skipNextNewline = true;
        }
        this.buffer = rest;
        this.hiddenType = null;
        continue;
      }

      if (this.hiddenType === 'tool_tag') {
        const closeIdx = this.buffer.indexOf('</tool>');
        if (closeIdx === -1) {
          const hold = fencePrefixHold(this.buffer, '</tool>');
          this.buffer = hold ? this.buffer.slice(this.buffer.length - hold) : '';
          return;
        }
        let rest = this.buffer.slice(closeIdx + 7);
        if (rest.startsWith('\r\n')) {
          rest = rest.slice(2);
        } else if (rest.startsWith('\n')) {
          rest = rest.slice(1);
        } else if (rest.length === 0) {
          this.skipNextNewline = true;
        }
        this.buffer = rest;
        this.hiddenType = null;
        continue;
      }

      const fenceIdx = this.buffer.indexOf(FENCE);
      const dsmlMatch = /<\/?\s*(?:\||｜)+DSML(?:\||｜)+/i.exec(this.buffer);
      const dsmlIdx = dsmlMatch ? dsmlMatch.index : -1;
      const toolCallIdx = this.buffer.indexOf('<tool_call');
      const toolTagMatch = /<tool\b/i.exec(this.buffer);
      const toolTagIdx = toolTagMatch ? toolTagMatch.index : -1;
      // feedback.txt item 1: bare XML invoke/parameter tags (no DSML pipes) —
      // <invoke name="write_file"><parameter name="path">…</parameter></invoke>
      const invokeTagMatch = /<\/?\s*(?:invoke|parameter|function_calls)\b/i.exec(this.buffer);
      const invokeTagIdx = invokeTagMatch ? invokeTagMatch.index : -1;
      const malformedMatch = /[<＜]\s*([^\s>]+)\s+[^>]*?\b(?:name|tool|query|path|command|action)\s*=/i.exec(this.buffer);
      const malformedIdx = malformedMatch ? malformedMatch.index : -1;

      const candidates: Array<{
        idx: number;
        type: 'fence' | 'dsml' | 'tool_call' | 'tool_tag' | 'invoke_tag' | 'malformed_tag';
      }> = [];
      if (fenceIdx !== -1) candidates.push({ idx: fenceIdx, type: 'fence' });
      if (dsmlIdx !== -1) candidates.push({ idx: dsmlIdx, type: 'dsml' });
      if (toolCallIdx !== -1) candidates.push({ idx: toolCallIdx, type: 'tool_call' });
      if (toolTagIdx !== -1 && toolTagIdx !== toolCallIdx) candidates.push({ idx: toolTagIdx, type: 'tool_tag' });
      if (invokeTagIdx !== -1 && invokeTagIdx !== dsmlIdx) candidates.push({ idx: invokeTagIdx, type: 'invoke_tag' });
      if (
        malformedIdx !== -1 &&
        malformedIdx !== dsmlIdx &&
        malformedIdx !== toolCallIdx &&
        malformedIdx !== toolTagIdx &&
        malformedIdx !== invokeTagIdx
      ) {
        candidates.push({ idx: malformedIdx, type: 'malformed_tag' });
      }

      if (candidates.length === 0) {
        const holdFence = fencePrefixHold(this.buffer, FENCE);
        const holdDsml = dsmlPrefixHold(this.buffer);
        const holdToolCall = fencePrefixHold(this.buffer, '<tool_call');
        const holdToolTag = fencePrefixHold(this.buffer, '<tool');
        const holdInvokeTag = invokeTagPrefixHold(this.buffer);
        const holdMalformed = malformedPrefixHold(this.buffer);
        const hold = Math.max(holdFence, holdDsml, holdToolCall, holdToolTag, holdInvokeTag, holdMalformed);
        const emit = this.buffer.slice(0, this.buffer.length - hold);
        this.buffer = hold ? this.buffer.slice(this.buffer.length - hold) : '';
        if (emit) this.sink(emit);
        return;
      }

      candidates.sort((a, b) => a.idx - b.idx);
      const earliest = candidates[0];

      if (earliest.idx > 0) {
        this.sink(this.buffer.slice(0, earliest.idx));
        this.buffer = this.buffer.slice(earliest.idx);
      }

      if (earliest.type === 'fence') {
        if (this.buffer.length < FENCE.length + 4) {
          if (TOOL_FENCE_RE.test(this.buffer)) {
            this.hiddenType = 'tool_fence';
            this.buffer = this.buffer.slice(this.buffer.indexOf('tool') + 4);
          }
          return;
        }
        if (TOOL_FENCE_RE.test(this.buffer)) {
          this.hiddenType = 'tool_fence';
          this.buffer = this.buffer.slice(this.buffer.indexOf('tool') + 4);
          continue;
        }
        // Check if markdown code block is a pseudo-tool JSON call
        const closeFence = this.buffer.indexOf(FENCE, FENCE.length);
        if (closeFence !== -1) {
          const fencedBody = this.buffer.slice(FENCE.length, closeFence);
          if (JSON_TOOL_CALL_RE.test(fencedBody)) {
            let rest = this.buffer.slice(closeFence + FENCE.length);
            if (rest.startsWith('\r\n')) rest = rest.slice(2);
            else if (rest.startsWith('\n')) rest = rest.slice(1);
            else if (rest.length === 0) this.skipNextNewline = true;
            this.buffer = rest;
            continue;
          }
        } else {
          // Unclosed or in-flight fence: check if candidate tool JSON payload is already visible
          if (JSON_TOOL_CALL_RE.test(this.buffer)) {
            this.hiddenType = 'tool_fence';
            this.buffer = this.buffer.slice(FENCE.length);
            continue;
          }
          // If the buffer currently looks like the start of a json codeblock, hold briefly
          if (/^```(?:json)?\s*\{?$/i.test(this.buffer.slice(0, 32))) {
            return;
          }
        }
        this.sink(FENCE);
        this.buffer = this.buffer.slice(FENCE.length);
        continue;
      }

      if (earliest.type === 'dsml') {
        const gtIdx = this.buffer.indexOf('>');
        if (gtIdx === -1) {
          return;
        }
        const tag = this.buffer.slice(0, gtIdx + 1);
        this.buffer = this.buffer.slice(gtIdx + 1);
        if (tag.endsWith('/>')) {
          continue;
        }
        if (/<\s*(?:\||｜)+DSML(?:\||｜)+\s*(?:calls|tool_calls)\b/i.test(tag)) {
          this.hiddenType = 'dsml_calls';
          continue;
        }
        if (/<\s*(?:\||｜)+DSML(?:\||｜)+\s*invoke\b/i.test(tag)) {
          this.hiddenType = 'dsml_invoke';
          continue;
        }
        if (/<\s*(?:\||｜)+DSML(?:\||｜)+\s*parameter\b/i.test(tag)) {
          // A DSML parameter tag without a wrapping invoke: hide its value too.
          this.hiddenType = 'xml_parameter';
          continue;
        }
        // stray or closing tag
        continue;
      }

      if (earliest.type === 'tool_call') {
        this.hiddenType = 'tool_call';
        continue;
      }

      if (earliest.type === 'tool_tag') {
        this.hiddenType = 'tool_tag';
        continue;
      }

      if (earliest.type === 'invoke_tag') {
        // Bare XML invoke/parameter block (feedback.txt item 1). The opening
        // tag is consumed, then everything up to the matching closing tag is
        // hidden — self-closing and stray closing tags are dropped outright.
        const gtIdx = this.buffer.indexOf('>');
        if (gtIdx === -1) {
          return;
        }
        const tag = this.buffer.slice(0, gtIdx + 1);
        this.buffer = this.buffer.slice(gtIdx + 1);
        if (tag.endsWith('/>')) continue;
        if (/^<\s*\/\s*invoke\b/i.test(tag)) continue;
        if (/^<\s*invoke\b/i.test(tag)) {
          this.hiddenType = 'dsml_invoke';
          continue;
        }
        if (/^<\s*parameter\b/i.test(tag)) {
          this.hiddenType = 'xml_parameter';
          continue;
        }
        // <function_calls> / </function_calls> wrapper tags: hide the tag only.
        continue;
      }

      if (earliest.type === 'malformed_tag') {
        const gtIdx = this.buffer.indexOf('>');
        if (gtIdx === -1) {
          return;
        }
        const tagHeader = this.buffer.slice(0, gtIdx + 1);
        const nameMatch = /^[<＜]\s*([^\s>]+)/.exec(tagHeader);
        const tagName = nameMatch ? nameMatch[1] : '';
        let restIdx = gtIdx + 1;

        if (!tagHeader.endsWith('/>') && tagName) {
          const escapedName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const closeTagRe = new RegExp(`</\\s*${escapedName}\\s*>`, 'i');
          const closeMatch = closeTagRe.exec(this.buffer);
          if (closeMatch) {
            restIdx = closeMatch.index + closeMatch[0].length;
          }
        }

        let rest = this.buffer.slice(restIdx);
        if (rest.startsWith('\r\n')) {
          rest = rest.slice(2);
        } else if (rest.startsWith('\n')) {
          rest = rest.slice(1);
        } else if (rest.length === 0) {
          this.skipNextNewline = true;
        }
        this.buffer = rest;
        continue;
      }
    }
  }
}

/**
 * Lightweight Terminal Markdown Formatter (zero runtime dependency).
 *
 * Converts markdown formatting to ANSI escape codes:
 * - Bold: `**teks**` -> Bold Cyan (\u001b[1;36mteks\u001b[0m)
 * - Inline Code: ` `teks` ` -> Yellow (\u001b[33mteks\u001b[0m)
 * - Regular vertical spacing before bold headings/bullet labels
 * - Fenced code blocks (` ```...``` `) pass through without inline modifications
 * - Non-TTY or NO_COLOR: cleanly strips `**` and ` ` ` without escape codes
 */
export class TerminalMarkdownFormatter {
  private inCodeBlock = false;
  private prevLineWasBlank = true;

  constructor(private forceColors?: boolean) {}

  public format(text: string): string {
    if (!text) return '';
    const useColors = this.forceColors ?? colorsEnabled();
    const hasTrailingNewline = text.endsWith('\n');
    const lines = text.split('\n');
    if (hasTrailingNewline) {
      lines.pop();
    }
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const trimmed = rawLine.trim();

      // Track fenced code blocks
      if (trimmed.startsWith('```')) {
        this.inCodeBlock = !this.inCodeBlock;
        result.push(useColors ? dim(rawLine) : rawLine);
        this.prevLineWasBlank = false;
        continue;
      }

      // Inside code fences, pass content through untouched
      if (this.inCodeBlock) {
        result.push(rawLine);
        this.prevLineWasBlank = trimmed === '';
        continue;
      }

      // Add vertical breathing room before standalone bold section headings if previous line wasn't blank
      const isBoldHeading = /^\*\*[^*]+\*\*/.test(trimmed);
      if (isBoldHeading && !this.prevLineWasBlank) {
        result.push('');
      }

      // Tokenize inline code first to protect inline code containing asterisks
      const codeTokens: string[] = [];
      let formatted = rawLine.replace(/`([^`]+)`/g, (_match, p1) => {
        const token = `\x00RUKO_CODE_${codeTokens.length}\x00`;
        codeTokens.push(useColors ? `\u001b[33m${p1}\u001b[0m` : p1);
        return token;
      });

      // Replace **bold** with Bold Cyan (\u001b[1;36m)
      formatted = formatted.replace(/\*\*([^*]+)\*\*/g, (_match, p1) => {
        return useColors ? `\u001b[1;36m${p1}\u001b[0m` : p1;
      });

      // Restore inline code tokens
      if (codeTokens.length > 0) {
        formatted = formatted.replace(/\x00RUKO_CODE_(\d+)\x00/g, (_match, idx) => {
          return codeTokens[Number(idx)] ?? '';
        });
      }

      result.push(formatted);
      this.prevLineWasBlank = trimmed === '';
    }

    return result.join('\n') + (hasTrailingNewline ? '\n' : '');
  }

  public reset(): void {
    this.inCodeBlock = false;
    this.prevLineWasBlank = true;
  }
}

export function formatTerminalMarkdown(text: string, forceColors?: boolean): string {
  const formatter = new TerminalMarkdownFormatter(forceColors);
  return formatter.format(text);
}

/** Structural shape of a parsed tool call (see `parseToolCalls` in tools.ts). */
export interface ToolCallLike {
  tool: string;
  [key: string]: unknown;
}

/**
 * Infers a clean, contextual step description from the batch of tool calls.
 */
export function inferStepDescription(
  calls: ToolCallLike[],
  stepNumber: number,
): string {
  const tools = new Set(calls.map((c) => c.tool));
  if (
    tools.has('read_file') ||
    tools.has('glob') ||
    tools.has('code_search') ||
    tools.has('list_dir') ||
    tools.has('list_directory')
  ) {
    if (tools.has('write_file') || tools.has('edit_file') || tools.has('patch_file') || tools.has('revert_file')) {
      return 'Pemeriksaan dan modifikasi berkas proyek';
    }
    return 'Membaca konfigurasi & struktur berkas';
  }
  if (tools.has('write_file') || tools.has('edit_file') || tools.has('patch_file') || tools.has('revert_file')) {
    return 'Modifikasi berkas proyek';
  }
  if (tools.has('exec')) {
    return 'Menjalankan perintah shell';
  }
  if (tools.has('remember')) {
    return 'Menyimpan catatan ke persistent memory';
  }
  if (tools.has('load_skill') || tools.has('save_skill') || tools.has('delete_skill')) {
    return 'Mengelola skill operasional proyek';
  }
  if (tools.has('search_sessions')) {
    return 'Mencari riwayat percakapan sesi sebelumnya';
  }
  if (tools.has('delegate')) {
    return 'Mendelegasikan sub-tugas ke subagent terisolasi';
  }
  if (
    tools.has('start_process') ||
    tools.has('stop_process') ||
    tools.has('read_process_logs') ||
    tools.has('get_status')
  ) {
    return 'Pengelolaan proses latar belakang';
  }
  if (tools.has('delete_file') || tools.has('move_file')) {
    return 'Pengelolaan & reorganisasi berkas proyek';
  }
  if (tools.has('web_fetch')) {
    return 'Mengambil konten referensi web eksternal';
  }
  return `Langkah ${stepNumber}`;
}

/**
 * Workflow Step Indicator & Tool Tree (Claude Code / Gemini CLI standard).
 *
 * Renders tool execution sequences in a connected unicode box tree:
 *   ┌─ ● [Langkah 1] Membaca konfigurasi & struktur berkas
 *   │  🟢 Read(package.json)
 *   ├─ ● [Langkah 2] Modifikasi berkas proyek
 *   │  🟡 Edit(src/core/ui.ts)
 *   └─ ✓ [Selesai] Semua langkah tuntas
 */
export interface WorkflowTreeOptions {
  compact?: boolean;
  /**
   * Branch action-log history (feedback §3): tool calls are committed to
   * scrollback ONCE, as `├── [n] 🖥️ Bash(npm test) · 1.2s`, and only after the
   * action finished. Per-tool start lines are captured instead of printed, and
   * the tool's own detail output (diffs, warnings) is buffered until the
   * action line is out, then printed indented under it.
   */
  branch?: boolean;
}

/**
 * Formats a raw tool invocation log line into the compact single-line mobile view (§Item 5).
 */
export function formatCompactToolLog(no: number, text: string, durationMs?: number): string | null {
  const plain = stripAnsi(text).trim();
  const suffix = durationMs != null ? ` (${formatDuration(durationMs)})` : '';
  
  const editMatch = plain.match(/^(?:🟢|🟡)\s*(?:Edit|Write|Patch)\(([^)]+)\)/i);
  if (editMatch) {
    return `${cyan(`[${no}]`)} ✏️ Edit ${editMatch[1]}${dim(suffix)}`;
  }
  const readMatch = plain.match(/^🟢\s*Read\(([^)]+)\)/i);
  if (readMatch) {
    return `${cyan(`[${no}]`)} 📖 Read ${readMatch[1]}${dim(suffix)}`;
  }
  const searchMatch = plain.match(/^🟢\s*(?:Search|Glob|ListDir)\(([^)]+)\)/i);
  if (searchMatch) {
    return `${cyan(`[${no}]`)} 🔎 Mencari ${searchMatch[1]}${dim(suffix)}`;
  }
  const bashMatch = plain.match(/^🟢\s*Bash\(([^)]+)\)/i);
  if (bashMatch) {
    // Remove timeout badge if present
    const cmd = bashMatch[1].replace(/\s*\[\d+s\]$/, '').trim();
    return `${cyan(`[${no}]`)} 🟢 ${cmd}${dim(suffix)}`;
  }
  const directCmdMatch = plain.match(/^🟢\s+([^\s].*)$/);
  if (directCmdMatch && !plain.includes('Edit(') && !plain.includes('Read(')) {
    return `${cyan(`[${no}]`)} 🟢 ${directCmdMatch[1]}${dim(suffix)}`;
  }
  return null;
}

export class WorkflowTree {
  private stepCount = 0;
  private actionCount = 0;
  private active = false;
  private readonly compact: boolean;
  private readonly branch: boolean;
  /** True between `beginAction()` and `completeAction()` (branch mode only). */
  private actionOpen = false;
  /** Captured per-tool start line (`🟢 Read(x)`), preferred over the fallback. */
  private pendingStart: string | null = null;
  /** Detail lines logged while an action runs; flushed under its branch. */
  private buffered: string[] = [];

  constructor(
    private readonly out: (line: string) => void = (l) => console.log(l),
    options: WorkflowTreeOptions = {},
  ) {
    this.compact = options.compact ?? false;
    this.branch = options.branch ?? false;
  }

  startStep(description: string): void {
    this.stepCount++;
    this.active = true;
    if (this.compact || this.branch) {
      return;
    }
    const prefix = this.stepCount === 1 ? '┌─' : '├─';
    const badge = cyan(`● [Langkah ${this.stepCount}]`);
    this.out(`${prefix} ${badge} ${description}`);
  }

  /**
   * Opens the branch buffer for one tool call. Everything logged until
   * `completeAction()` lands in the buffer so the action line can be printed
   * FIRST, exactly once, when the tool is done (feedback §3/§4).
   */
  beginAction(): void {
    if (!this.branch) return;
    this.actionOpen = true;
    this.pendingStart = null;
    this.buffered = [];
  }

  /**
   * Commits a finished tool call to the permanent scroll history as
   * `├── [n] <icon> <tool>(<arg>) · <duration>` plus its buffered detail lines.
   */
  completeAction(fallbackText: string, durationMs?: number): void {
    if (!this.branch) return;
    const raw = this.pendingStart ?? fallbackText;
    const formatted = formatActionLogLine(this.actionCount + 1, raw, durationMs);
    if (formatted) {
      this.actionCount += 1;
      this.out(formatted);
    }
    const details = this.buffered;
    this.buffered = [];
    this.pendingStart = null;
    this.actionOpen = false;
    for (const l of details) this.out(`${dim('│  ')}${l}`);
  }

  /** Prints anything still buffered (aborted turn, thrown tool, end of turn). */
  flush(): void {
    const details = this.buffered;
    this.buffered = [];
    this.actionOpen = false;
    if (this.pendingStart) {
      const pending = this.pendingStart;
      this.pendingStart = null;
      this.out(pending);
    }
    for (const l of details) this.out(l);
  }

  log(line: string): void {
    if (!this.active) {
      this.out(line);
      return;
    }

    if (this.branch) {
      for (const l of line.split('\n')) {
        // Fase 4: baris mutasi berkas (marker \f dari writeWithDiff) selalu
        // masuk buffer detail — juga saat isToolStartLine(l) true. Baris ini
        // di-flush di bawah baris `├──` tool saat completeAction(); ia TIDAK
        // menimpa pendingStart, sehingga hint shortcut tidak pernah hilang.
        if (isFileMutationLogLine(l)) {
          const shown = stripMutationMarker(l);
          if (this.actionOpen) this.buffered.push(shown);
          else this.out(shown);
          continue;
        }
        if (isToolStartLine(l)) {
          // A tool call is only worth one line — and only once it finished.
          if (this.actionOpen) {
            if (!this.pendingStart) this.pendingStart = l;
          } else {
            this.out(l);
          }
          continue;
        }
        if (this.actionOpen) this.buffered.push(l);
        else this.out(l);
      }
      return;
    }

    if (this.compact) {
      const lines = line.split('\n');
      for (const l of lines) {
        const compactFormatted = formatCompactToolLog(this.actionCount + 1, l);
        if (compactFormatted) {
          this.actionCount++;
          this.out(compactFormatted);
        } else {
          // Output line directly (diff lines, warnings) without tree character prefix `│ `
          this.out(l);
        }
      }
      return;
    }

    const lines = line.split('\n');
    for (const l of lines) {
      this.out(`│  ${l}`);
    }
  }

  error(message: string): void {
    if (!this.active) {
      this.out(message);
      return;
    }
    const badge = red('✖ [Gagal]');
    if (this.compact || this.branch) {
      this.out(`${badge} ${message}`);
    } else {
      this.out(`│  ${badge} ${message}`);
    }
  }

  finish(summary = 'Semua langkah tuntas'): void {
    if (!this.active) {
      this.flush();
      return;
    }
    this.flush();
    if (this.compact || this.branch) {
      this.active = false;
      const badge = summary.includes('Dibatalkan') || summary.includes('loop') ? yellow('⚠') : green('✓');
      this.out(`${badge} ${summary}`);
      return;
    }
    const badge = green('✓ [Selesai]');
    this.out(`└─ ${badge} ${summary}`);
    this.active = false;
  }

  get isTreeActive(): boolean {
    return this.active;
  }

  get currentStep(): number {
    return this.stepCount;
  }
}

