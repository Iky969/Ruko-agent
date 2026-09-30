/**
 * Fase 1 (F1-T1) — Sanitizer: allowlist NFKC, astral Unicode, BiDi strip,
 * dan pemisahan domain tanggung jawab `sanitizeForPrompt` vs `sanitizePath`.
 *
 * Matriks acuan: QA.md §1.2 dan TC-SEC-02 / TC-SEC-03.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_MAX_PROMPT_CHARS,
  PathSanitizationError,
  isWinReservedSegment,
  sanitizeForPrompt,
  sanitizePath,
} from '../core/prompt/sanitizer.js';

describe('F1-T1 sanitizer — sanitizeForPrompt (allowlist ASCII)', () => {
  test('NFKC memetakan separator kompatibilitas ke ASCII', () => {
    // U+FF0F FULLWIDTH SOLIDUS -> '/'
    assert.equal(sanitizeForPrompt('a／b'), 'a/b');
    // U+2025 TWO DOT LEADER -> '..'
    assert.equal(sanitizeForPrompt('a‥b'), 'a..b');
    // U+FB01 LIGATURE 'fi' -> 'fi'
    assert.equal(sanitizeForPrompt('oﬃce'), 'office');
  });

  test('homoglyph tanpa dekomposisi NFKC di-escape, bukan dipetakan jadi ASCII', () => {
    // U+2215 DIVISION SLASH tidak punya dekomposisi kompatibilitas, jadi
    // hasil yang aman adalah escape — bukan '/' palsu yang bisa dipakai
    // menyamar sebagai path prefix di mata model.
    assert.equal(sanitizeForPrompt('a∕b'), 'a\\u2215b');
  });

  test('karakter non-ASCII ditulis sebagai escape, ASCII sah tetap apa adanya', () => {
    assert.equal(sanitizeForPrompt('readme.md: 1.0'), 'readme.md: 1.0');
    assert.equal(sanitizeForPrompt('é'), '\\u00e9');
    assert.equal(sanitizeForPrompt('≠≤'), '\\u2260\\u2264');
  });

  test('karakter kontrol di-escape, termasuk newline dan null byte', () => {
    assert.equal(sanitizeForPrompt('a\nb'), 'a\\u000ab');
    assert.equal(sanitizeForPrompt('a\r\nb'), 'a\\u000d\\u000ab');
    assert.equal(sanitizeForPrompt('a\u0000b'), 'a\\u0000b');
    assert.equal(sanitizeForPrompt('a\u007fb'), 'a\\u007fb');
  });

  test('BiDi override, isolate, dan zero-width dibuang', () => {
    // U+202E RLO + U+202C PDF: silent-direction attack
    assert.equal(sanitizeForPrompt('safe\u202eevil\u202c'), 'safeevil');
    // U+2066 LRI ... U+2069 PDI
    assert.equal(sanitizeForPrompt('a\u2066b\u2069'), 'ab');
    // U+200B ZWSP, U+200D ZWJ, U+FEFF BOM, U+00AD SHY
    assert.equal(sanitizeForPrompt('ab\u200dc\ufeffd\u00ade'), 'abcde');
    // U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR
    assert.equal(sanitizeForPrompt('a\u2028b\u2029c'), 'abc');
  });

  test('karakter astral (non-BMP) ditangani per code point, bukan per code unit', () => {
    // U+1F600 GRINNING FACE -> dua code unit UTF-16, satu code point
    assert.equal(sanitizeForPrompt('hi😀'), 'hi\\u{1F600}');
    // U+1D11E MUSICAL SYMBOL G CLEF
    assert.equal(sanitizeForPrompt('𝄞'), '\\u{1D11E}');
    // Tidak ada surrogate yatim yang bocor ke prompt
    const out = sanitizeForPrompt('😀');
    assert.equal(/[\uD800-\uDFFF]/.test(out), false);
  });

  test('surrogate pair di tengah teks tidak membuat karakter ikut hilang', () => {
    const input = `${'x'.repeat(5)}😀${'y'.repeat(5)}`;
    assert.equal(sanitizeForPrompt(input), `${'x'.repeat(5)}\\u{1F600}${'y'.repeat(5)}`);
  });

  test('masukan non-string dinormalisasi dengan aman', () => {
    assert.equal(sanitizeForPrompt(null as unknown as string), '');
    assert.equal(sanitizeForPrompt(undefined as unknown as string), '');
    assert.equal(sanitizeForPrompt(12345 as unknown as string), '12345');
  });

  test('masukan kepanjangan dipotong pada batas anti-DoS', () => {
    const huge = 'a'.repeat(DEFAULT_MAX_PROMPT_CHARS + 1000);
    const out = sanitizeForPrompt(huge);
    assert.equal(out.length, DEFAULT_MAX_PROMPT_CHARS);
    assert.equal(sanitizeForPrompt('abcdef', { maxChars: 3 }), 'abc');
  });
});

describe('F1-T1 sanitizer — sanitizePath (validasi jalur, tanpa mangling UTF-8)', () => {
  test('TC-SEC-03: nama berkas beraksen tetap utuh', () => {
    assert.equal(sanitizePath('docs/panduan_résumé.md'), 'docs/panduan_résumé.md');
    assert.equal(sanitizePath('dokumen/日本語/メモ.md'), 'dokumen/日本語/メモ.md');
    // Bandingkan dengan sanitizeForPrompt yang memang WAJIB mem-escape non-ASCII.
    assert.equal(sanitizeForPrompt('résumé.md'), 'r\\u00e9sum\\u00e9.md');
  });

  test('TC-SEC-02: null byte ditolak dengan kode NULL_BYTE', () => {
    assert.throws(
      () => sanitizePath('safe.txt\0.js'),
      (err: unknown) => err instanceof PathSanitizationError && err.code === 'NULL_BYTE',
    );
  });

  test('path traversal keluar dari root ditolak', () => {
    assert.throws(
      () => sanitizePath('../etc/passwd'),
      (err: unknown) => err instanceof PathSanitizationError && err.code === 'PATH_TRAVERSAL',
    );
    assert.throws(
      () => sanitizePath('src/../../etc/passwd'),
      (err: unknown) => err instanceof PathSanitizationError && err.code === 'PATH_TRAVERSAL',
    );
  });

  test('traversal yang menyamar lewat NFKC tetap tidak bisa keluar root', () => {
    // U+2025 TWO DOT LEADER dinormalisasi NFKC menjadi '..'
    assert.equal(sanitizePath('safe/‥/secret'), 'secret');
    assert.throws(
      () => sanitizePath('‥/etc/passwd'),
      (err: unknown) => err instanceof PathSanitizationError && err.code === 'PATH_TRAVERSAL',
    );
    // U+FF0E FULLWIDTH FULL STOP x2 -> '..'
    assert.throws(
      () => sanitizePath('．．/etc/passwd'),
      (err: unknown) => err instanceof PathSanitizationError && err.code === 'PATH_TRAVERSAL',
    );
  });

  test('segmentasi redundan diratakan tanpa mengubah nama berkas sah', () => {
    assert.equal(sanitizePath('./src//core/./file.ts'), 'src/core/file.ts');
    assert.equal(sanitizePath('a/b/../c.txt'), 'a/c.txt');
    assert.equal(sanitizePath('src\\core\\file.ts'), 'src/core/file.ts');
  });

  test('path kosong ditolak', () => {
    assert.throws(
      () => sanitizePath(''),
      (err: unknown) => err instanceof PathSanitizationError && err.code === 'EMPTY_PATH',
    );
  });

  test('workspaceRoot: jalur relatif menempel pada root, absolut di luar root ditolak', () => {
    assert.equal(sanitizePath('src/index.ts', '/repo'), 'src/index.ts');
    assert.equal(sanitizePath('/repo/src/index.ts', '/repo'), '/repo/src/index.ts');
    assert.throws(
      () => sanitizePath('/etc/passwd', '/repo'),
      (err: unknown) => err instanceof PathSanitizationError && err.code === 'PATH_TRAVERSAL',
    );
    assert.throws(
      () => sanitizePath('../../etc/passwd', '/repo'),
      (err: unknown) => err instanceof PathSanitizationError && err.code === 'PATH_TRAVERSAL',
    );
  });

  test('predikat nama reserved Win32 benar-benar/platform-agnostic', () => {
    for (const reserved of ['con', 'CON', 'nul', 'com1', 'LPT9', 'con.txt', 'aux.json']) {
      assert.equal(isWinReservedSegment(reserved), true, reserved);
    }
    for (const safe of ['console', 'config', 'com10', 'lpt.txt', 'readme.md']) {
      assert.equal(isWinReservedSegment(safe), false, safe);
    }
  });

  test('di Win32, nama reserved di-escape (hanya dijalankan di platform tsb)', (t) => {
    if (process.platform !== 'win32') {
      t.skip('platform-specific: hanya relevan di Win32');
      return;
    }
    assert.equal(sanitizePath('con/file.txt'), '_con/file.txt');
  });
});
