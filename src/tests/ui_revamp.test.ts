import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { ReadStream, WriteStream } from 'node:tty';
import { Agent } from '../agent/agent.js';
import { setWorkspaceRoot } from '../agent/tools.js';
import { ActivityTray, formatActivityRow, formatTrayDuration } from '../core/activity.js';
import { Context } from '../core/context.js';
import { LineEditor } from '../core/tui.js';
import {
  activityIconForTool,
  activityLabelForTool,
  buildStatusPanel,
  describeToolCallForLog,
  formatActionLogLine,
  shortModelName,
  stripAnsi,
  visibleLength,
  WorkflowTree,
} from '../core/ui.js';
import { DEFAULT_CONFIG } from '../types.js';

// ============================================================================
// 1. Model name truncation (feedback §1)
// ============================================================================

test('shortModelName keeps only the core family name of a model id', () => {
  assert.equal(shortModelName('gemini-3.8-flash'), 'gemini');
  assert.equal(shortModelName('claude-opus-3.7'), 'claude');
  assert.equal(shortModelName('qwen3.8-flash'), 'qwen');
  assert.equal(shortModelName('nvidia/nemotron-3-ultra-550b-a55b:free'), 'nemotron');
  assert.equal(shortModelName('gpt-4o-mini'), 'gpt');
  assert.equal(shortModelName('deepseek-v4.1-flash'), 'deepseek');
  assert.equal(shortModelName('llama3.1:70b'), 'llama');
  // Short / odd ids must not be mangled or emptied.
  assert.equal(shortModelName('m'), 'm');
  assert.equal(shortModelName(''), 'no-model');
  assert.ok(shortModelName('x'.repeat(40)).length <= 16, 'long ids are capped');
});

// ============================================================================
// 2. Responsive status panel (feedback §2)
// ============================================================================

test('buildStatusPanel renders a box whose rows all share one visible width', () => {
  const lines = buildStatusPanel({
    width: 80,
    model: 'gemini-3.8-flash',
    usedChars: 12000,
    budgetChars: 30000,
    yoloMode: true,
    turn: { promptChars: 3200, completionChars: 800 },
  });
  assert.equal(lines.length, 5, 'top / cells / separator / hint / bottom');
  assert.ok(lines[0].startsWith('┌') && lines[0].endsWith('┐'));
  assert.ok(lines[1].startsWith('│') && lines[1].endsWith('│'));
  assert.ok(lines[2].startsWith('├') && lines[2].endsWith('┤'));
  assert.ok(lines[3].startsWith('│') && lines[3].endsWith('│'));
  assert.ok(lines[4].startsWith('└') && lines[4].endsWith('┘'));
  const widths = new Set(lines.map(visibleLength));
  assert.equal(widths.size, 1, 'every row must be exactly as wide as the frame');

  const plain = lines.map(stripAnsi);
  assert.ok(plain[1].includes('gemini'), 'short model name in the model cell');
  assert.ok(plain[1].includes('YOLO'), 'YOLO badge when bypass is active');
  assert.ok(plain[1].includes('↑ 800t ↓ 200t'), 'turn tokens per feedback spec');
  assert.ok(plain[3].includes('/? for help, ask anything...'), 'hint row');
  assert.ok(plain[0].includes('┬') && plain[2].includes('┴'), 'column joins');
});

test('buildStatusPanel border runs follow the live terminal width (no static columns)', () => {
  for (const width of [120, 80, 60, 46, 40, 30, 24]) {
    const lines = buildStatusPanel({ width, model: 'nvidia/nemotron-3-ultra-550b-a55b:free', usedChars: 1, budgetChars: 10 });
    for (const line of lines) {
      assert.ok(
        visibleLength(line) <= Math.max(16, width - 1),
        `row overflows a ${width}-col terminal: ${visibleLength(line)}`,
      );
    }
    const widths = new Set(lines.map(visibleLength));
    assert.equal(widths.size, 1, `ragged box at width ${width}`);
    assert.ok(
      visibleLength(lines[0]) >= Math.min(20, width - 1),
      `box should adapt to the terminal, got ${visibleLength(lines[0])} at ${width}`,
    );
  }
});

