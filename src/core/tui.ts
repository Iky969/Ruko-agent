/**
 * Zero-dependency raw-mode line editor for Ruko.
 *
 * Why not readline? The `keypress` event is not emitted reliably in every PTY
 * (Known Bug #7), which blocked the live `/` menu. This editor parses stdin
 * bytes itself in raw mode, so it can:
 *   - show a placeholder that disappears the moment the user types (§3),
 *   - render a live, filtered command overlay under the prompt (§4),
 *   - mask secret input such as an API key with `*` (§5).
 *
 * The editor works one line at a time: `readLine()` enables raw mode, draws as
 * keys arrive, resolves with the submitted line (or `null` on Ctrl+C/EOF), then
 * restores the terminal. It is a no-op replacement for readline and is only
 * used when stdin is a TTY — piped input keeps using node:readline.
 */

import type { ReadStream, WriteStream } from 'node:tty';
import { dim, visibleLength } from './ui.js';

/** One row in the live overlay (slash-command menu). */
export interface MenuItem {
  label: string;
  detail?: string;
  /** Buffer text inserted when this item is accepted with Tab (§4). */
  insert?: string;
}

export interface ReadLineOptions {
  /** Prompt printed before the buffer (may contain ANSI colors). */
  prompt: string;
  /** Dim hint shown only while the buffer is empty (§3). */
  placeholder?: string;
  /** Echo `*` per character instead of the real text (§5). */
  mask?: boolean;
  /** Live overlay items for the current buffer; return [] to hide the menu. */
  getMenu?: (buffer: string) => MenuItem[];
  /**
   * When true for the submitted buffer, Enter only CLOSES the overlay: the
   * region is erased and the line resolves to `null` WITHOUT echoing anything
   * into scrollback (feedback v0.6 #2 — help listings must never settle).
   */
  menuOnlyClose?: (buffer: string) => boolean;
}

interface Pending {
  options: ReadLineOptions;
  resolve: (value: string | null) => void;
}

