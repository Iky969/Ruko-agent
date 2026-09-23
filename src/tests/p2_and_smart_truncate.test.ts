import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  terminalWidth,
  truncatePath,
  renderReasoningBox,
  formatActionLogLine,
  stripAnsi,
  visibleLength,
} from '../core/ui.js';
import { handleCommand, listCommands, buildHelpText } from '../agent/commands.js';
import { Context } from '../core/context.js';
import { DEFAULT_CONFIG } from '../types.js';
import { getWorkspaceRoot, setWorkspaceRoot } from '../agent/tools.js';

// ============================================================================
// TUGAS 8: terminalWidth priority (process.env.COLUMNS > stdout.columns)
// ============================================================================

test('terminalWidth prioritizes process.env.COLUMNS over process.stdout.columns', () => {
  const origEnvCols = process.env.COLUMNS;
  try {
    process.env.COLUMNS = '120';
    assert.equal(terminalWidth(), 120);

    process.env.COLUMNS = '42';
    assert.equal(terminalWidth(), 42);

    // Invalid non-numeric or <= 0 fall back to stdout.columns or default 80
    process.env.COLUMNS = '0';
    const fallback0 = terminalWidth();
    assert.equal(fallback0, process.stdout.columns ?? 80);

    process.env.COLUMNS = '-10';
    const fallbackNeg = terminalWidth();
    assert.equal(fallbackNeg, process.stdout.columns ?? 80);

    process.env.COLUMNS = 'invalid';
    const fallbackNan = terminalWidth();
    assert.equal(fallbackNan, process.stdout.columns ?? 80);
  } finally {
    if (origEnvCols !== undefined) {
      process.env.COLUMNS = origEnvCols;
    } else {
      delete process.env.COLUMNS;
    }
  }
});

// ============================================================================
// TUGAS 9: Perintah /context & /ctx consolidation
// ============================================================================

test('TUGAS 9: /context and /ctx are unified and show dashboard or update budget', async () => {
  const commands = listCommands();
  const ctxCmd = commands.find((c) => c.name === 'ctx');
  assert.ok(ctxCmd, '/ctx command must be registered');
  assert.ok(ctxCmd.aliases?.includes('context'), '/context must be an alias for /ctx');
  assert.ok(ctxCmd.aliases?.includes('budget'), '/budget must be an alias for /ctx');
  assert.ok(ctxCmd.aliases?.includes('status'), '/status must be an alias for /ctx');

  const config = { ...DEFAULT_CONFIG, maxContextChars: 40000 };
  const ctx = new Context(config);
  ctx.add('user', 'halo testing consolidation');

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

  const env: any = {
    ctx,
    config,
    llm: { model: 'deepseek-v4.1-flash', name: 'openai' },
    updateConfig: (patch: any) => Object.assign(config, patch),
    handle: { stop: () => {}, getSessionId: () => 'sess-p2', setSessionId: () => {} },
  };

  try {
    // 1. /context without args renders dashboard
    logs.length = 0;
    await handleCommand('/context', env);
    const ctxOut = logs.join('\n');
    assert.ok(ctxOut.includes('Context Budget & Status Aktif'));
    assert.ok(ctxOut.includes('40,000 karakter'));

    // 2. /context set 60k updates context limit
    logs.length = 0;
    await handleCommand('/context set 60k', env);
    assert.equal(config.maxContextChars, 60000);
    assert.ok(logs.join('\n').includes('60000 karakter'));

    // 3. /ctx set 75000 updates context limit
    logs.length = 0;
    await handleCommand('/ctx set 75000', env);
    assert.equal(config.maxContextChars, 75000);
    assert.ok(logs.join('\n').includes('75000 karakter'));

    // 4. Invalid input rejection
    logs.length = 0;
    await handleCommand('/context set abc', env);
    assert.ok(logs.join('\n').includes('Error: nilai limit context harus berupa angka positif'));
  } finally {
    console.log = origLog;
  }
});

// ============================================================================
// TUGAS 13: Terminal recovery documentation and crash tips
// ============================================================================

test('TUGAS 13: buildHelpText and formatFatalError contain terminal recovery commands', () => {
  const helpText = buildHelpText();
  assert.ok(
    helpText.includes('reset') || helpText.includes('stty sane'),
    'buildHelpText must mention terminal recovery commands (reset / stty sane)',
  );

  const indexSrc = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
  assert.ok(
    indexSrc.includes('reset') && indexSrc.includes('stty sane'),
    'src/index.ts must guide users to restore terminal via reset or stty sane in fatal error handler',
  );

  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
  assert.ok(
    readme.includes('stty sane') && readme.includes('reset'),
    'README.md must have terminal recovery section with reset and stty sane',
  );
});

