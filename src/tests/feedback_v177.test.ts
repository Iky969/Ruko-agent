import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectRisk } from '../core/approval.js';
import { containsSensitiveFilePattern, runSubagent } from '../agent/subagent.js';
import { codeSearchTool } from '../agent/filetools.js';
import { DEFAULT_CONFIG } from '../types.js';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { createProvider } from '../agent/llm.js';
import { handleCommand } from '../agent/commands.js';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { takeSnapshot } from '../core/undo.js';

const approvalConfig = {
  ...DEFAULT_CONFIG,
  approvalEnabled: true,
  approvalAllowlist: [] as string[],
};

// ═══════════════════════════════════════════════════════════════════════════
// Item 1: Approval gate — rm on system-critical paths MUST be blocked
// ═══════════════════════════════════════════════════════════════════════════

test('Item 1: rm /etc (no flags) is BLOCKED, not merely dangerous', () => {
  const v = detectRisk('rm /etc', approvalConfig);
  assert.equal(v.risk, 'blocked', `rm /etc should be blocked, got: ${v.risk} — ${v.reason}`);
});

test('Item 1: rm -r /etc is BLOCKED', () => {
  const v = detectRisk('rm -r /etc', approvalConfig);
  assert.equal(v.risk, 'blocked', `rm -r /etc should be blocked, got: ${v.risk}`);
});

test('Item 1: rm -rf /etc is BLOCKED', () => {
  const v = detectRisk('rm -rf /etc', approvalConfig);
  assert.equal(v.risk, 'blocked', `rm -rf /etc should be blocked, got: ${v.risk}`);
});

test('Item 1: rmdir /usr is BLOCKED', () => {
  const v = detectRisk('rmdir /usr', approvalConfig);
  assert.equal(v.risk, 'blocked', `rmdir /usr should be blocked, got: ${v.risk}`);
});

test('Item 1: rm / is BLOCKED', () => {
  const v = detectRisk('rm /', approvalConfig);
  assert.equal(v.risk, 'blocked');
});

test('Item 1: rm /boot/grub is BLOCKED', () => {
  const v = detectRisk('rm /boot/grub', approvalConfig);
  assert.equal(v.risk, 'blocked');
});

test('Item 1: rm -r /home is BLOCKED', () => {
  const v = detectRisk('rm -r /home', approvalConfig);
  assert.equal(v.risk, 'blocked');
});

test('Item 1: rm -rf /var/log is BLOCKED', () => {
  const v = detectRisk('rm -rf /var/log', approvalConfig);
  assert.equal(v.risk, 'blocked');
});

test('Item 1: sudo rm /bin is BLOCKED', () => {
  const v = detectRisk('sudo rm /bin', approvalConfig);
  assert.equal(v.risk, 'blocked');
});

test('Item 1: rm within workspace is DANGEROUS (not blocked)', () => {
  const v = detectRisk('rm myfile.txt', approvalConfig);
  assert.equal(v.risk, 'dangerous', 'rm in workspace should be dangerous, not blocked');
});

test('Item 1: variable substitution hiding rm /etc is still BLOCKED (VULN-01 consistency)', () => {
  const v = detectRisk('DIR=/etc; rm -rf $DIR', approvalConfig);
  assert.equal(v.risk, 'blocked', 'Variable-substituted rm on /etc must still be blocked');
});

test('Item 1: bash -c "rm -rf /etc" is BLOCKED (quote stripping)', () => {
  const v = detectRisk('bash -c "rm -rf /etc"', approvalConfig);
  assert.equal(v.risk, 'blocked');
});

// ═══════════════════════════════════════════════════════════════════════════
// Item 2: /login refreshes provider in active session
// ═══════════════════════════════════════════════════════════════════════════

test('Item 2: /login replaces agent provider instance without process restart', async () => {
  const config = {
    ...DEFAULT_CONFIG,
    provider: 'gemini',
    apiKey: 'old-gemini-key',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: 'gemini-1.5-flash',
  };

  const providerA = createProvider(config);
  const ctx = new Context(config);
  const agent = new Agent(ctx, providerA, config);

  assert.equal(agent.llm.name, 'gemini', 'Initial provider should be gemini');

  // Simulate /login with OpenAI-compatible endpoint
  const answers = ['new-sk-test-12345', 'http://localhost:11434/v1', 'y', 'llama3', 's'];
  let askIndex = 0;

  const commandEnv = {
    ctx,
    config,
    llm: agent.llm,
    agent,
    confirm: async () => true,
    ask: async (_q: string) => answers[askIndex++] ?? '',
    askSecret: async (_q: string) => answers[askIndex++] ?? '',
    updateConfig: (patch: Partial<typeof config>) => {
      Object.assign(config, patch);
    },
    handle: {
      stop: () => {},
      getSessionId: () => null,
      setSessionId: () => {},
    },
  };

  await handleCommand('/login', commandEnv);

  // Verify provider was replaced in the agent
  assert.notEqual(agent.llm, providerA, 'Agent provider must not be the old instance');
  assert.equal(agent.llm.name, 'openai-compatible', 'Agent should now hold openai-compatible provider');
  assert.equal(agent.llm.model, 'llama3', 'Agent provider model should be updated');

  // Verify next request uses the new provider
  let chatCalledOnNewProvider = false;
  (agent.llm as any).chat = async () => {
    chatCalledOnNewProvider = true;
    return 'Response from new provider';
  };
  await agent.handleInstruction('test');
  assert.equal(chatCalledOnNewProvider, true, 'Next request must route to new provider B');
});

