/**
 * shell_selection_faseD.test.ts — Unit test Fase D (v1.9.0):
 * Pemilihan shell di executor.ts via SATU sumber kebenaran
 * (`envProfile.shellFamily` — tidak ada cek platform/flavor tersebar).
 *
 * Kontrak yang dikunci test ini:
 *  1. REGRESI BIT-IDENTIK non-win32: linux/darwin/wsl/colab/ci/termux/unknown
 *     → binary `/bin/sh` + args `['-c', command]` — PERSIS kode sebelum Fase D
 *     (`isWindows ? (ComSpec || 'cmd.exe') : '/bin/sh'`,
 *      `isWindows ? ['/d','/s','/c', cmd] : ['-c', cmd]`).
 *  2. Flavor TIDAK mengubah pemilihan shell (termux pun tetap /bin/sh);
 *     resolusi $PREFIX/bin hanya untuk skrip eksplisit via resolveTermuxBin()
 *     dan merupakan no-op untuk environment lain.
 *  3. Test BARU Windows: cmd (ComSpec) & powershell (flags process-scoped
 *     -NoProfile -NonInteractive -ExecutionPolicy Bypass; pwsh dari ComSpec).
 *  4. Single source of truth: resolver hanya membaca profile (os, shellFamily)
 *     + env ComSpec — bukan process.platform.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  resolveShellSelection,
  buildShellInvocation,
  resolveTermuxBin,
} from '../core/executor.js';
import { buildEnvProfile, getEnvProfile, resetEnvCache, type EnvProfile } from '../core/env.js';
import { execute } from '../core/executor.js';

/** Bangun profil sintetis (tanpa menyentuh proses global). */
function profileOf(opts: {
  os?: EnvProfile['os'];
  shellFamily?: EnvProfile['shellFamily'];
  flavor?: EnvProfile['flavor'];
  pathPrefix?: string;
}): EnvProfile {
  return {
    os: opts.os ?? 'linux',
    shellFamily: opts.shellFamily ?? 'posix',
    flavor: opts.flavor ?? 'none',
    isInteractiveTTY: true,
    supportsColor: true,
    defaultShell: '/bin/sh',
    ...(opts.pathPrefix ? { pathPrefix: opts.pathPrefix } : {}),
  };
}

// ===========================================================================
// 1. REGRESI BIT-IDENTIK — environment existing (sebelum vs sesudah Fase D)
//    Nilai ekspektasi DIHARDCODE dari kode lama executor.ts:
//      shellBinary = isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh'
//      shellArgs   = isWindows ? ['/d','/s','/c', command] : ['-c', command]
// ===========================================================================

describe('faseD: regresi bit-identik non-win32 (shell binary + args shape)', () => {
  test('linux → /bin/sh + [-c, command] (identik kode lama)', () => {
    const sel = resolveShellSelection(profileOf({ os: 'linux', shellFamily: 'posix' }), {});
    assert.deepEqual(sel, { binary: '/bin/sh', argsPrefix: ['-c'] });
    const inv = buildShellInvocation(profileOf({ os: 'linux' }), 'echo hi', {});
    assert.deepEqual(inv, { binary: '/bin/sh', args: ['-c', 'echo hi'] });
  });

  test('darwin (macOS) → /bin/sh + [-c, command] (identik kode lama)', () => {
    const inv = buildShellInvocation(profileOf({ os: 'darwin', shellFamily: 'posix' }), 'ls -la', {});
    assert.deepEqual(inv, { binary: '/bin/sh', args: ['-c', 'ls -la'] });
  });

  test('flavor wsl / colab / jupyter / ci TIDAK mengubah shell (tetap /bin/sh)', () => {
    for (const flavor of ['wsl', 'colab', 'jupyter', 'ci'] as const) {
      const inv = buildShellInvocation(
        profileOf({ os: 'linux', shellFamily: 'posix', flavor }),
        'true',
        {},
      );
      assert.deepEqual(inv, { binary: '/bin/sh', args: ['-c', 'true'] }, `flavor=${flavor}`);
    }
  });

  test('os unknown → tetap /bin/sh + [-c] (identik kode lama, fail-safe posix)', () => {
    const inv = buildShellInvocation(profileOf({ os: 'unknown', shellFamily: 'posix' }), 'true', {});
    assert.deepEqual(inv, { binary: '/bin/sh', args: ['-c', 'true'] });
  });

  test('termux: shell selection SAMA PERSIS dengan linux biasa (/bin/sh)', () => {
    const termux = profileOf({ os: 'linux', shellFamily: 'posix', flavor: 'termux', pathPrefix: '/data/data/com.termux/files/usr' });
    const linux = profileOf({ os: 'linux', shellFamily: 'posix' });
    assert.deepEqual(resolveShellSelection(termux, {}), resolveShellSelection(linux, {}));
    assert.deepEqual(
      buildShellInvocation(termux, 'npm test', {}),
      { binary: '/bin/sh', args: ['-c', 'npm test'] },
    );
  });

  test('termux: resolveTermuxBin — bare name → $PREFIX/bin, path eksplisit utuh, non-termux no-op', () => {
    const termux = profileOf({ flavor: 'termux', pathPrefix: '/data/data/com.termux/files/usr' });
    assert.equal(resolveTermuxBin('rg', termux), '/data/data/com.termux/files/usr/bin/rg');
    assert.equal(resolveTermuxBin('./scripts/build.sh', termux), './scripts/build.sh');
    assert.equal(resolveTermuxBin('/usr/bin/git', termux), '/usr/bin/git');
    // Environment lain: NO-OP total (path resolution tidak berubah).
    const linux = profileOf({ flavor: 'none' });
    assert.equal(resolveTermuxBin('rg', linux), 'rg');
    const wsl = profileOf({ flavor: 'wsl' });
    assert.equal(resolveTermuxBin('rg', wsl), 'rg');
    // termux tanpa pathPrefix → no-op (fail-safe).
    const termuxNoPrefix = profileOf({ flavor: 'termux' });
    assert.equal(resolveTermuxBin('rg', termuxNoPrefix), 'rg');
  });

  test('runtime nyata di sandbox ini: profil aktual non-win32 → /bin/sh (guard per-platform)', () => {
    resetEnvCache();
    const p = getEnvProfile();
    if (p.os !== 'win32') {
      const sel = resolveShellSelection(p);
      assert.equal(sel.binary, '/bin/sh');
      assert.deepEqual(sel.argsPrefix, ['-c']);
    }
    resetEnvCache();
  });

  test('execute() end-to-end tetap berjalan (jalur non-win32 ter wiring benar)', async () => {
    const r = await execute('echo halo-faseD');
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('halo-faseD'));
  });
});

