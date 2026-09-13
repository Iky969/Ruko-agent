import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  defaultProcessManager,
  redactCredentials,
  CREDENTIAL_REDACT_REGEX,
} from '../agent/processManager.js';
import { runToolCall, setWorkspaceRoot } from '../agent/tools.js';
import { DEFAULT_CONFIG } from '../types.js';

function inTempWorkspace<T>(fn: (ws: string) => Promise<T> | T): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-procsec-'));
  setWorkspaceRoot(ws);
  const prev = process.cwd();
  process.chdir(ws);
  return Promise.resolve(fn(ws)).finally(async () => {
    defaultProcessManager.reset();
    setWorkspaceRoot(null);
    process.chdir(prev);
    rmSync(ws, { recursive: true, force: true });
  });
}

test('start_process spawns detached process and returns process ID and PID', async () => {
  await inTempWorkspace(async (ws) => {
    const resRaw = await runToolCall(
      { tool: 'start_process', command: 'node -e "setInterval(() => {}, 1000)"' },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
    );
    const res = JSON.parse(resRaw);
    assert.equal(res.ok, true);
    assert.ok(res.process_id.startsWith('proc_'));
    assert.ok(typeof res.pid === 'number' && res.pid > 0);
    assert.equal(res.status, 'running');

    // Cleanup
    await defaultProcessManager.stopProcess(res.process_id);
  });
});

test('start_process requires Approval Gate and is rejected when user says No', async () => {
  await inTempWorkspace(async (ws) => {
    let confirmCalled = false;
    const confirm = async () => {
      confirmCalled = true;
      return false; // User denies
    };

    const resRaw = await runToolCall(
      { tool: 'start_process', command: 'node -e "console.log(1)"' },
      { confirm, workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: true } },
    );
    const res = JSON.parse(resRaw);
    assert.ok(confirmCalled);
    assert.ok(res.error.includes('Persetujuan ditolak'));
    assert.equal(defaultProcessManager.getActiveProcesses().length, 0);
  });
});

test('start_process succeeds when user confirms Approval Gate', async () => {
  await inTempWorkspace(async (ws) => {
    let promptSeen = '';
    const confirm = async (cmd: string) => {
      promptSeen = cmd;
      return true; // User approves
    };

    const resRaw = await runToolCall(
      { tool: 'start_process', command: 'node -e "setInterval(() => {}, 1000)"' },
      { confirm, workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: true } },
    );
    const res = JSON.parse(resRaw);
    assert.equal(res.ok, true);
    assert.ok(promptSeen.includes('start_process'));

    await defaultProcessManager.stopProcess(res.process_id);
  });
});

test('start_process enforces limit of 3 concurrent active processes', async () => {
  await inTempWorkspace(async (ws) => {
    const p1Raw = await runToolCall(
      { tool: 'start_process', command: 'node -e "setInterval(() => {}, 1000)"' },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
    );
    const p1 = JSON.parse(p1Raw);

    const p2Raw = await runToolCall(
      { tool: 'start_process', command: 'node -e "setInterval(() => {}, 1000)"' },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
    );
    const p2 = JSON.parse(p2Raw);

    const p3Raw = await runToolCall(
      { tool: 'start_process', command: 'node -e "setInterval(() => {}, 1000)"' },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
    );
    const p3 = JSON.parse(p3Raw);

    assert.equal(defaultProcessManager.getActiveProcesses().length, 3);

    // 4th attempt should be rejected with clear message listing active processes
    const p4Raw = await runToolCall(
      { tool: 'start_process', command: 'node -e "setInterval(() => {}, 1000)"' },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
    );
    const p4 = JSON.parse(p4Raw);
    assert.ok(p4.error.includes('batas maksimal 3 proses aktif tercapai'));
    assert.ok(p4.error.includes(p1.process_id));
    assert.ok(p4.error.includes(p2.process_id));
    assert.ok(p4.error.includes(p3.process_id));
    assert.ok(p4.error.includes('stop_process'));

    // Stop one process, then 4th attempt succeeds
    await defaultProcessManager.stopProcess(p1.process_id);
    assert.equal(defaultProcessManager.getActiveProcesses().length, 2);

    const p5Raw = await runToolCall(
      { tool: 'start_process', command: 'node -e "setInterval(() => {}, 1000)"' },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
    );
    const p5 = JSON.parse(p5Raw);
    assert.equal(p5.ok, true);

    await defaultProcessManager.stopProcess(p2.process_id);
    await defaultProcessManager.stopProcess(p3.process_id);
    await defaultProcessManager.stopProcess(p5.process_id);
  });
});

