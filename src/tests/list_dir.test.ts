import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { listDirTool } from '../agent/filetools.js';
import { parseToolCalls, runToolCall, setWorkspaceRoot } from '../agent/tools.js';
import { inferStepDescription } from '../core/ui.js';

let tmpDir: string;

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruko-listdir-test-'));
  setWorkspaceRoot(tmpDir);

  // Normal structure
  await fs.mkdir(path.join(tmpDir, 'src'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'docs'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'empty_dir'), { recursive: true });

  await fs.writeFile(path.join(tmpDir, 'src', 'index.ts'), 'console.log("hello");\n');
  await fs.writeFile(path.join(tmpDir, 'package.json'), '{"name":"pkg","version":"1.0.0"}\n');
  await fs.writeFile(path.join(tmpDir, 'README.md'), '# Readme documentation\n');

  // Dotfiles / hidden
  await fs.mkdir(path.join(tmpDir, '.hidden_dir'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, '.hidden_file'), 'hidden\n');

  // Sensitive files
  const rukoDir = path.join(tmpDir, '.ruko');
  await fs.mkdir(rukoDir, { recursive: true });
  await fs.writeFile(path.join(rukoDir, 'config.json'), '{"apiKey":"secret"}');
  await fs.writeFile(path.join(tmpDir, '.env'), 'SECRET_KEY=123');
  await fs.writeFile(path.join(tmpDir, 'secret.key'), 'PRIVATE_KEY_DATA');

  // Symlink
  try {
    await fs.symlink(path.join(tmpDir, 'README.md'), path.join(tmpDir, 'link_to_readme'));
  } catch {
    // Some systems may disallow symlinks without admin
  }
});

