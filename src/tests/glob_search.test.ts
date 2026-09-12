import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import {
  codeSearchTool,
  globTool,
  globToRegex,
  IGNORED_DIRS,
  isBinaryFile,
  walkDirectory,
} from '../agent/filetools.js';
import { parseToolCalls, runToolCall } from '../agent/tools.js';

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruko-glob-search-'));

  // Create normal project directory structure
  await fs.mkdir(path.join(tmpDir, 'src', 'utils'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'src', 'agent'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'docs'), { recursive: true });

  // Create ignored directories
  for (const dir of IGNORED_DIRS) {
    await fs.mkdir(path.join(tmpDir, dir), { recursive: true });
    await fs.writeFile(path.join(tmpDir, dir, 'hidden.ts'), 'export const secret = 123;\n');
  }

  // Create text files
  await fs.writeFile(
    path.join(tmpDir, 'src', 'index.ts'),
    '// Entry point\nimport { helper } from "./utils/helper.js";\nconsole.log("start");\nhelper();\n',
  );
  await fs.writeFile(
    path.join(tmpDir, 'src', 'utils', 'helper.ts'),
    'export function helper() {\n  // helper function\n  console.log("helper called");\n  return 42;\n}\n',
  );
  await fs.writeFile(
    path.join(tmpDir, 'src', 'agent', 'tools.ts'),
    'export const tools = ["glob", "code_search", "read_file"];\n// helper tool setup\nexport function setup() {}\n',
  );
  await fs.writeFile(
    path.join(tmpDir, 'docs', 'readme.md'),
    '# Documentation\nThis is helper documentation.\nSee index.ts for usage.\n',
  );
  await fs.writeFile(
    path.join(tmpDir, 'package.json'),
    '{\n  "name": "test-pkg",\n  "version": "1.0.0"\n}\n',
  );

  // Create binary file (with image extension and with null bytes)
  await fs.writeFile(path.join(tmpDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  await fs.writeFile(
    path.join(tmpDir, 'data.bin'),
    Buffer.concat([Buffer.from('BINARY_DATA'), Buffer.alloc(32, 0)]),
  );
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// --- globToRegex unit tests ---
test('globToRegex matches simple extensions and wildcards', () => {
  const tsRe = globToRegex('*.ts');
  assert.equal(tsRe.test('index.ts'), true);
  assert.equal(tsRe.test('src/index.ts'), true);
  assert.equal(tsRe.test('index.js'), false);

  const nestedRe = globToRegex('src/**/*.ts');
  assert.equal(nestedRe.test('src/index.ts'), true);
  assert.equal(nestedRe.test('src/utils/helper.ts'), true);
  assert.equal(nestedRe.test('docs/readme.md'), false);

  const starRe = globToRegex('*');
  assert.equal(starRe.test('anything.txt'), true);
});

// --- globTool tests ---
test('globTool lists files matching pattern while skipping ignored directories', async () => {
  const r = await globTool('*.ts', {}, tmpDir);
  assert.equal(r.ok, true);
  assert.ok(r.files.length >= 3);
  assert.ok(r.files.some((f) => f.includes('src/index.ts')));
  assert.ok(r.files.some((f) => f.includes('src/utils/helper.ts')));
  assert.ok(r.files.some((f) => f.includes('src/agent/tools.ts')));

  // Must NOT include files from ignored dirs
  for (const ignored of IGNORED_DIRS) {
    assert.ok(
      !r.files.some((f) => f.includes(`${ignored}/`)),
      `glob must skip ${ignored}`,
    );
  }
});

test('globTool filters by subpath directory pattern', async () => {
  const r = await globTool('src/utils/*.ts', {}, tmpDir);
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 1);
  assert.ok(r.files[0].endsWith('helper.ts'));
});

test('globTool skips binary files', async () => {
  const r = await globTool('*', {}, tmpDir);
  assert.equal(r.ok, true);
  assert.ok(!r.files.some((f) => f.endsWith('.png')));
  assert.ok(!r.files.some((f) => f.endsWith('.bin')));
});

test('globTool respects limit cap and marks truncated', async () => {
  const r = await globTool('*', { limit: 2 }, tmpDir);
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 2);
  assert.equal(r.truncated, true);
  assert.ok(r.totalFound > 2);
  assert.match(r.text, /hasil terpotong/);
});

test('globTool reports when no files match', async () => {
  const r = await globTool('*.nonexistent', {}, tmpDir);
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 0);
  assert.equal(r.totalFound, 0);
  assert.match(r.text, /Tidak ada file yang cocok/);
});

test('globTool returns error on invalid start directory', async () => {
  const r = await globTool('*.ts', { path: 'non_existent_folder_xyz' }, tmpDir);
  assert.equal(r.ok, false);
  assert.match(r.text, /tidak ditemukan/);
});

