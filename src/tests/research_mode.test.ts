import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../agent/agent.js';
import { handleCommand } from '../agent/commands.js';
import { LLMProvider } from '../agent/llm.js';
import { researchModeAddendum } from '../agent/roles.js';
import { runSubagent } from '../agent/subagent.js';
import { setWorkspaceRoot } from '../agent/tools.js';
import { Context } from '../core/context.js';
import {
  evaluateDispatcherGate,
  isResearchModeAllowedExec,
} from '../core/dispatcher/dispatcherGate.js';
import { AgentConfig, ContextMessage, DEFAULT_CONFIG } from '../types.js';

/** Scripted provider: returns one canned reply per chat() call. */

// Diagnostik CI Windows: output test child dilewatkan pipeline TAP node:test
// yang mengawali tiap baris dengan `# `, sehingga workflow command `::notice`
// yang ditulis dari dalam test TIDAK PERNAH menjadi annotation GitHub
// (terbukti di 2 run: diagnostik tidak muncul). Maka test integrasi ini
// menulis hasil tiap bagiannya ke file JSON di tmpdir; scripts/run-tests.mjs
// (proses induk) membacanya setelah runner selesai dan meneruskannya sebagai
// annotation — hanya bila ada kegagalan. File dihapus run-tests.mjs di awal
// run berikutnya supaya tidak basi.
const RESEARCH_DEBUG_FILE = join(tmpdir(), 'ruko-research-debug.json');
function writeResearchDebug(part: string, data: Record<string, unknown>): void {
  try {
    let all: Record<string, unknown> = {};
    try {
      all = JSON.parse(readFileSync(RESEARCH_DEBUG_FILE, 'utf8')) as Record<string, unknown>;
    } catch {
      // Belum ada file / rusak — mulai dari kosong.
    }
    all[part] = data;
    writeFileSync(RESEARCH_DEBUG_FILE, JSON.stringify(all));
  } catch {
    // Diagnostik tidak boleh menutupi hasil test.
  }
}

class FakeProvider implements LLMProvider {
  readonly name = 'fake';
  readonly isConfigured = true;
  model = 'fake-model';
  receivedMessages: ContextMessage[][] = [];
  private calls = 0;
  constructor(private readonly replies: string[]) {}
  setModel(model: string): void {
    this.model = model;
  }
  async chat(messages: ContextMessage[], options?: { onToken?: (t: string) => void }): Promise<string> {
    this.receivedMessages.push([...messages]);
    const reply = this.replies[Math.min(this.calls, this.replies.length - 1)];
    this.calls += 1;
    options?.onToken?.(reply);
    return reply;
  }
}

const baseConfig: AgentConfig = { ...DEFAULT_CONFIG, approvalEnabled: false };

// NOTE: capture console.* (NOT process.stdout.write) — overriding stdout
// swallows node:test TAP lines and silently drops tests under `npm test`.
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  let out = '';
  const sink = (...args: unknown[]) => {
    out += `${args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')}\n`;
  };
  console.log = sink as typeof console.log;
  console.warn = sink as typeof console.warn;
  console.error = sink as typeof console.error;
  try {
    const result = await fn();
    return { result, out };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
}

const MUTATION_TOOLS = [
  'write_file',
  'edit_file',
  'patch_file',
  'delete_file',
  'move_file',
  'revert_file',
  'remember',
  'save_skill',
  'delete_skill',
  'start_process',
];

const READ_TOOLS = [
  'read_file',
  'glob',
  'list_dir',
  'list_directory',
  'code_search',
  'read_process_logs',
  'get_status',
  'web_fetch',
  'search_sessions',
];

const ALLOWED_EXEC = [
  'npm test',
  'npm run test',
  'npm run test:unit',
  'npm run test:e2e -- --runInBand',
  'yarn test',
  'pnpm test',
  'bun test',
  'npx vitest run',
  'npx jest --coverage',
  'vitest run',
  'jest',
  'mocha test/',
  'ava',
  'tap test/*.js',
  'playwright test',
  'cypress run',
  'node --test',
  'node --test test/foo.test.js',
  'node --test test/sed.test.js',
  'deno test',
  'go test ./...',
  'cargo test',
  'cargo test -- --nocapture',
  'pytest -q',
  'python -m pytest tests/',
  'python3 -m unittest',
  'phpunit',
  'vendor/bin/phpunit',
  'rspec',
  'bundle exec rspec spec/',
  'dotnet test',
  'mvn test',
  './gradlew test',
  'make test',
  'ctest',
  'bats tests/',
  'cd /tmp/x && npm test',
  'NODE_ENV=test npm test',
  './node_modules/.bin/jest',
  'pnpm dlx vitest run',
  'yarn dlx jest',
  'npm test -- --grep "foo bar"',
];