test('buildStatusPanel drops optional columns before truncating the model cell', () => {
  const wide = buildStatusPanel({
    width: 90,
    model: 'claude-opus-3.7',
    yoloMode: true,
    planMode: true,
    usedChars: 100,
    budgetChars: 1000,
  }).map(stripAnsi);
  assert.ok(wide[1].includes('claude') && wide[1].includes('YOLO') && wide[1].includes('PLAN'));

  // Extra narrow: badges/stats fold away, the model family name survives.
  const narrow = buildStatusPanel({ width: 26, model: 'claude-opus-3.7', yoloMode: true, usedChars: 100, budgetChars: 1000 }).map(stripAnsi);
  assert.ok(narrow[1].includes('claude'), 'model cell kept on narrow screens');

  // No YOLO / no turn stats → no stray badge, no stray arrow.
  const quiet = buildStatusPanel({ width: 60, model: 'qwen3.8-flash', usedChars: 3000, budgetChars: 30000 }).map(stripAnsi);
  assert.ok(!quiet[1].includes('YOLO'), 'YOLO column is hidden while confirmation is enforced');
  assert.ok(!quiet[1].includes('↑'), 'no token stats before the first turn');
  assert.ok(quiet[1].includes('ctx 10%'), 'context percent takes the stats column');
});

// ============================================================================
// 3. Action log history (feedback §3)
// ============================================================================

test('formatActionLogLine renders ├── branches for finished tool calls', () => {
  assert.equal(
    stripAnsi(formatActionLogLine(1, '🟢 Glob(PROGRESS.md)', 12) ?? ''),
    '├── [1] 🔍 find PROGRESS.md · 12ms',
  );
  assert.equal(
    stripAnsi(formatActionLogLine(2, '🟢 Bash(npm test)', 1200) ?? ''),
    '├── [2] 🖥️ Bash(npm test) · 1.2s',
  );
  assert.equal(
    stripAnsi(formatActionLogLine(3, '🟣 Subagent(read file halo.md)') ?? ''),
    '├── [3] 🟣 Subagent "read file halo.md"',
  );
  // Compact-compatible read form (existing logs/tests depend on it).
  assert.equal(stripAnsi(formatActionLogLine(1, '🟢 Read(a.txt)', 5) ?? ''), '├── [1] 📖 Read a.txt · 5ms');
  // Extra notes emitted by the tool are preserved.
  assert.equal(
    stripAnsi(formatActionLogLine(4, '🟡 Edit(src/x.ts) — tidak ada perubahan') ?? ''),
    '├── [4] ✏️ Edit src/x.ts — tidak ada perubahan',
  );
  // Non-tool lines are never turned into branches.
  assert.equal(formatActionLogLine(1, '⚠ Perintah identik terlewat'), null);
  assert.equal(formatActionLogLine(1, '--- a/src/x.ts'), null);
});

test('describeToolCallForLog / activity labels map tool calls to tray + log text', () => {
  assert.equal(describeToolCallForLog({ tool: 'read_file', path: 'a.txt' }), '🟢 Read(a.txt)');
  assert.equal(describeToolCallForLog({ tool: 'exec', command: 'npm test' }), '🟢 Bash(npm test)');
  assert.equal(describeToolCallForLog({ tool: 'glob', pattern: '*.ts' }), '🟢 Glob(*.ts)');
  assert.equal(describeToolCallForLog({ tool: 'delete_file', path: 'x.ts' }), '🔴 Delete(x.ts)');
  assert.equal(describeToolCallForLog({ tool: 'delegate', task: 'read file halo.md' }), '🟣 Subagent(read file halo.md)');

  assert.equal(activityLabelForTool({ tool: 'exec', command: 'npm test' }), 'npm test');
  assert.equal(activityLabelForTool({ tool: 'delegate', task: 'read_file halo.md' }), 'Subagent (read_file) halo.md');
  assert.equal(activityLabelForTool({ tool: 'read_file', path: 'package.json' }), 'Read package.json');
  assert.equal(activityIconForTool({ tool: 'delegate' }), '🟣');
  assert.equal(activityIconForTool({ tool: 'exec' }), '🟢');
});