// ═══════════════════════════════════════════════════════════════════════════
// Item 3: .ruko/trusted in containsSensitiveFilePattern (subagent.ts)
// ═══════════════════════════════════════════════════════════════════════════

test('Item 3: containsSensitiveFilePattern detects .ruko/trusted', () => {
  assert.equal(containsSensitiveFilePattern('read .ruko/trusted'), true,
    '.ruko/trusted should be detected as sensitive');
});

test('Item 3: containsSensitiveFilePattern detects .ruko/trusted with forward slash', () => {
  assert.equal(containsSensitiveFilePattern('cat /project/.ruko/trusted'), true);
});

test('Item 3: containsSensitiveFilePattern detects .ruko/trusted with backslash', () => {
  assert.equal(containsSensitiveFilePattern('cat .ruko\\trusted'), true);
});

test('Item 3: containsSensitiveFilePattern still detects .ruko/config.json', () => {
  assert.equal(containsSensitiveFilePattern('read .ruko/config.json'), true);
});

test('Item 3: containsSensitiveFilePattern detects .pem and .key files', () => {
  assert.equal(containsSensitiveFilePattern('read server.pem'), true);
  assert.equal(containsSensitiveFilePattern('read private.key'), true);
});

test('Item 3: containsSensitiveFilePattern detects id_ecdsa and id_dsa (expanded coverage)', () => {
  assert.equal(containsSensitiveFilePattern('cat ~/.ssh/id_ecdsa'), true);
  assert.equal(containsSensitiveFilePattern('cat ~/.ssh/id_dsa'), true);
});

