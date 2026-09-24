import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APPROVAL_LABELS,
  buildStatusBar,
  buildUsageLine,
  charWidth,
  CLEAR_CURRENT_LINE,
  colorsEnabled,
  createSpinner,
  ERASE_PREVIOUS_LINE,
  formatK,
  formatProcessSummary,
  graphemeWidth,
  LineGate,
  padVisible,
  renderApprovalBox,
  renderApprovalDecision,
  renderBox,
  renderDivider,
  sanitizeTerminalOutput,
  terminalWidth,
  truncateVisible,
  stripAnsi,
  visibleLength,
} from '../core/ui.js';

test('stripAnsi removes escape sequences', () => {
  assert.equal(stripAnsi('\u001b[32mhello\u001b[0m'), 'hello');
});

test('visibleLength ignores ANSI codes', () => {
  assert.equal(visibleLength('\u001b[1mabc\u001b[0m'), 3);
});

test('formatK formats budgets', () => {
  assert.equal(formatK(30_000), '30k');
  assert.equal(formatK(32_500), '32.5k');
  assert.equal(formatK(900), '900');
});

test('renderBox draws unicode borders with equal widths', () => {
  const box = renderBox('Title', ['one', 'two-longer-line']);
  const lines = box.split('\n');
  assert.ok(lines[0].startsWith('┌') && lines[0].endsWith('┐'));
  assert.ok(lines[1].startsWith('│') && lines[1].includes('Title'));
  assert.ok(lines[2].startsWith('├') && lines[2].endsWith('┤'));
  assert.ok(lines[lines.length - 1].startsWith('└'));
  assert.ok(lines[lines.length - 1].endsWith('┘'));
  const widths = new Set(lines.map((l) => visibleLength(l)));
  assert.equal(widths.size, 1, 'all box rows must have equal visible width');
});

test('status bar contains model, context usage and hint', () => {
  const bar = buildStatusBar({ model: 'qwen3.8-flash', usedChars: 12345, budgetChars: 30_000 });
  const plain = stripAnsi(bar);
  assert.ok(plain.includes('⚡'));
  assert.ok(plain.includes('[qwen3.8-flash]'));
  assert.ok(plain.includes('ctx 41%'), 'percent usage per feedback §7.47');
  assert.ok(plain.includes('12.3k/30k'));
  assert.ok(plain.includes('/ perintah'));
  if (!colorsEnabled()) return;
  assert.ok(bar.includes('\u001b['), 'expected ANSI colors when TTY');
});

test('status bar flags plan mode and role', () => {
  const plain = stripAnsi(
    buildStatusBar({
      model: 'm',
      usedChars: 0,
      budgetChars: 100,
      role: 'teacher',
      planMode: true,
    }),
  );
  assert.ok(plain.includes('⏸ PLAN'));
  assert.ok(plain.includes('· teacher'));
});

test('status bar carries per-turn stats instead of a separate line (§8)', () => {
  const plain = stripAnsi(
    buildStatusBar({
      model: 'm',
      usedChars: 1000,
      budgetChars: 30_000,
      turn: { promptChars: 3200, completionChars: 800 },
    }),
  );
  assert.ok(plain.includes('↑3.2k ↓800'), 'turn stats live in the bar');
  const without = stripAnsi(buildStatusBar({ model: 'm', usedChars: 1, budgetChars: 100 }));
  assert.ok(!without.includes('↑'), 'no stray stats when no turn ran');
});

test('buildUsageLine reports per-turn chars and ctx percent', () => {
  const line = buildUsageLine({ promptChars: 3200, completionChars: 800, usedChars: 15_000, budgetChars: 30_000 });
  assert.equal(line, '↑ 3.2k ↓ 800 · ctx 50%');
});

test('LineGate holds the trailing line and flushes it for a final answer (§2)', () => {
  let out = '';
  const gate = new LineGate((t) => {
    out += t;
  });
  gate.push('Hello world');
  assert.equal(out, '', 'single trailing line is held back');
  assert.equal(gate.finish(true), true);
  assert.equal(out, 'Hello world');
});

test('LineGate drops a dangling preamble before a tool block (§2)', () => {
  let out = '';
  const gate = new LineGate((t) => {
    out += t;
  });
  gate.push('dengan: melihat daftar perintah');
  assert.equal(gate.finish(false), false);
  assert.equal(out, '', 'fragment must not reach the screen');
});