// ============================================================================
// Usulan Baru: truncatePath (Smart Path Truncation)
// ============================================================================

test('truncatePath handles short paths without modification', () => {
  const shortPath = 'src/index.ts';
  assert.equal(truncatePath(shortPath, 40), 'src/index.ts');
});

test('truncatePath makes paths relative to workspace when inside cwd', () => {
  const ws = getWorkspaceRoot();
  const absPath = join(ws, 'src', 'core', 'ui.ts');
  const result = truncatePath(absPath, 50, { cwd: ws });
  assert.equal(result, 'src/core/ui.ts');
});

test('truncatePath performs middle truncation for deeply nested paths', () => {
  const longPath = 'packages/core/src/submodules/controllers/authentication_handler.ts';
  const truncated = truncatePath(longPath, 42);
  assert.ok(truncated.includes('...'), 'must contain ellipsis');
  assert.ok(truncated.endsWith('authentication_handler.ts'), 'must preserve filename');
  assert.ok(truncated.startsWith('packages/'), 'must preserve root folder');
  assert.ok(truncated.length <= 42, `length ${truncated.length} must be <= 42`);
});

test('truncatePath falls back to basename on narrow terminals (< 45 cols)', () => {
  const longPath = 'src/components/forms/login/validation/rules/email_validator.ts';
  const result = truncatePath(longPath, 40, { terminalCols: 40 });
  assert.equal(result, 'email_validator.ts');

  // When terminal width is wide (>= 45), middle truncation is used
  const wideResult = truncatePath(longPath, 30, { terminalCols: 80 });
  assert.ok(wideResult.includes('...'));
  assert.ok(wideResult.endsWith('email_validator.ts'));
});

test('truncatePath handles edge cases: root file, single segment, or very short maxLen', () => {
  assert.equal(truncatePath('file.ts', 20), 'file.ts');
  assert.equal(truncatePath('', 20), '');

  const path = 'a/b/c/d/very_long_file_name_that_exceeds_budget.ts';
  const res = truncatePath(path, 15);
  assert.ok(res.length <= 15 || res === 'very_long_file_name_that_exceeds_budget.ts');
});

test('formatActionLogLine integrates truncatePath and inline duration (Xms)', () => {
  const logMsg = '🟢 Read(very/deeply/nested/directory/structure/inside/project/config_loader.ts)';
  const formatted = formatActionLogLine(1, logMsg, 25);
  assert.ok(formatted !== null);
  const plain = stripAnsi(formatted!);
  assert.ok(plain.startsWith('├── [1] 📖 Read '));
  assert.ok(plain.endsWith('(25ms)'));
  assert.ok(!plain.includes(' · 25ms'), 'must not use old bullet dot format');
});

// ============================================================================
// Usulan Baru: renderReasoningBox (Framed Reasoning Box)
// ============================================================================

test('renderReasoningBox renders framed box with proper borders and width', () => {
  const reasoning = 'Saya sedang memeriksa file ui.ts untuk memvalidasi fungsi truncatePath.';
  const box = renderReasoningBox(reasoning, 70);
  const plain = stripAnsi(box);
  const lines = plain.split('\n');

  assert.ok(lines[0].startsWith('┌─ Reasoning ──'));
  assert.ok(lines[lines.length - 1].startsWith('└─'));
  for (let i = 1; i < lines.length - 1; i++) {
    assert.ok(lines[i].startsWith('│ '));
  }

  for (const line of lines) {
    assert.ok(visibleLength(line) <= 70, `line exceeds max width: "${line}" (${visibleLength(line)})`);
  }

  // Multiline wrapping
  const longReasoning = 'Langkah pertama adalah membaca file. Langkah kedua adalah membedah implementasi. Langkah ketiga adalah membuat unit test.';
  const wrappedBox = renderReasoningBox(longReasoning, 50);
  const wrappedLines = stripAnsi(wrappedBox).split('\n');
  assert.ok(wrappedLines.length >= 3, 'long reasoning must wrap across multiple inner lines');
});

test('renderReasoningBox returns empty string for empty or whitespace reasoning', () => {
  assert.equal(renderReasoningBox(''), '');
  assert.equal(renderReasoningBox('   \n  \t '), '');
});
