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
  const headerText = '⚠ KONFIRMASI PERINTAH BERISIKO';
  const reasonText = `Alasan  : ${reason}`;
  const cmdText = `Perintah: ${command}`;
  const needed = Math.max(visibleLength(headerText), visibleLength(reasonText), visibleLength(cmdText)) + 4;
  const inner = Math.min(Math.max(needed, 36), maxInner);

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
  /** True while the AI is thinking/executing tools (v0.7 live input). */
  busy?: boolean;
  /**
   * Char counts of the most recent turn (§8). Merged into the bar instead of
   * printed as its own output line, so usage stats never look like noise.
   */
  turn?: { promptChars: number; completionChars: number };
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
    const busy = input.busy ? '⏳ AI bekerja · ' : '';
    const role = input.role && input.role !== 'default' ? ` · ${input.role}` : '';
    const turn = input.turn
      ? ` · ↑${formatK(input.turn.promptChars)} ↓${formatK(input.turn.completionChars)}`
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
    const full = ` ⚡ [${input.model}${role}]${procStr} | ${busy}${plan}ctx ${pct}%${detailCtx}${turn}${hint}${waiting}`;
    if (visibleLength(full) <= targetWidth) {
      return onDarkGreen(full);
    }
    // Drop hint
    const noHint = ` ⚡ [${input.model}${role}]${procStr} | ${busy}${plan}ctx ${pct}%${detailCtx}${turn}${waiting ? waiting : ' '}`;
    if (visibleLength(noHint) <= targetWidth) {
      return onDarkGreen(noHint);
    }
    // Drop turn stats
    const noTurn = ` ⚡ [${input.model}${role}]${procStr} | ${busy}${plan}ctx ${pct}%${detailCtx}${waiting ? waiting : ' '}`;
    if (visibleLength(noTurn) <= targetWidth) {
      return onDarkGreen(noTurn);
    }
    // Drop detailCtx
    const noDetail = ` ⚡ [${input.model}${role}]${procStr} | ${busy}${plan}ctx ${pct}%${waiting ? waiting : ' '}`;
    if (visibleLength(noDetail) <= targetWidth) {
      return onDarkGreen(noDetail);
    }
  }

  // Narrow terminal responsive layout (< 60, e.g. Termux mobile):
  const busyNarrow = input.busy ? (isVeryNarrow ? '⏳ ' : '⏳ AI bekerja · ') : '';
  const planNarrow = input.planMode ? (isVeryNarrow ? '⏸ ' : '⏸ PLAN · ') : '';
  const waitNarrow = input.pending && input.pending > 0
    ? (isVeryNarrow ? ` ⏳${input.pending}` : ` · ⏳ ${input.pending} menunggu `)
    : '';

  const right = `${busyNarrow}${planNarrow}ctx ${pct}%${waitNarrow ? waitNarrow : ' '}`;

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
}

export interface SpinnerOptions {
  /**
   * When true, renders the left-aligned Pac-Man eating "Thinking..." animation,
   * followed by 2 ghosts chasing it (feedback v0.8 / pac.cjs).
   * When false (or terminal too narrow < 24 cols), uses the plain `▸ Thinking...` dot spinner.
   * Default: true.
   */
  pacman?: boolean;
}

/**
 * `▸ Thinking...` spinner or Pac-Man eating "Thinking..." animation.
 * Redrawn in place on a single line via carriage return (`\r`) so it integrates
 * with LineEditor's shared redraw engine without stacking lines in scrollback.
 * Auto-disabled when stdout is not a TTY or colors are disabled.
 * Always call `stop()` when the LLM answers.
 */
