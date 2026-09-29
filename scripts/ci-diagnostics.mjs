#!/usr/bin/env node
/**
 * CI failure diagnostics — printed only when a matrix job fails.
 *
 * Zero dependency (`node:*` only). Focus: platform/env facts that explain the
 * class of bug this workflow guards against (path & file-URL handling, temp
 * directory shapes, shell family, redacted environment).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const line = (label, value) => console.log(`${label.padEnd(28)}: ${value}`);

console.log('── Ruko CI diagnostics ───────────────────────────────');
line('node', process.version);
line('platform', `${process.platform} ${process.arch}`);
line('cwd', process.cwd());
line('shell (npm_config_shell)', process.env.npm_config_shell ?? '(default)');
line('ComSpec', process.env.ComSpec ?? '(none)');
line('TERM / NO_COLOR', `${process.env.TERM ?? '(none)'} / ${process.env.NO_COLOR ?? '(unset)'}`);

// Temp directory is the usual Windows offender: it contains the user profile.
const tmp = tmpdir();
line('os.tmpdir()', tmp);
line('tmpdir file URL', pathToFileURL(tmp.endsWith(sep) ? tmp : tmp + sep).href);
line('tmpdir round-trip ok', fileURLToPath(pathToFileURL(tmp)) === tmp);

// Reproduce the URL shapes involved, so a failing job explains itself.
const cliEntry = join(process.cwd(), 'dist', 'index.js');
line('CLI entry exists', existsSync(cliEntry));
line('CLI entry (path)', cliEntry);
line('CLI entry (file URL)', pathToFileURL(cliEntry).href);
line('naive concat (INVALID)', `file://${cliEntry}`);

const testsDir = join(process.cwd(), 'dist', 'tests');
line('dist/tests exists', existsSync(testsDir));
if (existsSync(testsDir)) {
  const compiled = readdirSync(testsDir, { withFileTypes: true });
  line('dist/tests entries', compiled.length);
  const newest = compiled
    .filter((e) => e.isFile())
    .map((e) => ({ name: e.name, mtime: statSync(join(testsDir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (newest) line('dist/tests newest', `${newest.name} (${new Date(newest.mtime).toISOString()})`);
}

// Environment keys only — never values (API keys may live here).
const rukoKeys = Object.keys(process.env)
  .filter((key) => key.startsWith('RUKO_') || key === 'CI')
  .sort();
line('RUKO_*/CI keys', rukoKeys.length ? rukoKeys.join(', ') : '(none)');

// ─── Probe glob/code_search: reproduksi isPathInsideWorkspace pada path tmp ───
// Cluster kegagalan CI Windows: walkDirectory membuang subdirektori karena
// mismatch bentuk path 8.3 vs long-name. Probe ini menampilkan bentuk nyata
// di runner yang gagal sehingga akar masalah terlihat di log.
try {
  const fs = await import('node:fs');
  const probeRoot = fs.mkdtempSync(join(tmp, 'ruko-probe-'));
  fs.mkdirSync(join(probeRoot, 'sub'), { recursive: true });
  fs.writeFileSync(join(probeRoot, 'sub', 'file.ts'), 'probe\n', 'utf8');
  line('probe root (raw)', probeRoot);
  line('probe root realpath', fs.realpathSync(probeRoot));
  line('probe subdir realpath', fs.realpathSync(join(probeRoot, 'sub')));
  line('cwd realpath', fs.realpathSync(process.cwd()));
  line('cwd === realpath(cwd)', process.cwd() === fs.realpathSync(process.cwd()));
  line('tmpdir === realpath(tmpdir)', tmp === fs.realpathSync(tmp));
  fs.rmSync(probeRoot, { recursive: true, force: true });
} catch (err) {
  line('probe error', err instanceof Error ? err.message : String(err));
}
console.log('──────────────────────────────────────────────────────');
