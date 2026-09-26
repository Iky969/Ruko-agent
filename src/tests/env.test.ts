/**
 * env.test.ts — Unit test Fase A (v1.9.0): Environment Detection Module.
 *
 * Test mem-mock `process.platform`, `os.release`, `process.env`,
 * `process.stdout/stdin.isTTY` untuk memverifikasi tiap kombinasi
 * os+shellFamily+flavor, fallback flags, edge case (env kosong/partial/
 * whitespace/case-sensitivity), fail-closed (partial match → 'none'),
 * dan perilaku cache singleton.
 *
 * Semua mock di-restore pada finally agar test lain tidak terkontaminasi.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import {
  buildEnvProfile,
  getEnvProfile,
  resetEnvCache,
  isTermuxEnv,
  isColabEnv,
  isWslEnv,
  isCiEnv,
  type EnvProfile,
} from '../core/env.js';

// ---------------------------------------------------------------------------
// Helper mock — pola save/restore seperti trust.test.ts
// ---------------------------------------------------------------------------

function withMockedEnv(envPatch: Record<string, string | undefined>): () => void {
  const saved: Record<string, string | undefined> = {};
  const keys = Object.keys(envPatch);
  for (const k of keys) {
    saved[k] = process.env[k];
    if (envPatch[k] === undefined) delete process.env[k];
    else process.env[k] = envPatch[k] as string;
  }
  return () => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k] as string;
    }
  };
}

/** Bangun profil langsung dari parts (tanpa menyentuh proses global). */
function profileOf(parts: {
  platform: string;
  release?: string;
  env?: Record<string, string>;
  stdoutIsTTY?: boolean;
  stdinIsTTY?: boolean;
}): EnvProfile {
  return buildEnvProfile({
    platform: parts.platform,
    release: parts.release ?? 'generic-release',
    env: parts.env ?? {},
    stdoutIsTTY: parts.stdoutIsTTY ?? true,
    stdinIsTTY: parts.stdinIsTTY ?? true,
  });
}

// ---------------------------------------------------------------------------
// 1. Dimensi os
// ---------------------------------------------------------------------------