test('WorkflowTree branch mode prints one ├── line per tool, only when it finishes', () => {
  const output: string[] = [];
  const tree = new WorkflowTree((line) => output.push(line), { compact: true, branch: true });

  tree.startStep('Membaca berkas');
  tree.beginAction();
  tree.log('🟢 Read(package.json)');
  assert.deepEqual(output, [], 'the per-tool start line must NOT be committed yet');

  tree.log('--- a/package.json\n+++ b/package.json'); // tool detail output
  assert.deepEqual(output, [], 'detail output waits for the action line');
  tree.completeAction('🟢 Read(package.json)', 42);

  const plain = output.map(stripAnsi);
  assert.equal(plain[0], '├── [1] 📖 Read package.json · 42ms', 'action line lands first');
  assert.equal(plain[1], '│  --- a/package.json', 'detail lines are indented under the branch');
  assert.equal(plain[2], '│  +++ b/package.json');

  // A warning logged outside an action is printed immediately.
  tree.log('⚠ Perintah identik terdeteksi berulang, dilewati');
  assert.ok(stripAnsi(output[output.length - 1]).includes('Perintah identik terdeteksi berulang'));

  // Second action: numbered independently, fallback text used when the tool logged nothing.
  tree.beginAction();
  tree.completeAction('🟢 Bash(echo hi)', 3);
  assert.equal(stripAnsi(output[output.length - 1]), '├── [2] 🖥️ Bash(echo hi) · 3ms');

  tree.finish('Semua langkah tuntas');
  assert.ok(stripAnsi(output[output.length - 1]).includes('Semua langkah tuntas'));
});

test('WorkflowTree branch mode never loses buffered detail output when a turn is flushed', () => {
  const output: string[] = [];
  const tree = new WorkflowTree((line) => output.push(line), { compact: true, branch: true });
  tree.startStep('Menjalankan perintah');
  tree.beginAction();
  tree.log('🟢 Bash(sleep 5)');
  tree.log('sebagian output');
  tree.flush();
  const plain = output.map(stripAnsi);
  assert.ok(plain.some((l) => l.includes('sleep 5')), 'captured start line is not dropped');
  assert.ok(plain.some((l) => l.includes('sebagian output')), 'buffered detail is not dropped');
});

// ============================================================================
// 4. Live bottom activity tray (feedback §4)
// ============================================================================

test('ActivityTray renders icon + label + right-aligned elapsed time', () => {
  const tray = new ActivityTray({ now: () => 0 });
  tray.start('a', 'npm test', { icon: '🟢', startedAt: -45_000 });
  tray.start('b', 'Subagent (read_file) halo.md', { icon: '🟣', startedAt: -23_000 });

  const rows = tray.renderRows({ width: 40 }).map(stripAnsi);
  assert.equal(rows.length, 2, 'both runners fit the default 2-row tray');
  assert.ok(rows[0].startsWith('🟢 npm test'), `label first: ${rows[0]}`);
  assert.ok(rows[0].endsWith('45s'), `elapsed right-aligned: ${rows[0]}`);
  assert.ok(rows[1].startsWith('🟣 Subagent (read_file) halo.md'));
  assert.ok(rows[1].endsWith('23s'));
  for (const row of rows) assert.ok(visibleLength(row) <= 40, `row must fit: ${visibleLength(row)}`);
});

test('ActivityTray collapses overflow into a ctrl+o hint and expands on request', () => {
  const tray = new ActivityTray({ now: () => 0 });
  for (let i = 0; i < 4; i++) tray.start(`t${i}`, `task ${i}`, { startedAt: -1000 * (i + 1) });

  const collapsed = tray.renderRows({ width: 40, maxRows: 2 }).map(stripAnsi);
  assert.equal(collapsed.length, 3, '2 rows + overflow hint');
  assert.equal(collapsed[2], '-- 2 more, ctrl+o to expand');

  assert.equal(tray.toggleExpanded(), true);
  const expanded = tray.renderRows({ width: 40, maxRows: 2 }).map(stripAnsi);
  assert.equal(expanded.length, 4, 'every runner visible when expanded');
  assert.ok(!expanded.some((r) => r.includes('more, ctrl+o')), 'no hint while expanded');
});

test('ActivityTray emits change, drops finished runners and keeps timers on resync', () => {
  const tray = new ActivityTray({ now: () => 1000 });
  let changes = 0;
  tray.on('change', () => (changes += 1));

  tray.start('a', 'npm test', { icon: '🟢' });
  assert.equal(changes, 1);
  assert.equal(tray.size(), 1);

  // Background-process resync keeps the original start time (no timer reset).
  tray.syncGroup('proc', [{ id: 'proc:1', label: 'vite', startedAt: 0 }]);
  tray.syncGroup('proc', [{ id: 'proc:1', label: 'vite', startedAt: 0 }]);
  assert.equal(tray.size(), 2);
  assert.equal(tray.get('proc:1')?.startedAt, 0, 'resync must not restart the elapsed clock');

  assert.equal(tray.finish('a'), true);
  assert.equal(tray.size(), 1);
  assert.equal(tray.renderRows({ width: 40 }).length, 1);
  assert.equal(tray.finish('a'), false, 'finishing twice is a no-op');

  tray.clear();
  assert.deepEqual(tray.renderRows({ width: 40 }), [], 'nothing running → the tray reserves no rows');
});

