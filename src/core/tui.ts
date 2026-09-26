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
   *
   * May return MULTIPLE rows (feedback UI revamp: the responsive status panel
   * is a 5-row box); every row is clamped to `width - 1` and counted in the
   * rewind math.
   */
  statusLine?: (width?: number) => string;
  /** Dim hint shown only while the buffer is empty (§3). */
  placeholder?: string;
  /** Echo `*` per character instead of the real text (§5). */
  mask?: boolean;
  /** Live overlay items for the current buffer; return [] to hide the menu. */
  getMenu?: (buffer: string) => MenuItem[];
  /**
   * Live bottom activity tray rows (feedback §4): drawn BELOW the input line
   * and repainted in place with the rest of the region, so running tools,
   * subagents and background processes never pile up in scrollback. Returns
   * `[]` when nothing is running (no rows are reserved).
   */
  activityRows?: (width?: number) => string[];
  /** Ctrl+O — toggles the tray's "expand all rows" mode. */
  onToggleTray?: () => void;
  /** Ctrl+R — expand/collapse panel Reasoning (Fase 3, feedback.txt). */
  onToggleReasoning?: () => void;
  /** Ctrl+D — expand/collapse detail diff mutasi berkas (Fase 4, feedback.txt). */
  onToggleDiffDetail?: () => void;
  /**
   * When true for the submitted buffer, Enter only CLOSES the overlay: the
   * region is erased and the line resolves to `null` WITHOUT echoing anything
   * into scrollback (feedback v0.6 #2 — help listings must never settle).
   */
  menuOnlyClose?: (buffer: string) => boolean;
  /**
   * feedback.txt item 2: when true, Enter resolves the line but commits
   * NOTHING to scrollback — the live region (prompt + answer) is erased and
   * the caller prints its own one-line result. Used by the approval `y/n`
   * prompt so the confirmation line never leaves an artifact in the terminal
   * history, and the answer is not pushed into command history either.
   */
  hideEcho?: boolean;
}

interface Pending {
  options: ReadLineOptions;
  resolve: (value: string | null) => void;
}