const CSI_RE = /^\u001b\[([0-9;]*)([A-Za-z~])/;

export class LineEditor {
  private pending: Pending | null = null;
  private buffer = '';
  private cursor = 0;
  private menu: MenuItem[] = [];
  private selected = 0;
  private dataHandler: ((chunk: string | Buffer) => void) | null = null;
  /** Bytes that arrived after a submitted line (paste / CRLF) — replayed next. */
  private queuedInput = '';
  /** Terminal rows occupied by the last drawn prompt+buffer (>=1 once drawn). */
  private drawnRows = 0;
  /** Row (0-based, from the top of the drawn region) the cursor sat on. */
  private drawnCursorRow = 0;

  constructor(
    private readonly input: ReadStream = process.stdin as ReadStream,
    private readonly output: WriteStream = process.stdout as WriteStream,
  ) {}

  get isActive(): boolean {
    return this.pending !== null;
  }

  /** Reads one line. Resolves `null` on Ctrl+C or Ctrl+D at an empty buffer. */
  readLine(options: ReadLineOptions): Promise<string | null> {
    this.buffer = '';
    this.cursor = 0;
    this.menu = [];
    this.selected = 0;
    this.drawnRows = 0;
    this.drawnCursorRow = 0;
    return new Promise<string | null>((resolve) => {
      this.pending = { options, resolve };
      this.attach();
      this.refreshMenu();
      this.render();
      // Replay anything that trailed a previous line in the same stdin chunk
      // (fast typing, paste, or CRLF) instead of silently dropping it.
      if (this.queuedInput) {
        const replay = this.queuedInput;
        this.queuedInput = '';
        this.handleData(replay);
      }
    });
  }

  /** Restores the terminal and drops any in-flight line. */
  close(): void {
    if (this.pending) this.finish(null);
    this.detach();
  }

  private attach(): void {
    this.input.setRawMode(true);
    this.input.resume();
    this.input.setEncoding('utf8');
    const handler = (chunk: string | Buffer): void => this.handleData(String(chunk));
    this.dataHandler = handler;
    this.input.on('data', handler);
  }

  private detach(): void {
    if (this.dataHandler) {
      this.input.off('data', this.dataHandler);
      this.dataHandler = null;
    }
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
  }

  private finish(value: string | null): void {
    const pending = this.pending;
    this.pending = null;
    this.buffer = '';
    this.cursor = 0;
    this.menu = [];
    this.selected = 0;
    this.drawnRows = 0;
    this.drawnCursorRow = 0;
    this.detach();
    pending?.resolve(value);
  }

  // --- rendering -----------------------------------------------------------

  /** Usable terminal width (fallback 80 when stdout is not a TTY). */
  private termWidth(): number {
    return Math.max(20, this.output.columns ?? 80);
  }

  private renderedLine(): string {
    const { prompt, placeholder, mask } = this.pending!.options;
    if (this.buffer.length === 0) return prompt + (placeholder ? dim(placeholder) : '');
    return prompt + (mask ? '*'.repeat(this.buffer.length) : this.buffer);
  }

  /** Terminal height (fallback 24 when stdout is not a TTY). */
  private termRows(): number {
    return Math.max(4, this.output.rows ?? 24);
  }

  /**
   * Rows the overlay may occupy WITHOUT the terminal scrolling (§ v0.6): the
   * REPL writes the status bar + prompt right above it, so leave 3 rows of
   * margin; anything taller gets pushed into scrollback where ESC[0J can no
   * longer reach it — that scroll is how closed menus used to linger as
   * duplicate blocks.
   */
  private overlayBudget(lineRows: number): number {
    return Math.max(0, this.termRows() - 3 - lineRows);
  }

  /**
   * Menu rows for the current selection, windowed to fit the overlay budget so
   * the terminal NEVER scrolls the overlay (scrolled rows escape ESC[0J and
   * linger in scrollback forever — feedback v0.6). Returns rendered rows plus
   * their per-row terminal heights; always includes the selected item.
   */
  private menuRows(): { rows: string[]; heights: number[] } {
    const width = this.termWidth();
    const styled = this.menu.map((item, i) => {
      const text = item.detail ? `${item.label}  ${dim(item.detail)}` : item.label;
      return i === this.selected ? `\u001b[7m${text}\u001b[0m` : text;
    });
    const heights = styled.map((r) => Math.max(1, Math.ceil(visibleLength(r) / width)));
    const budget = this.overlayBudget(1);
    const total = heights.reduce((a, b) => a + b, 0);
    if (budget >= total) return { rows: styled, heights };
    // Greedy window around the selection: grow downward first (reading order),
    // then upward. Reserve 1 row per truncated side for the scroll indicator.
    const sel = Math.min(this.selected, styled.length - 1);
    const selH = heights[sel] ?? 1;
    if (selH > budget) return { rows: [styled[sel]], heights: [selH] };
    let lo = sel;
    let hi = sel;
    let used = selH;
    while (hi + 1 < styled.length && used + heights[hi + 1] <= budget - 1) {
      hi += 1;
      used += heights[hi];
    }
    while (lo - 1 >= 0 && used + heights[lo - 1] <= budget - (hi + 1 < styled.length ? 2 : 1)) {
      lo -= 1;
      used += heights[lo];
    }
    const rows: string[] = [];
    const outHeights: number[] = [];
    if (lo > 0) {
      rows.push(dim(`  ↑ ${lo} lagi di atas`));
      outHeights.push(1);
    }
    for (let i = lo; i <= hi; i++) {
      rows.push(styled[i]);
      outHeights.push(heights[i]);
    }
    if (hi < styled.length - 1) {
      rows.push(dim(`  ↓ ${styled.length - 1 - hi} lagi di bawah (↑/↓ gulung)`));
      outHeights.push(1);
    }
    return { rows, heights: outHeights };
  }

  private render(): void {
    if (!this.pending) return;
    const options = this.pending.options;
    const { rows, heights } = this.menuRows();
    const width = this.termWidth();
    // Return the cursor to the FIRST row of the previously drawn region
    // (a bare "\r" only resets within the CURRENT row, which breaks redraw
    // once the buffer wraps to row 2+), then erase everything below it.
    let out = '';
    if (this.drawnCursorRow > 0) out += `\u001b[${this.drawnCursorRow}A`;
    out += `\r\u001b[0J`;
    const line = this.renderedLine();
    out += line;
    // Rows this draw occupies once the terminal wraps it naturally.
    const lineRows = Math.max(1, Math.ceil(visibleLength(line) / width));
    this.drawnRows = lineRows;
    // Cursor cell = prompt width + caret index within the buffer.
    const col = visibleLength(options.prompt) + this.cursor;
    const cursorRow = Math.min(lineRows - 1, Math.floor(col / width));
    const cursorCol = col - cursorRow * width;
    this.drawnCursorRow = cursorRow;
    // Overlay rows sit below the input line and wrap like the line does —
    // counting them as 1 row each (the old bug) left the cursor buried in
    // the previous menu, so the next ESC[0J only cleared DOWNWARD and stale
    // prompt lines piled up in the scrollback (feedback: "/e / /ex / /exit").
    let menuRows = 0;
    rows.forEach((row, i) => {
      menuRows += heights[i];
      out += `\n\u001b[2K${row}`;
    });
    // From the bottom of the drawn region, walk back up to the cursor row of
    // the input line, then right to the exact column.
    const upFromBottom = lineRows - 1 + menuRows - cursorRow;
    if (upFromBottom > 0) out += `\u001b[${upFromBottom}A`;
    out += '\r';
    if (cursorCol > 0) out += `\u001b[${cursorCol}C`;
    this.output.write(out);
  }

  // --- input parsing -------------------------------------------------------

  private handleData(data: string): void {
    if (!this.pending) return;
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\u001b') {
        const match = data.slice(i).match(CSI_RE);
        if (match) {
          this.handleCsi(match[1], match[2]);
          i += match[0].length;
          continue;
        }
        // Lone Escape closes the overlay.
        this.menu = [];
        this.selected = 0;
        i += 1;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        // Treat CR, LF and CRLF as one Enter; keep the remainder for next time.
        let next = i + 1;
        if ((ch === '\r' && data[next] === '\n') || (ch === '\n' && data[next] === '\r')) {
          next += 1;
        }
        this.queuedInput = data.slice(next);
        this.submit();
        return;
      }
      if (ch === '\u007f' || ch === '\b') {
        this.backspace();
        i += 1;
        continue;
      }
      if (ch === '\t') {
        this.acceptSelection();
        i += 1;
        continue;
      }
      if (ch === '\u0003') {
        // Abort: discard anything that trailed the interrupt.
        this.cancel();
        return;
      }
      if (ch === '\u0004') {
        if (this.buffer.length === 0) {
          this.cancel();
          return;
        }
        i += 1;
        continue;
      }
      if (ch === '\u0015') {
        this.buffer = '';
        this.cursor = 0;
        i += 1;
        continue;
      }
      if (ch === '\u0001') {
        this.cursor = 0;
        i += 1;
        continue;
      }
      if (ch === '\u0005') {
        this.cursor = this.buffer.length;
        i += 1;
        continue;
      }
      if (ch < ' ') {
        i += 1;
        continue;
      }
      this.insert(ch);
      i += 1;
    }
    this.refreshMenu();
    this.render();
  }

  private handleCsi(param: string, final: string): void {
    if (final === 'A') this.moveSelection(-1);
    else if (final === 'B') this.moveSelection(1);
    else if (final === 'C') this.cursor = Math.min(this.buffer.length, this.cursor + 1);
    else if (final === 'D') this.cursor = Math.max(0, this.cursor - 1);
    else if (final === 'H') this.cursor = 0;
    else if (final === 'F') this.cursor = this.buffer.length;
    else if (final === '~' && param === '3') this.deleteForward();
    this.refreshMenu();
    this.render();
  }

  private insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
  }

  private backspace(): void {
    if (this.cursor === 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor -= 1;
  }

  private deleteForward(): void {
    if (this.cursor >= this.buffer.length) return;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
  }

  private moveSelection(delta: number): void {
    if (this.menu.length === 0) return;
    this.selected = (this.selected + delta + this.menu.length) % this.menu.length;
  }

  private acceptSelection(): void {
    const item = this.menu[this.selected];
    if (!item) return;
    const text = item.insert ?? item.label;
    this.buffer = text;
    this.cursor = text.length;
    this.refreshMenu();
    this.render();
  }

  private refreshMenu(): void {
    if (!this.pending) return;
    const getMenu = this.pending.options.getMenu;
    const items = getMenu ? getMenu(this.buffer) : [];
    const previous = this.menu[this.selected]?.label;
    this.menu = items;
    if (items.length === 0) {
      this.selected = 0;
      return;
    }
    const idx = previous ? items.findIndex((m) => m.label === previous) : -1;
    this.selected = idx >= 0 ? idx : Math.min(this.selected, items.length - 1);
  }

  private submit(): void {
    const pending = this.pending;
    if (!pending) return;
    const value = this.buffer;
    // Menu-only Enter (bare "/"): close the overlay by ERASING the whole
    // drawn region and commit NOTHING — a help listing the user dismissed
    // must never settle in the scrollback (feedback v0.6 #2).
    if (pending.options.menuOnlyClose?.(value)) {
      let out = '';
      if (this.drawnCursorRow > 0) out += `\u001b[${this.drawnCursorRow}A`;
      out += '\r\u001b[0J';
      this.output.write(out);
      // Resolve as an empty line — the loop ignores it and keeps reading.
      this.finish('');
      return;
    }
    const shown = pending.options.mask ? '*'.repeat(value.length) : value;
    const finalLine = pending.options.prompt + shown;
    // Return to the first row of the drawn (possibly wrapped) region, erase
    // the overlay and any extra rows, then commit the final line.
    let out = '';
    if (this.drawnCursorRow > 0) out += `\u001b[${this.drawnCursorRow}A`;
    out += `\r\u001b[0J${finalLine}\n`;
    this.output.write(out);
    this.finish(value);
  }

  private cancel(): void {
    const pending = this.pending;
    if (!pending) return;
    let out = '';
    if (this.drawnCursorRow > 0) out += `\u001b[${this.drawnCursorRow}A`;
    out += '\r\u001b[0J^\n';
    this.output.write(out);
    this.finish(null);
  }
}

/** Creates the raw-mode editor wired to the process stdio. */
export function createLineEditor(): LineEditor {
  return new LineEditor();
}