const BLOCKED_EXEC = [
  'rm -rf .',
  'npm test && rm -rf dist',
  'npm test > out.txt',
  'npm test | tee out.txt',
  'npm test 2>&1',
  'npm test; echo done',
  'npm run build',
  'npm run lint',
  'node server.js',
  'node -e "console.log(1)"',
  'python script.py',
  'git status',
  'git diff',
  'echo hi',
  'ls -la',
  'cat package.json',
  'npx cowsay hi',
  'npx tsc --noEmit',
  'curl https://example.com -o f.html',
  'wget https://example.com',
  'vitest run; rm -rf /tmp/x',
  'cd /tmp && rm -rf x',
  'npm test `rm -rf x`',
  'npm test $(rm -rf x)',
  'sh -c "npm test"',
  'bash -c "npm test"',
  'sed -i s/a/b/ file.txt',
  'touch newfile.txt',
  'mkdir newdir',
  'chmod +x script.sh',
  'mv a.txt b.txt',
  'cp a.txt b.txt',
  '',
  '   ',
];

test('research gate: tool mutasi diblok, tool baca diizinkan', async () => {
  for (const tool of MUTATION_TOOLS) {
    const d = await evaluateDispatcherGate({ tool, args: {}, researchMode: true });
    assert.equal(d.allowed, false, `${tool} harus diblok di research mode`);
    assert.ok(d.reason?.includes('research mode aktif'), `${tool}: alasan harus menyebut research mode`);
  }
  for (const tool of READ_TOOLS) {
    const d = await evaluateDispatcherGate({ tool, args: {}, researchMode: true });
    assert.equal(d.allowed, true, `${tool} harus diizinkan di research mode`);
  }
});

test('research gate: tanpa research mode, mutasi dan exec bebas tidak diblok gate', async () => {
  const d1 = await evaluateDispatcherGate({ tool: 'write_file', args: {} });
  assert.equal(d1.allowed, true);
  const d2 = await evaluateDispatcherGate({ tool: 'exec', args: { command: 'echo hi' } });
  assert.equal(d2.allowed, true);
});

test('research gate: plan mode tetap menang atas exec perintah test', async () => {
  const d = await evaluateDispatcherGate({
    tool: 'exec',
    args: { command: 'npm test' },
    planMode: true,
    researchMode: true,
  });
  assert.equal(d.allowed, false, 'plan mode memblokir exec apa pun, termasuk perintah test');
  assert.ok(d.reason?.includes('plan mode aktif'));
});

test('research exec allowlist: perintah test diizinkan', () => {
  for (const cmd of ALLOWED_EXEC) {
    const v = isResearchModeAllowedExec(cmd);
    assert.equal(v.allowed, true, `"${cmd}" harus diizinkan: ${v.reason ?? ''}`);
  }
});

test('research exec allowlist: perintah mutasi / non-test ditolak', () => {
  for (const cmd of BLOCKED_EXEC) {
    const v = isResearchModeAllowedExec(cmd);
    assert.equal(v.allowed, false, `"${cmd}" harus ditolak`);
    assert.ok(v.reason?.includes('research mode aktif'), `"${cmd}": alasan harus menyebut research mode`);
  }
});

test('getLoopDetectorParams: research mode tetap melonggarkan tool baca (10)', () => {
  const agent = new Agent(new Context(baseConfig), new FakeProvider([]), baseConfig);
  agent.sessionState.mode = 'research';
  const read = agent.getLoopDetectorParams('read_file');
  assert.equal(read.loopThreshold, 10);
  assert.equal(read.readOnlyRelaxed, true);
  // Guard identik berturut-turut tetap seragam (2) di semua mode.
  assert.equal(read.softWarningThreshold, 2);
  const exec = agent.getLoopDetectorParams('exec');
  assert.equal(exec.loopThreshold, 10);

  agent.sessionState.mode = 'default';
  const readDefault = agent.getLoopDetectorParams('read_file');
  assert.equal(readDefault.loopThreshold, 2);
  assert.equal(readDefault.readOnlyRelaxed, false);
});

test('research mode addendum: prompt memberi tahu model soal aturan baca+test', () => {
  const text = researchModeAddendum();
  assert.ok(text.includes('RESEARCH'));
  assert.ok(text.includes('read_file'));
  assert.ok(text.includes('npm test'));
  assert.ok(text.includes('Do NOT call write_file'));
});

