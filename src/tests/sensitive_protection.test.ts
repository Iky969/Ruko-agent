import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  SECURITY_CORE_FILES,
  assertNotSensitivePath,
  detectSensitiveFileAccessInExec,
  isSecurityCoreFile,
  isSensitiveEnvCommand,
  isSensitivePath,
  runToolCall,
  setWorkspaceRoot,
} from '../agent/tools.js';
import { codeSearchTool, globTool, readFileTool } from '../agent/filetools.js';
import {
  checkSsrfSafety,
  isPrivateOrLocalIp,
  isPrivateOrLocalIPv4,
  isPrivateOrLocalIPv6,
  parseAlternativeIPv4,
  webFetchTool,
} from '../agent/webtools.js';
import { runSubagent } from '../agent/subagent.js';
import { loadConfig } from '../core/config.js';
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

    // 5. /proc/*/environ
    assert.equal(isSensitivePath('/proc/self/environ', ws), true);
    assert.equal(isSensitivePath('/proc/1/environ', ws), true);
    assert.equal(isSensitivePath('/proc/$$/environ', ws), true);
    assert.equal(isSensitivePath('/proc/12345/environ', ws), true);
    assert.throws(
      () => assertNotSensitivePath('/proc/self/environ', ws),
      /Akses ke file sensitif.*ditolak/,
    );

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

// ─────────────────────────────────────────────────────────────────────────────
// Bagian D: Proteksi Immutable Security Core Files
// ─────────────────────────────────────────────────────────────────────────────

test('isSecurityCoreFile: mendeteksi tepat 6 berkas inti keamanan Ruko', () => {
  assert.equal(SECURITY_CORE_FILES.length, 6);
  assert.ok(SECURITY_CORE_FILES.includes('src/core/approval.ts'));
  assert.ok(SECURITY_CORE_FILES.includes('src/core/executor.ts'));
  assert.ok(SECURITY_CORE_FILES.includes('src/agent/tools.ts'));
  assert.ok(SECURITY_CORE_FILES.includes('src/agent/filetools.ts'));
  assert.ok(SECURITY_CORE_FILES.includes('src/agent/subagent.ts'));
  assert.ok(SECURITY_CORE_FILES.includes('src/agent/webtools.ts'));

  assert.equal(isSecurityCoreFile('src/core/approval.ts', '/root'), true);
  assert.equal(isSecurityCoreFile('src/core/executor.ts', '/root'), true);
  assert.equal(isSecurityCoreFile('src/agent/tools.ts', '/root'), true);
  assert.equal(isSecurityCoreFile('src/agent/filetools.ts', '/root'), true);
  assert.equal(isSecurityCoreFile('src/agent/subagent.ts', '/root'), true);
  assert.equal(isSecurityCoreFile('src/agent/webtools.ts', '/root'), true);

  // Negative
  assert.equal(isSecurityCoreFile('src/agent/agent.ts', '/root'), false);
  assert.equal(isSecurityCoreFile('package.json', '/root'), false);
});

