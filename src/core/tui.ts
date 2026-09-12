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
import { dim, truncateVisible, visibleLength } from './ui.js';

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
  /**
   * LIVE status line drawn ABOVE the prompt inside the editor's managed
   * region (feedback v0.6.2 — the green status bar used to be printed fresh
   * every REPL iteration, so stale versions piled up in scrollback). The
   * editor redraws it in place on every frame and ERASES it on submit/cancel,
   * so at most one status bar is ever alive on screen.
   */
  statusLine?: () => string;
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

/** Options for the always-live ambient input (feedback v0.7 #1). */
export interface AmbientOptions {
  prompt: string;
  placeholder?: string;
  /** Live status line drawn above the input (same renderer as readLine). */
  statusLine?: () => string;
  /** Slash overlay while the AI works — identical filtering rules. */
  getMenu?: (buffer: string) => MenuItem[];
  /** Enter pressed while the AI is busy — the loop shows the queue modal. */
  onSubmit: (line: string) => void;
  /** Ctrl+C pressed while the AI is busy — interrupt the turn, not the session. */
  onInterrupt: () => void;
}

/** Inline modal question inside the live region (feedback v0.7 #2/#6). */
export interface ModalOptions {
  prompt: string;
  /** Single keys that answer the modal (compared case-insensitively). */
  keys: string[];
  /** Answer used when the user presses Enter without choosing. */
  defaultKey?: string;
}

interface Modal extends ModalOptions {
  resolve: (key: string | null) => void;
}

