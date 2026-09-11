/**
 * Ruko entry splash — aquarium animation (anim.js) + box layout (anim.txt).
 *
 * Sequence on a real TTY (normal buffer, cursor hidden during frames):
 *   1. Aquarium scene plays inside the box — water ripples on the surface,
 *      bubbles rising, three fish swimming back and forth (tails flicking),
 *      sandy bottom and swaying plants. Same logic as anim.js, 110 ms frames,
 *      redrawn in place via the shared `createInPlaceBlock` helper.
 *   2. The scene freezes and the text sweeps in left-to-right:
 *
 *        ┌Ruko-agent────────────────version 0.6.0─────┐
 *        │                                             │
 *        │  "Masuk Ruko..."                            │
 *        │                                             │
 *        │  model: claude-5 ──── provider: custom       │
 *        │                                             │
 *        │  Ketik / untuk daftar perintah, Ctrl+C keluar│
 *        └─────────────────────────────────────────────┘
 *
 *   3. The final box is committed to scrollback.
 *
 * Non-TTY, CI, NO_COLOR, or RUKO_NO_ANIM=1 skip straight to the static print
 * so tests and pipes stay deterministic.
 */

import { colorsEnabled, createInPlaceBlock, padVisible, stripAnsi, terminalWidth, truncateVisible, visibleLength } from './ui.js';

/** The three fish shades from anim.js (93 bright yellow, 96 cyan, 95 grey). */
const FISH_COLORS = [93, 96, 95];

/** Aquarium scene height in rows: surface, 3 swim lanes, sandy bottom. */
const SCENE_ROWS = 5;