test('mutating tools menolak keras modifikasi atau penghapusan berkas Security Core', async () => {
  await inTempWorkspace(async (ws) => {
    // Siapkan struktur berkas palsu di dalam temporary workspace
    mkdirSync(join(ws, 'src/core'), { recursive: true });
    mkdirSync(join(ws, 'src/agent'), { recursive: true });

    for (const coreFile of SECURITY_CORE_FILES) {
      writeFileSync(join(ws, coreFile), '// original core content\n', 'utf8');
    }

    // 1. write_file ditolak pada seluruh berkas Security Core
    for (const coreFile of SECURITY_CORE_FILES) {
      const resWrite = await runToolCall(
        { tool: 'write_file', path: coreFile, content: '// malicious rewrite' },
        { workspaceRoot: ws },
      );
      const parsed = JSON.parse(resWrite);
      assert.ok(parsed.error && parsed.error.includes('Security Core file'));
      assert.equal(readFileSync(join(ws, coreFile), 'utf8'), '// original core content\n');
    }

    // 2. edit_file ditolak pada berkas Security Core
    const resEdit = await runToolCall(
      {
        tool: 'edit_file',
        path: 'src/agent/tools.ts',
        old_string: '// original core content\n',
        new_string: '// edited core content\n',
      },
      { workspaceRoot: ws },
    );
    const parsedEdit = JSON.parse(resEdit);
    assert.ok(parsedEdit.error && parsedEdit.error.includes('Security Core file'));

    // 3. patch_file ditolak pada berkas Security Core
    const resPatch = await runToolCall(
      {
        tool: 'patch_file',
        path: 'src/agent/filetools.ts',
        search: '// original core content\n',
        replace: '// patched\n',
      },
      { workspaceRoot: ws },
    );
    const parsedPatch = JSON.parse(resPatch);
    assert.ok(parsedPatch.error && parsedPatch.error.includes('Security Core file'));

    // 4. delete_file ditolak pada berkas Security Core
    const resDel = await runToolCall(
      { tool: 'delete_file', path: 'src/core/approval.ts' },
      { workspaceRoot: ws },
    );
    const parsedDel = JSON.parse(resDel);
    assert.ok(parsedDel.error && parsedDel.error.includes('Security Core file'));
    assert.ok(existsSync(join(ws, 'src/core/approval.ts')));

    // 5. move_file ditolak bila sumber atau tujuan adalah berkas Security Core
    const resMoveSource = await runToolCall(
      {
        tool: 'move_file',
        source: 'src/agent/subagent.ts',
        destination: 'src/agent/subagent.bak',
      },
      { workspaceRoot: ws },
    );
    const parsedMoveSource = JSON.parse(resMoveSource);
    assert.ok(parsedMoveSource.error && parsedMoveSource.error.includes('Security Core file'));

    const resMoveDest = await runToolCall(
      {
        tool: 'move_file',
        source: 'src/agent/subagent.bak',
        destination: 'src/agent/subagent.ts',
      },
      { workspaceRoot: ws },
    );
    const parsedMoveDest = JSON.parse(resMoveDest);
    assert.ok(parsedMoveDest.error && parsedMoveDest.error.includes('Security Core file'));

    // 6. revert_file ditolak pada berkas Security Core
    const resRevert = await runToolCall(
      { tool: 'revert_file', path: 'src/agent/webtools.ts' },
      { workspaceRoot: ws },
    );
    const parsedRevert = JSON.parse(resRevert);
    assert.ok(parsedRevert.error && parsedRevert.error.includes('Security Core file'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bagian E: Uji Hardening SSRF & Notasi IP Alternatif
// ─────────────────────────────────────────────────────────────────────────────

test('parseAlternativeIPv4: normalisasi berbagai representasi notasi IP', () => {
  // Desimal integer
  assert.equal(parseAlternativeIPv4('2130706433'), '127.0.0.1');
  assert.equal(parseAlternativeIPv4('2852039166'), '169.254.169.254');
  assert.equal(parseAlternativeIPv4('3232235521'), '192.168.0.1');
  assert.equal(parseAlternativeIPv4('0'), '0.0.0.0');

  // Oktal
  assert.equal(parseAlternativeIPv4('0177.0.0.1'), '127.0.0.1');
  assert.equal(parseAlternativeIPv4('017700000001'), '127.0.0.1');

  // Heksadesimal
  assert.equal(parseAlternativeIPv4('0x7f000001'), '127.0.0.1');
  assert.equal(parseAlternativeIPv4('0x7f.0.0.1'), '127.0.0.1');
  assert.equal(parseAlternativeIPv4('0xa9fea9fe'), '169.254.169.254');

  // Shorthand dotted
  assert.equal(parseAlternativeIPv4('127.1'), '127.0.0.1');
  assert.equal(parseAlternativeIPv4('10.1'), '10.0.0.1');

  // Non-IP string
  assert.equal(parseAlternativeIPv4('example.com'), null);
  assert.equal(parseAlternativeIPv4('not-an-ip'), null);
});

test('isPrivateOrLocalIp & isPrivateOrLocalIPv6: memblokir notasi privat/lokal dan IPv4-mapped IPv6', () => {
  // Desimal, oktal, hex privat
  assert.equal(isPrivateOrLocalIp('2130706433'), true);
  assert.equal(isPrivateOrLocalIp('2852039166'), true);
  assert.equal(isPrivateOrLocalIp('0177.0.0.1'), true);
  assert.equal(isPrivateOrLocalIp('0x7f000001'), true);
  assert.equal(isPrivateOrLocalIp('127.1'), true);

  // IPv4 standar
  assert.equal(isPrivateOrLocalIp('127.0.0.1'), true);
  assert.equal(isPrivateOrLocalIp('10.0.0.1'), true);
  assert.equal(isPrivateOrLocalIp('172.16.0.1'), true);
  assert.equal(isPrivateOrLocalIp('192.168.1.1'), true);
  assert.equal(isPrivateOrLocalIp('169.254.169.254'), true);
  assert.equal(isPrivateOrLocalIp('8.8.8.8'), false);
  assert.equal(isPrivateOrLocalIp('1.1.1.1'), false);

  // IPv6 & IPv4-mapped IPv6
  assert.equal(isPrivateOrLocalIPv6('::1'), true);
  assert.equal(isPrivateOrLocalIPv6('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrLocalIPv6('::ffff:7f00:1'), true);
  assert.equal(isPrivateOrLocalIPv6('::ffff:a9fe:a9fe'), true);
  assert.equal(isPrivateOrLocalIPv6('::ffff:169.254.169.254'), true);
  assert.equal(isPrivateOrLocalIPv6('fe80::1'), true);
  assert.equal(isPrivateOrLocalIPv6('fc00::1'), true);
  assert.equal(isPrivateOrLocalIPv6('2606:4700:4700::1111'), false);
});

test('checkSsrfSafety: menolak URL dengan notasi IP alternatif berbahaya', async () => {
  const badUrls = [
    'http://2130706433/',
    'http://2852039166/latest/meta-data',
    'http://0177.0.0.1/',
    'http://0x7f000001/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data',
  ];

  for (const u of badUrls) {
    const res = await checkSsrfSafety(new URL(u));
    assert.equal(res.safe, false, `Expected ${u} to be unsafe`);
    assert.ok(res.reason && res.reason.length > 0);
  }
});

test('webFetchTool: memblokir redirect hop yang mengarah ke target SSRF privat/metadata', async () => {
  // Jalankan server redirect lokal sementara
  const server = createServer((req, res) => {
    if (req.url === '/redirect-to-metadata') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
      res.end();
    } else if (req.url === '/redirect-to-decimal-loopback') {
      res.writeHead(302, { Location: 'http://2852039166/secret' });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as any).port;

  try {
    // 1. Redirect hop ke 169.254.169.254 diblokir
    const resMeta = await webFetchTool(
      `http://127.0.0.1:${port}/redirect-to-metadata`,
      { allowLocalhost: true },
    );
    assert.equal(resMeta.ok, false);
    assert.ok(resMeta.text.includes('redirect mengarah ke alamat internal') || resMeta.text.includes('IP lokal/privat'));

    // 2. Redirect hop ke integer desimal 2130706433 diblokir
    const resDec = await webFetchTool(
      `http://127.0.0.1:${port}/redirect-to-decimal-loopback`,
      { allowLocalhost: true },
    );
    assert.equal(resDec.ok, false);
    assert.ok(resDec.text.includes('redirect mengarah ke alamat internal') || resDec.text.includes('IP lokal/privat'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VULN-02: Shell Wildcard Expansion pada exec
// ─────────────────────────────────────────────────────────────────────────────

test('VULN-02: detectSensitiveFileAccessInExec memblokir wildcard yang menargetkan .ruko atau file sensitif', () => {
  const blockedWildcards = [
    'cat .ruko/conf*',
    'cat .ruko/*',
    'ls .ruko/*',
    'head -n 10 .ruko/config.*',
    'cat .env*',
    'grep foo .env.*',
    'cat *.pem',
    'cat *.key',
    'cat id_rsa*',
    'cat id_ed25519*',
    'cat ~/.ssh/*',
  ];

  for (const cmd of blockedWildcards) {
    const res = detectSensitiveFileAccessInExec(cmd);
    assert.equal(res.blocked, true, `Seharusnya diblokir: ${cmd}`);
    assert.match(res.message ?? '', /akses ke file sensitif/i);
  }

  // Wildcard umum non-sensitif tetap diizinkan
  const allowedWildcards = [
    'ls *.ts',
    'cat src/*.js',
    'grep test docs/*.md',
    'cat build/*.log',
  ];

  for (const cmd of allowedWildcards) {
    const res = detectSensitiveFileAccessInExec(cmd);
    assert.equal(res.blocked, false, `Seharusnya tidak diblokir: ${cmd}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Bagian F: Uji Bypass Encoding Path dan Command Filter Exec
// ─────────────────────────────────────────────────────────────────────────────

test('detectSensitiveFileAccessInExec: menangkap subshell, backslash unescaping, dan tracking variabel', async () => {
  await inTempWorkspace(async (ws) => {
    // Subshell $() dan backtick
    assert.equal(detectSensitiveFileAccessInExec('echo $(cat .env)', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('VAR=$(cat .ruko/config.json)', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('echo `cat .env`', ws).blocked, true);

    // Backslash unescaping
    assert.equal(detectSensitiveFileAccessInExec('cat .ru\\ko/con\\fig.json', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('cat .e\\nv', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('head -n 5 .e\\nv.local', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('cat .git-cre\\dentials', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('cat ~/.s\\sh/id_rsa', ws).blocked, true);

    // Variable tracking
    assert.equal(detectSensitiveFileAccessInExec('V=.env; cat $V', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('TARGET=.ruko/config.json; head "$TARGET"', ws).blocked, true);
    assert.equal(detectSensitiveFileAccessInExec('KEY=id_rsa; tail $KEY', ws).blocked, true);
  });
});

test('isSensitiveEnvCommand: menangkap ekspresi bertingkat dan variabel bertranslasi ke env sensitif', () => {
  assert.equal(isSensitiveEnvCommand('V=RUKO_API_KEY; printenv $V'), true);
  assert.equal(isSensitiveEnvCommand('K=OPENAI_API_KEY; env | grep $K'), true);
  assert.equal(isSensitiveEnvCommand('print\\env RUKO_API_KEY'), true);
  assert.equal(isSensitiveEnvCommand('e\\nv'), true);
});

test('isSensitivePath: menangani URL-encoding, case sensitivity, dan tilde expansion', () => {
  // URL-encoding
  assert.equal(isSensitivePath('%2e%65%6e%76'), true); // .env
  assert.equal(isSensitivePath('.ruko%2fconfig.json'), true); // .ruko/config.json
  assert.equal(isSensitivePath('.ruko%2Fconfig%2Ejson'), true);

  // Case variations
  assert.equal(isSensitivePath('.RUKO/CONFIG.JSON'), true);
  assert.equal(isSensitivePath('.Env'), true);
  assert.equal(isSensitivePath('.ENV.LOCAL'), true);
  assert.equal(isSensitivePath('.Git-Credentials'), true);
  assert.equal(isSensitivePath('ID_RSA'), true);
  assert.equal(isSensitivePath('ID_ED25519'), true);

  // Home directory (tilde) expansion
  assert.equal(isSensitivePath('~/.ssh/id_rsa'), true);
  assert.equal(isSensitivePath('~/.ssh/id_ed25519'), true);
  assert.equal(isSensitivePath('~/.git-credentials'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bagian G: Uji Konsistensi Symlink & Broken Symlink Escape
// ─────────────────────────────────────────────────────────────────────────────

test('symlink consistency: broken symlink write-through ditolak tanpa escape workspace', async () => {
  await inTempWorkspace(async (ws) => {
    // Siapkan broken symlink yang menunjuk ke lokasi di luar workspace yang belum ada
    const outsideTarget = join(tmpdir(), `ruko-broken-escape-${Date.now()}.txt`);
    const brokenLinkPath = join(ws, 'broken_symlink.txt');

    try {
      symlinkSync(outsideTarget, brokenLinkPath);
    } catch {
      // Jika platform/lingkungan tidak mengizinkan symlink tanpa hak khusus, lewati
      return;
    }

    // Upaya menulis ke broken symlink via write_file harus ditolak
    const resWrite = await runToolCall(
      { tool: 'write_file', path: 'broken_symlink.txt', content: 'hacked outside content' },
      { workspaceRoot: ws },
    );
    const parsedWrite = JSON.parse(resWrite);
    assert.ok(parsedWrite.error && (parsedWrite.error.includes('luar workspace') || parsedWrite.error.includes('working directory')));
    assert.equal(existsSync(outsideTarget), false, 'Berkas target di luar workspace tidak boleh tercipta');

    // Upaya edit_file via broken symlink juga harus ditolak
    const resEdit = await runToolCall(
      {
        tool: 'edit_file',
        path: 'broken_symlink.txt',
        content: 'hacked edit',
      },
      { workspaceRoot: ws },
    );
    const parsedEdit = JSON.parse(resEdit);
    assert.ok(parsedEdit.error && (parsedEdit.error.includes('luar workspace') || parsedEdit.error.includes('working directory')));
    assert.equal(existsSync(outsideTarget), false);
  });
});

test('symlink consistency: symlink ke berkas sensitif diblokir di readFileTool dan mutating tools', async () => {
  await inTempWorkspace(async (ws) => {
    // Buat file sensitif asli .env
    writeFileSync(join(ws, '.env'), 'SECRET_SYMLINK_TOKEN=99999', 'utf8');

    // Buat symlink di dalam workspace yang mengarah ke .env
    const linkPath = join(ws, 'symlink_to_env.txt');
    try {
      symlinkSync(join(ws, '.env'), linkPath);
    } catch {
      return;
    }

    // 1. readFileTool melalui symlink diblokir
    const readRes = await readFileTool('symlink_to_env.txt', {}, ws);
    assert.equal(readRes.ok, false);
    assert.ok(readRes.text.includes('file sensitif'));

    // 2. write_file melalui symlink ke berkas sensitif diblokir
    const writeRes = await runToolCall(
      { tool: 'write_file', path: 'symlink_to_env.txt', content: 'overwrite secret' },
      { workspaceRoot: ws },
    );
    const parsedWrite = JSON.parse(writeRes);
    assert.ok(parsedWrite.error && parsedWrite.error.includes('file sensitif'));
    assert.equal(readFileSync(join(ws, '.env'), 'utf8'), 'SECRET_SYMLINK_TOKEN=99999');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VULN-03: Exfiltrasi Environment Variable via Runtime Scripting
// ─────────────────────────────────────────────────────────────────────────────

test('VULN-03: isSensitiveEnvCommand memblokir eksekusi runtime inline yang membaca environment', () => {
  const envDumpCommands = [
    'node -e "console.log(process.env)"',
    "node -e 'console.log(process.env)'",
    'node --eval "process.stdout.write(JSON.stringify(process.env))"',
    'python3 -c "import os; print(os.environ)"',
    "python -c 'import os; print(os.environ)'",
    'python3 -c "import os; print(os.getenv(\'API_KEY\'))"',
    'ruby -e "p ENV"',
    "ruby -e 'puts ENV.to_h'",
    "perl -e 'print join(\" \", %ENV)'",
    'perl -e "print $ENV{SECRET}"',
    'php -r "print_r($_ENV);"',
    'php -r "var_dump($_SERVER);"',
    'declare -p',
    'set',
  ];

  for (const cmd of envDumpCommands) {
    assert.equal(isSensitiveEnvCommand(cmd), true, `Seharusnya terdeteksi sensitif: ${cmd}`);
  }

  // Perintah runtime normal tanpa akses env tetap aman
  const harmlessCommands = [
    'node -e "console.log(1 + 1)"',
    'python3 -c "print(\'hello world\')"',
    'ruby -e "puts 42"',
    'perl -e "print 123"',
    'php -r "echo 99;"',
  ];

  for (const cmd of harmlessCommands) {
    assert.equal(isSensitiveEnvCommand(cmd), false, `Seharusnya tidak terdeteksi sensitif: ${cmd}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Point 2: Mitigasi Eksfiltrasi Environment Tidak Langsung (/proc/*/environ, awk ENVIRON, eval/subshell)
// ─────────────────────────────────────────────────────────────────────────────

test('Point 2: isSensitiveEnvCommand & detectSensitiveFileAccessInExec memblokir /proc/*/environ', () => {
  const procCommands = [
    'cat /proc/self/environ',
    'strings /proc/self/environ',
    'xxd /proc/self/environ',
    'head -n 50 /proc/$$/environ',
    'tail /proc/$PPID/environ',
    'cat /proc/1234/environ',
    'grep API_KEY /proc/self/environ',
  ];

  for (const cmd of procCommands) {
    assert.equal(isSensitiveEnvCommand(cmd), true, `isSensitiveEnvCommand harus memblokir: ${cmd}`);
    const fileAccess = detectSensitiveFileAccessInExec(cmd);
    assert.equal(fileAccess.blocked, true, `detectSensitiveFileAccessInExec harus memblokir: ${cmd}`);
  }

  // File proc non-environ tetap diizinkan
  assert.equal(isSensitiveEnvCommand('cat /proc/cpuinfo'), false);
  assert.equal(isSensitiveEnvCommand('cat /proc/meminfo'), false);
  assert.equal(detectSensitiveFileAccessInExec('cat /proc/cpuinfo').blocked, false);
});

test('Point 2: isSensitiveEnvCommand memblokir eksfiltrasi via awk ENVIRON array', () => {
  const awkCommands = [
    "awk 'BEGIN { for (k in ENVIRON) print k, ENVIRON[k] }'",
    'gawk \'BEGIN { print ENVIRON["OPENAI_API_KEY"] }\'',
    'mawk \'BEGIN { for (e in ENVIRON) printf("%s=%s\\n", e, ENVIRON[e]) }\'',
    'nawk \'BEGIN { print ENVIRON["SECRET"] }\'',
  ];

  for (const cmd of awkCommands) {
    assert.equal(isSensitiveEnvCommand(cmd), true, `Awk ENVIRON harus diblokir: ${cmd}`);
  }

  // Awk umum tanpa ENVIRON tetap diizinkan
  const safeAwkCommands = [
    "awk '{print $1}' data.csv",
    "awk -F, 'NR>1 {print $2}' table.txt",
    "gawk '{count++} END {print count}' log.txt",
  ];

  for (const cmd of safeAwkCommands) {
    assert.equal(isSensitiveEnvCommand(cmd), false, `Awk normal tidak boleh diblokir: ${cmd}`);
  }
});

test('Point 2: isSensitiveEnvCommand memblokir subshell / command substitution eksfiltrasi (eval, $(...), `...`)', () => {
  const subshellCommands = [
    'eval $(env)',
    'eval "$(printenv)"',
    'echo $(printenv)',
    'echo `printenv`',
    'eval "printenv"',
    'cat <(printenv)',
    'eval $(echo $API_KEY)',
  ];

  for (const cmd of subshellCommands) {
    assert.equal(isSensitiveEnvCommand(cmd), true, `Subshell env exfiltration harus diblokir: ${cmd}`);
  }

  // Subshell normal tanpa pembocoran env tetap aman
  const safeSubshellCommands = [
    'echo $(date)',
    'eval "echo 42"',
    'echo `whoami`',
    'cat <(ls -la)',
  ];

  for (const cmd of safeSubshellCommands) {
    assert.equal(isSensitiveEnvCommand(cmd), false, `Subshell aman tidak boleh diblokir: ${cmd}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// H3 (audit v1.7.7): isPrivateOrLocalIPv4 tidak boleh mempercayai notasi
// alternatif (oktal leading-zero / hex). Sebelumnya parseInt(p, 10) membuat
// "0177.0.0.1" diparsing sebagai 177.0.0.1 (bukan 127.0.0.1) sehingga LOLOS
// dari deteksi loopback. Sekarang notasi non-desimal = malformed = unsafe.
// ─────────────────────────────────────────────────────────────────────────────

test('H3: isPrivateOrLocalIPv4 menolak notasi oktal/hex sebagai malformed (unsafe)', () => {
  // Payload dari audit — semuanya harus dianggap privat/lokal (unsafe)
  assert.equal(isPrivateOrLocalIPv4('0177.0.0.1'), true, 'oktal loopback harus unsafe');
  assert.equal(isPrivateOrLocalIPv4('0x7f.0.0.1'), true, 'hex loopback harus unsafe');
  assert.equal(isPrivateOrLocalIPv4('0x7f000001'), true, 'hex penuh harus unsafe');
  assert.equal(isPrivateOrLocalIPv4('010.0.0.1'), true, 'oktal leading-zero harus unsafe (fail closed)');
  assert.equal(isPrivateOrLocalIPv4('0177.000.000.001'), true, 'oktal multi-segmen harus unsafe');
  assert.equal(isPrivateOrLocalIPv4(' 8.8.8.8'), true, 'whitespace = malformed');
  assert.equal(isPrivateOrLocalIPv4('+8.8.8.8'), true, 'tanda = malformed');
  assert.equal(isPrivateOrLocalIPv4('8.8.8'), true, 'jumlah segmen salah = malformed');
  assert.equal(isPrivateOrLocalIPv4('8.8.8.8.8'), true, 'terlalu banyak segmen = malformed');
  assert.equal(isPrivateOrLocalIPv4('999.1.1.1'), true, 'out of range = malformed');
  assert.equal(isPrivateOrLocalIPv4(''), true, 'string kosong = malformed');
});

test('H3: isPrivateOrLocalIPv4 tetap akurat untuk notasi desimal murni', () => {
  assert.equal(isPrivateOrLocalIPv4('127.0.0.1'), true);
  assert.equal(isPrivateOrLocalIPv4('10.0.0.1'), true);
  assert.equal(isPrivateOrLocalIPv4('172.16.0.1'), true);
  assert.equal(isPrivateOrLocalIPv4('192.168.1.1'), true);
  assert.equal(isPrivateOrLocalIPv4('169.254.169.254'), true);
  assert.equal(isPrivateOrLocalIPv4('0.0.0.0'), true);
  assert.equal(isPrivateOrLocalIPv4('8.8.8.8'), false);
  assert.equal(isPrivateOrLocalIPv4('1.1.1.1'), false);
  assert.equal(isPrivateOrLocalIPv4('93.184.216.34'), false);
});

test('H3: isPrivateOrLocalIp tetap mendeteksi notasi oktal/hex lewat normalisasi', () => {
  // parseAlternativeIPv4 menormalkan notasi alternatif lebih dulu, sehingga
  // payload audit tetap terdeteksi sebagai privat/lokal.
  for (const ip of ['0177.0.0.1', '0x7f.0.0.1', '0x7f000001', '2130706433', '127.1', '017700000001']) {
    assert.equal(isPrivateOrLocalIp(ip), true, `harus privat/lokal: ${ip}`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '010.0.0.1']) {
    assert.equal(isPrivateOrLocalIp(ip), false, `harus publik: ${ip}`);
  }
});

test('H3: checkSsrfSafety menolak URL dengan notasi IP alternatif (oktal/hex)', async () => {
  for (const target of [
    'http://0177.0.0.1/',
    'http://0x7f.0.0.1/',
    'http://0x7f000001/',
    'http://2130706433/',
  ]) {
    const res = await checkSsrfSafety(new URL(target));
    assert.equal(res.safe, false, `SSRF check harus menolak: ${target}`);
  }
  // Host publik tetap lolos (tanpa lookup DNS tambahan untuk literal IP)
  const publicIp = await checkSsrfSafety(new URL('http://93.184.216.34/'));
  assert.equal(publicIp.safe, true, 'IP publik harus lolos');
  // Notasi mentah yang BELUM dinormalisasi oleh URL parser (mis. dipanggil
  // dari caller internal) tetap harus ditolak oleh checkSsrfSafety.
  const rawNotation = { protocol: 'http:', hostname: '0177.0.0.1' } as unknown as URL;
  const rawRes = await checkSsrfSafety(rawNotation);
  assert.equal(rawRes.safe, false, 'hostname notasi oktal mentah harus ditolak');
});

