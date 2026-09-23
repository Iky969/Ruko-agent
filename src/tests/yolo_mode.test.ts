import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleCommand, listCommands, matchCommands } from '../agent/commands.js';
import { runToolCall } from '../agent/tools.js';
import { detectRisk } from '../core/approval.js';
import { buildStatusBar, stripAnsi, visibleLength } from '../core/ui.js';
import { AgentConfig, DEFAULT_CONFIG } from '../types.js';

test('/yolo command is registered in command registry and autocomplete', () => {
  const commands = listCommands();
  const yoloCmd = commands.find((c) => c.name === 'yolo');
  assert.ok(yoloCmd, '/yolo command must be registered');
  assert.ok(yoloCmd.help.toLowerCase().includes('yolo'));
  assert.equal(yoloCmd.hint, 'on | off');

  const matched = matchCommands('/yo').map((c) => c.name);
  assert.ok(matched.includes('yolo'), 'autocomplete /yo must include yolo');
});

test('/yolo toggles approval mode ON and OFF with exact terminal messages', async () => {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));

  try {
    const config: AgentConfig = { ...DEFAULT_CONFIG, approvalEnabled: true };
    let savedPatch: any = null;
    const env: any = {
      config,
      updateConfig: (patch: Partial<AgentConfig>) => {
        savedPatch = patch;
        Object.assign(config, patch);
      },
    };

    // 1. Initial state: approvalEnabled is true. Running /yolo toggles it ON.
    logs.length = 0;
    await handleCommand('/yolo', env);
    assert.equal(config.approvalEnabled, false, 'approvalEnabled should become false');
    assert.equal(savedPatch?.approvalEnabled, false);
    const out1 = stripAnsi(logs.join('\n'));
    assert.ok(
      out1.includes('⚡ YOLO mode ON: semua perintah tool akan disetujui otomatis.'),
      `expected YOLO mode ON message, got: ${out1}`,
    );

    // 2. Running /yolo again toggles it OFF.
    logs.length = 0;
    await handleCommand('/yolo', env);
    assert.equal(config.approvalEnabled, true, 'approvalEnabled should become true');
    assert.equal(savedPatch?.approvalEnabled, true);
    const out2 = stripAnsi(logs.join('\n'));
    assert.ok(
      out2.includes('🛡️ YOLO mode OFF: kembali ke mode verifikasi manual.'),
      `expected YOLO mode OFF message, got: ${out2}`,
    );

    // 3. Explicit /yolo on
    logs.length = 0;
    await handleCommand('/yolo on', env);
    assert.equal(config.approvalEnabled, false);
    assert.ok(stripAnsi(logs.join('\n')).includes('⚡ YOLO mode ON'));

    // 4. Explicit /yolo off
    logs.length = 0;
    await handleCommand('/yolo off', env);
    assert.equal(config.approvalEnabled, true);
    assert.ok(stripAnsi(logs.join('\n')).includes('🛡️ YOLO mode OFF'));

    // 5. Invalid argument
    logs.length = 0;
    await handleCommand('/yolo maybe', env);
    assert.equal(config.approvalEnabled, true, 'config should not change on invalid arg');
    assert.ok(stripAnsi(logs.join('\n')).includes('Gunakan: /yolo [on|off]'));
  } finally {
    console.log = origLog;
  }
});

test('Tool requiring approval (delete_file) executes directly without prompt when YOLO is ON', async () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-yolo-tool-'));
  const testFile = join(tmpWs, 'target.txt');
  writeFileSync(testFile, 'file to delete\n', 'utf-8');

  let confirmCalled = false;
  const mockConfirm = async () => {
    confirmCalled = true;
    return true;
  };

  try {
    // A. Normal mode (approvalEnabled = true): confirm MUST be called
    confirmCalled = false;
    const normalRes = JSON.parse(
      await runToolCall(
        { tool: 'delete_file', path: 'target.txt' },
        {
          workspaceRoot: tmpWs,
          config: { ...DEFAULT_CONFIG, approvalEnabled: true },
          confirm: mockConfirm,
        },
      ),
    );
    assert.equal(confirmCalled, true, 'confirm should be called in normal mode');
    assert.equal(normalRes.ok, true, 'delete_file should return ok in normal mode');

    // Re-create file for YOLO test
    writeFileSync(testFile, 'file to delete 2\n', 'utf-8');

    // B. YOLO mode (approvalEnabled = false): confirm must NOT be called at all
    confirmCalled = false;
    const yoloRes = JSON.parse(
      await runToolCall(
        { tool: 'delete_file', path: 'target.txt' },
        {
          workspaceRoot: tmpWs,
          config: { ...DEFAULT_CONFIG, approvalEnabled: false },
          confirm: async () => {
            confirmCalled = true;
            throw new Error('confirm should not be invoked in YOLO mode!');
          },
        },
      ),
    );
    assert.equal(confirmCalled, false, 'confirm must NOT be called when YOLO mode is active');
    assert.equal(yoloRes.ok, true);
    assert.equal(yoloRes.path, 'target.txt');
    assert.ok(!existsSync(testFile), 'file must be deleted directly in YOLO mode');
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('Shell execution in YOLO mode auto-approves dangerous commands but blocks catastrophic ones', async () => {
  const yoloConfig: AgentConfig = { ...DEFAULT_CONFIG, approvalEnabled: false };
  const normalConfig: AgentConfig = { ...DEFAULT_CONFIG, approvalEnabled: true };

  // 1. Dangerous command (e.g. rm a file)
  const dangerVerdictNormal = detectRisk('rm temp.txt', normalConfig);
  assert.equal(dangerVerdictNormal.risk, 'dangerous', 'should be dangerous in normal mode');

  const dangerVerdictYolo = detectRisk('rm temp.txt', yoloConfig);
  assert.equal(dangerVerdictYolo.risk, 'none', 'should be auto-approved (risk: none) in YOLO mode');

  // 2. Catastrophic command (e.g. rm -rf /)
  const blockedVerdictYolo = detectRisk('rm -rf /', yoloConfig);
  assert.equal(blockedVerdictYolo.risk, 'blocked', 'catastrophic command must remain blocked even in YOLO mode');
});

test('Bottom status bar renders [YOLO] badge when yoloMode is active and fits viewport', () => {
  // 1. Wide terminal
  const wideNormal = stripAnsi(
    buildStatusBar({ model: 'gpt-4o', usedChars: 1000, budgetChars: 20000, width: 80, yoloMode: false }),
  );
  assert.ok(!wideNormal.includes('[YOLO]'), 'normal status bar must not have [YOLO]');

  const wideYolo = stripAnsi(
    buildStatusBar({ model: 'gpt-4o', usedChars: 1000, budgetChars: 20000, width: 80, yoloMode: true }),
  );
  assert.ok(wideYolo.includes('[YOLO]'), 'YOLO status bar must have [YOLO] badge');

  // 2. Narrow terminal (40 cols, Termux mobile)
  const narrowYolo = buildStatusBar({
    model: 'gpt-4o',
    usedChars: 1000,
    budgetChars: 20000,
    width: 40,
    yoloMode: true,
  });
  const strippedNarrow = stripAnsi(narrowYolo);
  assert.ok(strippedNarrow.includes('[YOLO]'), 'narrow status bar should preserve [YOLO]');
  assert.ok(
    visibleLength(narrowYolo) <= 39,
    `narrow status bar visible length (${visibleLength(narrowYolo)}) must be <= 39`,
  );
});