export function createSpinner(label = 'Thinking', options: SpinnerOptions = {}): Spinner {
  if (!colorsEnabled()) return { stop() {} };

  const usePacman = options.pacman ?? true;
  const width = Math.min(38, terminalWidth() - 1);

  // If width is too small or pacman is false, fall back to plain dot spinner
  if (!usePacman || width < 24) {
    let dots = 0;
    const render = () => {
      const text = `▸ ${label}${'.'.repeat(dots)}`;
      process.stdout.write(`\r${dim(text)}`.padEnd(24, ' '));
    };
    render();
    const timer = setInterval(() => {
      dots = (dots + 1) % 4;
      render();
    }, 200);
    return {
      stop() {
        clearInterval(timer);
        process.stdout.write(`\r\u001b[2K${' '.repeat(24)}\r`);
      },
    };
  }

  // Pac-Man eating "Thinking..." animation (left-aligned per feedback.txt & pac.cjs)
  const text = label.length <= 11 ? (label.endsWith('...') ? label : `${label}...`) : label;
  let x = width - 1;
  let frame = 0;
  let maxCleared = width;

  const render = () => {
    const currentWidth = Math.min(38, terminalWidth() - 1);
    if (currentWidth > maxCleared) maxCleared = currentWidth;
    const cells: string[] = Array(currentWidth).fill(' ');

    const draw = (str: string, position: number, colorCode: string) => {
      for (let i = 0; i < str.length; i++) {
        const col = position + i;
        if (col >= 0 && col < currentWidth) {
          cells[col] = wrap(colorCode, str[i]);
        }
      }
    };

    // Characters behind Pac-Man are eaten; characters before Pac-Man are visible (cyan, code 36)
    for (let i = 0; i < text.length; i++) {
      if (i < x) {
        draw(text[i], i, '36');
      }
    }

    // Two ghosts chasing Pac-Man from the right with fixed distance:
    // Ghost 1: bright cyan (96)
    // Ghost 2: bright magenta (95)
    const ghost = Math.floor(frame / 2) % 2 ? '(oo)' : '(OO)';
    draw(ghost, x + 4, '96');
    draw(ghost, x + 10, '95');

    // Pac-Man: bright yellow (93), mouth alternates '>' and 'O'
    const mouth = frame % 2 ? '>' : 'O';
    draw(mouth, x, '93');

    process.stdout.write(`\r${cells.join('')}`);

    x--;
    frame++;

    // Loop when Pac-Man and both ghosts exit on the left
    if (x < -14) {
      x = currentWidth - 1;
    }
  };

  render();
  const timer = setInterval(render, 100);
  return {
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

/**
 * Protocol-aware streaming reveal filter.
 *
 * Feeds raw LLM tokens through `feed()`; emits only human-visible text to
 * the sink while hiding tool blocks:
 *   - ```tool ... ```
 *   - <|DSML|... / <｜DSML｜...
 *   - <tool_call>...</tool_call>
 */
export class RevealFilter {
  private buffer = '';
  private hiddenType: 'tool_fence' | 'dsml' | 'tool_call' | null = null;

  constructor(private readonly sink: (text: string) => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    this.drain();
  }

  /** Flush any pending visible text once the stream has ended. */
  end(): void {
    if (!this.hiddenType && this.buffer) this.sink(this.buffer);
    this.buffer = '';
    this.hiddenType = null;
  }

  private drain(): void {
    for (;;) {
      if (this.hiddenType === 'tool_fence') {
        const close = this.buffer.indexOf(FENCE);
        if (close === -1) {
          const hold = fencePrefixHold(this.buffer, FENCE);
          this.buffer = hold ? this.buffer.slice(this.buffer.length - hold) : '';
          return;
        }
        let rest = this.buffer.slice(close + FENCE.length);
        if (rest.startsWith('\n')) rest = rest.slice(1);
        this.buffer = rest;
        this.hiddenType = null;
        continue;
      }

      if (this.hiddenType === 'dsml') {
        const dsmlCloseMatch = /<\/(?:\||｜)DSML(?:\||｜)(?:invoke|tool_calls)[^>]*>/i.exec(this.buffer);
        if (!dsmlCloseMatch) {
          const hold1 = fencePrefixHold(this.buffer, '</|DSML|invoke>');
          const hold2 = fencePrefixHold(this.buffer, '</｜DSML｜invoke>');
          const hold = Math.max(hold1, hold2);
          this.buffer = hold ? this.buffer.slice(this.buffer.length - hold) : '';
          return;
        }
        let rest = this.buffer.slice(dsmlCloseMatch.index + dsmlCloseMatch[0].length);
        if (rest.startsWith('\n')) rest = rest.slice(1);
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
        if (rest.startsWith('\n')) rest = rest.slice(1);
        this.buffer = rest;
        this.hiddenType = null;
        continue;
      }

      const fenceIdx = this.buffer.indexOf(FENCE);
      const dsmlAsciiIdx = this.buffer.indexOf('<|DSML|');
      const dsmlUniIdx = this.buffer.indexOf('<｜DSML｜');
      const toolCallIdx = this.buffer.indexOf('<tool_call');

      const candidates: Array<{ idx: number; type: 'fence' | 'dsml' | 'tool_call' }> = [];
      if (fenceIdx !== -1) candidates.push({ idx: fenceIdx, type: 'fence' });
      if (dsmlAsciiIdx !== -1) candidates.push({ idx: dsmlAsciiIdx, type: 'dsml' });
      if (dsmlUniIdx !== -1) candidates.push({ idx: dsmlUniIdx, type: 'dsml' });
      if (toolCallIdx !== -1) candidates.push({ idx: toolCallIdx, type: 'tool_call' });

      if (candidates.length === 0) {
        const holdFence = fencePrefixHold(this.buffer, FENCE);
        const holdDsml1 = fencePrefixHold(this.buffer, '<|DSML|');
        const holdDsml2 = fencePrefixHold(this.buffer, '<｜DSML｜');
        const holdToolCall = fencePrefixHold(this.buffer, '<tool_call');
        const hold = Math.max(holdFence, holdDsml1, holdDsml2, holdToolCall);
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
        this.sink(FENCE);
        this.buffer = this.buffer.slice(FENCE.length);
        continue;
      }

      if (earliest.type === 'dsml') {
        this.hiddenType = 'dsml';
        continue;
      }

      if (earliest.type === 'tool_call') {
        this.hiddenType = 'tool_call';
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
export class WorkflowTree {
  private stepCount = 0;
  private active = false;

  constructor(private readonly out: (line: string) => void = (l) => console.log(l)) {}

  startStep(description: string): void {
    this.stepCount++;
    this.active = true;
    const prefix = this.stepCount === 1 ? '┌─' : '├─';
    const badge = cyan(`● [Langkah ${this.stepCount}]`);
    this.out(`${prefix} ${badge} ${description}`);
  }

  log(line: string): void {
    if (!this.active) {
      this.out(line);
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
    this.out(`│  ${badge} ${message}`);
  }

  finish(summary = 'Semua langkah tuntas'): void {
    if (!this.active) return;
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