test('formatTrayDuration keeps the tray counters short', () => {
  assert.equal(formatTrayDuration(0), '0ms');
  assert.equal(formatTrayDuration(450), '450ms');
  assert.equal(formatTrayDuration(23_000), '23s');
  assert.equal(formatTrayDuration(45_900), '45s');
  assert.equal(formatTrayDuration(64_000), '1m 4s');
});

test('formatActivityRow never exceeds the given width, even with a long label', () => {
  const row = formatActivityRow(
    { id: 'a', label: 'x'.repeat(200), icon: '🟢', group: 'tool', startedAt: 0 },
    10_000,
    30,
  );
  assert.ok(visibleLength(row) <= 30, `clamped row: ${visibleLength(row)}`);
  assert.ok(stripAnsi(row).endsWith('10s'), 'duration stays visible when the label is clipped');
});

// ============================================================================
// 5. Editor integration: panel + tray live inside one managed region
// ============================================================================

class FakeInput extends EventEmitter {
  isTTY = true;
  rawMode = false;
  setRawMode(mode: boolean): void {
    this.rawMode = mode;
  }
  resume(): void {}
  pause(): void {}
  setEncoding(): void {}
  send(keys: string): void {
    this.emit('data', keys);
  }
}

class FakeOutput {
  data = '';
  isTTY = true;
  columns = 46;
  rows = 24;
  write(text: string): boolean {
    this.data += text;
    return true;
  }
}

function panel(width?: number): string {
  return buildStatusPanel({
    width,
    model: 'gemini-3.8-flash',
    usedChars: 1000,
    budgetChars: 30_000,
    yoloMode: true,
  }).join('\n');
}