describe('env: dimensi os', () => {
  test('linux/win32/darwin terdeteksi dari process.platform', () => {
    assert.equal(profileOf({ platform: 'linux' }).os, 'linux');
    assert.equal(profileOf({ platform: 'win32' }).os, 'win32');
    assert.equal(profileOf({ platform: 'darwin' }).os, 'darwin');
  });

  test('platform tak dikenal fail-closed ke unknown', () => {
    assert.equal(profileOf({ platform: 'freebsd' }).os, 'unknown');
    assert.equal(profileOf({ platform: 'aix' }).os, 'unknown');
    assert.equal(profileOf({ platform: '' }).os, 'unknown');
    assert.equal(profileOf({ platform: 'android' }).os, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// 2. Dimensi shellFamily
// ---------------------------------------------------------------------------

describe('env: dimensi shellFamily', () => {
  test('non-win32 selalu posix', () => {
    assert.equal(profileOf({ platform: 'linux' }).shellFamily, 'posix');
    assert.equal(profileOf({ platform: 'darwin' }).shellFamily, 'posix');
    assert.equal(profileOf({ platform: 'freebsd' }).shellFamily, 'posix');
  });

  test('win32 default cmd (ComSpec cmd.exe, tanpa sinyal PowerShell)', () => {
    const p = profileOf({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    });
    assert.equal(p.shellFamily, 'cmd');
  });

  test('win32 powershell via ComSpec menunjuk powershell.exe', () => {
    const p = profileOf({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
    });
    assert.equal(p.shellFamily, 'powershell');
  });

  test('win32 powershell via ComSpec pwsh (case-insensitive, forward slash)', () => {
    const p = profileOf({ platform: 'win32', env: { ComSpec: 'c:/tools/pwsh.exe' } });
    assert.equal(p.shellFamily, 'powershell');
  });

  test('win32 powershell via PSModulePath meski ComSpec cmd', () => {
    const p = profileOf({
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe', PSModulePath: 'C:\\Program Files\\WindowsPowerShell\\Modules' },
    });
    assert.equal(p.shellFamily, 'powershell');
  });

  test('win32 tanpa env sama sekali → cmd (fail-safe ke cmd)', () => {
    assert.equal(profileOf({ platform: 'win32' }).shellFamily, 'cmd');
  });

  test('win32 whitespace ComSpec dianggap tidak ada', () => {
    const p = profileOf({ platform: 'win32', env: { ComSpec: '   ' } });
    assert.equal(p.shellFamily, 'cmd');
  });
});

// ---------------------------------------------------------------------------
// 3. Dimensi flavor
// ---------------------------------------------------------------------------

describe('env: flavor colab (dievaluasi SEBELUM jupyter)', () => {
  test('COLAB_GPU ter-set → colab', () => {
    assert.equal(profileOf({ platform: 'linux', env: { COLAB_GPU: '1' } }).flavor, 'colab');
  });

  test('COLAB_RELEASE_TAG ter-set → colab', () => {
    assert.equal(profileOf({ platform: 'linux', env: { COLAB_RELEASE_TAG: 'release-_2026-09-01' } }).flavor, 'colab');
  });

  test('DATALAB_ENV ter-set → colab', () => {
    assert.equal(profileOf({ platform: 'linux', env: { DATALAB_ENV: 'COLAB' } }).flavor, 'colab');
  });

  test('colab menang atas jupyter meski JPY_* juga ada', () => {
    const p = profileOf({
      platform: 'linux',
      env: { COLAB_GPU: '1', JPY_PARENT_PID: '42' },
    });
    assert.equal(p.flavor, 'colab');
  });

  test('nilai whitespace-only → tidak terdeteksi (fail-closed)', () => {
    assert.equal(profileOf({ platform: 'linux', env: { COLAB_GPU: '   ' } }).flavor, 'none');
  });
});

describe('env: flavor jupyter (indikator resmi saja)', () => {
  test('JPY_PARENT_PID → jupyter', () => {
    assert.equal(profileOf({ platform: 'linux', env: { JPY_PARENT_PID: '1234' } }).flavor, 'jupyter');
  });

  test('JPY_SESSION_NAME → jupyter', () => {
    assert.equal(profileOf({ platform: 'linux', env: { JPY_SESSION_NAME: 'kernel-abc.json' } }).flavor, 'jupyter');
  });

  test('indikator tidak resmi (VSCODE_PID, SPYDER_ARGS) TIDAK dianggap jupyter', () => {
    const p = profileOf({ platform: 'linux', env: { VSCODE_PID: '99', SPYDER_ARGS: 'x' } });
    assert.equal(p.flavor, 'none');
  });
});

describe('env: flavor termux', () => {
  test('TERMUX_VERSION → termux + pathPrefix terisi', () => {
    const p = profileOf({ platform: 'linux', env: { TERMUX_VERSION: '0.118' } });
    assert.equal(p.flavor, 'termux');
    assert.ok(p.pathPrefix);
  });

  test('PREFIX mengandung com.termux → termux', () => {
    const p = profileOf({
      platform: 'linux',
      env: { PREFIX: '/data/data/com.termux/files/usr' },
    });
    assert.equal(p.flavor, 'termux');
    assert.equal(p.pathPrefix, '/data/data/com.termux/files/usr');
  });

  test('PREFIX biasa (bukan termux) → none', () => {
    const p = profileOf({ platform: 'linux', env: { PREFIX: '/usr/local' } });
    assert.equal(p.flavor, 'none');
    assert.equal(p.pathPrefix, undefined);
  });

  test('PREFIX case-insensitive terhadap com.termux', () => {
    const p = profileOf({ platform: 'linux', env: { PREFIX: '/DATA/COM.TERMUX/files/usr' } });
    assert.equal(p.flavor, 'termux');
  });
});

describe('env: flavor wsl (platform guard + release)', () => {
  test('linux + release microsoft → wsl (case-insensitive)', () => {
    assert.equal(
      profileOf({ platform: 'linux', release: '5.15.153.1-microsoft-standard-WSL2' }).flavor,
      'wsl',
    );
    assert.equal(
      profileOf({ platform: 'linux', release: '4.4.0-19041-MICROSOFT' }).flavor,
      'wsl',
    );
  });

  test('linux + release mengandung wsl → wsl', () => {
    assert.equal(profileOf({ platform: 'linux', release: 'custom-wsl-kernel' }).flavor, 'wsl');
  });

  test('win32 + release microsoft TETAP win32 (platform guard) — wsl.exe dari luar', () => {
    const p = profileOf({ platform: 'win32', release: '10.0.22621 (Microsoft Windows)' });
    assert.equal(p.flavor, 'none');
    assert.equal(p.os, 'win32');
  });

  test('darwin + release microsoft → none (platform guard)', () => {
    assert.equal(profileOf({ platform: 'darwin', release: 'microsoft-x' }).flavor, 'none');
  });

  test('linux release normal → none', () => {
    assert.equal(profileOf({ platform: 'linux', release: '6.1.0-13-amd64' }).flavor, 'none');
  });
});

describe('env: flavor ci', () => {
  test('CI → ci', () => {
    assert.equal(profileOf({ platform: 'linux', env: { CI: 'true' } }).flavor, 'ci');
  });

  test('GITHUB_ACTIONS → ci', () => {
    assert.equal(profileOf({ platform: 'linux', env: { GITHUB_ACTIONS: 'true' } }).flavor, 'ci');
  });

  test('indikator CI umum lain: GITLAB_CI, CIRCLECI, TRAVIS, BUILD_NUMBER, TEAMCITY_VERSION, CODEBUILD_BUILD_ID, BITBUCKET_BUILD_NUMBER', () => {
    for (const [key, value] of [
      ['GITLAB_CI', 'true'],
      ['CIRCLECI', 'true'],
      ['TRAVIS', 'true'],
      ['BUILD_NUMBER', '42'],
      ['TEAMCITY_VERSION', '2023.1'],
      ['CODEBUILD_BUILD_ID', 'abc:123'],
      ['BITBUCKET_BUILD_NUMBER', '7'],
    ] as const) {
      assert.equal(profileOf({ platform: 'linux', env: { [key]: value } }).flavor, 'ci', key);
    }
  });

  test('ci prioritas terendah: kekalahan oleh colab/jupyter/termux/wsl', () => {
    assert.equal(
      profileOf({ platform: 'linux', env: { CI: '1', GITHUB_ACTIONS: 'true', COLAB_GPU: '1' } }).flavor,
      'colab',
    );
    assert.equal(
      profileOf({ platform: 'linux', release: 'wsl-kernel', env: { CI: '1' } }).flavor,
      'wsl',
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Fallback flags: isInteractiveTTY, supportsColor, defaultShell
// ---------------------------------------------------------------------------

describe('env: fallback flags', () => {
  test('isInteractiveTTY butuh stdout DAN stdin sama-sama TTY', () => {
    assert.equal(profileOf({ platform: 'linux', stdoutIsTTY: true, stdinIsTTY: true }).isInteractiveTTY, true);
    assert.equal(profileOf({ platform: 'linux', stdoutIsTTY: true, stdinIsTTY: false }).isInteractiveTTY, false);
    assert.equal(profileOf({ platform: 'linux', stdoutIsTTY: false, stdinIsTTY: true }).isInteractiveTTY, false);
    assert.equal(profileOf({ platform: 'linux', stdoutIsTTY: false, stdinIsTTY: false }).isInteractiveTTY, false);
  });

  test('supportsColor false ketika NO_COLOR ter-set (nilai apa pun)', () => {
    assert.equal(profileOf({ platform: 'linux' }).supportsColor, true);
    assert.equal(profileOf({ platform: 'linux', env: { NO_COLOR: '1' } }).supportsColor, false);
    assert.equal(profileOf({ platform: 'linux', env: { NO_COLOR: '' } }).supportsColor, false);
  });

  test('defaultShell posix: SHELL bila ada, fallback /bin/sh', () => {
    assert.equal(profileOf({ platform: 'linux', env: { SHELL: '/bin/zsh' } }).defaultShell, '/bin/zsh');
    assert.equal(profileOf({ platform: 'linux' }).defaultShell, '/bin/sh');
  });

  test('defaultShell cmd: ComSpec bila ada, fallback cmd.exe', () => {
    assert.equal(
      profileOf({ platform: 'win32', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } }).defaultShell,
      'C:\\Windows\\system32\\cmd.exe',
    );
    assert.equal(profileOf({ platform: 'win32' }).defaultShell, 'cmd.exe');
  });

  test('defaultShell powershell: powershell.exe', () => {
    assert.equal(
      profileOf({ platform: 'win32', env: { ComSpec: 'C:\\x\\powershell.exe' } }).defaultShell,
      'powershell.exe',
    );
  });

  test('pathPrefix hanya terisi pada termux', () => {
    assert.equal(profileOf({ platform: 'linux' }).pathPrefix, undefined);
    const t = profileOf({ platform: 'linux', env: { TERMUX_VERSION: '0.118' } });
    assert.equal(t.pathPrefix, '/data/data/com.termux/files/usr');
  });
});

// ---------------------------------------------------------------------------
// 5. Edge case: env kosong/partial/whitespace/case-sensitivity
// ---------------------------------------------------------------------------

describe('env: edge case', () => {
  test('env kosong total → posix/none + fallback shell', () => {
    const p = profileOf({ platform: 'linux', env: {} });
    assert.equal(p.os, 'linux');
    assert.equal(p.shellFamily, 'posix');
    assert.equal(p.flavor, 'none');
    assert.equal(p.defaultShell, '/bin/sh');
  });

  test('partial match (satu var pun ter-set) tetap terdeteksi', () => {
    assert.equal(profileOf({ platform: 'linux', env: { TERMUX_VERSION: 'x' } }).flavor, 'termux');
  });

  test('whitespace-only di semua kandidat → none', () => {
    const p = profileOf({
      platform: 'linux',
      env: { CI: ' ', GITHUB_ACTIONS: '\t', JPY_PARENT_PID: '\n', TERMUX_VERSION: '  ' },
    });
    assert.equal(p.flavor, 'none');
  });

  test('case-sensitivity nama env: GitHub Actions style tidak salah baca', () => {
    // Nama env case-sensitive: github_actions (huruf kecil) BUKAN sinyal.
    assert.equal(profileOf({ platform: 'linux', env: { github_actions: 'true' } }).flavor, 'none');
  });
});

// ---------------------------------------------------------------------------
// 6. Cache singleton + resetEnvCache
// ---------------------------------------------------------------------------

describe('env: cache singleton', () => {
  test('getEnvProfile mengembalikan objek identik (referensi sama)', () => {
    resetEnvCache();
    const a = getEnvProfile();
    const b = getEnvProfile();
    assert.equal(a, b); // referensi sama — true singleton
    resetEnvCache();
  });

  test('resetEnvCache memaksa deteksi ulang', () => {
    resetEnvCache();
    const first = getEnvProfile();
    // Ubah lingkungan lalu reset — profil baru berbeda referensi.
    const restore = withMockedEnv({ CI: 'true' });
    try {
      resetEnvCache();
      const second = getEnvProfile();
      assert.notEqual(second, first);
      assert.equal(second.flavor, 'ci');
      resetEnvCache();
    } finally {
      restore();
      resetEnvCache();
    }
  });

  test('helper predikat membaca profil singleton', () => {
    resetEnvCache();
    const restore = withMockedEnv({ CI: 'true' });
    try {
      resetEnvCache();
      assert.equal(isCiEnv(), true);
      assert.equal(isTermuxEnv(), false);
      assert.equal(isColabEnv(), false);
      assert.equal(isWslEnv(), false);
    } finally {
      restore();
      resetEnvCache();
    }
  });

  test('profil asli terdeteksi ulang tanpa mock (no-throw, konsisten)', () => {
    resetEnvCache();
    const p1 = getEnvProfile();
    const p2 = getEnvProfile();
    assert.equal(p1, p2);
    assert.ok(['linux', 'win32', 'darwin', 'unknown'].includes(p1.os));
    assert.ok(['posix', 'cmd', 'powershell'].includes(p1.shellFamily));
    assert.ok(['none', 'wsl', 'colab', 'jupyter', 'termux', 'ci'].includes(p1.flavor));
  });
});