test('integrasi agent: write_file diblok di research mode, file tidak tercipta', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-research-write-'));
  setWorkspaceRoot(tmp);
  try {
    const writeCall = '```tool\n{"tool": "write_file", "path": "out.txt", "content": "abc"}\n```';
    const provider = new FakeProvider([writeCall, 'Selesai tanpa mengubah file.']);
    const ctx = new Context(baseConfig);
    const agent = new Agent(ctx, provider, baseConfig, async () => true, tmp);
    agent.sessionState.mode = 'research';

    const { result } = await captureConsole(() => agent.handleInstruction('tulis file out.txt'));
    assert.equal(result, 'Selesai tanpa mengubah file.');
    assert.equal(existsSync(join(tmp, 'out.txt')), false, 'file tidak boleh tercipta');
    const toolMsgs = provider.receivedMessages[1].filter((m) => m.role === 'tool');
    assert.ok(toolMsgs.length >= 1, 'harus ada tool result untuk panggilan yang diblok');
    assert.ok(
      toolMsgs[0].content.includes('research mode aktif'),
      'tool result harus menjelaskan pemblokiran research mode',
    );
  } finally {
    setWorkspaceRoot(null);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('integrasi agent: read_file tetap jalan di research mode', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-research-read-'));
  setWorkspaceRoot(tmp);
  try {
    writeFileSync(join(tmp, 'notes.txt'), 'isi catatan bug', 'utf8');
    const readCall = '```tool\n{"tool": "read_file", "path": "notes.txt"}\n```';
    const provider = new FakeProvider([readCall, 'Catatan sudah dibaca.']);
    const ctx = new Context(baseConfig);
    const agent = new Agent(ctx, provider, baseConfig, async () => true, tmp);
    agent.sessionState.mode = 'research';

    const { result } = await captureConsole(() => agent.handleInstruction('baca notes.txt'));
    assert.equal(result, 'Catatan sudah dibaca.');
    const toolMsgs = provider.receivedMessages[1].filter((m) => m.role === 'tool');
    assert.ok(toolMsgs[0].content.includes('isi catatan bug'), 'isi file harus terbaca');
  } finally {
    setWorkspaceRoot(null);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('integrasi agent: npm test jalan di research mode, rm diblok', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-research-test-'));
  setWorkspaceRoot(tmp);
  try {
    // Skrip test ditulis sebagai file sungguhan (test.cjs), BUKAN `node -e "..."`
    // inline di package.json: npm menjalankan skrip lewat `cmd /d /s /c` di
    // Windows, dan kutip ganda bersarang di dalam skrip dirusak aturan strip
    // kutip cmd.exe — `node -e "console.log(...)"` gagal hanya di Windows
    // (CI PR #46: test ini 1 gagal di windows-latest 18.x/20.x, lolos di
    // Ubuntu/macOS). File .cjs tanpa kutip bekerja di semua platform.
    writeFileSync(join(tmp, 'test.cjs'), "console.log('TEST-RAN-OK');\n", 'utf8');
    writeFileSync(
      join(tmp, 'package.json'),
      JSON.stringify({ name: 'tmp-proj', scripts: { test: 'node test.cjs' } }),
      'utf8',
    );
    // NOTE: exec selalu jalan di process.cwd() (perilaku lama Ruko) — jadi
    // perintah test diarahkan dengan prefix `cd <dir> &&` yang memang
    // didukung allowlist research mode.
    // PERBAIKAN (CI Windows): tool call HARUS dibuat via JSON.stringify.
    // Template literal mentah menyisipkan path Windows apa adanya
    // (`cd C:\Users\... && npm test`) — backslash jadi escape JSON tak valid
    // (\U, \R, ...) sehingga JSON.parse di parseToolCalls melempar dan tool
    // call ditolak sebagai malformed HANYA di Windows (di Linux/macOS path
    // memakai `/` jadi JSON-nya valid). Ini penyebab Windows 18.x/20.x
    // masih merah di PR #46 setelah fix test.cjs.
    const testCall = JSON.stringify({ tool: 'exec', command: `cd ${tmp} && npm test` });
    const testCallBlock = `\`\`\`tool\n${testCall}\n\`\`\``;
    const provider = new FakeProvider([testCallBlock, 'Test sudah dijalankan.']);
    const ctx = new Context(baseConfig);
    const agent = new Agent(ctx, provider, baseConfig, async () => true, tmp);
    agent.sessionState.mode = 'research';

    // Diagnostik CI Windows: dicetak SEBELUM assert (kegagalan bisa terjadi
    // di assert `result` / tidak adanya panggilan ke-2) — ditulis ke file
    // (lihat writeResearchDebug), bukan ke stdout, karena pipeline TAP
    // mengawali output child dengan `# ` dan workflow command tidak dikenali.
    let result = '';
    let calls = 0;
    let toolContent = '(belum dieksekusi)';
    try {
      ({ result } = await captureConsole(() => agent.handleInstruction('jalankan test')));
      calls = provider.receivedMessages.length;
      const toolMsgs = (provider.receivedMessages[1] ?? []).filter((m) => m.role === 'tool');
      toolContent = toolMsgs[0]?.content ?? '(tidak ada tool message)';
    } catch (err) {
      toolContent = `THROW: ${err instanceof Error ? err.message : String(err)}`;
    }
    writeResearchDebug('npm', { result, calls, tool: toolContent.slice(0, 1500) });
    assert.equal(result, 'Test sudah dijalankan.');
    assert.ok(toolContent.includes('TEST-RAN-OK'), 'npm test harus benar-benar dieksekusi');

    // Perintah mutasi di sesi yang sama tetap diblok.
    const rmCall = '```tool\n{"tool": "exec", "command": "rm -rf node_modules"}\n```';
    const provider2 = new FakeProvider([rmCall, 'Perintah ditolak, lanjut baca saja.']);
    agent.setLlmProvider(provider2);
    let result2 = '';
    let calls2 = 0;
    let toolContent2 = '(belum dieksekusi)';
    try {
      ({ result: result2 } = await captureConsole(() =>
        agent.handleInstruction('hapus node_modules'),
      ));
      calls2 = provider2.receivedMessages.length;
      const toolMsgs2 = (provider2.receivedMessages[1] ?? []).filter((m) => m.role === 'tool');
      toolContent2 = toolMsgs2[0]?.content ?? '(tidak ada tool message)';
    } catch (err) {
      toolContent2 = `THROW: ${err instanceof Error ? err.message : String(err)}`;
    }
    writeResearchDebug('rm', { result: result2, calls: calls2, tool: toolContent2.slice(0, 1500) });
    assert.equal(result2, 'Perintah ditolak, lanjut baca saja.');
    assert.ok(toolContent2.includes('research mode aktif'));
  } finally {
    setWorkspaceRoot(null);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('/mode research: mengganti mode dan menampilkan definisi baru', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-research-mode-'));
  setWorkspaceRoot(tmp);
  try {
    const ctx = new Context(baseConfig);
    const agent = new Agent(ctx, new FakeProvider([]), baseConfig, async () => true, tmp);
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args.join(' '));
    const env: any = {
      ctx,
      agent,
      config: baseConfig,
      llm: { model: 'test-model', isConfigured: true },
      confirm: async () => true,
      updateConfig: () => {},
      handle: { stop: () => {}, getSessionId: () => null, setSessionId: () => {} },
    };
    try {
      await handleCommand('/mode research', env);
    } finally {
      console.log = origLog;
    }
    assert.equal(agent.sessionState.mode, 'research');
    assert.ok(logged.some((l) => l.includes('cari bug')), 'label mode harus menyebut cari bug');
    assert.ok(
      agent.systemPrompt().includes('RESEARCH (bug-hunting)'),
      'system prompt harus memuat addendum research mode',
    );
  } finally {
    setWorkspaceRoot(null);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('subagent mewarisi research mode: mutasi subagent ikut diblok', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ruko-research-sub-'));
  setWorkspaceRoot(tmp);
  try {
    const writeCall = '```tool\n{"tool": "write_file", "path": "sub-out.txt", "content": "x"}\n```';
    const provider = new FakeProvider([writeCall, 'Subagent selesai tanpa mengubah file.']);
    const result = await runSubagent(
      'tulis file sub-out.txt',
      {
        config: { ...baseConfig },
        llmProvider: provider,
      },
      { researchMode: true, workspaceRoot: tmp },
    );
    assert.ok(result.includes('Subagent selesai tanpa mengubah file.'));
    assert.equal(existsSync(join(tmp, 'sub-out.txt')), false, 'subagent tidak boleh membuat file');
  } finally {
    setWorkspaceRoot(null);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('research mode tidak memblokir delegate itu sendiri', async () => {
  const d = await evaluateDispatcherGate({ tool: 'delegate', args: {}, researchMode: true });
  assert.equal(d.allowed, true, 'delegate diizinkan — subagent-nya yang mewarisi research mode');
});