test('globTool and walkDirectory safely handle symlink loops without hanging', async () => {
  const loopDir = path.join(tmpDir, 'src', 'symloop');
  try {
    await fs.mkdir(loopDir, { recursive: true });
    // create symlink pointing back to parent
    await fs.symlink(loopDir, path.join(loopDir, 'self-link'));

    const r = await globTool('*.ts', { path: 'src' }, tmpDir);
    assert.equal(r.ok, true);
  } catch (err) {
    // Windows or environment without symlink privileges: ignore
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
  }
});

// --- codeSearchTool tests ---
test('codeSearchTool finds literal query with line numbers and context', async () => {
  const r = await codeSearchTool('helper', {}, tmpDir);
  assert.equal(r.ok, true);
  assert.ok(r.totalMatches >= 3);
  assert.ok(r.totalFiles >= 2);
  assert.match(r.text, />\s*\d+\|\s*.*helper/);
  assert.match(r.text, /Menemukan \d+ kecocokan/);
});

test('codeSearchTool respects caseSensitive option', async () => {
  const caseSensitiveMatch = await codeSearchTool('HELPER', { caseSensitive: true }, tmpDir);
  assert.equal(caseSensitiveMatch.totalMatches, 0);

  const caseInsensitiveMatch = await codeSearchTool('HELPER', { caseSensitive: false }, tmpDir);
  assert.ok(caseInsensitiveMatch.totalMatches > 0);
});

test('codeSearchTool supports regex search', async () => {
  const r = await codeSearchTool('helper\\(\\)', { isRegex: true }, tmpDir);
  assert.equal(r.ok, true);
  assert.ok(r.totalMatches >= 1);
  assert.match(r.text, /helper\(\)/);
});

test('codeSearchTool filters by extension', async () => {
  const r = await codeSearchTool('helper', { extension: 'md' }, tmpDir);
  assert.equal(r.ok, true);
  assert.equal(r.totalFiles, 1);
  assert.match(r.text, /docs\/readme\.md/);
});

test('codeSearchTool searches a specific file path', async () => {
  const r = await codeSearchTool('helper', { path: 'src/utils/helper.ts' }, tmpDir);
  assert.equal(r.ok, true);
  assert.equal(r.totalFiles, 1);
  assert.match(r.text, /src\/utils\/helper\.ts/);
});

test('codeSearchTool respects limit cap and truncates cleanly', async () => {
  const r = await codeSearchTool('helper', { limit: 1 }, tmpDir);
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.match(r.text, /hasil terpotong/);
  assert.match(r.text, /\[\.\.\. Hasil dibatasi 1 kecocokan/);
});

test('codeSearchTool reports error on missing or empty query', async () => {
  const r = await codeSearchTool('', {}, tmpDir);
  assert.equal(r.ok, false);
  assert.match(r.text, /missing "query"/);
});

test('codeSearchTool reports error on invalid regex', async () => {
  const r = await codeSearchTool('([a-z', { isRegex: true }, tmpDir);
  assert.equal(r.ok, false);
  assert.match(r.text, /regex tidak valid/);
});

test('codeSearchTool reports when no matches are found', async () => {
  const r = await codeSearchTool('xyz_completely_absent_term', {}, tmpDir);
  assert.equal(r.ok, true);
  assert.equal(r.totalMatches, 0);
  assert.match(r.text, /Tidak ditemukan kecocokan/);
});

test('codeSearchTool skips ignored directories and binary files', async () => {
  const r = await codeSearchTool('secret', {}, tmpDir);
  // 'secret' is in hidden.ts inside ignored directories, so it must not be found
  assert.equal(r.totalMatches, 0);

  const binSearch = await codeSearchTool('BINARY_DATA', {}, tmpDir);
  assert.equal(binSearch.totalMatches, 0);
});

// --- runToolCall protocol integration tests ---
test('runToolCall dispatches glob call', async () => {
  const calls = parseToolCalls(
    '```tool\n' + JSON.stringify({ tool: 'glob', pattern: '*.ts', path: tmpDir }) + '\n```',
  );
  assert.equal(calls.length, 1);
  const out = await runToolCall(calls[0]);
  assert.match(out, /Menemukan \d+ file/);
});

test('runToolCall dispatches code_search call', async () => {
  const calls = parseToolCalls(
    '```tool\n' + JSON.stringify({ tool: 'code_search', query: 'helper', path: tmpDir }) + '\n```',
  );
  assert.equal(calls.length, 1);
  const out = await runToolCall(calls[0]);
  assert.match(out, /Menemukan \d+ kecocokan/);
});

test('runToolCall reports code_search missing query', async () => {
  const out = await runToolCall({ tool: 'code_search' });
  const parsed = JSON.parse(out);
  assert.match(parsed.error, /missing "query"/);
});

test('plan mode permits glob and code_search (read-only inspection)', async () => {
  const globResult = await runToolCall(
    { tool: 'glob', pattern: '*.ts', path: tmpDir },
    { planMode: true },
  );
  assert.ok(!globResult.includes('plan mode aktif: tool "glob" diblok'));

  const searchResult = await runToolCall(
    { tool: 'code_search', query: 'helper', path: tmpDir },
    { planMode: true },
  );
  assert.ok(!searchResult.includes('plan mode aktif: tool "code_search" diblok'));
});
