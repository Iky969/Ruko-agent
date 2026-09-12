/**
 * Tiny zero-dependency ANSI terminal UI toolkit for Ruko.
 *
 * Provides color helpers (auto-disabled when stdout is not a TTY or when
 * NO_COLOR is set), unicode box drawing, the REPL status bar, a thinking
 * spinner, and a fence-aware streaming reveal filter.
 */

const ANSI_RE = /\u001b\[[0-9;]*m/g;

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
export const whiteBright = (s: string): string => wrap('97', s);
export const bgBlue = (s: string): string => wrap('44', s);
export const bgGreen = (s: string): string => wrap('42', s);
/**
 * Dim, dark-green status bar: light text on 256-color dark green (§3 — the
 * old bright `42` background was glaring; this is muted and easy on the eyes).
 */
export const onDarkGreen = (s: string): string => wrap('38;5;252;48;5;22', s);

/** Strips all ANSI escape sequences from a string. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
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
  return Math.max(20, process.stdout.columns ?? 80);
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

export interface StatusBarInput {
  model: string;
  usedChars: number;
  budgetChars: number;
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
}

/** `⚡ [model] | ctx 41% (12.3k/30k) · ↑3.2k ↓800 | / perintah` dark-green bar. */
export function buildStatusBar(input: StatusBarInput): string {
  const pct = input.budgetChars > 0
    ? Math.min(100, Math.round((input.usedChars / input.budgetChars) * 100))
    : 0;
  const plan = input.planMode ? '⏸ PLAN · ' : '';
  const busy = input.busy ? '⏳ AI bekerja · ' : '';
  const role = input.role && input.role !== 'default' ? ` · ${input.role}` : '';
  const turn = input.turn
    ? ` · ↑${formatK(input.turn.promptChars)} ↓${formatK(input.turn.completionChars)}`
    : '';
  const waiting = input.pending && input.pending > 0 ? ` · ⏳ ${input.pending} menunggu ` : '';
  return onDarkGreen(
    ` ⚡ [${input.model}${role}] | ${busy}${plan}ctx ${pct}% (${formatK(input.usedChars)}/${formatK(input.budgetChars)})${turn} | / perintah · Ctrl+C batal ${waiting}`,
  );
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
        process.stdout.write(`\r${' '.repeat(24)}\r`);
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
      process.stdout.write(`\r${' '.repeat(maxCleared)}\r`);
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
 * Fence-aware streaming reveal filter.
 *
 * Feeds raw LLM tokens through `feed()`; emits only the human-visible text
 * to the sink while hiding ```` ```tool ```` code blocks (the internal tool
 * protocol) even when the fence markers arrive split across chunks. Regular
 * (non-tool) code fences pass through untouched.
 */
export class RevealFilter {
  private buffer = '';
  private hidden = false;

  constructor(private readonly sink: (text: string) => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    this.drain();
  }

  /** Flush any pending visible text once the stream has ended. */
  end(): void {
    if (!this.hidden && this.buffer) this.sink(this.buffer);
    this.buffer = '';
  }

  private drain(): void {
    for (;;) {
      if (this.hidden) {
        const close = this.buffer.indexOf(FENCE);
        if (close === -1) {
          const hold = fencePrefixHold(this.buffer, FENCE);
          this.buffer = hold ? this.buffer.slice(this.buffer.length - hold) : '';
          return;
        }
        // Drop one newline right after the closing fence so the line before
        // the tool block and the line after it rejoin without a blank gap.
        let rest = this.buffer.slice(close + FENCE.length);
        if (rest.startsWith('\n')) rest = rest.slice(1);
        this.buffer = rest;
        this.hidden = false;
        continue;
      }
      const open = this.buffer.indexOf(FENCE);
      if (open === -1) {
        const hold = fencePrefixHold(this.buffer, FENCE);
        const emit = this.buffer.slice(0, this.buffer.length - hold);
        this.buffer = hold ? this.buffer.slice(this.buffer.length - hold) : '';
        if (emit) this.sink(emit);
        return;
      }
      if (open > 0) {
        this.sink(this.buffer.slice(0, open));
        this.buffer = this.buffer.slice(open);
      }
      if (this.buffer.length < FENCE.length + 4) {
        // Not enough lookahead to decide between ```tool and a normal fence.
        if (TOOL_FENCE_RE.test(this.buffer)) {
          this.hidden = true;
          this.buffer = this.buffer.slice(this.buffer.indexOf('tool') + 4);
        }
        return;
      }
      if (TOOL_FENCE_RE.test(this.buffer)) {
        this.hidden = true;
        this.buffer = this.buffer.slice(this.buffer.indexOf('tool') + 4);
        continue;
      }
      // Ordinary code fence — reveal it as normal text.
      this.sink(FENCE);
      this.buffer = this.buffer.slice(FENCE.length);
    }
  }
}