after(async () => {
  setWorkspaceRoot(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('listDirTool lists directory contents with [DIR] and [FILE] with sizes', async () => {
  const r = await listDirTool('.', {}, tmpDir);
  assert.equal(r.ok, true);
  assert.ok(r.totalEntries >= 4);
  assert.match(r.text, /Direktori: \. \(\d+ entri\):/);
  assert.match(r.text, /\[DIR\]\s+docs\//);
  assert.match(r.text, /\[DIR\]\s+src\//);
  assert.match(r.text, /\[FILE\]\s+package\.json \(\d+ B\)/);
  assert.match(r.text, /\[FILE\]\s+README\.md \(\d+ B\)/);

  // Directories must be sorted first
  const dirIndex = r.entries.findIndex((e) => e.type === 'directory');
  const fileIndex = r.entries.findIndex((e) => e.type === 'file');
  assert.ok(dirIndex !== -1 && fileIndex !== -1);
  assert.ok(dirIndex < fileIndex, 'directories should precede files in listing');
});

test('listDirTool defaults to workspace root when path is omitted or empty', async () => {
  const rEmpty = await listDirTool('', {}, tmpDir);
  assert.equal(rEmpty.ok, true);
  assert.match(rEmpty.text, /Direktori: \./);

  const rDefault = await listDirTool(undefined, {}, tmpDir);
  assert.equal(rDefault.ok, true);
  assert.match(rDefault.text, /Direktori: \./);
});

test('listDirTool lists subdirectories specifically', async () => {
  const r = await listDirTool('src', {}, tmpDir);
  assert.equal(r.ok, true);
  assert.equal(r.totalEntries, 1);
  assert.match(r.text, /Direktori: src/);
  assert.match(r.text, /\[FILE\]\s+index\.ts/);
});

test('listDirTool handles empty directory cleanly', async () => {
  const r = await listDirTool('empty_dir', {}, tmpDir);
  assert.equal(r.ok, true);
  assert.equal(r.totalEntries, 0);
  assert.match(r.text, /Direktori 'empty_dir' kosong\./);
});

test('listDirTool respects limit cap and truncates cleanly', async () => {
  const r = await listDirTool('.', { limit: 2 }, tmpDir);
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.equal(r.entries.length, 2);
  assert.ok(r.totalEntries > 2);
  assert.match(r.text, /hasil terpotong/);
  assert.match(r.text, /\[\.\.\. Hasil dibatasi 2 entri/);
});

test('listDirTool rejects non-directory (file path)', async () => {
  const r = await listDirTool('package.json', {}, tmpDir);
  assert.equal(r.ok, false);
  assert.match(r.text, /adalah file, bukan direktori/);
});

test('listDirTool rejects non-existent directory', async () => {
  const r = await listDirTool('non_existent_folder', {}, tmpDir);
  assert.equal(r.ok, false);
  assert.match(r.text, /tidak ditemukan/);
});

test('listDirTool enforces workspace sandbox (rejects path outside workspace)', async () => {
  const r = await listDirTool('/etc', {}, tmpDir);
  assert.equal(r.ok, false);
  assert.match(r.text, /di luar working directory/);
});

test('listDirTool hides sensitive files and blocks direct sensitive path inspection', async () => {
  const r = await listDirTool('.', {}, tmpDir);
  assert.equal(r.ok, true);

  // Sensitive items in root must be omitted
  const names = r.entries.map((e) => e.name);
  assert.ok(!names.includes('.env'), '.env must be hidden');
  assert.ok(!names.includes('secret.key'), 'secret.key must be hidden');

  // Attempting to list directly inside sensitive file or dir
  const rSensitive = await listDirTool('.ruko/config.json', {}, tmpDir);
  assert.equal(rSensitive.ok, false);
  assert.match(rSensitive.text, /Akses ke file sensitif/);
});

test('listDirTool respects showHidden option', async () => {
  const rWithHidden = await listDirTool('.', { showHidden: true }, tmpDir);
  assert.equal(rWithHidden.ok, true);
  const namesWith = rWithHidden.entries.map((e) => e.name);
  assert.ok(namesWith.includes('.hidden_dir'));
  assert.ok(namesWith.includes('.hidden_file'));

  const rNoHidden = await listDirTool('.', { showHidden: false }, tmpDir);
  assert.equal(rNoHidden.ok, true);
  const namesWithout = rNoHidden.entries.map((e) => e.name);
  assert.ok(!namesWithout.includes('.hidden_dir'));
  assert.ok(!namesWithout.includes('.hidden_file'));
});

test('runToolCall dispatches list_dir and list_directory alias', async () => {
  const { calls } = parseToolCalls(
    '```tool\n' + JSON.stringify({ tool: 'list_dir', path: 'src' }) + '\n```',
  );
  assert.equal(calls.length, 1);
  const out = await runToolCall(calls[0], { workspaceRoot: tmpDir });
  assert.match(out, /Direktori: src/);
  assert.match(out, /index\.ts/);

  const outAlias = await runToolCall(
    { tool: 'list_directory', dir: 'src' },
    { workspaceRoot: tmpDir },
  );
  assert.match(outAlias, /Direktori: src/);
  assert.match(outAlias, /index\.ts/);
});

test('plan mode permits list_dir (read-only inspection)', async () => {
  const r = await runToolCall(
    { tool: 'list_dir', path: '.' },
    { workspaceRoot: tmpDir, planMode: true },
  );
  assert.ok(!r.includes('plan mode aktif: tool "list_dir" diblok'));
  assert.match(r, /Direktori: \./);
});

test('inferStepDescription recognizes list_dir tool calls', () => {
  const descSingle = inferStepDescription([{ tool: 'list_dir', path: '.' }], 1);
  assert.equal(descSingle, 'Membaca konfigurasi & struktur berkas');

  const descCombined = inferStepDescription(
    [{ tool: 'list_dir', path: '.' }, { tool: 'write_file', path: 'a.ts' }],
    1,
  );
  assert.equal(descCombined, 'Pemeriksaan dan modifikasi berkas proyek');
});
