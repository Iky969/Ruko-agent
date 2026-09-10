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
/** Dark-green status bar: black text on green background. */
export const onDarkGreen = (s: string): string => wrap('30;42', s);

/** Strips all ANSI escape sequences from a string. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Visible width of a string (ANSI codes do not count). */
export function visibleLength(text: string): number {
  // Strip ANSI, then count code points (emoji/graphemes approximated).
  return Array.from(stripAnsi(text)).length;
}

function padVisible(text: string, width: number): string {
  const gap = width - visibleLength(text);
  return text + ' '.repeat(Math.max(0, gap));
}

/**
 * Renders a unicode box-drawing panel:
 *
 *   ┌────────────┐
 *   │ title      │
 *   ├────────────┤
 *   │ line       │
 *   └────────────┘
 *
 * Lines may contain ANSI colors; padding is computed on visible width.
 */
export function renderBox(title: string, lines: string[]): string {
  const inner = Math.max(visibleLength(title), ...lines.map(visibleLength), 1) + 2;
  const top = `┌${'─'.repeat(inner)}┐`;
  const titleRow = `│ ${padVisible(title, inner - 2)} │`;
  const sep = `├${'─'.repeat(inner)}┤`;
  const body = lines.map((l) => `│ ${padVisible(l, inner - 2)} │`);
  const bottom = `└${'─'.repeat(inner)}┘`;
  return [top, titleRow, sep, ...body, bottom].join('\n');
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
}

/** `⚡ [model] | ctx 41% | / perintah · ↑ riwayat · Ctrl+C batal` dark-green bar. */
export function buildStatusBar(input: StatusBarInput): string {
  const pct = input.budgetChars > 0
    ? Math.min(100, Math.round((input.usedChars / input.budgetChars) * 100))
    : 0;
  const plan = input.planMode ? '⏸ PLAN · ' : '';
  const role = input.role && input.role !== 'default' ? ` · ${input.role}` : '';
  return onDarkGreen(
    ` ⚡ [${input.model}${role}] | ${plan}ctx ${pct}% (${formatK(input.usedChars)}/${formatK(input.budgetChars)}) | / perintah · Ctrl+C batal `,
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

/**
 * `▸ Thinking...` spinner. Rotates a trailing-dot animation in place; a
 * no-op when stdout is not a TTY. Always call stop() when the LLM answers.
 */
export function createSpinner(label = 'Thinking'): Spinner {
  if (!colorsEnabled()) return { stop() {} };
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
