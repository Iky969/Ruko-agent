/**
 * Issue #31 — Residual hardening post-audit (Qwen + Grok, cross-checked ke kode asli).
 *
 *  (a) Hardlink escape di secureReadFile: hardlink di dalam workspace yang menunjuk
 *      inode file sensitif di luar workspace WAJIB ditolak (HARDLINK_ESCAPE,
 *      fail-closed); file reguler nlink=1 tetap lolos tanpa regresi.
 *  (b) Env interpreter Python/Perl/Ruby (PYTHONSTARTUP, PYTHONPATH, PYTHONWARNINGS,
 *      PERL5OPT, PERL5LIB, RUBYOPT, RUBYLIB) tidak boleh lolos ke subprocess maupun
 *      dimuat dari .env workspace; env aplikasi normal tetap lolos.
 *
 * Test interpreter bersifat behavioral: payload nyata (sitecustomize.py / Evil.pm /
 * evil.rb) dengan positive control yang membuktikan payload MEMANG tereksekusi bila
 * env tidak di-strip — jadi test tidak bisa hijau secara vakum.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { secureReadFile, SecurityViolation } from '../core/tools/secureRead.js';
import { readFileTool } from '../agent/filetools.js';
import { execute, DANGEROUS_ENV_VARS } from '../core/executor.js';
import { DANGEROUS_WORKSPACE_ENV_VARS, isDangerousWorkspaceEnvVar, loadDotenv } from '../core/dotenv.js';

const isWin = process.platform === 'win32';

const INTERPRETER_VARS = [
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONWARNINGS',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
] as const;

function hasBinary(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Command node lintas-shell yang mencetak nilai env (null bila tidak ada) sebagai JSON. */
function envProbeCommand(keys: readonly string[]): string {
  const list = keys.map((k) => `'${k}'`).join(',');
  return `node -e "process.stdout.write(JSON.stringify([${list}].map(function(k){return process.env[k]===undefined?null:process.env[k]})))"`;
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) Hardlink escape
// ─────────────────────────────────────────────────────────────────────────────
describe('Issue #31 (a): secureReadFile hardlink escape detection', () => {
  let ws: string;
  let outside: string;
  let secretPath: string;
  let linkSupported = true;
  const SECRET = 'ROOT_PRIVATE_KEY_DO_NOT_LEAK_31';

  before(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), 'ruko-hl-ws-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'ruko-hl-out-'));
    secretPath = path.join(outside, 'id_rsa_fake');
    await fs.writeFile(secretPath, SECRET);
    await fs.writeFile(path.join(ws, 'regular.txt'), 'REGULAR_CONTENT');
    await fs.mkdir(path.join(ws, 'nested', 'deep'), { recursive: true });
    try {
      // Hardlink nama "innocent" di workspace → inode file sensitif di luar.
      await fs.link(secretPath, path.join(ws, 'notes.txt'));
      await fs.link(secretPath, path.join(ws, 'nested', 'deep', 'config.txt'));
    } catch {
      linkSupported = false; // FS tanpa dukungan hardlink (jarang) → skip kasus hardlink.
    }
  });

  after(async () => {
    await fs.rm(ws, { recursive: true, force: true }).catch(() => {});
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
  });

  test('ADV: hardlink ke file sensitif di luar workspace ditolak (HARDLINK_ESCAPE), isi rahasia tidak bocor', async (t) => {
    if (!linkSupported) return t.skip('fs.link tidak didukung filesystem ini');
    // Pre-condition: semua containment check berbasis path memang lolos
    // (realpath tetap di dalam workspace) — inilah kenapa butuh cek nlink.
    const real = fsSync.realpathSync(path.join(ws, 'notes.txt'));
    assert.ok(real.startsWith(fsSync.realpathSync(ws)), 'realpath hardlink tetap di dalam workspace');

    await assert.rejects(
      () => secureReadFile(ws, 'notes.txt'),
      (err: any) => {
        assert.ok(err instanceof SecurityViolation);
        assert.equal(err.code, 'HARDLINK_ESCAPE');
        assert.ok(!String(err.message).includes(SECRET), 'pesan error tidak boleh memuat isi file');
        return true;
      },
    );
  });

  test('ADV: hardlink di subdirektori bersarang & via path absolut juga ditolak', async (t) => {
    if (!linkSupported) return t.skip('fs.link tidak didukung filesystem ini');
    for (const p of ['nested/deep/config.txt', path.join(ws, 'nested', 'deep', 'config.txt')]) {
      await assert.rejects(
        () => secureReadFile(ws, p),
        (err: any) => err instanceof SecurityViolation && err.code === 'HARDLINK_ESCAPE',
        `harus ditolak: ${p}`,
      );
    }
  });

  test('ADV: read_file tool end-to-end menolak hardlink dan tidak mengembalikan isi rahasia', async (t) => {
    if (!linkSupported) return t.skip('fs.link tidak didukung filesystem ini');
    const res = await readFileTool('notes.txt', {}, ws);
    assert.equal(res.ok, false);
    assert.match(res.text, /hardlink/i);
    assert.ok(!res.text.includes(SECRET), 'isi file sensitif tidak boleh muncul di output tool');
  });

  test('Kebijakan fail-closed: hardlink sesama file workspace (st_dev sama) juga ditolak', async (t) => {
    // link(2) tidak bisa lintas device (EXDEV) → hardlink escape nyata SELALU st_dev
    // sama. Karena itu penolakan tidak boleh bergantung pada perbedaan st_dev.
    if (!linkSupported) return t.skip('fs.link tidak didukung filesystem ini');
    const a = path.join(ws, 'pair_a.txt');
    await fs.writeFile(a, 'PAIR');
    await fs.link(a, path.join(ws, 'pair_b.txt'));
    const [st, wsSt] = [fsSync.statSync(a), fsSync.statSync(ws)];
    assert.equal(st.dev, wsSt.dev, 'pre-condition: hardlink berada di device yang sama dengan workspace');
    await assert.rejects(
      () => secureReadFile(ws, 'pair_a.txt'),
      (err: any) => err instanceof SecurityViolation && err.code === 'HARDLINK_ESCAPE',
    );
  });

  test('Anti false-positive: file reguler nlink=1 tetap terbaca normal (secureReadFile & read_file)', async () => {
    assert.equal(fsSync.statSync(path.join(ws, 'regular.txt')).nlink, 1);
    const buf = await secureReadFile(ws, 'regular.txt');
    assert.equal(buf.toString('utf8'), 'REGULAR_CONTENT');
    const res = await readFileTool('regular.txt', {}, ws);
    assert.equal(res.ok, true);
    assert.match(res.text, /REGULAR_CONTENT/);
  });

  test('Anti false-positive: setelah nama di luar dihapus (nlink kembali 1) file terbaca lagi', async (t) => {
    if (!linkSupported) return t.skip('fs.link tidak didukung filesystem ini');
    const solo = path.join(outside, 'solo.txt');
    await fs.writeFile(solo, 'SOLO_CONTENT');
    await fs.link(solo, path.join(ws, 'solo.txt'));
    await assert.rejects(() => secureReadFile(ws, 'solo.txt'), (e: any) => e?.code === 'HARDLINK_ESCAPE');
    await fs.unlink(solo);
    assert.equal(fsSync.statSync(path.join(ws, 'solo.txt')).nlink, 1);
    const buf = await secureReadFile(ws, 'solo.txt');
    assert.equal(buf.toString('utf8'), 'SOLO_CONTENT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) Interpreter env injection — Python / Perl / Ruby
// ─────────────────────────────────────────────────────────────────────────────
describe('Issue #31 (b): Python/Perl/Ruby env injection tidak lolos ke subprocess', () => {
  let payloadDir: string;

  before(async () => {
    payloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruko-envinj-'));
    await fs.writeFile(path.join(payloadDir, 'sitecustomize.py'), 'print("PWNED_PY")\n');
    await fs.writeFile(path.join(payloadDir, 'Evil.pm'), 'package Evil; print "PWNED_PL\\n"; 1;\n');
    await fs.writeFile(path.join(payloadDir, 'evil.rb'), 'puts "PWNED_RB"\n');
  });

  after(async () => {
    await fs.rm(payloadDir, { recursive: true, force: true }).catch(() => {});
  });

  test('Denylist parity: ketujuh variabel ada di DANGEROUS_ENV_VARS (executor) & DANGEROUS_WORKSPACE_ENV_VARS (dotenv)', () => {
    for (const k of INTERPRETER_VARS) {
      assert.ok(DANGEROUS_ENV_VARS.has(k), `executor DANGEROUS_ENV_VARS harus memuat ${k}`);
      assert.ok(DANGEROUS_WORKSPACE_ENV_VARS.has(k), `dotenv DANGEROUS_WORKSPACE_ENV_VARS harus memuat ${k}`);
      assert.equal(isDangerousWorkspaceEnvVar(k), true);
      assert.equal(isDangerousWorkspaceEnvVar(k.toLowerCase()), true, `varian lowercase ${k} juga diblokir`);
    }
  });

  test('ADV: execute() membuang ketujuh env interpreter dari options.env, env aplikasi normal tetap lolos', async () => {
    const injected: Record<string, string> = {
      PYTHONSTARTUP: path.join(payloadDir, 'startup.py'),
      PYTHONPATH: payloadDir,
      PYTHONWARNINGS: 'ignore::evil.Category',
      PERL5OPT: '-MEvil',
      PERL5LIB: payloadDir,
      RUBYOPT: '-revil',
      RUBYLIB: payloadDir,
    };
    const normal: Record<string, string> = {
      RUKO31_APP_TOKEN: 'app-token-123',
      DATABASE_URL: 'postgres://localhost/db',
      // Variabel Python/Ruby yang benign: pastikan tidak ada prefix-stripping berlebihan.
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      RUBY_GC_HEAP_INIT_SLOTS: '10000',
    };
    const keys = [...INTERPRETER_VARS, ...Object.keys(normal)];
    const result = await execute(envProbeCommand(keys), {
      env: { ...injected, ...normal },
      timeoutMs: 20_000,
      summarize: false,
    });
    assert.equal(result.code, 0, result.output);
    const values = JSON.parse(result.stdout.trim()) as (string | null)[];
    INTERPRETER_VARS.forEach((k, i) => assert.equal(values[i], null, `${k} harus dibuang dari child env`));
    Object.values(normal).forEach((v, i) => {
      assert.equal(values[INTERPRETER_VARS.length + i], v, `${Object.keys(normal)[i]} harus tetap lolos`);
    });
  });

  test('ADV: env interpreter yang sudah ada di process.env Ruko (bukan options.env) juga dibuang', async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of INTERPRETER_VARS) {
      saved[k] = process.env[k];
      process.env[k] = `poisoned-${k}`;
    }
    process.env.RUKO31_PARENT_NORMAL = 'parent-ok';
    try {
      const result = await execute(envProbeCommand([...INTERPRETER_VARS, 'RUKO31_PARENT_NORMAL']), {
        timeoutMs: 20_000,
        summarize: false,
      });
      assert.equal(result.code, 0, result.output);
      const values = JSON.parse(result.stdout.trim()) as (string | null)[];
      INTERPRETER_VARS.forEach((k, i) => assert.equal(values[i], null, `${k} dari process.env harus dibuang`));
      assert.equal(values[INTERPRETER_VARS.length], 'parent-ok');
    } finally {
      for (const k of INTERPRETER_VARS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      delete process.env.RUKO31_PARENT_NORMAL;
    }
  });

  test('ADV behavioral: PYTHONPATH + sitecustomize.py tidak tereksekusi lewat execute()', async (t) => {
    if (isWin || !hasBinary('python3')) return t.skip('python3 tidak tersedia / win32');
    const env = { PYTHONPATH: payloadDir };
    // Positive control: tanpa Ruko, payload MEMANG jalan.
    const raw = execFileSync('python3', ['-c', 'print("clean")'], { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.match(raw, /PWNED_PY/, 'positive control: vektor serangan harus nyata');
    const result = await execute('python3 -c "print(\'clean\')"', { env, timeoutMs: 20_000, summarize: false });
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /clean/);
    assert.doesNotMatch(result.output, /PWNED_PY/);
  });

  test('ADV behavioral: PERL5OPT=-MEvil + PERL5LIB tidak tereksekusi lewat execute()', async (t) => {
    if (isWin || !hasBinary('perl')) return t.skip('perl tidak tersedia / win32');
    const env = { PERL5OPT: '-MEvil', PERL5LIB: payloadDir };
    const raw = execFileSync('perl', ['-e', 'print "clean\\n"'], { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.match(raw, /PWNED_PL/, 'positive control: vektor serangan harus nyata');
    const result = await execute('perl -e \'print "clean\\n"\'', { env, timeoutMs: 20_000, summarize: false });
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /clean/);
    assert.doesNotMatch(result.output, /PWNED_PL/);
  });

  test('ADV behavioral: RUBYOPT=-revil + RUBYLIB tidak tereksekusi lewat execute()', async (t) => {
    if (isWin || !hasBinary('ruby')) return t.skip('ruby tidak tersedia / win32');
    const env = { RUBYOPT: '-revil', RUBYLIB: payloadDir };
    const raw = execFileSync('ruby', ['-e', 'puts "clean"'], { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.match(raw, /PWNED_RB/, 'positive control: vektor serangan harus nyata');
    const result = await execute('ruby -e \'puts "clean"\'', { env, timeoutMs: 20_000, summarize: false });
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /clean/);
    assert.doesNotMatch(result.output, /PWNED_RB/);
  });

  test('ADV: .env workspace berisi env interpreter diblokir, variabel aplikasi normal tetap dimuat', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ruko-dotenv31-'));
    const envFile = path.join(dir, '.env');
    const lines = INTERPRETER_VARS.map((k) => `${k}=${payloadDir}`);
    lines.push('pythonstartup=/tmp/evil_lower.py'); // varian case
    lines.push('RUKO31_DOTENV_NORMAL=hello', 'RUKO31_PYTHONISH_FLAG=1');
    await fs.writeFile(envFile, lines.join('\n'));
    const saved: Record<string, string | undefined> = {};
    for (const k of INTERPRETER_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const loaded = loadDotenv({ path: envFile });
      for (const k of INTERPRETER_VARS) {
        assert.equal(loaded[k], undefined, `${k} tidak boleh dimuat dari .env`);
        assert.equal(process.env[k], undefined, `${k} tidak boleh mencemari process.env`);
      }
      assert.equal(loaded.pythonstartup, undefined);
      assert.equal(process.env.pythonstartup, undefined);
      assert.equal(loaded.RUKO31_DOTENV_NORMAL, 'hello');
      assert.equal(loaded.RUKO31_PYTHONISH_FLAG, '1');
      assert.equal(process.env.RUKO31_DOTENV_NORMAL, 'hello');
    } finally {
      for (const k of INTERPRETER_VARS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      delete process.env.RUKO31_DOTENV_NORMAL;
      delete process.env.RUKO31_PYTHONISH_FLAG;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