test('LineGate streams completed lines but reserves the last one', () => {
  let out = '';
  const gate = new LineGate((t) => {
    out += t;
  });
  gate.push('first\nsecond\nthird');
  assert.equal(out, 'first\n', 'only the last line stays reserved');
  gate.finish(true);
  assert.equal(out, 'first\nsecond\nthird');
});

// --- v0.6.1: single box helper + width clamp (feedback: stacking borders) ---

test('truncateVisible cuts to visible width and closes open colors', () => {
  const colored = '\u001b[93mmodel: claude-5\u001b[0m ── provider: custom';
  const cut = truncateVisible(colored, 10);
  assert.equal(visibleLength(cut), 10);
  assert.ok(!/\u001b\[93m[^\u001b]*$/.test(cut), 'no dangling color at cut end');
  assert.equal(truncateVisible('short', 50), 'short', 'no-op when it fits');
});

test('renderBox clamps to the terminal width so borders never wrap-stack', () => {
  const saved = process.stdout.columns;
  try {
    process.stdout.columns = 30;
    const box = renderBox('Title', ['x'.repeat(200)]);
    for (const line of box.split('\n')) {
      assert.ok(
        visibleLength(line) <= 30 - 1,
        `row must fit the terminal: ${visibleLength(line)}`,
      );
    }
    const widths = new Set(box.split('\n').map(visibleLength));
    assert.equal(widths.size, 1, 'all rows equal width even when clamped');
  } finally {
    process.stdout.columns = saved;
  }
});

// --- v0.7: double-width aware measuring (root cause of the bar wrap-stack) ---

test('visibleLength counts emoji/CJK as 2 terminal columns (wcwidth)', () => {
  assert.equal(visibleLength('⚡'), 2, 'U+26A1 high voltage is wide in terminals');
  assert.equal(visibleLength('⏳'), 2);
  assert.equal(visibleLength('中文'), 4);
  assert.equal(visibleLength('abc'), 3);
  assert.equal(visibleLength('\u001b[32m⚡ok\u001b[0m'), 4, 'ANSI ignored, emoji wide');
});

test('truncateVisible never splits a double-width cell', () => {
  const cut = truncateVisible('⚡⚡⚡', 3);
  assert.equal(visibleLength(cut), 2, 'stops before the third emoji, not mid-cell');
});

test('status bar with busy+queue badge measures within its clamp', () => {
  const bar = buildStatusBar({
    model: 'm',
    usedChars: 10,
    budgetChars: 30000,
    busy: true,
    pending: 1,
    turn: { promptChars: 2600, completionChars: 28 },
  });
  const plain = stripAnsi(bar);
  assert.ok(plain.includes('⏳ AI bekerja'), 'busy indicator in the bar');
  assert.ok(plain.includes('1 menunggu'), 'queue badge in the bar');
  // The editor clamps to width-1 with truncateVisible; measuring must agree
  // with what terminals actually render (the v0.7 stacking root cause).
  assert.ok(visibleLength(truncateVisible(bar, 40)) <= 40);
});

// --- v0.8: Pac-Man thinking animation (feedback.txt / pac.cjs) ---

test('createSpinner stops cleanly in non-TTY without throwing', () => {
  const spinner = createSpinner('Thinking');
  assert.doesNotThrow(() => spinner.stop());
});

test('createSpinner renders dot spinner and cleans up cleanly', () => {
  const origIsTTY = process.stdout.isTTY;
  const origColumns = process.stdout.columns;
  const origWrite = process.stdout.write;
  const origNoColor = process.env.NO_COLOR;
  const writes: string[] = [];
  let spinner: { stop(): void } | undefined;

  try {
    process.stdout.isTTY = true;
    process.stdout.columns = 80;
    delete process.env.NO_COLOR;
    process.stdout.write = ((chunk: any) => {
      writes.push(String(chunk));
      return true;
    }) as any;

    spinner = createSpinner('Thinking');
    assert.ok(writes.length >= 1);
    const plain = stripAnsi(writes[0]);
    assert.ok(plain.includes('▸ Thinking'), 'spinner uses dot spinner');
    assert.ok(!plain.includes('(oo)') && !plain.includes('(OO)'), 'no ghosts in spinner');

    spinner.stop();
    const lastWrite = writes[writes.length - 1];
    assert.ok(lastWrite.startsWith('\r') && lastWrite.endsWith('\r'));
  } finally {
    spinner?.stop();
    process.stdout.isTTY = origIsTTY;
    process.stdout.columns = origColumns;
    process.stdout.write = origWrite;
    if (origNoColor !== undefined) process.env.NO_COLOR = origNoColor;
    else delete process.env.NO_COLOR;
  }
});

test('renderDivider generates responsive horizontal line with fallback', () => {
  const origCols = process.stdout.columns;
  try {
    process.stdout.columns = 80;
    const div80 = renderDivider();
    assert.equal(stripAnsi(div80).length, 79);
    assert.ok(div80.includes('─'));

    process.stdout.columns = 50;
    const div50 = renderDivider();
    assert.equal(stripAnsi(div50).length, 49);

    // Fallback when columns is undefined
    delete (process.stdout as any).columns;
    const divFallback = renderDivider();
    assert.equal(stripAnsi(divFallback).length, 79);
  } finally {
    process.stdout.columns = origCols;
  }
});

test('renderApprovalBox renders equal-width rows with warning header and ANSI colors', () => {
  const origCols = process.stdout.columns;
  try {
    process.stdout.columns = 80;
    const box = renderApprovalBox('rm -rf node_modules', 'menghapus direktori dependensi');
    const lines = box.split('\n');
    assert.ok(lines.length >= 6);
    assert.ok(lines[0].startsWith('┌') && lines[0].endsWith('┐'));
    assert.ok(lines[1].includes('⚠ KONFIRMASI BERISIKO'));
    assert.ok(lines[2].startsWith('├') && lines[2].endsWith('┤'));
    assert.ok(lines[3].includes('Alasan') && lines[3].includes('menghapus direktori dependensi'));
    assert.ok(lines[4].includes('Perintah') && lines[4].includes('rm -rf node_modules'));
    assert.ok(lines[lines.length - 1].startsWith('└') && lines[lines.length - 1].endsWith('┘'));

    const widths = new Set(lines.map((l) => visibleLength(l)));
    assert.equal(widths.size, 1, 'all approval box rows must have identical visible width');

    // Narrow terminal test: adapts width responsively
    process.stdout.columns = 40;
    const narrowBox = renderApprovalBox('rm -rf ' + 'x'.repeat(100), 'menghapus file');
    const narrowLines = narrowBox.split('\n');
    const narrowWidths = new Set(narrowLines.map((l) => visibleLength(l)));
    assert.equal(narrowWidths.size, 1, 'all narrow box rows must have identical visible width');
    assert.ok([...narrowWidths][0] <= 40, 'box width must not exceed terminal columns');
  } finally {
    process.stdout.columns = origCols;
  }
});

test('formatProcessSummary formats single, multiple, and compact process representations', () => {
  assert.equal(formatProcessSummary([]), '');
  assert.equal(formatProcessSummary([{ command: 'sleep 301' }]), '1 proc (sleep 301)');
  assert.equal(
    formatProcessSummary([{ command: 'sleep 301' }, { command: 'vite' }]),
    '2 proc (sleep 301, vite)',
  );
  assert.equal(
    formatProcessSummary([{ command: 'sleep 301' }, { command: 'vite' }, { command: 'npm test' }]),
    '3 proc (sleep 301, vite, npm test)',
  );
  assert.equal(
    formatProcessSummary([{ command: 'sleep 301' }, { command: 'vite' }], true),
    '2 proc',
  );
});

test('status bar integrates active background processes and is responsive on narrow viewport', () => {
  const bar = buildStatusBar({
    model: 'glm-5.3-flash',
    usedChars: 6000,
    budgetChars: 30000,
    activeProcesses: [{ command: 'sleep 301' }, { command: 'vite' }],
  });
  const plain = stripAnsi(bar);
  assert.ok(plain.includes('⚡ [glm-5.3-flash]'), 'contains model badge');
  assert.ok(plain.includes('⚙️ 2 proc (sleep 301, vite)'), 'contains active process summary');
  assert.ok(plain.includes('ctx 20%'), 'contains context usage percent');

  // Narrow terminal responsive test (40 columns)
  const narrowBar = buildStatusBar({
    model: 'glm-5.3-flash',
    usedChars: 6000,
    budgetChars: 30000,
    width: 40,
    activeProcesses: [{ command: 'sleep 301' }, { command: 'vite' }],
  });
  const narrowPlain = stripAnsi(narrowBar);
  assert.ok(narrowPlain.includes('⚙️ 2 proc'), 'contains compact proc badge');
  assert.ok(narrowPlain.includes('ctx 20%'), 'contains context percent');
  assert.ok(visibleLength(truncateVisible(narrowBar, 40)) <= 40, 'narrow status bar fits <= 40 cols');
});

test('status bar on narrow screens (Termux <= 40 cols) preserves context percent and indicators without cutting off', () => {
  // Long model name on 40 columns
  const bar40 = buildStatusBar({
    model: 'claude-3-7-sonnet-20250219',
    usedChars: 12000,
    budgetChars: 30000,
    width: 40,
    busy: true,
    activeProcesses: [{ command: 'vite' }],
  });
  const plain40 = stripAnsi(bar40);
  assert.ok(plain40.includes('ctx 40%'), 'ctx percent must be present on 40-col screen');
  assert.ok(plain40.includes('⏳'), 'busy indicator must be present');
  assert.ok(visibleLength(bar40) <= 39, `visible length (${visibleLength(bar40)}) must be <= 39 cols`);

  // Extra narrow terminal (34 columns, e.g. mobile portrait with font zoom)
  const bar34 = buildStatusBar({
    model: 'gemini-2.5-flash',
    usedChars: 6000,
    budgetChars: 30000,
    width: 34,
  });
  const plain34 = stripAnsi(bar34);
  assert.ok(plain34.includes('ctx 20%'), 'ctx percent must be present on 34-col screen');
  assert.ok(visibleLength(bar34) <= 33, `visible length (${visibleLength(bar34)}) must be <= 33 cols`);
});

test('terminalWidth respects process.env.COLUMNS when stdout.columns is undefined', () => {
  const origCols = process.stdout.columns;
  const origEnv = process.env.COLUMNS;
  try {
    delete (process.stdout as any).columns;
    process.env.COLUMNS = '42';
    assert.equal(terminalWidth(), 42);

    process.env.COLUMNS = '12'; // below min 20
    assert.equal(terminalWidth(), 20);

    delete process.env.COLUMNS;
    assert.equal(terminalWidth(), 80); // fallback
  } finally {
    process.stdout.columns = origCols;
    if (origEnv !== undefined) process.env.COLUMNS = origEnv;
    else delete process.env.COLUMNS;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// M5 (audit v1.7.7, batch 2): charWidth tidak grapheme-aware — emoji
// U+1F800–U+1FFFF, combining marks, ZWJ, dan regional indicator (flag) salah
// dihitung sehingga lebar baris bisa melenceng.
// ─────────────────────────────────────────────────────────────────────────────

test('M5: charWidth mencakup emoji U+1F800–U+1FFFF dan kelas zero-width', () => {
  assert.equal(charWidth(0x1f800), 2, 'Supplemental Symbols & Pictographs = 2');
  assert.equal(charWidth(0x1f9ff), 2, 'masih dalam rentang emoji');
  assert.equal(charWidth(0x1fae0), 2, 'Symbols & Pictographs Extended-A = 2');
  assert.equal(charWidth(0x1f1e6), 1, 'satu regional indicator = 1 kolom');
  assert.equal(charWidth(0x200d), 0, 'ZWJ = 0');
  assert.equal(charWidth(0x0301), 0, 'combining acute = 0');
  assert.equal(charWidth(0xfe0f), 0, 'variation selector-16 = 0');
  assert.equal(charWidth(0xfeff), 0, 'BOM/ZWNBSP = 0');
});

test('M5: visibleLength menghitung per grapheme cluster (flag, ZWJ, combining)', () => {
  // Ditulis dengan escape agar ZWJ (U+200D) tidak hilang saat berkas ditulis.
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  assert.equal(visibleLength('🇮🇩'), 2, 'flag emoji = 2 kolom (bukan 2 per indikator)');
  assert.equal(visibleLength('e\u0301'), 1, 'e + combining acute = 1 kolom');
  assert.equal(visibleLength(family), 2, 'keluarga ZWJ = 2 kolom');
  assert.equal(visibleLength('CJK 漢字'), 4 + 4, 'teks wide tetap 2 kolom per aksara');
  assert.equal(graphemeWidth('🇮🇩'), 2);
  assert.equal(graphemeWidth('e\u0301'), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// M8 (audit v1.7.7, batch 2): ANSI_RE terlalu sempit — CSI dengan parameter
// privat (\u001b[?25l, \u001b[?1049h) lolos sanitizeTerminalOutput.
// ─────────────────────────────────────────────────────────────────────────────

test('M8: sanitizeTerminalOutput membuang CSI private-mode dan intermediate bytes', () => {
  assert.equal(sanitizeTerminalOutput('A\u001b[?25lB'), 'AB', 'hide cursor dibuang');
  assert.equal(sanitizeTerminalOutput('A\u001b[?1049hB'), 'AB', 'alt screen dibuang');
  assert.equal(sanitizeTerminalOutput('A\u001b[?25hB'), 'AB');
  assert.equal(sanitizeTerminalOutput('A\u001b[>0cB'), 'AB');
  assert.equal(sanitizeTerminalOutput('A\u001b[2 qB'), 'AB', 'intermediate byte + final');
  // SGR tetap dipertahankan (warna tidak dianggap berbahaya)
  const colored = '\u001b[1;32mOK\u001b[0m';
  assert.equal(sanitizeTerminalOutput(colored), colored);
  // stripAnsi juga bersih dari sisa artefak
  assert.equal(stripAnsi('A\u001b[?25lB'), 'AB');
  assert.equal(visibleLength('A\u001b[?25lB'), 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// M9 (audit v1.7.7, batch 2): padding ditambahkan setelah SGR masih aktif dan
// early-return truncateVisible meneruskan ANSI berbahaya.
// ─────────────────────────────────────────────────────────────────────────────

test('M9: padVisible menutup SGR sebelum padding sehingga spasi tidak ikut berwarna', () => {
  assert.equal(padVisible('abc', 5), 'abc  ', 'tanpa ANSI tetap sama');
  assert.equal(padVisible('\u001b[31mab', 4), '\u001b[31mab\u001b[0m  ');
  assert.equal(padVisible('\u001b[31mab\u001b[0m', 4), '\u001b[31mab\u001b[0m  ');
  assert.equal(padVisible('abcdef', 3), 'abcdef', 'tidak memotong, hanya padding');
});

test('M9: truncateVisible menyaring sequence berbahaya walau tidak memotong', () => {
  assert.equal(truncateVisible('A\u001b[?25lB', 80), 'AB');
  assert.equal(truncateVisible('short', 50), 'short');
  assert.equal(truncateVisible('\u001b[31mred\u001b[0m', 50), '\u001b[31mred\u001b[0m');
});

// ─────────────────────────────────────────────────────────────────────────────
// L3 + feedback item 2: label approval terpusat & helper pembersihan baris.
// ─────────────────────────────────────────────────────────────────────────────

test('L3: label kotak approval terpusat di APPROVAL_LABELS dan dipakai renderApprovalBox', () => {
  assert.equal(APPROVAL_LABELS.header, '⚠ KONFIRMASI BERISIKO');
  assert.equal(APPROVAL_LABELS.reason, 'Alasan  :');
  assert.equal(APPROVAL_LABELS.command, 'Perintah:');

  const box = renderApprovalBox('rm -rf node_modules', 'menghapus direktori dependensi');
  assert.ok(box.includes(APPROVAL_LABELS.header));
  assert.ok(box.includes(APPROVAL_LABELS.reason));
  assert.ok(box.includes(APPROVAL_LABELS.command));
});

test('Item 2: helper pembersihan baris konfirmasi & baris hasil approval', () => {
  assert.equal(CLEAR_CURRENT_LINE, '\r\u001b[2K');
  assert.equal(ERASE_PREVIOUS_LINE, '\u001b[1A\r\u001b[2K');
  assert.equal(stripAnsi(renderApprovalDecision(true)), APPROVAL_LABELS.approved);
  assert.equal(stripAnsi(renderApprovalDecision(false)), APPROVAL_LABELS.denied);
});