export interface SplashInfo {
  /** Header line, e.g. `Ruko-agent 0.6.0`. */
  title: string;
  /** Right-aligned header text, e.g. `version 0.6.0`. */
  version: string;
  /** Centre tagline shown while the splash animates. */
  tagline: string;
  /** Info line, e.g. `model: x ──── provider: y`. */
  modelLine: string;
  /** Footer hint line. */
  hint: string;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Total box width (incl. borders): clamped to `terminalWidth() - 1`. A box
 * exactly as wide as the terminal triggers the pending-wrap glitch and its
 * borders pile up as separate rows (feedback v0.6.1 — the splash bug, again).
 */
export function splashWidth(): number {
  return Math.max(20, Math.min(56, terminalWidth() - 1));
}

/**
 * Builds the static splash box lines (no trailing newline). Padding uses
 * visible width so ANSI-coloured fields never break the borders. Default
 * width follows the terminal (was a fixed 56 — the root cause of the
 * wrapping splash on narrow terminals).
 */
export function renderSplashLines(info: SplashInfo, width = splashWidth()): string[] {
  const inner = Math.max(10, width - 2);
  const header = truncateVisible(
    padVisible(` ${info.title}`, inner - info.version.length - 1) + info.version + ' ',
    inner,
  );
  const top = `┌${header}┐`;
  const blank = `│${' '.repeat(inner)}│`;
  const centre = (text: string): string => {
    const t = truncateVisible(text, inner);
    const pad = Math.max(0, Math.floor((inner - visibleLength(t)) / 2));
    return `│${' '.repeat(pad)}${padVisible(t, inner - pad)}│`;
  };
  const bottom = `└${'─'.repeat(inner)}┘`;
  return [
    top,
    blank,
    centre(info.tagline),
    blank,
    centre(info.modelLine),
    blank,
    centre(info.hint),
    bottom,
  ];
}

/** True when the animated splash may run in this environment. */
export function splashAnimatable(): boolean {
  return (
    colorsEnabled() &&
    !!process.stdout.isTTY &&
    !!process.stdin.isTTY &&
    process.env.RUKO_NO_ANIM !== '1'
  );
}

function paint(text: string, color: number): string {
  return `\u001b[${color}m${text}\u001b[0m`;
}

/**
 * One aquarium frame as a grid of painted cells (anim.js `put`/`rows` port).
 * Cells hold ANSI-painted characters; empty cells are plain spaces.
 */
function sceneFrame(width: number, frame: number): string[][] {
  const rows: string[][] = Array.from({ length: SCENE_ROWS }, () =>
    Array.from({ length: width }, () => ' '),
  );

  const put = (text: string, x: number, y: number, color: number): void => {
    [...text].forEach((char, i) => {
      if (y >= 0 && y < SCENE_ROWS && x + i >= 0 && x + i < width) {
        rows[y][x + i] = paint(char, color);
      }
    });
  };

  // Riak permukaan air.
  for (let x = 0; x < width; x++) {
    put((x + Math.floor(frame / 3)) % 6 < 2 ? '~' : '.', x, 0, 34);
  }

  // Gelembung bergerak naik dan sedikit ke samping.
  for (let i = 0; i < 5; i++) {
    const age = (Math.floor(frame / 3) + i) % SCENE_ROWS;
    const x = (i * 11 + 6 + (age % 2)) % width;
    put(age > 1 ? 'o' : '.', x, SCENE_ROWS - 1 - age, 96);
  }

  // Ikan berbalik arah setelah keluar dari layar.
  for (let i = 0; i < 3; i++) {
    const span = width + 10;
    const step = Math.floor(frame / (i + 1)) + i * 17;
    const phase = step % (span * 2);
    const right = phase < span;
    const x = right ? phase - 9 : span * 2 - phase - 9;
    const tail = Math.floor(frame / 2) % 2;
    const fish = right
      ? tail ? '><(((o>' : '}-(((o>'
      : tail ? '<o)))><' : '<o)))-{';
    put(fish, x, i + 1, FISH_COLORS[i]);
  }

  // Dasar akuarium dan tanaman bergoyang.
  for (let x = 0; x < width; x++) {
    put(x % 3 === 0 ? '.' : '_', x, SCENE_ROWS - 1, 90);
  }
  for (let x = 3; x < width - 2; x += 9) {
    const sway = Math.floor(frame / 4 + x) % 2;
    put(sway ? '(' : ')', x, SCENE_ROWS - 2, 32);
    put(sway ? '\\|/' : '/|\\', x - 1, SCENE_ROWS - 1, 92);
  }

  return rows;
}

/** Wraps scene rows in the box border with the given header/bottom. */
function framed(width: number, header: string, bottom: string, scene: string[][]): string[] {
  const inner = width - 2;
  const top = `┌${truncateVisible(header, inner)}┐`;
  const body = scene.map((row) => `│${truncateVisible(row.join(''), inner)}│`);
  return [top, ...body, bottom];
}

/**
 * Plays the aquarium splash and commits the final text box to scrollback
 * afterwards. Returns the static lines either way.
 *
 * v0.6.1: redraw goes through the SHARED `createInPlaceBlock` helper on the
 * NORMAL buffer (was: alternate screen + hand-rolled `ESC[H` frame loop).
 * Two reasons: (a) the alt screen made the animation invisible on terminals
 * that don't restore it cleanly (feedback #6 "animasi gak muncul"), and (b)
 * the hand-rolled loop was a second box renderer whose frames could exceed
 * the terminal width and pile up as separate rows — the same stacking bug as
 * the splash text box. Every frame line is now clamped to `width` ≤
 * `terminalWidth()-1`, so the rewind math can never break.
 */
export async function playSplash(info: SplashInfo): Promise<string[]> {
  const lines = renderSplashLines(info);
  if (!splashAnimatable()) {
    console.log(lines.join('\n'));
    return lines;
  }

  const SCENE_MS = 1800; // aquarium swims before the text arrives
  const REVEAL_MS = 900; // left-to-right text sweep
  const FRAME_MS = 110; // same cadence as anim.js

  const width = splashWidth();
  const inner = width - 2;
  const header = padVisible(` ${info.title}`, inner - info.version.length - 1) + info.version + ' ';
  const bottom = `└${'─'.repeat(inner)}┘`;
  const textLines = renderSplashLines(info, width);
  const textPlain = textLines.map(stripAnsi);

  const block = createInPlaceBlock();
  process.stdout.write('\u001b[?25l'); // hide cursor while frames redraw
  const started = Date.now();
  // Phase 1 — aquarium swims in place.
  for (let frame = 0; Date.now() - started < SCENE_MS; frame++) {
    block.draw(framed(width, header, bottom, sceneFrame(inner, frame)));
    await delay(Math.max(0, FRAME_MS - ((Date.now() - started) % FRAME_MS)));
  }
  // Phase 2 — text sweeps in left-to-right over the frozen frame.
  const revealStart = Date.now();
  for (;;) {
    const elapsed = Date.now() - revealStart;
    const reveal = Math.min(1, elapsed / REVEAL_MS);
    block.draw(
      textPlain.map((row) => row.slice(0, Math.ceil(row.length * reveal))),
    );
    if (reveal >= 1) break;
    await delay(Math.max(0, 40 - (elapsed % 40)));
  }
  await delay(350);
  // Erase the animation, restore the cursor, then commit the final static box once.
  block.clear();
  process.stdout.write('\u001b[?25h');
  console.log(textLines.join('\n'));
  return lines;
}
