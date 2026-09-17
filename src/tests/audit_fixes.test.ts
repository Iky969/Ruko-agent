import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codeSearchTool } from '../agent/filetools.js';
import { OpenAiCompatibleProvider } from '../agent/llm.js';
import { sanitizeConfigFile } from '../core/config.js';
import { formatTerminalMarkdown, TerminalMarkdownFormatter } from '../core/ui.js';
import { takeSnapshot, undoLast, validateSnapshotPath } from '../core/undo.js';

test('Finding 1: codeSearchTool finds all matching lines without regex lastIndex skip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-search-test-'));
  try {
    const testFile = join(dir, 'test.txt');
    // Consecutive lines matching regex
    writeFileSync(testFile, 'match line 1\nmatch line 2\nshort\nmatch line 3\n', 'utf8');
    const result = await codeSearchTool('match', { isRegex: true }, dir);
    assert.equal(result.ok, true);
    assert.ok(result.text.includes('match line 1'));
    assert.ok(result.text.includes('match line 2'));
    assert.ok(result.text.includes('match line 3'));
    assert.equal(result.totalMatches, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Finding 2: validateSnapshotPath blocks traversal and sensitive paths', () => {
  const ws = '/workspaces/project';
  // Outside workspace
  assert.throws(() => validateSnapshotPath('/etc/passwd', ws), /di luar workspace/);
  assert.throws(() => validateSnapshotPath('/workspaces/other/file.txt', ws), /di luar workspace/);

  // Sensitive paths inside workspace
  assert.throws(() => validateSnapshotPath(join(ws, '.ruko', 'config.json'), ws), /terproteksi/);
  assert.throws(() => validateSnapshotPath(join(ws, '.ruko', 'undo', '123.content'), ws), /terproteksi/);
  assert.throws(() => validateSnapshotPath(join(ws, '.env'), ws), /terproteksi/);
  assert.throws(() => validateSnapshotPath(join(ws, '.env.production'), ws), /terproteksi/);
  assert.throws(() => validateSnapshotPath(join(ws, 'id_rsa'), ws), /terproteksi/);

  // Safe file inside workspace
  assert.doesNotThrow(() => validateSnapshotPath(join(ws, 'src', 'index.ts'), ws));
});

test('Finding 2: undoLast rejects restoring a snapshot pointing outside workspace', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-undo-ws-'));
  const undoDir = join(ws, '.ruko', 'undo');
  try {
    // Manually forge or simulate a snapshot with outside path
    const outsideFile = join(tmpdir(), 'outside.txt');
    const snapshot = takeSnapshot(outsideFile, undoDir);
    assert.ok(snapshot);

    assert.throws(() => {
      undoLast(undoDir, ws);
    }, /di luar workspace/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('Finding 3: sanitizeConfigFile preserves provider and maxOutputTokens', () => {
  const raw = {
    provider: 'gemini',
    maxOutputTokens: 8192,
    model: 'gemini-1.5-pro',
    maxLogChars: 2000,
  };
  const clean = sanitizeConfigFile(raw);
  assert.equal(clean.provider, 'gemini');
  assert.equal(clean.maxOutputTokens, 8192);
  assert.equal(clean.model, 'gemini-1.5-pro');
  assert.equal(clean.maxLogChars, 2000);
});

test('Finding 4: TerminalMarkdownFormatter maintains code block state across streaming chunks', () => {
  const formatter = new TerminalMarkdownFormatter(false);

  // Line 1: Code fence start
  const chunk1 = formatter.format('```python\n');
  assert.equal(chunk1, '```python\n');

  // Line 2: Code content containing bold syntax and asterisks
  const chunk2 = formatter.format('def test(**kwargs):\n');
  assert.equal(chunk2, 'def test(**kwargs):\n', 'inside code block, syntax must remain untouched');

  // Line 3: Code fence end
  const chunk3 = formatter.format('```\n');
  assert.equal(chunk3, '```\n');

  // Line 4: Outside code block
  const chunk4 = formatter.format('Now this is **bold** text.\n');
  assert.equal(chunk4, 'Now this is bold text.\n', 'outside code block, bold is formatted');
});

test('Finding 4: formatTerminalMarkdown protects inline code containing asterisks', () => {
  const input = 'Use parameter `**kwargs` or `*args` in your function.';
  const plain = formatTerminalMarkdown(input, false);
  assert.equal(plain, 'Use parameter **kwargs or *args in your function.');

  const colored = formatTerminalMarkdown(input, true);
  assert.ok(colored.includes('\u001b[33m**kwargs\u001b[0m'));
  assert.ok(!colored.includes('\u001b[1;36m')); // No bold color triggered
});

test('Finding 5: OpenAiCompatibleProvider strips surrounding quotes from baseUrl and apiKey', () => {
  const provider = new OpenAiCompatibleProvider({
    apiKey: '"sk-test-12345"',
    baseUrl: "'https://api.openai.com/v1/'",
    model: '"gpt-4o"',
  });

  assert.equal(provider.model, 'gpt-4o');
  // Test via setCredentials as well
  provider.setCredentials('  "sk-new-key"  ', " 'https://api.deepseek.com/v1/' ");
  assert.equal((provider as any).apiKey, 'sk-new-key');
  assert.equal((provider as any).baseUrl, 'https://api.deepseek.com/v1');
});