test('Item 3: containsSensitiveFilePattern rejects safe paths', () => {
  assert.equal(containsSensitiveFilePattern('read src/main.ts'), false);
  assert.equal(containsSensitiveFilePattern('read README.md'), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Item 4: code_search regex alternation auto-detection
// ═══════════════════════════════════════════════════════════════════════════

test('Item 4: code_search with regex alternation returns results without explicit isRegex', async () => {
  // Create a temporary test file
  const tmpDir = mkdtempSync(join(tmpdir(), 'ruko-test-search-'));
  const testFile = join(tmpDir, 'test_search.txt');
  writeFileSync(testFile, 'This has a limitation\nThis is a known issue\nThis is a todo item\nNormal line\n');

  try {
    // Search with alternation pattern — should auto-detect regex
    const result = await codeSearchTool('(limitation|known issue|todo)', { path: '.' }, tmpDir);
    assert.equal(result.ok, true, 'code_search should succeed');
    assert.ok(result.totalMatches >= 3, `Should find at least 3 matches, found ${result.totalMatches}`);
    assert.ok(result.text.includes('limitation'), 'Should match limitation');
    assert.ok(result.text.includes('known issue'), 'Should match known issue');
    assert.ok(result.text.includes('todo'), 'Should match todo');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Item 4: code_search with explicit isRegex:true still works', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ruko-test-search-'));
  const testFile = join(tmpDir, 'test_search.txt');
  writeFileSync(testFile, 'error: something\nwarning: another\ninfo: normal\n');

  try {
    const result = await codeSearchTool('(error|warning)', { isRegex: true }, tmpDir);
    assert.equal(result.ok, true);
    assert.equal(result.totalMatches, 2, 'Should find exactly 2 matches');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Item 4: code_search plain text without regex metacharacters still works as literal', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ruko-test-search-'));
  writeFileSync(join(tmpDir, 'test.txt'), 'hello world\ngoodbye world\n');

  try {
    const result = await codeSearchTool('hello world', {}, tmpDir);
    assert.equal(result.ok, true);
    assert.equal(result.totalMatches, 1, 'Should find exactly 1 match for literal search');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Item 4: code_search with invalid auto-detected regex falls back to literal', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ruko-test-search-'));
  writeFileSync(join(tmpDir, 'test.txt'), 'text with (bad|regex[\n');

  try {
    // This has | and ( but is actually invalid regex — should fallback to literal
    const result = await codeSearchTool('(bad|regex[', {}, tmpDir);
    assert.equal(result.ok, true, 'Should succeed with literal fallback');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Item 5: Subagent timeout reports modified files
// ═══════════════════════════════════════════════════════════════════════════

test('Item 5: subagent timeout message includes file modification report', async () => {
  const config = {
    ...DEFAULT_CONFIG,
  };
  const tempUndoDir = mkdtempSync(join(tmpdir(), 'ruko-test-undo-'));
  const origUndoDir = process.env.RUKO_UNDO_DIR;
  process.env.RUKO_UNDO_DIR = tempUndoDir;

  // Mock provider with isConfigured as a property (not a getter)
  const mockProvider = {
    name: 'mock',
    model: 'mock-model',
    isConfigured: true,
    lastFinishReason: 'stop',
    chat: async (_msgs: unknown, opts: any) => {
      return new Promise<string>((_, reject) => {
        const onAbort = () => reject(new Error('aborted'));
        if (opts?.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        opts?.signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    setModel: () => {},
    setCredentials: () => {},
  } as any;

  try {
    const result = await runSubagent(
      'do something slow',
      { config, llmProvider: mockProvider },
      { timeoutMs: 100 },
    );

    assert.ok(result.includes('timed out'), `Result should mention timeout: ${result}`);
    assert.ok(
      result.includes('Tidak ada file yang termodifikasi'),
      `Result should report no file modification: ${result}`,
    );
  } finally {
    if (origUndoDir !== undefined) {
      process.env.RUKO_UNDO_DIR = origUndoDir;
    } else {
      delete process.env.RUKO_UNDO_DIR;
    }
    rmSync(tempUndoDir, { recursive: true, force: true });
  }
});

test('Item 5: subagent timeout message includes rollback instructions when files are modified', async () => {
  const config = { ...DEFAULT_CONFIG };
  const tempUndoDir = mkdtempSync(join(tmpdir(), 'ruko-test-undo-'));
  const origUndoDir = process.env.RUKO_UNDO_DIR;
  process.env.RUKO_UNDO_DIR = tempUndoDir;

  const mockProvider = {
    name: 'mock',
    model: 'mock-model',
    isConfigured: true,
    lastFinishReason: 'stop',
    chat: async (_msgs: unknown, opts: any) => {
      // Simulate file modified before timeout
      const dummyFile = join(tempUndoDir, 'modified_sample.txt');
      writeFileSync(dummyFile, 'subagent changed this');
      takeSnapshot(dummyFile, tempUndoDir);

      return new Promise<string>((_, reject) => {
        if (opts?.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
    setModel: () => {},
    setCredentials: () => {},
  } as any;

  try {
    const result = await runSubagent(
      'test task',
      { config, llmProvider: mockProvider },
      { timeoutMs: 50 },
    );

    assert.ok(result.includes('timed out after 50ms'), 'Should include timeout duration');
    assert.ok(result.includes('file termodifikasi'), 'Should report modified files');
    assert.ok(result.includes('Opsi rollback'), 'Should include rollback options');
    assert.ok(result.includes('/undo'), 'Should suggest /undo command');
  } finally {
    if (origUndoDir !== undefined) {
      process.env.RUKO_UNDO_DIR = origUndoDir;
    } else {
      delete process.env.RUKO_UNDO_DIR;
    }
    rmSync(tempUndoDir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Item 6: Delegate sequential nature is documented
// ═══════════════════════════════════════════════════════════════════════════

test('Item 6: README.md documents delegate sequential execution model', async () => {
  const { readFile } = await import('node:fs/promises');
  const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8');
  assert.ok(readme.includes('sekuensial'), 'README should mention sequential execution');
  assert.ok(readme.includes('bukan concurrent/paralel') || readme.includes('bukan concurrent'),
    'README should explicitly state not concurrent/parallel');
  assert.ok(readme.includes('timeout'), 'README should mention timeout');
});

test('Item 6: tools.ts delegate handler has docstring about sequential execution', async () => {
  const { readFile } = await import('node:fs/promises');
  const toolsSrc = await readFile(join(process.cwd(), 'src', 'agent', 'tools.ts'), 'utf8');
  assert.ok(toolsSrc.includes('Sifat Eksekusi Sekuensial'), 'tools.ts should have sequential execution docstring');
  assert.ok(toolsSrc.includes('SATU tool call per giliran'), 'tools.ts should document one-call-per-turn');
});