test('status panel + activity tray are drawn in place inside the live region (no scrollback)', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const tray = new ActivityTray({ now: () => 0 });
  tray.start('a', 'npm test', { icon: '🟢', startedAt: -45_000 });
  tray.start('b', 'Subagent (read_file) halo.md', { icon: '🟣', startedAt: -23_000 });
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(' '));

  try {
    const editor = new LineEditor(input as unknown as ReadStream, output as unknown as WriteStream);
    const line = editor.readLine({
      prompt: '› ',
      statusLine: (w?: number) => panel(w),
      activityRows: (w?: number) => tray.renderRows({ width: w }),
      onToggleTray: () => tray.toggleExpanded(),
      placeholder: '',
    });

    const frame = output.data;
    const plain = stripAnsi(frame);
    // Panel above, input in the middle, tray rows below it.
    assert.ok(plain.includes('gemini') && plain.includes('YOLO'), 'status panel drawn');
    assert.ok(plain.includes('/? for help, ask anything...'), 'panel hint row drawn');
    assert.ok(plain.indexOf('gemini') < plain.indexOf('›'), 'panel sits above the input line');
    assert.ok(plain.indexOf('›') < plain.indexOf('npm test'), 'tray sits below the input line');
    assert.ok(plain.includes('45s') && plain.includes('23s'), 'elapsed counters rendered');
    assert.deepEqual(logged, [], 'live rows are never emitted with console.log');

    // In-place update: the frame climbs over the status rows and clears the
    // whole region (tray rows included) with ESC[0J before redrawing.
    output.data = '';
    tray.finish('a');
    editor.refresh();
    const update = output.data;
    assert.match(update, /^\u001b\[5A\r\u001b\[0J/, 'climb over the panel then erase the region from the top');
    assert.ok(!stripAnsi(update).includes('npm test'), 'the finished runner row is gone');
    assert.ok(stripAnsi(update).includes('23s'), 'the remaining runner is redrawn');
    assert.ok(!update.includes('\n\n'), 'no blank rows are appended to scrollback');
    assert.deepEqual(logged, [], 'still no console.log from the live tray');

    // Ctrl+O reaches the tray toggle callback.
    output.data = '';
    input.send('\u000f');
    assert.equal(tray.expanded, true, 'Ctrl+O expands the tray');

    // Submitting erases the whole region (panel + tray) and commits one line.
    input.send('hi'); // typing redraws the region (its own frame)
    output.data = '';
    input.send('\r');
    const submit = output.data;
    assert.match(submit, /^\u001b\[5A\r\u001b\[0J/, 'submit climbs over the region');
    assert.equal((submit.match(/\n/g) ?? []).length, 1, 'exactly one newline — only the echo commits');
    assert.ok(!stripAnsi(submit).includes('npm test'), 'tray rows never settle in scrollback');
    assert.ok(!stripAnsi(submit).includes('/? for help'), 'panel never settles in scrollback');
    assert.equal(await line, 'hi');

    output.data = '';
    editor.close();
    assert.equal(output.data, '', 'closing after a commit redraws nothing');
  } finally {
    console.log = origLog;
  }
});

test('the live ticker repaints the tray counters and stops with the region', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  let now = 0;
  const tray = new ActivityTray({ now: () => now });
  tray.start('a', 'npm test', { startedAt: 0 });
  const editor = new LineEditor(input as unknown as ReadStream, output as unknown as WriteStream);
  editor.startAmbient({
    prompt: '› ',
    activityRows: (w?: number) => tray.renderRows({ width: w }),
    onSubmit: () => {},
    onInterrupt: () => {},
  });
  assert.ok(stripAnsi(output.data).includes('0ms'), 'first frame shows the initial counter');
  assert.ok(
    (editor as unknown as { liveTicker: unknown }).liveTicker !== null,
    'a ticker is running while tray rows are on screen',
  );
  now = 5000;
  editor.refresh();
  assert.ok(stripAnsi(output.data).includes('5s'), 'counter advanced in place');
  editor.stopAmbient();
  assert.equal((editor as unknown as { liveTicker: unknown }).liveTicker, null, 'ticker cleared with the region');
});

// ============================================================================
// 6. Agent integration: ├── history + live tray lifecycle
// ============================================================================

test('agent commits ├── action lines once per finished tool and reports the tray while running', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-uirevamp-'));
  setWorkspaceRoot(ws);
  writeFileSync(join(ws, 'PROGRESS.md'), '# progress\n', 'utf-8');

  let call = 0;
  const provider = {
    name: 'mock',
    isConfigured: true,
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    setModel() {},
    async chat(_messages: unknown[], options?: { onToken?: (t: string) => void }) {
      call += 1;
      if (call === 1) {
        const r = 'Mencari berkas.\n```tool\n{"tool":"glob","pattern":"PROGRESS.md"}\n```';
        for (const ch of r) options?.onToken?.(ch);
        return r;
      }
      if (call === 2) {
        const r = '```tool\n{"tool":"exec","command":"echo halo"}\n```';
        for (const ch of r) options?.onToken?.(ch);
        return r;
      }
      return 'PROGRESS.md ditemukan.';
    },
  };

  const traySeen: string[][] = [];
  const logged: string[] = [];
  const origLog = console.log;
  // Only console.log is captured: the workflow tree commits its action lines
  // through it, and stubbing process.stdout.write would swallow the test
  // runner's own protocol stream.
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(' '));

  try {
    const config = { ...DEFAULT_CONFIG, mode: 'beginner' as const };
    const ctx = new Context(config);
    const agent = new Agent(ctx, provider as never, config, async () => true, ws);
    agent.activityTray.on('change', () => {
      traySeen.push(agent.activityTray.renderRows({ width: 60, now: Date.now() }).map(stripAnsi));
    });

    const result = await agent.handleInstruction('cari PROGRESS.md lalu jalankan echo halo');
    assert.equal(result, 'PROGRESS.md ditemukan.');

    const plain = stripAnsi(logged.join('\n'));
    const actions = plain.match(/├── \[\d+\][^\n\r]*/g) ?? [];
    assert.equal(actions.length, 2, `one branch per tool, got: ${JSON.stringify(actions)}`);
    assert.ok(actions[0].includes('[1] 🔍 find PROGRESS.md'), actions[0]);
    assert.ok(actions[1].includes('[2] 🖥️ Bash(echo halo)'), actions[1]);
    assert.ok(!plain.includes('[1] 📖 Read'), 'no duplicate start lines');
    assert.ok(!/🟢 Glob\(/.test(plain), 'per-tool start line never committed on its own');

    // Tray: each tool appears while running and disappears the moment it ends.
    assert.ok(traySeen.some((rows) => rows.some((r) => r.includes('find PROGRESS.md'))), 'running glob visible in tray');
    assert.ok(traySeen.some((rows) => rows.some((r) => r.includes('echo halo'))), 'running exec visible in tray');
    assert.deepEqual(agent.activityTray.list(), [], 'tray is empty once the turn ends');
  } finally {
    console.log = origLog;
    rmSync(ws, { recursive: true, force: true });
  }
});
