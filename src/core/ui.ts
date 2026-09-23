/**
 * Tiny zero-dependency ANSI terminal UI toolkit for Ruko.
 *
 * Provides color helpers (auto-disabled when stdout is not a TTY or when
 * NO_COLOR is set), unicode box drawing, the REPL status bar, a thinking
 * spinner, and a fence-aware streaming reveal filter.
 */

const ANSI_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;

/**
 * Matches dangerous terminal escape sequences:
 * - OSC sequences: \u001b] ... (\u0007 | \u001b\) (e.g. title changes, hyperlinks)
 * - DCS / APC / PM: \u001b[P_^] ... \u001b\
 * - Control characters: \u0007 (bell), \u000c (form feed)
 */
const DANGEROUS_TERMINAL_RE = /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[P_^][^\u001b]*\u001b\\)|[\u0007\u000c]/g;

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
 * Terminal cell width of one code point (wcwidth subset): 2 for East-Asian
 * Wide/Fullwidth and the emoji-presentation blocks, 1 otherwise. Terminals
 * (and pyte) render ⚡ ⏳ 🟢 and CJK as TWO columns — counting them as one is
 * what let the status bar overflow its clamp and wrap (feedback v0.7 audit;
 * closes Known Bugs #7's double-width caveat).
 */
export function charWidth(cp: number): number {
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
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Visible terminal columns of a string (ANSI codes do not count). */
export function visibleLength(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) width += charWidth(ch.codePointAt(0)!);
  return width;
}

export function padVisible(text: string, width: number): string {
  const gap = width - visibleLength(text);
  return text + ' '.repeat(Math.max(0, gap));
}

/** Usable terminal width (fallback 80 when stdout is not a TTY). */
export function terminalWidth(): number {
  const envCols = process.env.COLUMNS ? parseInt(process.env.COLUMNS, 10) : NaN;
  const cols = process.stdout.columns ?? (Number.isFinite(envCols) && envCols > 0 ? envCols : undefined) ?? 80;
  return Math.max(20, cols);
}

/**
 * Truncates a string to `width` VISIBLE characters. ANSI escape sequences are
 * copied through without counting toward the width, and a reset is appended
 * when the cut lands inside a colored run — so borders never drift.
 */
export function truncateVisible(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  let out = '';
  let count = 0;
  let i = 0;
  let colored = false;
  while (i < text.length && count < width) {
    if (text[i] === '\u001b') {
      const m = /^\u001b\[[0-9;]*m/.exec(text.slice(i));
      if (m) {
        out += m[0];
        colored = m[0] !== '\u001b[0m';
        i += m[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i)!;
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
 * Renders a high-visibility ANSI red/yellow bordered box for approval gate confirmations.
 * Clamped responsively to terminal width (fallback process.stdout.columns ?? 80).
 */
export function renderApprovalBox(command: string, reason: string): string {
  const cols = terminalWidth();
  const maxInner = Math.max(16, cols - 4);
  const headerText = '⚠ KONFIRMASI BERISIKO';
  const reasonText = `Alasan  : ${reason}`;
  const cmdText = `Perintah: ${command}`;
  const needed = Math.max(visibleLength(headerText), visibleLength(reasonText), visibleLength(cmdText)) + 4;
  const inner = Math.min(Math.max(needed, 28), maxInner);

  const fit = (t: string): string => truncateVisible(t, inner - 2);

  const border = (s: string) => yellow(s);
  const alertHeader = bold(red(headerText));

  const top = border(`┌${'─'.repeat(inner)}┐`);
  const headerRow = `${border('│')} ${padVisible(fit(alertHeader), inner - 2)} ${border('│')}`;
  const sep = border(`├${'─'.repeat(inner)}┤`);
  const reasonRow = `${border('│')} ${padVisible(fit(`${bold('Alasan  :')} ${yellow(reason)}`), inner - 2)} ${border('│')}`;
  const cmdRow = `${border('│')} ${padVisible(fit(`${bold('Perintah:')} ${cyan(command)}`), inner - 2)} ${border('│')}`;
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
    const full = ` ⚡ [${input.model}${role}]${procStr} | ${busy}${plan}${yolo}ctx ${pct}%${detailCtx}${turn}${hint}${waiting}`;
    if (visibleLength(full) <= targetWidth) {
      return onDarkGreen(full);
    }
    // Drop hint
    const noHint = ` ⚡ [${input.model}${role}]${procStr} | ${busy}${plan}${yolo}ctx ${pct}%${detailCtx}${turn}${waiting ? waiting : ' '}`;
    if (visibleLength(noHint) <= targetWidth) {
      return onDarkGreen(noHint);
    }
    // Drop turn stats
    const noTurn = ` ⚡ [${input.model}${role}]${procStr} | ${busy}${plan}${yolo}ctx ${pct}%${detailCtx}${waiting ? waiting : ' '}`;
    if (visibleLength(noTurn) <= targetWidth) {
      return onDarkGreen(noTurn);
    }
    // Drop detailCtx
    const noDetail = ` ⚡ [${input.model}${role}]${procStr} | ${busy}${plan}${yolo}ctx ${pct}%${waiting ? waiting : ' '}`;
    if (visibleLength(noDetail) <= targetWidth) {
      return onDarkGreen(noDetail);
    }
  }

  // Narrow terminal responsive layout (< 60, e.g. Termux mobile):
  const busyNarrow = input.busy ? (isVeryNarrow ? '⏳ ' : '⏳ AI bekerja · ') : '';
  const planNarrow = input.planMode ? (isVeryNarrow ? '⏸ ' : '⏸ PLAN · ') : '';
  const yoloNarrow = input.yoloMode ? (isVeryNarrow ? '[YOLO] ' : '[YOLO] · ') : '';
  const waitNarrow = input.pending && input.pending > 0
    ? (isVeryNarrow ? ` ⏳${input.pending}` : ` · ⏳ ${input.pending} menunggu `)
    : '';

  const right = `${busyNarrow}${planNarrow}${yoloNarrow}ctx ${pct}%${waitNarrow ? waitNarrow : ' '}`;

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
export const STATUS_PANEL_HINT = '/? for help, ask anything...';

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
}

/**
 * THE responsive status + input box (feedback: "Format Kotak Status & Input").
 *
 *   ┌──────────┬──────┬─────────────┐
 *   │ gemini   │ YOLO │ ↑ 3.2kt ↓ 800t │
 *   ├──────────┴──────┴─────────────┤
 *   │ /? for help, ask anything...  │
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

/** Maps one captured tool line onto its `├── ` branch label. */
function branchLabel(plain: string): string | null {
  const withParens = /^(\S+)\s+([A-Za-z_][\w]*)\(([^)]*)\)\s*(.*)$/.exec(plain);
  if (withParens) {
    const toolName = withParens[2];
    const arg = withParens[3].trim();
    const tail = withParens[4].trim();
    const render = BRANCH_LABELS[toolName.toLowerCase()];
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
 *   ├── [1] 🔍 find PROGRESS.md · 12ms
 *   ├── [2] 🖥️ Bash(npm test) · 4.2s
 *   ├── [3] 🟣 Subagent "read file halo.md"
 *
 * Returns `null` for lines that are not tool invocations.
 */
export function formatActionLogLine(no: number, rawText: string, durationMs?: number): string | null {
  const plain = stripAnsi(rawText).trim();
  if (!plain) return null;
  const label = branchLabel(plain);
  if (!label) return null;
  const suffix =
    durationMs != null && Number.isFinite(durationMs) && durationMs >= 0
      ? dim(` · ${formatDuration(durationMs)}`)
      : '';
  return `${dim('├──')} ${cyan(`[${no}]`)} ${label}${suffix}`;
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
  private hiddenType: 'tool_fence' | 'dsml_calls' | 'dsml_invoke' | 'tool_call' | 'tool_tag' | null = null;
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
        const closeMatch = /<\/\s*(?:\||｜)+DSML(?:\||｜)+\s*invoke[^>]*>/i.exec(this.buffer);
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
      const malformedMatch = /[<＜]\s*([^\s>]+)\s+[^>]*?\b(?:name|tool|query|path|command|action)\s*=/i.exec(this.buffer);
      const malformedIdx = malformedMatch ? malformedMatch.index : -1;

      const candidates: Array<{ idx: number; type: 'fence' | 'dsml' | 'tool_call' | 'tool_tag' | 'malformed_tag' }> = [];
      if (fenceIdx !== -1) candidates.push({ idx: fenceIdx, type: 'fence' });
      if (dsmlIdx !== -1) candidates.push({ idx: dsmlIdx, type: 'dsml' });
      if (toolCallIdx !== -1) candidates.push({ idx: toolCallIdx, type: 'tool_call' });
      if (toolTagIdx !== -1 && toolTagIdx !== toolCallIdx) candidates.push({ idx: toolTagIdx, type: 'tool_tag' });
      if (malformedIdx !== -1 && malformedIdx !== dsmlIdx && malformedIdx !== toolCallIdx && malformedIdx !== toolTagIdx) {
        candidates.push({ idx: malformedIdx, type: 'malformed_tag' });
      }

      if (candidates.length === 0) {
        const holdFence = fencePrefixHold(this.buffer, FENCE);
        const holdDsml = dsmlPrefixHold(this.buffer);
        const holdToolCall = fencePrefixHold(this.buffer, '<tool_call');
        const holdToolTag = fencePrefixHold(this.buffer, '<tool');
        const holdMalformed = malformedPrefixHold(this.buffer);
        const hold = Math.max(holdFence, holdDsml, holdToolCall, holdToolTag, holdMalformed);
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
  const suffix = durationMs != null ? ` · ${formatDuration(durationMs)}` : '';
  
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