const CSI_RE = /^\u001b\[([0-9;]*)([A-Za-z~])/;

export class LineEditor {
  private pending: Pending | null = null;
  /** Ambient input while the AI works (feedback v0.7 #1); null when idle. */
  private ambient: AmbientOptions | null = null;
  /** True while a blocking readLine (e.g. approval) borrows the terminal. */
  private ambientSuspended = false;
  /** Half-typed ambient buffer parked while readLine borrows the terminal. */
  private ambientSaved: { buffer: string; cursor: number } | null = null;
  /** Inline modal question inside the live region (queue choice, y/N). */
  private modal: Modal | null = null;
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
  /** Terminal rows occupied by the live status line above the prompt (0 if none). */
  private statusRows = 0;
  /**
   * Partial output line written by the agent since its last newline. While
   * the live region is up, every stdout write is intercepted: the region is
   * erased, the tail + fresh output are written, then the region redraws
   * BELOW the output — so streaming text never corrupts the input (v0.7).
   */
  private tail = '';
  /** True when the current tail row is actually painted above the region. */
  private tailRendered = false;
  private patchedWrite: ((chunk: any, ...rest: any[]) => boolean) | null = null;
  private rawOutputWrite: ((chunk: any, ...rest: any[]) => boolean) | null = null;

  constructor(
    private readonly input: ReadStream = process.stdin as ReadStream,
    private readonly output: WriteStream = process.stdout as WriteStream,
  ) {}

  get isActive(): boolean {
    return this.pending !== null;
  }

  /** True while an inline modal question (queue choice / approval) is open. */
  get modalActive(): boolean {
    return this.modal !== null;
  }

  /**
   * Shows a single-key modal question INSIDE the live region (same renderer —
   * feedback v0.7 #2/#6: no separate render path). Resolves with the pressed
   * key (lowercased), `defaultKey` on Enter, or `null` on Ctrl+C/Escape.
   */
  askModal(options: ModalOptions): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      if (this.modal || (!this.pending && !this.ambient)) {
        resolve(null);
        return;
      }
      this.modal = { ...options, resolve };
      this.render();
    });
  }

  /** Reads one line. Resolves `null` on Ctrl+C or Ctrl+D at an empty buffer. */
  readLine(options: ReadLineOptions): Promise<string | null> {
    // A blocking read (e.g. the approval prompt while the AI works) borrows
    // the terminal: park the ambient region, restore it in finish().
    this.suspendAmbient();
    this.buffer = '';
    this.cursor = 0;
    this.menu = [];
    this.selected = 0;
    this.drawnRows = 0;
    this.drawnCursorRow = 0;
    this.statusRows = 0;
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

  // --- ambient live input (feedback v0.7 #1) --------------------------------

  /**
   * Starts the always-live input region shown while the AI works. Uses the
   * SAME redraw machinery as readLine (status line + prompt + overlay), so
   * the stacking bug cannot return, and intercepts stdout writes so streamed
   * agent output lands ABOVE the region instead of corrupting it.
   */
  startAmbient(options: AmbientOptions): void {
    if (this.ambient) return;
    this.ambient = options;
    this.buffer = '';
    this.cursor = 0;
    this.menu = [];
    this.selected = 0;
    this.drawnRows = 0;
    this.drawnCursorRow = 0;
    this.statusRows = 0;
    this.ambientSuspended = false;
    this.attach();
    this.patchStdout();
    this.render();
  }

  /** Removes the ambient region and stops intercepting stdout. */
  stopAmbient(): void {
    if (!this.ambient) return;
    // A modal still open when the turn ends resolves with its default — the
    // safer choice (queue) — so the loop's submit handler never hangs.
    if (this.modal) {
      const modal = this.modal;
      this.modal = null;
      modal.resolve(modal.defaultKey ?? null);
    }
    this.eraseRegion();
    this.ambient = null;
    // The partial output line (if any) already sits ABOVE the erased region
    // with the cursor below it — it is committed; the region must not redraw.
    this.unpatchStdout();
    if (!this.pending) this.detach();
  }

  /** readLine borrows the terminal: hide the ambient region, keep raw mode. */
  private suspendAmbient(): void {
    if (!this.ambient || this.ambientSuspended || this.pending) return;
    this.ambientSuspended = true;
    this.eraseRegion();
    this.ambientSaved = { buffer: this.buffer, cursor: this.cursor };
    this.buffer = '';
    this.cursor = 0;
  }

  /** Ambient region returns after the blocking read committed its line. */
  private resumeAmbient(): void {
    if (!this.ambient || !this.ambientSuspended) return;
    this.ambientSuspended = false;
    // Restore the half-typed ambient line (approval borrowed the terminal —
    // feedback v0.7 #6: the user's in-progress message must not be lost).
    this.buffer = this.ambientSaved?.buffer ?? '';
    this.cursor = this.ambientSaved?.cursor ?? 0;
    this.ambientSaved = null;
    this.menu = [];
    this.selected = 0;
    this.drawnRows = 0;
    this.drawnCursorRow = 0;
    this.statusRows = 0;
    this.attach();
    this.refreshMenu();
    this.render();
  }

  /** Restores the terminal and drops any in-flight line. */
  close(): void {
    if (this.pending) this.finish(null);
    this.stopAmbient();
    this.detach();
  }

  private attach(): void {
    this.input.setRawMode(true);
    this.input.resume();
    this.input.setEncoding('utf8');
    if (!this.dataHandler) {
      const handler = (chunk: string | Buffer): void => this.handleData(String(chunk));
      this.dataHandler = handler;
      this.input.on('data', handler);
    }
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
    this.statusRows = 0;
    this.detach();
    pending?.resolve(value);
    this.resumeAmbient();
  }

  // --- rendering -----------------------------------------------------------

  /** Usable terminal width (fallback 80 when stdout is not a TTY). */
  private termWidth(): number {
    return Math.max(20, this.output.columns ?? 80);
  }

  private renderedLine(): string {
    const { prompt, placeholder, mask } = this.activeOptions();
    if (this.buffer.length === 0) return prompt + (placeholder ? dim(placeholder) : '');
    return prompt + (mask ? '*'.repeat(this.buffer.length) : this.buffer);
  }

  /** The options driving the live region right now (readLine wins over ambient). */
  private activeOptions(): Pick<ReadLineOptions, 'prompt' | 'placeholder' | 'statusLine' | 'getMenu' | 'mask'> {
    if (this.pending) return this.pending.options;
    return this.ambient ?? { prompt: '› ' };
  }

  /** Terminal height (fallback 24 when stdout is not a TTY). */
  private termRows(): number {
    return Math.max(4, this.output.rows ?? 24);
  }

  /**
   * Rows the overlay may occupy WITHOUT the terminal scrolling (§ v0.6): the
   * live region also holds the status line + prompt, so leave 3 rows of
   * margin; anything taller gets pushed into scrollback where ESC[0J can no
   * longer reach it — that scroll is how closed menus used to linger as
   * duplicate blocks.
   */
  private overlayBudget(lineRows: number): number {
    const hasStatus = !!this.activeOptions().statusLine;
    const hasModal = this.modal ? 1 : 0;
    return Math.max(0, this.termRows() - 3 - lineRows - (hasStatus ? 1 : 0) - hasModal);
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
    if (!this.pending && !this.ambient) return;
    const options = this.activeOptions();
    // While a modal question is open it replaces the overlay: the user's
    // full attention goes to the choice (feedback v0.7 #2/#6).
    const { rows, heights } = this.modal ? { rows: [], heights: [] } : this.menuRows();
    const width = this.termWidth();
    // Return the cursor to the FIRST row of the previously drawn region
    // (status line included — a bare "\r" only resets within the CURRENT row,
    // which breaks redraw once the buffer wraps to row 2+), then erase
    // everything below it.
    let out = '';
    const climb = this.drawnCursorRow + this.statusRows;
    if (climb > 0) out += `\u001b[${climb}A`;
    out += `\r\u001b[0J`;
    // Live status line (e.g. the green bar): redrawn IN PLACE every frame and
    // clamped to width-1 so it can never wrap and break the rewind math
    // (feedback v0.6.2 — the bar used to pile up in scrollback per iteration).
    if (options.statusLine) {
      const status = truncateVisible(options.statusLine(), width - 1);
      out += `${status}\n`;
      this.statusRows = 1;
    } else {
      this.statusRows = 0;
    }
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
    // Modal question row (drawn under the input line, above nothing else).
    let modalRows = 0;
    if (this.modal) {
      const text = truncateVisible(this.modal.prompt, width - 1);
      modalRows = 1;
      out += `\n\u001b[2K${text}`;
    }
    // From the bottom of the drawn region, walk back up to the cursor row of
    // the input line, then right to the exact column.
    const upFromBottom = lineRows - 1 + menuRows + modalRows - cursorRow;
    if (upFromBottom > 0) out += `\u001b[${upFromBottom}A`;
    out += '\r';
    if (cursorCol > 0) out += `\u001b[${cursorCol}C`;
    this.rawWrite(out);
  }

  /** Write that BYPASSES the stdout interception (used by the renderer itself). */
  private rawWrite(text: string): void {
    if (this.rawOutputWrite) this.rawOutputWrite(text);
    else this.output.write(text);
  }

  /** Climb to the top of the live region and erase everything below it. */
  private eraseRegion(): void {
    const climb = this.drawnCursorRow + this.statusRows;
    let out = '';
    if (climb > 0) out += `\u001b[${climb}A`;
    out += '\r\u001b[0J';
    this.rawWrite(out);
    this.drawnRows = 0;
    this.drawnCursorRow = 0;
    this.statusRows = 0;
  }

  /** Erase the uncommitted output row (if rendered) AND the live region. */
  private eraseForOutput(): void {
    let tailRows = 0;
    if (this.tailRendered) {
      const width = this.termWidth();
      const tailOut = this.tail.includes('\r') ? this.tail.slice(this.tail.lastIndexOf('\r') + 1) : this.tail;
      tailRows = tailOut ? Math.max(1, Math.ceil(visibleLength(tailOut) / width)) : 0;
    }
    const climb = this.drawnCursorRow + this.statusRows + tailRows;
    let out = '';
    if (climb > 0) out += `\u001b[${climb}A`;
    out += '\r\u001b[0J';
    this.rawWrite(out);
    this.drawnRows = 0;
    this.drawnCursorRow = 0;
    this.statusRows = 0;
    this.tailRendered = false;
  }

  /**
   * Intercept stdout while the live region is up (v0.7): streamed agent
   * output lands ABOVE the region — the region is erased, the output replayed
   * (completed lines commit; the partial tail redraws in place, which is how
   * the spinner keeps animating), then the region redraws below. A blocking
   * readLine (approval etc.) borrows the terminal: writes pass through raw.
   */
  private patchStdout(): void {
    if (this.patchedWrite) return;
    // Capture the ORIGINAL bound write now — resolving `this.output.write`
    // lazily would recurse once the patch is installed.
    const orig = ((this.output as unknown as { write: (c: any, ...r: any[]) => boolean }).write).bind(
      this.output,
    );
    const raw = ((chunk: any, ...rest: any[]): boolean => orig(chunk, ...rest)) as (
      chunk: any,
      ...rest: any[]
    ) => boolean;
    this.rawOutputWrite = raw;
    const patched = (chunk: any, ...rest: any[]): boolean => {
      if (this.pending || this.ambientSuspended || !this.ambient) {
        return raw(chunk, ...rest);
      }
      const text =
        typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this.eraseForOutput();
      const merged = this.tail + text;
      const nl = merged.lastIndexOf('\n');
      const completed = nl === -1 ? '' : merged.slice(0, nl + 1);
      const afterNl = nl === -1 ? merged : merged.slice(nl + 1);
      // tail = the CURRENT uncommitted row's content only: a trailing `\r`
      // (spinner stop() clears its row) must leave tail EMPTY, otherwise the
      // dead spinner text would be re-committed by the next newline.
      const tailOut = afterNl.includes('\r') ? afterNl.slice(afterNl.lastIndexOf('\r') + 1) : afterNl;
      this.tail = tailOut;
      raw(completed + tailOut);
      // The region always sits BELOW the live output row; an in-place row
      // (spinner: contains \r) stays uncommitted and is erased+replaced by
      // the next write via tailRendered's climb.
      if (tailOut) {
        raw('\n');
        this.tailRendered = true;
      }
      this.render();
      return true;
    };
    this.patchedWrite = patched;
    (this.output as unknown as { write: typeof patched }).write = patched;
  }

  private unpatchStdout(): void {
    if (!this.patchedWrite || !this.rawOutputWrite) return;
    (this.output as unknown as { write: unknown }).write = this.rawOutputWrite;
    this.patchedWrite = null;
    this.rawOutputWrite = null;
    this.tail = '';
  }

  // --- input parsing -------------------------------------------------------

  private handleData(data: string): void {
    if (!this.pending && !this.ambient) return;
    // A modal question owns the keyboard: only its keys (or Enter/Ctrl+C)
    // count — the buffer stays frozen underneath (feedback v0.7 #2/#6).
    if (this.modal) {
      const modal = this.modal;
      for (const ch of data) {
        if (ch === '\u0003') {
          this.modal = null;
          modal.resolve(null);
          return;
        }
        if (ch === '\r' || ch === '\n') {
          this.modal = null;
          modal.resolve(modal.defaultKey ?? null);
          this.render();
          return;
        }
        const key = ch.toLowerCase();
        if (modal.keys.includes(key)) {
          this.modal = null;
          modal.resolve(key);
          this.render();
          return;
        }
      }
      return;
    }
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
    if (!this.pending && !this.ambient) return;
    const getMenu = this.activeOptions().getMenu;
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
    // Ambient Enter (AI busy): erase the region, hand the line to the loop
    // (which shows the queue modal), and redraw with an empty buffer.
    if (!this.pending && this.ambient) {
      const value = this.buffer;
      this.buffer = '';
      this.cursor = 0;
      this.menu = [];
      this.selected = 0;
      this.refreshMenu();
      this.eraseRegion();
      this.ambient.onSubmit(value);
      if (this.ambient) this.render();
      return;
    }
    const pending = this.pending;
    if (!pending) return;
    const value = this.buffer;
    // Menu-only Enter (bare "/"): close the overlay by ERASING the whole
    // drawn region and commit NOTHING — a help listing the user dismissed
    // must never settle in the scrollback (feedback v0.6 #2).
    if (pending.options.menuOnlyClose?.(value)) {
      let out = '';
      const climb = this.drawnCursorRow + this.statusRows;
      if (climb > 0) out += `\u001b[${climb}A`;
      out += '\r\u001b[0J';
      this.output.write(out);
      // Resolve as an empty line — the loop ignores it and keeps reading.
      this.finish('');
      return;
    }
    const shown = pending.options.mask ? '*'.repeat(value.length) : value;
    const finalLine = pending.options.prompt + shown;
    // Return to the FIRST row of the drawn region (status line included),
    // erase the live region — status bar, overlay and any extra rows — then
    // commit the final line. The bar is erased on purpose: the next REPL
    // iteration redraws it in place, so no stale version may settle in
    // scrollback (feedback v0.6.2).
    let out = '';
    const climb = this.drawnCursorRow + this.statusRows;
    if (climb > 0) out += `\u001b[${climb}A`;
    out += `\r\u001b[0J${finalLine}\n`;
    this.output.write(out);
    this.finish(value);
  }

  private cancel(): void {
    // Ambient Ctrl+C: interrupt the AI turn, NOT the session (feedback v0.7 #3).
    if (!this.pending && this.ambient) {
      this.eraseRegion();
      this.rawWrite('^\n');
      this.ambient.onInterrupt();
      if (this.ambient) this.render();
      return;
    }
    const pending = this.pending;
    if (!pending) return;
    let out = '';
    const climb = this.drawnCursorRow + this.statusRows;
    if (climb > 0) out += `\u001b[${climb}A`;
    out += '\r\u001b[0J^\n';
    this.output.write(out);
    this.finish(null);
  }
}

/** Creates the raw-mode editor wired to the process stdio. */
export function createLineEditor(): LineEditor {
  return new LineEditor();
}