/** Options for the always-live ambient input (feedback v0.7 #1). */
export interface AmbientOptions {
  prompt: string;
  placeholder?: string;
  /** Live status block drawn above the input (same renderer as readLine). */
  statusLine?: (width?: number) => string;
  /** Slash overlay while the AI works — identical filtering rules. */
  getMenu?: (buffer: string) => MenuItem[];
  /** Live bottom activity tray rows (feedback §4) — same renderer. */
  activityRows?: (width?: number) => string[];
  /** Ctrl+O — toggles the tray's "expand all rows" mode. */
  onToggleTray?: () => void;
  /** Ctrl+R — expand/collapse panel Reasoning (Fase 3, feedback.txt). */
  onToggleReasoning?: () => void;
  /** Ctrl+D — expand/collapse detail diff mutasi berkas (Fase 4, feedback.txt). */
  onToggleDiffDetail?: () => void;
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

/** One selectable item in a popup selector (Fase 1: /mode, Fase 2: /reasoning). */
export interface SelectorItem {
  id: string;
  label: string;
  description: string;
}

export interface SelectorOptions {
  title?: string;
  items: SelectorItem[];
  defaultId?: string;
}

interface ActiveSelector extends SelectorOptions {
  selectedIndex: number;
  drawnRows: number;
  resolve: (id: string | null) => void;
}

const CSI_RE = /^\u001b\[([0-9;]*)([A-Za-z~])/;

export interface LineEditorOptions {
  /** Initial history entries (oldest first). */
  history?: string[];
  /** Callback fired when a new command is submitted and appended to history. */
  onHistoryAppend?: (line: string) => void;
}

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
  /** Active popup selector (Fase 1: /mode, Fase 2: /reasoning). */
  private selector: ActiveSelector | null = null;
  private buffer = '';
  private cursor = 0;
  private menu: MenuItem[] = [];
  private selected = 0;
  private menuNavigated = false;
  private history: string[] = [];
  private historyIndex = -1;
  private historySavedBuffer = '';
  private onHistoryAppend?: (line: string) => void;
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
  /** Anti-flickering dirty-checking cache */
  private lastRenderedStatus = '';
  private lastRenderedLine = '';
  private lastRenderedMenuKey = '';
  private lastRenderedTrayKey = '';
  private lastRenderedModalPrompt = '';
  private lastRenderedWidth = 0;
  private lastDrawnCursorCol = 0;
  private renderThrottleTimer: NodeJS.Timeout | null = null;
  private lastRenderTimestamp = 0;
  /**
   * 1s ticker that repaints the live region while an activity tray is present,
   * so `23s` style counters advance without any `console.log` (feedback §4).
   */
  private liveTicker: NodeJS.Timeout | null = null;
  /** True while a frame is being composed (drops re-entrant repaints). */
  private rendering = false;

  constructor(
    private readonly input: ReadStream = process.stdin as ReadStream,
    private readonly output: WriteStream = process.stdout as WriteStream,
    options: LineEditorOptions = {},
  ) {
    this.history = options.history ? [...options.history] : [];
    this.onHistoryAppend = options.onHistoryAppend;
  }

  get isActive(): boolean {
    return this.pending !== null;
  }

  /** True while an inline modal question (queue choice / approval) is open. */
  get modalActive(): boolean {
    return this.modal !== null;
  }

  /** True while a popup selector (/mode, /reasoning) is active. */
  get selectorActive(): boolean {
    return this.selector !== null;
  }

  /**
   * Opens an interactive popup selector with ↑/↓ navigation, Enter confirmation,
   * Esc cancellation, and live single-line description of the highlighted item.
   * Completely blocks chat input while open.
   */
  askSelector(options: SelectorOptions): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      if (this.selector) {
        resolve(null);
        return;
      }
      let defaultIdx = 0;
      if (options.defaultId) {
        const found = options.items.findIndex((it) => it.id === options.defaultId);
        if (found !== -1) defaultIdx = found;
      }
      this.selector = {
        ...options,
        selectedIndex: defaultIdx,
        drawnRows: 0,
        resolve,
      };
      this.attach();
      this.renderSelector();
    });
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
    this.menuNavigated = false;
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
    this.menuNavigated = false;
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
    if (this.renderThrottleTimer) {
      clearTimeout(this.renderThrottleTimer);
      this.renderThrottleTimer = null;
    }
    this.stopLiveTicker();
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
    this.menuNavigated = false;
    this.drawnRows = 0;
    this.drawnCursorRow = 0;
    this.statusRows = 0;
    this.attach();
    this.refreshMenu();
    this.render();
  }

  /** Restores the terminal and drops any in-flight line. */
  close(): void {
    if (this.renderThrottleTimer) {
      clearTimeout(this.renderThrottleTimer);
      this.renderThrottleTimer = null;
    }
    if (this.selector) this.closeSelector(null);
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
    if (this.renderThrottleTimer) {
      clearTimeout(this.renderThrottleTimer);
      this.renderThrottleTimer = null;
    }
    this.stopLiveTicker();
    const pending = this.pending;
    this.pending = null;
    this.buffer = '';
    this.cursor = 0;
    this.menu = [];
    this.selected = 0;
    this.menuNavigated = false;
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
    const envCols = process.env.COLUMNS ? parseInt(process.env.COLUMNS, 10) : NaN;
    const cols = this.output.columns ?? process.stdout.columns ?? (Number.isFinite(envCols) && envCols > 0 ? envCols : undefined) ?? 80;
    return Math.max(20, cols);
  }

  private renderedLine(): string {
    const { prompt, placeholder, mask } = this.activeOptions();
    if (this.buffer.length === 0) return prompt + (placeholder ? dim(placeholder) : '');
    return prompt + (mask ? '*'.repeat(this.buffer.length) : this.buffer);
  }

  /** The options driving the live region right now (readLine wins over ambient). */
  private activeOptions(): Pick<
    ReadLineOptions,
    'prompt' | 'placeholder' | 'statusLine' | 'getMenu' | 'mask' | 'activityRows' | 'onToggleTray' | 'onToggleReasoning' | 'onToggleDiffDetail'
  > {
    if (this.pending) return this.pending.options;
    return this.ambient ?? { prompt: '› ' };
  }

  /** Rows the live status block occupies right now (0 when there is none). */
  private statusRowCount(): number {
    const statusLine = this.activeOptions().statusLine;
    if (!statusLine) return 0;
    return Math.max(1, statusLine(this.termWidth()).split('\n').length);
  }

  /** Tray rows for the current frame, already clamped to `width - 1`. */
  private trayRowsFor(width: number): string[] {
    const provider = this.activeOptions().activityRows;
    if (!provider) return [];
    return provider(width).map((r) => truncateVisible(r, width - 1));
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
    const hasModal = this.modal ? 1 : 0;
    const trayRows = this.trayRowsFor(this.termWidth()).length;
    return Math.max(
      0,
      this.termRows() - 3 - lineRows - this.statusRowCount() - trayRows - hasModal,
    );
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

  /**
   * Repaints the live region. Re-entrancy guarded: the activity-tray provider
   * runs inside the frame (it resyncs background processes) and can emit a
   * `change` that asks for another repaint — the frame in flight already draws
   * the fresh state, so a nested render is dropped instead of recursing.
   */
  private render(): void {
    if (this.rendering) return;
    this.rendering = true;
    try {
      this.renderFrame();
    } finally {
      this.rendering = false;
    }
  }

  private renderFrame(): void {
    if (this.renderThrottleTimer) {
      clearTimeout(this.renderThrottleTimer);
      this.renderThrottleTimer = null;
    }
    this.lastRenderTimestamp = Date.now();
    if (!this.pending && !this.ambient) return;
    const options = this.activeOptions();
    // While a modal question is open it replaces the overlay: the user's
    // full attention goes to the choice (feedback v0.7 #2/#6).
    const { rows, heights } = this.modal ? { rows: [], heights: [] } : this.menuRows();
    const width = this.termWidth();

    // Status block: one or more rows (the responsive status panel is a box).
    // Every row is clamped to width-1 so it can never wrap and break the
    // rewind math (feedback v0.6.2 — the bar used to pile up in scrollback).
    const statusLines = options.statusLine
      ? options.statusLine(width)
          .split('\n')
          .map((l) => truncateVisible(l, width - 1))
      : [];
    const status = statusLines.join('\n');
    // Live bottom activity tray (feedback §4): redrawn in place with the rest
    // of the region, below the input line, so runners never hit scrollback.
    const trayRows = this.trayRowsFor(width);
    const line = this.renderedLine();
    const lineRows = Math.max(1, Math.ceil(visibleLength(line) / width));
    const col = visibleLength(options.prompt) + this.cursor;
    const cursorRow = Math.min(lineRows - 1, Math.floor(col / width));
    const cursorCol = col - cursorRow * width;
    const menuKey = rows.join('|');
    const trayKey = trayRows.join('|');
    const modalPrompt = this.modal?.prompt ?? '';

    // Anti-flickering dirty check: jika tidak ada perubahan data nyata pada region,
    // hindari emisi ulang ANSI escape code (\r atau \x1b[2K atau \x1b[0J) yang memicu flickering.
    if (
      this.drawnRows > 0 &&
      this.lastRenderedStatus === status &&
      this.lastRenderedLine === line &&
      this.lastRenderedMenuKey === menuKey &&
      this.lastRenderedTrayKey === trayKey &&
      this.lastRenderedModalPrompt === modalPrompt &&
      this.lastRenderedWidth === width &&
      this.drawnCursorRow === cursorRow &&
      this.lastDrawnCursorCol === cursorCol
    ) {
      this.ensureLiveTicker(!!options.activityRows);
      return;
    }

    // Return the cursor to the FIRST row of the previously drawn region
    // (status line included — a bare "\r" only resets within the CURRENT row,
    // which breaks redraw once the buffer wraps to row 2+), then erase
    // everything below it.
    let out = '';
    const climb = this.drawnCursorRow + this.statusRows;
    if (climb > 0) out += `\u001b[${climb}A`;
    out += `\r\u001b[0J`;
    for (const statusRow of statusLines) out += `${statusRow}\n`;
    this.statusRows = statusLines.length;
    out += line;
    // Rows this draw occupies once the terminal wraps it naturally.
    this.drawnRows = lineRows;
    // Cursor cell = prompt width + caret index within the buffer.
    this.drawnCursorRow = cursorRow;
    this.lastDrawnCursorCol = cursorCol;
    // Activity tray rows sit directly BELOW the input line (feedback §4) and
    // are clamped to width-1, so each one is exactly one terminal row.
    let trayHeight = 0;
    for (const trayRow of trayRows) {
      trayHeight += Math.max(1, Math.ceil(visibleLength(trayRow) / width));
      out += `\n\u001b[2K${trayRow}`;
    }
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
    const upFromBottom = lineRows - 1 + trayHeight + menuRows + modalRows - cursorRow;
    if (upFromBottom > 0) out += `\u001b[${upFromBottom}A`;
    out += '\r';
    if (cursorCol > 0) out += `\u001b[${cursorCol}C`;

    this.lastRenderedStatus = status;
    this.lastRenderedLine = line;
    this.lastRenderedMenuKey = menuKey;
    this.lastRenderedTrayKey = trayKey;
    this.lastRenderedModalPrompt = modalPrompt;
    this.lastRenderedWidth = width;

    this.rawWrite(out);
    this.ensureLiveTicker(!!options.activityRows);
  }

  /**
   * Keeps the tray's elapsed counters moving. The ticker only repaints the
   * live region (the dirty check suppresses identical frames), and it is
   * cleared the moment the region goes away — no `console.log`, no scrollback.
   */
  private ensureLiveTicker(wanted: boolean): void {
    if (!wanted) {
      if (this.liveTicker) {
        clearInterval(this.liveTicker);
        this.liveTicker = null;
      }
      return;
    }
    if (this.liveTicker) return;
    this.liveTicker = setInterval(() => this.render(), 1000);
    this.liveTicker.unref?.();
  }

  private stopLiveTicker(): void {
    if (this.liveTicker) {
      clearInterval(this.liveTicker);
      this.liveTicker = null;
    }
  }

  /** Public repaint hook (used by the loop when the activity tray changes). */
  refresh(): void {
    this.render();
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
    this.lastDrawnCursorCol = 0;
    this.statusRows = 0;
    this.lastRenderedStatus = '';
    this.lastRenderedLine = '';
    this.lastRenderedMenuKey = '';
    this.lastRenderedTrayKey = '';
    this.lastRenderedModalPrompt = '';
    this.lastRenderedWidth = 0;
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
    this.lastDrawnCursorCol = 0;
    this.statusRows = 0;
    this.tailRendered = false;
    this.lastRenderedStatus = '';
    this.lastRenderedLine = '';
    this.lastRenderedMenuKey = '';
    this.lastRenderedTrayKey = '';
    this.lastRenderedModalPrompt = '';
    this.lastRenderedWidth = 0;
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
    const patchedBody = (chunk: any, ...rest: any[]): boolean => {
      if (this.pending || this.ambientSuspended || !this.ambient) {
        return raw(chunk, ...rest);
      }
      const text =
        typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);

      const merged = this.tail + text;
      const nl = merged.lastIndexOf('\n');
      const completed = nl === -1 ? '' : merged.slice(0, nl + 1);
      const afterNl = nl === -1 ? merged : merged.slice(nl + 1);
      // tail = the CURRENT uncommitted row's content only: a trailing `\r`
      // (spinner stop() clears its row) must leave tail EMPTY, otherwise the
      // dead spinner text would be re-committed by the next newline.
      const tailOut = afterNl.includes('\r') ? afterNl.slice(afterNl.lastIndexOf('\r') + 1) : afterNl;

      // Anti-flickering: jika hanya update in-place pada baris tail (misal spinner) tanpa newline baru
      if (!completed && this.tailRendered) {
        this.tail = tailOut;
        const width = this.termWidth();
        const options = this.activeOptions();
        const currentStatus = options.statusLine ? truncateVisible(options.statusLine(width), width - 1) : '';
        const statusChanged = currentStatus !== this.lastRenderedStatus;

        if (statusChanged) {
          // Status bar berubah secara nyata (persentase context, proses, model): render ulang
          this.eraseForOutput();
          raw(tailOut + '\n');
          this.tailRendered = true;
          this.render();
        } else {
          // Status bar tidak berubah: perbarui hanya baris tail in-place tanpa menyentuh status bar
          const climb = this.drawnCursorRow + this.statusRows + 1;
          const col = visibleLength(options.prompt) + this.cursor;
          const lineRows = Math.max(1, Math.ceil(visibleLength(this.renderedLine()) / width));
          const cursorRow = Math.min(lineRows - 1, Math.floor(col / width));
          const cursorCol = col - cursorRow * width;

          let out = `\u001b[${climb}A\r\u001b[2K${tailOut}\u001b[${climb}B\r`;
          if (cursorCol > 0) out += `\u001b[${cursorCol}C`;
          this.rawWrite(out);
        }
        return true;
      }

      this.eraseForOutput();
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
    /**
     * H7: the patched write must never stay installed after a handler error —
     * an exception inside the interception (render, status provider, …) would
     * otherwise leave process.stdout hijacked for the rest of the session and
     * the terminal permanently broken. Any throw unpatches first, then
     * re-raises so the caller still sees the failure.
     */
    const patched = (chunk: any, ...rest: any[]): boolean => {
      try {
        return patchedBody(chunk, ...rest);
      } catch (err) {
        this.unpatchStdout();
        throw err;
      }
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

  private handleSelectorData(data: string): void {
    if (!this.selector) return;
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\u001b') {
        const match = data.slice(i).match(CSI_RE);
        if (match) {
          const final = match[2];
          if (final === 'A') {
            this.selector.selectedIndex =
              (this.selector.selectedIndex - 1 + this.selector.items.length) % this.selector.items.length;
            this.renderSelector();
          } else if (final === 'B') {
            this.selector.selectedIndex =
              (this.selector.selectedIndex + 1) % this.selector.items.length;
            this.renderSelector();
          }
          i += match[0].length;
          continue;
        }
        // Lone Escape: cancel selector without side effect
        this.closeSelector(null);
        return;
      }
      if (ch === '\r' || ch === '\n') {
        const chosen = this.selector.items[this.selector.selectedIndex]?.id ?? null;
        this.closeSelector(chosen);
        return;
      }
      if (ch === '\u0003') {
        this.closeSelector(null);
        return;
      }
      // Any other character ignored (chat input completely blocked while selector is open)
      i += 1;
    }
  }

  private closeSelector(result: string | null): void {
    if (!this.selector) return;
    this.eraseSelector();
    const resolve = this.selector.resolve;
    this.selector = null;
    if (!this.pending && !this.ambient) {
      this.detach();
    }
    resolve(result);
  }

  private renderSelector(): void {
    if (!this.selector) return;
    const { title, items, selectedIndex } = this.selector;
    const width = Math.min(Math.max(40, this.termWidth() - 4), 62);

    const lines: string[] = [];
    const headerTitle = title ? ` ${title} ` : ' Pilihan ';
    const headerPad = Math.max(0, width - 2 - visibleLength(headerTitle) - 2);
    lines.push(`\x1b[36m┌─\x1b[1;37m${headerTitle}\x1b[0;36m${'─'.repeat(headerPad)}┐\x1b[0m`);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isSel = i === selectedIndex;
      const prefix = isSel ? '\x1b[1;36m● \x1b[1;97m' : '  \x1b[90m';
      const label = item.label;
      const visLen = 2 + visibleLength(label);
      const pad = Math.max(0, width - 2 - visLen - 2);
      const row = `\x1b[36m│\x1b[0m ${prefix}${label}\x1b[0m${' '.repeat(pad)} \x1b[36m│\x1b[0m`;
      lines.push(row);
    }

    lines.push(`\x1b[36m├${'─'.repeat(width - 2)}┤\x1b[0m`);

    const selItem = items[selectedIndex];
    const descText = selItem ? selItem.description : '';
    const descTruncated = truncateVisible(descText, width - 4);
    const descPad = Math.max(0, width - 2 - visibleLength(descTruncated) - 2);
    lines.push(`\x1b[36m│\x1b[0m \x1b[33m${descTruncated}\x1b[0m${' '.repeat(descPad)} \x1b[36m│\x1b[0m`);
    lines.push(`\x1b[36m└${'─'.repeat(width - 2)}┘\x1b[0m`);

    let out = '';
    if (this.selector.drawnRows > 0) {
      out += `\u001b[${this.selector.drawnRows - 1}A\r\u001b[0J`;
    }
    out += lines.join('\n');
    this.selector.drawnRows = lines.length;
    this.rawWrite(out);
  }

  private eraseSelector(): void {
    if (!this.selector || this.selector.drawnRows === 0) return;
    const climb = this.selector.drawnRows - 1;
    let out = '';
    if (climb > 0) out += `\u001b[${climb}A`;
    out += '\r\u001b[0J';
    this.rawWrite(out);
    this.selector.drawnRows = 0;
  }

  private handleData(data: string): void {
    if (this.selector) {
      this.handleSelectorData(data);
      return;
    }
    if (!this.pending && !this.ambient) return;
    // A modal question owns the keyboard: only its keys (or Enter/Ctrl+C)
    // count — the buffer stays frozen underneath (feedback v0.7 #2/#6).
    if (this.modal) {
      const modal = this.modal;
      for (const ch of data) {
        if (ch === '\u0003' || ch === '\u001b') {
          this.modal = null;
          modal.resolve(null);
          this.render();
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
        // Lone Escape:
        if (this.menu.length > 0) {
          this.menu = [];
          this.selected = 0;
          this.menuNavigated = false;
          this.render();
          i += 1;
          continue;
        }
        // Ambient mode: interrupt/cancel in-flight AI step/turn
        if (!this.pending && this.ambient) {
          this.buffer = '';
          this.cursor = 0;
          this.eraseRegion();
          this.ambient.onInterrupt();
          if (this.ambient) this.render();
          return;
        }
        if (this.pending) {
          this.cancel();
          return;
        }
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
      if (ch === '\u0015') {
        this.buffer = '';
        this.cursor = 0;
        this.menuNavigated = false;
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
      if (ch === '\u000f') {
        // Ctrl+O — expand/collapse the live activity tray (feedback §4:
        // "-- N more, ctrl+o to expand").
        this.activeOptions().onToggleTray?.();
        i += 1;
        continue;
      }
      if (ch === '\u0012') {
        // Ctrl+R — expand/collapse panel Reasoning (Fase 3). Tidak menimpa
        // Ctrl+O (activity tray): hanya memicu callback bila tersedia.
        this.activeOptions().onToggleReasoning?.();
        i += 1;
        continue;
      }
      if (ch === '\u0004') {
        // Ctrl+D — expand/collapse detail diff mutasi berkas (Fase 4).
        // Shortcut alternatif atas Ctrl+O (sudah dipakai activity tray).
        // EOF-with-empty-buffer (aksi bawaan Ctrl+D) pindah ke Ctrl+Q.
        this.activeOptions().onToggleDiffDetail?.();
        i += 1;
        continue;
      }
      if (ch === '\u0011') {
        // Ctrl+Q — menggantikan Ctrl+D lama: EOF/keluar saat buffer kosong.
        if (this.buffer.length === 0) {
          this.cancel();
          return;
        }
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
    if (final === 'A') {
      if (this.menu.length > 0) this.moveSelection(-1);
      else this.historyBack();
    } else if (final === 'B') {
      if (this.menu.length > 0) this.moveSelection(1);
      else this.historyForward();
    } else if (final === 'C') this.cursor = Math.min(this.buffer.length, this.cursor + 1);
    else if (final === 'D') this.cursor = Math.max(0, this.cursor - 1);
    else if (final === 'H') this.cursor = 0;
    else if (final === 'F') this.cursor = this.buffer.length;
    else if (final === '~' && param === '3') this.deleteForward();
    this.refreshMenu();
    this.render();
  }

  private historyBack(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.historySavedBuffer = this.buffer;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    }
    this.buffer = this.history[this.historyIndex];
    this.cursor = this.buffer.length;
  }

  private historyForward(): void {
    if (this.historyIndex === -1) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.buffer = this.history[this.historyIndex];
    } else {
      this.historyIndex = -1;
      this.buffer = this.historySavedBuffer;
    }
    this.cursor = this.buffer.length;
  }

  private insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
    this.menuNavigated = false;
  }

  private backspace(): void {
    if (this.cursor === 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor -= 1;
    this.menuNavigated = false;
  }

  private deleteForward(): void {
    if (this.cursor >= this.buffer.length) return;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
    this.menuNavigated = false;
  }

  private moveSelection(delta: number): void {
    if (this.menu.length === 0) return;
    this.selected = (this.selected + delta + this.menu.length) % this.menu.length;
    this.menuNavigated = true;
  }

  private acceptSelection(): void {
    const item = this.menu[this.selected];
    if (!item) return;
    const text = item.insert ?? item.label;
    this.buffer = text;
    this.cursor = text.length;
    this.menuNavigated = false;
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
      this.menuNavigated = false;
      return;
    }
    const idx = previous ? items.findIndex((m) => m.label === previous) : -1;
    this.selected = idx >= 0 ? idx : Math.min(this.selected, items.length - 1);
  }

  private submit(): void {
    // Ambient Enter (AI busy): erase the region, hand the line to the loop
    // (which shows the queue modal), and redraw with an empty buffer.
    if (!this.pending && this.ambient) {
      let value = this.buffer;
      if (this.menuNavigated && this.menu.length > 0 && this.menu[this.selected]) {
        const item = this.menu[this.selected];
        value = (item.insert ?? item.label).trim();
      }
      this.buffer = '';
      this.cursor = 0;
      this.menu = [];
      this.selected = 0;
      this.menuNavigated = false;
      this.refreshMenu();
      this.eraseRegion();
      this.ambient.onSubmit(value);
      if (this.ambient) this.render();
      return;
    }
    const pending = this.pending;
    if (!pending) return;

    let value = this.buffer;
    // If the user actively navigated / scrolled the menu, Enter selects and commits the highlighted item
    if (this.menuNavigated && this.menu.length > 0 && this.menu[this.selected]) {
      const item = this.menu[this.selected];
      value = (item.insert ?? item.label).trim();
      this.menu = [];
      this.selected = 0;
      this.menuNavigated = false;
    }

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
    if (pending.options.hideEcho) {
      // feedback.txt item 2: erase the region and commit NOTHING. The caller
      // (approval prompt) prints a clean decision line in its place, so the
      // `y/n` prompt never stays behind in the terminal history.
      out += '\r\u001b[0J';
      this.output.write(out);
      this.historyIndex = -1;
      this.historySavedBuffer = '';
      this.finish(value);
      return;
    }
    out += `\r\u001b[0J${finalLine}\n`;
    this.output.write(out);
    this.historyIndex = -1;
    this.historySavedBuffer = '';
    if (value.trim() && !pending.options.mask) {
      this.history.push(value);
      this.onHistoryAppend?.(value);
    }
    this.finish(value);
  }

  private cancel(): void {
    this.historyIndex = -1;
    this.historySavedBuffer = '';
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
export function createLineEditor(
  input: ReadStream = process.stdin as ReadStream,
  output: WriteStream = process.stdout as WriteStream,
  options: LineEditorOptions = {},
): LineEditor {
  return new LineEditor(input, output, options);
}