// ===========================================================================
// 2. TEST BARU WINDOWS — cmd & powershell (TAMBAHAN pilihan)
// ===========================================================================

describe('faseD: pemilihan shell Windows (baru)', () => {
  test('shellFamily cmd + ComSpec ter-set → binary ComSpec + [/d, /s, /c] (paritas kode lama)', () => {
    const sel = resolveShellSelection(
      profileOf({ os: 'win32', shellFamily: 'cmd' }),
      { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    );
    assert.deepEqual(sel, { binary: 'C:\\Windows\\system32\\cmd.exe', argsPrefix: ['/d', '/s', '/c'] });
    const inv = buildShellInvocation(
      profileOf({ os: 'win32', shellFamily: 'cmd' }),
      'dir',
      { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    );
    assert.deepEqual(inv, { binary: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/s', '/c', 'dir'] });
  });

  test('cmd tanpa ComSpec → fallback cmd.exe (delta terdokumentasi: string kosong/whitespace kini fallback, bukan dipakai mentah)', () => {
    assert.deepEqual(
      resolveShellSelection(profileOf({ os: 'win32', shellFamily: 'cmd' }), {}),
      { binary: 'cmd.exe', argsPrefix: ['/d', '/s', '/c'] },
    );
    assert.equal(
      resolveShellSelection(profileOf({ os: 'win32', shellFamily: 'cmd' }), { ComSpec: '   ' }).binary,
      'cmd.exe',
    );
  });

  test('shellFamily powershell → powershell.exe + flags process-scoped', () => {
    assert.deepEqual(
      resolveShellSelection(profileOf({ os: 'win32', shellFamily: 'powershell' }), {}),
      {
        binary: 'powershell.exe',
        argsPrefix: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'],
      },
    );
  });

  test('ComSpec menunjuk pwsh.exe → path pwsh dipakai (PS7 terdeteksi), flags sama', () => {
    const sel = resolveShellSelection(
      profileOf({ os: 'win32', shellFamily: 'powershell' }),
      { ComSpec: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
    );
    assert.equal(sel.binary, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    assert.deepEqual(sel.argsPrefix, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
  });

  test('command selalu elemen TERAKHIR args (kontrak spawn)', () => {
    const inv = buildShellInvocation(
      profileOf({ os: 'win32', shellFamily: 'powershell' }),
      'Get-ChildItem',
      {},
    );
    assert.equal(inv.args[inv.args.length - 1], 'Get-ChildItem');
  });

  test('single source of truth: resolver membaca shellFamily (bukan process.platform)', () => {
    // Dua profile dengan os sama tapi shellFamily beda → hasil beda murni
    // karena field shellFamily; tidak ada bacaan process.platform di resolver.
    const cmd = resolveShellSelection(profileOf({ os: 'win32', shellFamily: 'cmd' }), {});
    const ps = resolveShellSelection(profileOf({ os: 'win32', shellFamily: 'powershell' }), {});
    assert.equal(cmd.binary, 'cmd.exe');
    assert.equal(ps.binary, 'powershell.exe');
    // Flavor win32 apa pun tidak mempengaruhi.
    const ci = resolveShellSelection(profileOf({ os: 'win32', shellFamily: 'cmd', flavor: 'ci' }), {});
    assert.deepEqual(ci, cmd);
  });
});

// ===========================================================================
// 3. Integrasi Fase A→D: profil nyata dari buildEnvProfile ke resolver
// ===========================================================================

describe('faseD: integrasi buildEnvProfile → resolveShellSelection', () => {
  test('linux TERMUX dari env asli → shell tetap /bin/sh (regresi)', () => {
    const p = buildEnvProfile({
      platform: 'linux',
      release: 'generic',
      env: { TERMUX_VERSION: '0.118', PREFIX: '/data/data/com.termux/files/usr' },
      stdoutIsTTY: true,
      stdinIsTTY: true,
    });
    assert.equal(p.flavor, 'termux');
    assert.deepEqual(resolveShellSelection(p, {}), { binary: '/bin/sh', argsPrefix: ['-c'] });
  });

  test('win32 ComSpec powershell dari env asli → powershell selection', () => {
    const p = buildEnvProfile({
      platform: 'win32',
      release: '10.0',
      env: { ComSpec: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
      stdoutIsTTY: true,
      stdinIsTTY: true,
    });
    assert.equal(p.shellFamily, 'powershell');
    const sel = resolveShellSelection(p, {
      ComSpec: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    });
    assert.equal(sel.binary, 'powershell.exe');
    assert.ok(sel.argsPrefix.includes('-ExecutionPolicy'));
  });
});