test('start_process rejects cwd outside workspace boundary', async () => {
  await inTempWorkspace(async (ws) => {
    const resRaw = await runToolCall(
      { tool: 'start_process', command: 'echo 1', cwd: '/tmp' },
      { workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
    );
    const res = JSON.parse(resRaw);
    assert.ok(res.error.includes('di luar working directory'));
  });
});

test('start_process is blocked in plan mode, while read_process_logs and get_status are allowed', async () => {
  await inTempWorkspace(async (ws) => {
    const startResRaw = await runToolCall(
      { tool: 'start_process', command: 'echo 1' },
      { planMode: true, workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: false } },
    );
    const startRes = JSON.parse(startResRaw);
    assert.ok(startRes.error.includes('plan mode aktif: tool "start_process" diblok'));

    // start a process outside plan mode
    const runningProc = defaultProcessManager.startProcess('node -e "console.log(123)"', ws);

    // read_process_logs allowed in plan mode
    const logsResRaw = await runToolCall(
      { tool: 'read_process_logs', process_id: runningProc.id },
      { planMode: true, workspaceRoot: ws },
    );
    const logsRes = JSON.parse(logsResRaw);
    assert.equal(logsRes.ok, true);

    // get_status allowed in plan mode
    const statusResRaw = await runToolCall(
      { tool: 'get_status', process_id: runningProc.id },
      { planMode: true, workspaceRoot: ws },
    );
    const statusRes = JSON.parse(statusResRaw);
    assert.equal(statusRes.ok, true);

    await defaultProcessManager.stopProcess(runningProc.id);
  });
});

test('read_process_logs maintains ring buffer capped at 100 lines', async () => {
  await inTempWorkspace(async (ws) => {
    // Generate 150 lines of output
    const cmd = 'node -e "for(let i=1; i<=150; i++) console.log(\'line \' + i)"';
    const proc = defaultProcessManager.startProcess(cmd, ws);

    // Wait for output to complete
    await new Promise((r) => setTimeout(r, 500));

    const logs = defaultProcessManager.readProcessLogs(proc.id);
    assert.ok(logs);
    assert.equal(logs.length, 100);
    // Oldest 50 lines dropped, starting from line 51
    assert.equal(logs[0], '[stdout] line 51');
    assert.equal(logs[99], '[stdout] line 150');

    await defaultProcessManager.stopProcess(proc.id);
  });
});

test('read_process_logs redacts credentials with baseline regex pattern', async () => {
  await inTempWorkspace(async (ws) => {
    const cmd =
      'node -e "console.log(\'api_key: secret_123\\ntoken=token_abc\\npassword: pass123\\nsecret = my_secret\\nauthorization: auth_token_val\')' +
      '; console.error(\'API-KEY: err_secret\')"';
    const proc = defaultProcessManager.startProcess(cmd, ws);

    await new Promise((r) => setTimeout(r, 400));

    const resRaw = await runToolCall(
      { tool: 'read_process_logs', process_id: proc.id },
      { workspaceRoot: ws },
    );
    const res = JSON.parse(resRaw);
    assert.equal(res.ok, true);
    assert.equal(res.lines, 6);

    const logText = res.logs.join('\n');
    assert.ok(logText.includes('api_key: [REDACTED]'));
    assert.ok(logText.includes('token=[REDACTED]'));
    assert.ok(logText.includes('password: [REDACTED]'));
    assert.ok(logText.includes('secret = [REDACTED]'));
    assert.ok(logText.includes('authorization: [REDACTED]'));
    assert.ok(logText.includes('[stderr] API-KEY: [REDACTED]'));

    // Verify secret values are not leaked
    assert.ok(!logText.includes('secret_123'));
    assert.ok(!logText.includes('token_abc'));
    assert.ok(!logText.includes('pass123'));
    assert.ok(!logText.includes('my_secret'));
    assert.ok(!logText.includes('auth_token_val'));
    assert.ok(!logText.includes('err_secret'));

    await defaultProcessManager.stopProcess(proc.id);
  });
});

test('redactCredentials helper functions as best-effort redaction', () => {
  assert.equal(
    redactCredentials('Connect with api_key: 123456 to database'),
    'Connect with api_key: [REDACTED] to database',
  );
  assert.equal(
    redactCredentials('token=XYZ-999 and secret : ultra_secret'),
    'token=[REDACTED] and secret : [REDACTED]',
  );
  assert.equal(
    redactCredentials('Authorization:Bearer_9988'),
    'Authorization:[REDACTED]',
  );
  assert.equal(
    redactCredentials('normal output with no sensitive key'),
    'normal output with no sensitive key',
  );
});

