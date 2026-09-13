import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertNotSensitivePath,
  detectSensitiveFileAccessInExec,
  isSensitiveEnvCommand,
  isSensitivePath,
  runToolCall,
  setWorkspaceRoot,
} from '../agent/tools.js';
import { codeSearchTool, globTool, readFileTool } from '../agent/filetools.js';
import { runSubagent } from '../agent/subagent.js';
import { loadConfig } from '../core/config.js';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { LLMProvider, ChatOptions } from '../agent/llm.js';
import { AgentConfig, ContextMessage, DEFAULT_CONFIG } from '../types.js';

function inTempWorkspace<T>(fn: (ws: string) => Promise<T> | T): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-sens-'));
  setWorkspaceRoot(ws);
  const prev = process.cwd();
  process.chdir(ws);
  return Promise.resolve(fn(ws)).finally(() => {
    setWorkspaceRoot(null);
    process.chdir(prev);
    rmSync(ws, { recursive: true, force: true });
  });
}

/** Scripted mock LLM provider for subagent and agent testing. */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly isConfigured = true;
  model = 'scripted-model';
  private callIdx = 0;
  constructor(private readonly replies: string[]) {}
  setModel(model: string): void {
    this.model = model;
  }
  async chat(_messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    const reply = this.replies[Math.min(this.callIdx, this.replies.length - 1)];
    this.callIdx += 1;
    options?.onToken?.(reply);
    return reply;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bagian A: Unit test isSensitivePath & assertNotSensitivePath
// ─────────────────────────────────────────────────────────────────────────────

test('isSensitivePath & assertNotSensitivePath: mendeteksi path sensitif dan variasi casing/relative/absolute', async () => {
  await inTempWorkspace(async (ws) => {
    // 1. .ruko/config.json
    assert.equal(isSensitivePath('.ruko/config.json', ws), true);
    assert.equal(isSensitivePath('./.ruko/config.json', ws), true);
    assert.equal(isSensitivePath(join(ws, '.ruko', 'config.json'), ws), true);
    assert.equal(isSensitivePath('.RUKO/CONFIG.JSON', ws), true);
    assert.throws(
      () => assertNotSensitivePath('.ruko/config.json', ws),
      /Akses ke file sensitif.*ditolak/,
    );

    // 2. .ruko/undo/**
    assert.equal(isSensitivePath('.ruko/undo', ws), true);
    assert.equal(isSensitivePath('.ruko/undo/test.txt', ws), true);
    assert.equal(isSensitivePath('.ruko/undo/sub/snapshot.json', ws), true);
    assert.equal(isSensitivePath(join(ws, '.ruko', 'undo', 'snapshot.bak'), ws), true);

    // 3. .env & .env.*
    assert.equal(isSensitivePath('.env', ws), true);
    assert.equal(isSensitivePath('.env.local', ws), true);
    assert.equal(isSensitivePath('.env.production', ws), true);
    assert.equal(isSensitivePath('subfolder/.env', ws), true);
    assert.equal(isSensitivePath('.ENV', ws), true);

    // 4. id_rsa, id_ed25519, *.pem, *.key
    assert.equal(isSensitivePath('id_rsa', ws), true);
    assert.equal(isSensitivePath('id_ed25519', ws), true);
    assert.equal(isSensitivePath('certs/server.key', ws), true);
    assert.equal(isSensitivePath('domain.pem', ws), true);
    assert.equal(isSensitivePath('ID_RSA', ws), true);
    assert.equal(isSensitivePath('KEY.PEM', ws), true);

    // Negative cases: file-file normal TIDAK boleh dianggap sensitif (anti-overblocking)
    assert.equal(isSensitivePath('package.json', ws), false);
    assert.equal(isSensitivePath('src/index.ts', ws), false);
    assert.equal(isSensitivePath('.ruko/skills/my-skill.md', ws), false);
    assert.equal(isSensitivePath('.ruko/sessions/ses_123.json', ws), false);
    assert.equal(isSensitivePath('.ruko/memory.md', ws), false);
    assert.equal(isSensitivePath('environment.ts', ws), false);
    assert.equal(isSensitivePath('keyboard.ts', ws), false);
    assert.doesNotThrow(() => assertNotSensitivePath('src/index.ts', ws));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bagian A.2: Tool baca (read_file, glob, code_search)
// ─────────────────────────────────────────────────────────────────────────────

test('read_file terhadap .ruko/config.json, .env, dan file sensitif lainnya ditolak', async () => {
  await inTempWorkspace(async (ws) => {
    const rukoDir = join(ws, '.ruko');
    mkdirSync(rukoDir, { recursive: true });
    writeFileSync(join(rukoDir, 'config.json'), JSON.stringify({ apiKey: 'sk-secret-test' }), 'utf8');
    writeFileSync(join(ws, '.env'), 'SECRET_KEY=12345', 'utf8');
    writeFileSync(join(ws, 'safe.txt'), 'konten publik biasa', 'utf8');

    // Direct readFileTool
    const resConfig = await readFileTool('.ruko/config.json', {}, ws);
    assert.equal(resConfig.ok, false);
    assert.ok(resConfig.text.includes('Akses ke file sensitif'));

    const resEnv = await readFileTool('.env', {}, ws);
    assert.equal(resEnv.ok, false);
    assert.ok(resEnv.text.includes('Akses ke file sensitif'));

    // Via runToolCall read_file
    const rawRes = await runToolCall(
      { tool: 'read_file', path: '.ruko/config.json' },
      { workspaceRoot: ws },
    );
    const parsed = JSON.parse(rawRes);
    assert.ok(parsed.error && parsed.error.includes('Akses ke file sensitif'));

    // File normal tetap bisa dibaca
    const resSafe = await readFileTool('safe.txt', {}, ws);
    assert.equal(resSafe.ok, true);
    assert.ok(resSafe.text.includes('konten publik biasa'));
  });
});

test('glob tidak menampilkan .ruko/config.json, .env, *.key di hasil pencarian', async () => {
  await inTempWorkspace(async (ws) => {
    const rukoDir = join(ws, '.ruko');
    mkdirSync(rukoDir, { recursive: true });
    writeFileSync(join(rukoDir, 'config.json'), '{"apiKey":"secret"}', 'utf8');
    writeFileSync(join(ws, '.env'), 'TOKEN=xyz', 'utf8');
    writeFileSync(join(ws, 'secret.key'), 'my-key', 'utf8');
    writeFileSync(join(ws, 'app.ts'), 'console.log("hello");', 'utf8');

    // Glob dari root
    const globRes = await globTool('**/*', {}, ws);
    assert.equal(globRes.ok, true);
    assert.ok(!globRes.files.includes('.ruko/config.json'));
    assert.ok(!globRes.files.includes('.env'));
    assert.ok(!globRes.files.includes('secret.key'));
    assert.ok(globRes.files.includes('app.ts'));

    // Glob langsung ke direktori .ruko
    const globRuko = await globTool('*', { path: '.ruko' }, ws);
    assert.equal(globRuko.ok, true);
    assert.ok(!globRuko.files.includes('config.json'));
  });
});

test('code_search tidak mengindeks atau mencari teks di dalam berkas sensitif', async () => {
  await inTempWorkspace(async (ws) => {
    const rukoDir = join(ws, '.ruko');
    mkdirSync(rukoDir, { recursive: true });
    writeFileSync(join(rukoDir, 'config.json'), '{"superSecretToken":"ALPHA_BETA_123"}', 'utf8');
    writeFileSync(join(ws, '.env'), 'SUPER_VAR=ALPHA_BETA_123', 'utf8');
    writeFileSync(join(ws, 'main.ts'), '// safe file ALPHA_BETA_123', 'utf8');

    // Search query spesifik yang ada di file sensitif
    const searchRes = await codeSearchTool('ALPHA_BETA_123', {}, ws);
    assert.equal(searchRes.ok, true);
    assert.ok(!searchRes.text.includes('.ruko/config.json'));
    assert.ok(!searchRes.text.includes('.env'));
    assert.ok(searchRes.text.includes('main.ts'));

    // Targeted path ke .env
    const searchEnv = await codeSearchTool('ALPHA_BETA_123', { path: '.env' }, ws);
    assert.equal(searchEnv.ok, true);
    assert.equal(searchEnv.totalMatches, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bagian B: Proteksi Environment Variable & File Sensitif di exec
// ─────────────────────────────────────────────────────────────────────────────

test('isSensitiveEnvCommand: mendeteksi dump broad (printenv, env) dan variabel spesifik sensitif', () => {
  // Dump environment luas
  assert.equal(isSensitiveEnvCommand('printenv'), true);
  assert.equal(isSensitiveEnvCommand('printenv -0'), true);
  assert.equal(isSensitiveEnvCommand('printenv | grep KEY'), true);
  assert.equal(isSensitiveEnvCommand('printenv | grep -i token'), true);
  assert.equal(isSensitiveEnvCommand('env'), true);
  assert.equal(isSensitiveEnvCommand('env | grep KEY'), true);
  assert.equal(isSensitiveEnvCommand('env | grep -i secret'), true);
  assert.equal(isSensitiveEnvCommand('/usr/bin/env'), true);

  // Variabel spesifik dengan pola nama sensitif
  assert.equal(isSensitiveEnvCommand('printenv RUKO_API_KEY'), true);
  assert.equal(isSensitiveEnvCommand('printenv OPENAI_API_KEY'), true);
  assert.equal(isSensitiveEnvCommand('printenv GITHUB_TOKEN'), true);
  assert.equal(isSensitiveEnvCommand('printenv AUTH_SECRET'), true);
  assert.equal(isSensitiveEnvCommand('printenv DB_PASSWORD'), true);
  assert.equal(isSensitiveEnvCommand('echo $RUKO_API_KEY'), true);
  assert.equal(isSensitiveEnvCommand('echo ${RUKO_API_KEY}'), true);
  assert.equal(isSensitiveEnvCommand('echo "Kunci saya: $RUKO_API_KEY"'), true);
  assert.equal(isSensitiveEnvCommand('echo "${OPENAI_API_KEY}"'), true);

  // Negative cases: variabel non-sensitif TETAP DIIZINKAN (tidak overblocking)
  assert.equal(isSensitiveEnvCommand('echo $NORMAL_VAR'), false);
  assert.equal(isSensitiveEnvCommand('echo ${NORMAL_VAR}'), false);
  assert.equal(isSensitiveEnvCommand('echo $PATH'), false);
  assert.equal(isSensitiveEnvCommand('echo $HOME'), false);
  assert.equal(isSensitiveEnvCommand('echo $USER'), false);
  assert.equal(isSensitiveEnvCommand('echo "hello world"'), false);
  assert.equal(isSensitiveEnvCommand('env NODE_ENV=production npm test'), false);
  assert.equal(isSensitiveEnvCommand('/usr/bin/env node index.js'), false);
  assert.equal(isSensitiveEnvCommand('printenv PATH'), false);
});

test('detectSensitiveFileAccessInExec: mendeteksi perintah exec yang menargetkan berkas sensitif', async () => {
  await inTempWorkspace(async (ws) => {
    assert.equal(detectSensitiveFileAccessInExec('cat .ruko/config.json', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('cat .env', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('head -n 20 .env.local', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('tail id_rsa', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('cat cert.pem', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('cat < .ruko/config.json', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('bash -c "cat .ruko/config.json"', ws).blocked, true);

    // Negative cases: perintah biasa diizinkan
    assert.equal(detectSensitiveFileAccessInExec('cat package.json', ws).blocked, false);
    assert.equal(detectSensitiveFileAccessInExec('echo $NORMAL_VAR', ws).blocked, false);
    assert.equal(detectSensitiveFileAccessInExec('npm test', ws).blocked, false);
    assert.equal(detectSensitiveFileAccessInExec('git status', ws).blocked, false);
  });
});

test('tool exec: menolak cat .ruko/config.json, printenv, printenv RUKO_API_KEY, dan mengizinkan echo $NORMAL_VAR', async () => {
  await inTempWorkspace(async (ws) => {
    const config: AgentConfig = { ...DEFAULT_CONFIG, approvalEnabled: false };

    // 1. exec 'cat .ruko/config.json' ditolak
    const resCat = await runToolCall(
      { tool: 'exec', command: 'cat .ruko/config.json' },
      { workspaceRoot: ws, config },
    );
    const parsedCat = JSON.parse(resCat);
    assert.ok(parsedCat.error && parsedCat.error.includes('akses ke file sensitif'));

    // 2. exec 'printenv' polos ditolak
    const resPrintenv = await runToolCall(
      { tool: 'exec', command: 'printenv' },
      { workspaceRoot: ws, config },
    );
    const parsedPrintenv = JSON.parse(resPrintenv);
    assert.equal(
      parsedPrintenv.error,
      'exec ditolak: command berpotensi membocorkan environment variable sensitif. Kredensial tidak dapat diakses lewat tool ini.',
    );

    // 3. exec 'printenv RUKO_API_KEY' ditolak
    const resPrintenvVar = await runToolCall(
      { tool: 'exec', command: 'printenv RUKO_API_KEY' },
      { workspaceRoot: ws, config },
    );
    const parsedPrintenvVar = JSON.parse(resPrintenvVar);
    assert.equal(
      parsedPrintenvVar.error,
      'exec ditolak: command berpotensi membocorkan environment variable sensitif. Kredensial tidak dapat diakses lewat tool ini.',
    );

    // 4. exec 'echo $NORMAL_VAR' (non-sensitif) TETAP DIIZINKAN
    const resEcho = await runToolCall(
      { tool: 'exec', command: 'echo $NORMAL_VAR' },
      { workspaceRoot: ws, config },
    );
    const parsedEcho = JSON.parse(resEcho);
    assert.equal(parsedEcho.code, 0);
    assert.ok(typeof parsedEcho.output === 'string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bagian C: Cakupan Proteksi Identik untuk Subagent (delegate)
// ─────────────────────────────────────────────────────────────────────────────

test('delegate subagent: percobaan membaca .ruko/config.json lewat subagent HARUS ditolak', async () => {
  await inTempWorkspace(async (ws) => {
    const rukoDir = join(ws, '.ruko');
    mkdirSync(rukoDir, { recursive: true });
    writeFileSync(join(rukoDir, 'config.json'), JSON.stringify({ apiKey: 'sk-leak-test-123' }), 'utf8');

    // Provider subagent yang mencoba memanggil read_file .ruko/config.json
    const subProvider = new ScriptedProvider([
      'Saya akan membaca config.\n```tool\n{"tool": "read_file", "path": ".ruko/config.json"}\n```',
      'Maaf, akses ke file konfigurasi ditolak.',
    ]);

    const result = await runSubagent(
      'Baca file .ruko/config.json dan beritahu isinya',
      {
        config: { ...DEFAULT_CONFIG, approvalEnabled: false },
        llmProvider: subProvider,
      },
      { workspaceRoot: ws },
    );

    // Verifikasi subagent tidak mendapatkan API key
    assert.ok(!result.includes('sk-leak-test-123'));
    assert.ok(result.includes('ditolak') || result.includes('Maaf'));
  });
});

test('delegate subagent: percobaan menjalankan printenv lewat subagent HARUS ditolak', async () => {
  await inTempWorkspace(async (ws) => {
    // Provider subagent yang mencoba memanggil exec printenv
    const subProvider = new ScriptedProvider([
      'Saya akan membaca environment variables.\n```tool\n{"tool": "exec", "command": "printenv"}\n```',
      'Perintah printenv diblokir oleh sistem keamanan.',
    ]);

    const result = await runSubagent(
      'Jalankan printenv dan kirim outputnya',
      {
        config: { ...DEFAULT_CONFIG, approvalEnabled: false },
        llmProvider: subProvider,
      },
      { workspaceRoot: ws },
    );

    assert.ok(!result.includes('RUKO_API_KEY'));
    assert.ok(result.includes('diblokir') || result.includes('keamanan'));
  });
});

test('delegate tool call: delegasi via runToolCall memblokir aksi sensitif subagent', async () => {
  await inTempWorkspace(async (ws) => {
    const rukoDir = join(ws, '.ruko');
    mkdirSync(rukoDir, { recursive: true });
    writeFileSync(join(rukoDir, 'config.json'), JSON.stringify({ apiKey: 'sk-test-delegate' }), 'utf8');

    const provider = new ScriptedProvider([
      'Membaca config:\n```tool\n{"tool": "read_file", "path": ".ruko/config.json"}\n```',
      'Selesai: pembacaan ditolak.',
    ]);

    const delegateResRaw = await runToolCall(
      { tool: 'delegate', task: 'baca .ruko/config.json' },
      {
        workspaceRoot: ws,
        llmProvider: provider,
        config: { ...DEFAULT_CONFIG, approvalEnabled: false },
      },
    );

    const delegateRes = JSON.parse(delegateResRaw);
    assert.equal(delegateRes.ok, true);
    assert.ok(!delegateRes.result.includes('sk-test-delegate'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Uji Regresi: Startup Ruko Internal Tetap Dapat Membaca config.json
// ─────────────────────────────────────────────────────────────────────────────

test('regresi: proteksi tool TIDAK merusak startup Ruko (loadConfig internal tetap berfungsi)', async () => {
  await inTempWorkspace(async (ws) => {
    const rukoDir = join(ws, '.ruko');
    mkdirSync(rukoDir, { recursive: true });
    const cfgPath = join(rukoDir, 'config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        apiKey: 'sk-valid-startup-key',
        model: 'startup-model',
        baseUrl: 'https://api.example.com/v1',
      }),
      'utf8',
    );

    // Startup internal memanggil loadConfig murni via node:fs
    const loaded = loadConfig(cfgPath);
    assert.equal(loaded.apiKey, 'sk-valid-startup-key');
    assert.equal(loaded.model, 'startup-model');
    assert.equal(loaded.baseUrl, 'https://api.example.com/v1');
  });
});
