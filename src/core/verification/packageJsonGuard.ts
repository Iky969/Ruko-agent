/**
 * packageJsonGuard.ts — F2-T3 (Fase 2, Blueprint v2.0.0 §2.7)
 *
 * Guard Manifest & Dependensi:
 * Memvalidasi manifest paket dari serangan trojan melalui pencegahan
 * penyuntikan URL eksternal, validasi SemVer ketat, dan pemblokiran
 * skrip lifecycle instalasi.
 *
 * Invarian (PROGRESS2.md / QA.md §1.5 / Blueprint §2.7 / DoD #6):
 *  1. Anti-Lifecycle Manipulation: Modifikasi skrip instalasi berbahaya
 *     (preinstall, postinstall, dll.) tertolak deterministik (TC-PKG-02).
 *  2. Anti-Value Injection: Upaya penyuntikan URL eksternal, tarball git,
 *     atau protokol asing ditolak sebelum instalasi (TC-PKG-01).
 *  3. ReDoS Protection: String versi dibatasi maksimum 64 karakter sebelum
 *     evaluasi regex dijalankan (TC-PKG-03).
 *  4. Subpath Imports Hijacking: Blokir penambahan/modifikasi field `imports`
 *     yang mengarah ke luar root workspace atau protokol eksternal.
 *  5. Prototype Pollution: Blokir properti __proto__, constructor, prototype.
 *
 * ZERO dependency — hanya `node:*`.
 */

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const DANGEROUS_VALUE_PREFIXES = [
  'http://',
  'https://',
  'git://',
  'git+http://',
  'git+https://',
  'github:',
  'gitlab:',
  'bitbucket:',
  'file:',
  'ssh://',
];

const DANGEROUS_SCRIPTS = [
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

const SEMVER_STRICT_RANGE =
  /^[~^]?(?:[0-9]+|[xX*])(?:\.(?:[0-9]+|[xX*])){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface PackageJsonGuardResult {
  allowed: boolean;
  reason?: string;
}

export function verifyPackageJsonChange(
  original: Record<string, any>,
  updated: Record<string, any>,
): PackageJsonGuardResult {
  // 1. Blokir modifikasi skrip siklus hidup instalasi
  const origScripts = original.scripts || {};
  const newScripts = updated.scripts || {};
  for (const s of DANGEROUS_SCRIPTS) {
    if (newScripts[s] && newScripts[s] !== origScripts[s]) {
      return {
        allowed: false,
        reason: `Skrip siklus hidup berbahaya dilarang: ${s}`,
      };
    }
  }

  // 2. Blokir modifikasi field biner arbitrer
  if (updated.bin && JSON.stringify(updated.bin) !== JSON.stringify(original.bin)) {
    return {
      allowed: false,
      reason: 'Modifikasi field "bin" ditolak dalam sesi otomatis',
    };
  }

  // 3. Blokir Subpath Imports Hijacking (QA.md §1.5)
  if (updated.imports) {
    const isSafeImportTarget = (target: unknown): boolean => {
      if (typeof target === 'string') {
        const lower = target.toLowerCase().trim();
        if (DANGEROUS_VALUE_PREFIXES.some((p) => lower.startsWith(p))) return false;
        if (target.includes('..') || target.startsWith('/') || target.startsWith('\\')) return false;
        return true;
      }
      if (typeof target === 'object' && target !== null) {
        return Object.values(target).every(isSafeImportTarget);
      }
      return false;
    };

    const origImports = JSON.stringify(original.imports || {});
    const newImports = JSON.stringify(updated.imports);
    if (origImports !== newImports) {
      if (!isSafeImportTarget(updated.imports)) {
        return {
          allowed: false,
          reason: 'Field "imports" dilarang mengarah ke luar root workspace atau menggunakan protokol eksternal',
        };
      }
    }
  }

  // 4. Validasi nama paket dan format nilai dependensi (Anti-Value Injection)
  const depSections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const sec of depSections) {
    const origDeps = original[sec] || {};
    const newDeps = updated[sec] || {};

    if (Object.prototype.hasOwnProperty.call(newDeps, '__proto__') || Object.prototype.hasOwnProperty.call(newDeps, 'constructor') || Object.prototype.hasOwnProperty.call(newDeps, 'prototype')) {
      return {
        allowed: false,
        reason: 'Injeksi property prototype terlarang',
      };
    }

    const allKeys = Array.from(new Set([...Object.keys(newDeps), ...Object.getOwnPropertyNames(newDeps)]));
    for (const pkg of allKeys) {
      const val = newDeps[pkg];
      if (FORBIDDEN_OBJECT_KEYS.has(pkg)) {
        return {
          allowed: false,
          reason: `Injeksi property prototype terlarang: ${pkg}`,
        };
      }

      if (origDeps[pkg] === val) continue;

      if (typeof val !== 'string') {
        return {
          allowed: false,
          reason: `Nilai versi paket ${pkg} harus berupa string`,
        };
      }

      // ReDoS Protection (QA.md §1.5 / TC-PKG-03): batas karakter sebelum regex
      if (val.length > 64) {
        return {
          allowed: false,
          reason: `Nilai versi paket ${pkg} melampaui batas maksimum 64 karakter: ${val.length}`,
        };
      }

      const lowerVal = val.toLowerCase().trim();
      if (DANGEROUS_VALUE_PREFIXES.some((p) => lowerVal.startsWith(p))) {
        return {
          allowed: false,
          reason: `Injeksi URL/Git terdeteksi pada dependensi ${pkg}: ${val}`,
        };
      }

      // Deteksi path lokal: ., /, ~/ atau ~\
      const isLocalPath =
        val.startsWith('.') ||
        val.startsWith('/') ||
        val === '~' ||
        val.startsWith('~/') ||
        val.startsWith('~\\') ||
        (val.startsWith('~') && !/^[~][0-9xX*]/.test(val));

      if (isLocalPath) {
        return {
          allowed: false,
          reason: `Path lokal dilarang pada dependensi ${pkg}: ${val}`,
        };
      }

      if (
        !SEMVER_STRICT_RANGE.test(val) &&
        !/^(latest|beta|next|workspace:\*)$/.test(val)
      ) {
        return {
          allowed: false,
          reason: `Nilai versi paket ${pkg} bukan format semver sah: ${val}`,
        };
      }
    }
  }

  return { allowed: true };
}