test('get_status returns deterministic running, exited, and stale states', async () => {
  await inTempWorkspace(async (ws) => {
    // 1. Running state
    const runningProc = defaultProcessManager.startProcess(
      'node -e "setInterval(() => {}, 1000)"',
      ws,
    );
    const s1Raw = await runToolCall(
      { tool: 'get_status', process_id: runningProc.id },
      { workspaceRoot: ws },
    );
    const s1 = JSON.parse(s1Raw);
    assert.equal(s1.ok, true);
    assert.equal(s1.status, 'running');
    assert.equal(s1.exitCode, null);

    // 2. Exited state
    const exitProc = defaultProcessManager.startProcess('node -e "process.exit(7)"', ws);
    await new Promise((r) => setTimeout(r, 400));
    const s2Raw = await runToolCall(
      { tool: 'get_status', process_id: exitProc.id },
      { workspaceRoot: ws },
    );
    const s2 = JSON.parse(s2Raw);
    assert.equal(s2.ok, true);
    assert.equal(s2.status, 'exited');
    assert.equal(s2.exitCode, 7);

    // 3. Stale state (e.g. process record restored from session whose PID is no longer alive)
    defaultProcessManager.registerMockProcess({
      id: 'proc_stale_test',
      pid: 99999999, // Dead PID
      command: 'npm run dev',
      cwd: ws,
      startTime: Date.now() - 60000,
      child: null,
      exitCode: null,
      exitSignal: null,
      status: 'running',
      logs: [],
    });
    const s3Raw = await runToolCall(
      { tool: 'get_status', process_id: 'proc_stale_test' },
      { workspaceRoot: ws },
    );
    const s3 = JSON.parse(s3Raw);
    assert.equal(s3.ok, true);
    assert.equal(s3.status, 'stale');

    // 4. Unknown process returns clear error
    const s4Raw = await runToolCall(
      { tool: 'get_status', process_id: 'proc_nonexistent' },
      { workspaceRoot: ws },
    );
    const s4 = JSON.parse(s4Raw);
    assert.ok(s4.error.includes('tidak ditemukan'));

    await defaultProcessManager.stopProcess(runningProc.id);
  });
});

test('stop_process terminates with SIGTERM, does not require approval gate', async () => {
  await inTempWorkspace(async (ws) => {
    const proc = defaultProcessManager.startProcess(
      'node -e "setInterval(() => {}, 1000)"',
      ws,
    );

    let confirmHookCalled = false;
    const confirm = async () => {
      confirmHookCalled = true;
      return true;
    };

    // stop_process must NOT invoke confirm hook even if approvalEnabled: true
    const resRaw = await runToolCall(
      { tool: 'stop_process', process_id: proc.id },
      { confirm, workspaceRoot: ws, config: { ...DEFAULT_CONFIG, approvalEnabled: true } },
    );
    const res = JSON.parse(resRaw);
    assert.equal(confirmHookCalled, false, 'stop_process must not trigger approval gate');
    assert.equal(res.ok, true);
    assert.equal(res.status, 'exited');

    const status = defaultProcessManager.getProcessStatus(proc.id);
    assert.equal(status?.status, 'exited');
  });
});

test('stop_process falls back to SIGKILL when process ignores SIGTERM after timeout', async () => {
  await inTempWorkspace(async (ws) => {
    // Child process traps and ignores SIGTERM
    const trapScript = `
      process.on('SIGTERM', () => { /* ignore */ });
      setInterval(() => {}, 1000);
    `;
    const proc = defaultProcessManager.startProcess(`node -e "${trapScript.replace(/\n/g, ' ')}"`, ws);

    // Stop with 200ms timeout for fast testing of SIGKILL fallback
    const res = await defaultProcessManager.stopProcess(proc.id, 200);
    assert.equal(res.ok, true);
    assert.equal(res.status, 'exited');

    // Verify process is terminated
    let isAlive = true;
    try {
      process.kill(proc.pid, 0);
    } catch {
      isAlive = false;
    }
    assert.equal(isAlive, false, 'process must be killed by SIGKILL');
  });
});

test('lifecycle cleanup hook terminates child processes on exit/signal cleanup', async () => {
  await inTempWorkspace(async (ws) => {
    // Verify listeners are registered on process
    const exitListeners = process.listeners('exit');
    const sigintListeners = process.listeners('SIGINT');
    const sigtermListeners = process.listeners('SIGTERM');

    assert.ok(exitListeners.length > 0, 'exit listener must be registered');
    assert.ok(sigintListeners.length > 0, 'SIGINT listener must be registered');
    assert.ok(sigtermListeners.length > 0, 'SIGTERM listener must be registered');

    // Start a running child process
    const proc = defaultProcessManager.startProcess(
      'node -e "setInterval(() => {}, 1000)"',
      ws,
    );
    assert.equal(proc.status, 'running');

    // Simulate lifecycle cleanup (invoking cleanupAllSync as called by exit/SIGINT/SIGTERM handlers)
    defaultProcessManager.cleanupAllSync();

    assert.equal(proc.status, 'exited');

    await new Promise((r) => setTimeout(r, 200));

    let isAlive = true;
    try {
      process.kill(proc.pid, 0);
    } catch {
      isAlive = false;
    }
    assert.equal(isAlive, false, 'child process should be killed by cleanup hook');
  });
});
