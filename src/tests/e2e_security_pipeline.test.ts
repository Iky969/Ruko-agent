/**
 * e2e_security_pipeline.test.ts — E2E CLI Integration Harness (ADIT.md §4.3, UCUP.md §4.3, Blueprint §4)
 *
 * Menguji siklus hidup lengkap CLI Ruko v2.0.0 dari entrypoint biner:
 *  1. Bootstrap proses biner via `dist/index.js` dengan direktori HOME terisolasi.
 *  2. Verifikasi state session otoritatif di ~/.ruko/sessions/<sessionId>/state.json dengan hak akses 0600.
 *  3. Verifikasi fail-safe Plan Mode deny-by-default pada mutasi berkas di level DispatcherGate dan Agent.
 *  4. Verifikasi deterministik resume reset mode kembali ke 'plan' di RAM dan disk.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { bootstrapSecurityPipeline } from '../core/securityPipeline.js';
import { saveHostState, loadHostState } from '../core/state/hostState.js';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { AgentConfig, ContextMessage, DEFAULT_CONFIG } from '../types.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';

class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly isConfigured = true;
  model = 'scripted-model';
  private calls = 0;
  constructor(private readonly replies: string[]) {}
  setModel(model: string): void {
    this.model = model;
  }
  async chat(_messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    options?.onToken?.(reply);
    return reply;
  }
}

test('E2E Security Pipeline: Lifecycle startup, 0600 authoritative state, dan session isolation', async () => {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ruko-e2e-home-'));
  const tmpWs = await fs.mkdtemp(path.join(os.tmpdir(), 'ruko-e2e-ws-'));

  try {
    // Siapkan config.json dummy di workspace agar tidak memicu wizard
    const dotRuko = path.join(tmpWs, '.ruko');
    await fs.mkdir(dotRuko, { recursive: true });
    await fs.writeFile(
      path.join(dotRuko, 'config.json'),
      JSON.stringify({
        apiKey: 'test-key',
        baseUrl: 'http://127.0.0.1:19999/v1',
        model: 'test-model',
        approvalEnabled: true,
      }),
      { mode: 0o600 },
    );

    // Jalankan biner CLI Ruko dengan stdin pipe
    const binPath = path.resolve('dist/index.js');
    const child = spawn(process.execPath, [binPath, '--trust-folder'], {
      cwd: tmpWs,
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        HOMEDRIVE: path.parse(tmpHome).root,
        HOMEPATH: tmpHome.slice(path.parse(tmpHome).root.length),
        NODE_ENV: 'test',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    // Beri waktu proses untuk bootstrap pipeline (FileLock -> HostState 0600)
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Kirim perintah exit ke REPL
    child.stdin.write('/exit\n');
    child.stdin.end();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);

      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // 1. Verifikasi direktori sesi dibuat di $HOME/.ruko/sessions/
    const sessionsDir = path.join(tmpHome, '.ruko', 'sessions');
    assert.ok(fsSync.existsSync(sessionsDir), 'Direktori sessions harus terbuat');

    const sessions = await fs.readdir(sessionsDir);
    assert.ok(sessions.length >= 1, 'Harus ada minimal satu sesi dibuat');

    const sessionPath = path.join(sessionsDir, sessions[0]);
    const stateFile = path.join(sessionPath, 'state.json');
    assert.ok(fsSync.existsSync(stateFile), 'state.json harus terbuat');

    // 2. Verifikasi hak akses berkas 0600 (POSIX)
    if (process.platform !== 'win32') {
      const st = await fs.stat(stateFile);
      assert.equal(st.mode & 0o777, 0o600, 'state.json wajib memiliki izin 0600');
    }

    // 3. Verifikasi konten state berstatus 'plan' mode secara default
    const content = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.equal(content.mode, 'plan', 'Sesi awal wajib dimulai dalam Plan Mode');
    assert.equal(content.sessionId, sessions[0], 'sessionId harus sesuai dengan direktori sesi');
  } finally {
    await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tmpWs, { recursive: true, force: true }).catch(() => {});
  }
});

test('E2E Security Pipeline: Dispatcher Gate memblokir mutasi disk saat Plan Mode aktif', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruko-e2e-gate-'));
  const hostDir = path.join(tmpDir, 'sessions');
  await fs.mkdir(hostDir, { recursive: true });

  const prevEnv = process.env.RUKO_HOST_STATE_DIR;
  process.env.RUKO_HOST_STATE_DIR = hostDir;

  try {
    const sessionId = 'e2e-session-gate';
    const pipeline = await bootstrapSecurityPipeline({
      sessionId,
      workspaceRoot: tmpDir,
      resume: false,
      isTTY: false,
    });

    try {
      assert.equal(pipeline.hostState.mode, 'plan');

      // 1. Evaluasi DispatcherGate terpadu via pipeline
      const writeDecision = await pipeline.evaluateToolCall('write_file', { path: 'evil.txt' }, false);
      assert.equal(writeDecision.allowed, false, 'Mutasi dilarang saat Plan Mode');
      assert.match(writeDecision.reason || '', /Plan Mode aktif/i);

      // 2. Evaluasi Agent utuh
      const config: AgentConfig = { ...DEFAULT_CONFIG, approvalEnabled: false };
      const ctx = new Context(config);
      const llm = new ScriptedProvider([
        '```tool\n{"tool": "write_file", "path": "evil.txt", "content": "malicious"}\n```',
      ]);
      const agent = new Agent(ctx, llm, config, null, tmpDir);
      agent.setHostState(pipeline.hostState);
      agent.setScopeAmendmentManager(pipeline.scopeManager);

      await agent.handleInstruction('Buat file evil.txt');

      const messages = ctx.toJSON();
      const rejection = messages.find(
        (m: ContextMessage) => typeof m.content === 'string' && m.content.toLowerCase().includes('plan mode aktif'),
      );
      assert.ok(rejection, 'Eksekusi agent wajib mencatat penolakan Plan Mode');
      assert.equal(fsSync.existsSync(path.join(tmpDir, 'evil.txt')), false, 'File dilarang terbuat di disk');
    } finally {
      await pipeline.releaseLock();
    }
  } finally {
    if (prevEnv !== undefined) {
      process.env.RUKO_HOST_STATE_DIR = prevEnv;
    } else {
      delete process.env.RUKO_HOST_STATE_DIR;
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('E2E Security Pipeline: Fail-safe session resume mereset mode secara deterministik ke plan', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruko-e2e-resume-'));
  const hostDir = path.join(tmpDir, 'sessions');
  await fs.mkdir(hostDir, { recursive: true });

  const prevEnv = process.env.RUKO_HOST_STATE_DIR;
  process.env.RUKO_HOST_STATE_DIR = hostDir;

  try {
    const sessionId = 'e2e-session-resume';

    // 1. Sesi 1: Inisialisasi dan ubah mode ke 'act'
    const p1 = await bootstrapSecurityPipeline({
      sessionId,
      workspaceRoot: tmpDir,
      resume: false,
      isTTY: false,
    });

    p1.hostState.mode = 'act';
    await saveHostState(p1.hostState);
    await p1.releaseLock();

    // Verifikasi state di disk tersimpan sebagai 'act'
    const rawDisk = await loadHostState(sessionId, { resume: false });
    assert.equal(rawDisk.mode, 'act', 'State sebelum resume tersimpan sebagai act di disk');

    // 2. Sesi 2: Resume sesi lama
    const p2 = await bootstrapSecurityPipeline({
      sessionId,
      workspaceRoot: tmpDir,
      resume: true,
      isTTY: false,
    });

    try {
      // Verifikasi reset deterministik ke 'plan' di RAM dan disk
      assert.equal(p2.hostState.mode, 'plan', 'Resume sesi wajib reset mode ke plan di memori');

      const resumedDisk = await loadHostState(sessionId, { resume: false });
      assert.equal(resumedDisk.mode, 'plan', 'Resume sesi wajib tersimpan atomik sebagai plan di disk');
    } finally {
      await p2.releaseLock();
    }
  } finally {
    if (prevEnv !== undefined) {
      process.env.RUKO_HOST_STATE_DIR = prevEnv;
    } else {
      delete process.env.RUKO_HOST_STATE_DIR;
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
