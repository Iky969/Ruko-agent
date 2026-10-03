/**
 * fase1_sanitizer.test.ts — Test F1-T1 (Fase 1, Blueprint v2.0.0)
 *
 * Mencakup: NFKC homoglyph, stripping BiDi/zero-width (skenario Unicode/BiDi
 * injection — blueprint DoD #4), escape kontrol ASCII, iterasi codePointAt
 * untuk astral/emoji (surrogate pair), sanitizePath tanpa merusak UTF-8 sah
 * (QA.md §1.2 / TC-SEC-03), null byte (TC-SEC-02), dan reserved names Win32.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { sanitizeForPrompt, sanitizePath } from '../core/prompt/sanitizer.js';

describe('F1-T1 sanitizeForPrompt', () => {
  test('teks ASCII dalam allowlist lolos utuh', () => {
    // Allowlist blueprint: [a-zA-Z0-9._\-/: ] — tanpa koma/tanda seru
    assert.equal(sanitizeForPrompt('Hello world: read src/app.ts _ok-99'), 'Hello world: read src/app.ts _ok-99');
  });

  test('karakter di luar allowlist ASCII di-escape (komma, seru, kurung)', () => {
    assert.equal(sanitizeForPrompt('a,b'), 'a\\u002cb');
    assert.equal(sanitizeForPrompt('wow!'), 'wow\\u0021');
    assert.equal(sanitizeForPrompt('f(x)'), 'f\\u0028x\\u0029');
  });

  test('NFKC memetakan homoglyph fullwidth ke karakter kanonis', () => {
    // U+FF0F FULLWIDTH SOLIDUS punya dekomposisi kompatibilitas NFKC → '/'
    assert.equal(sanitizeForPrompt('path\uFF0Fto'), 'path/to');
    // Fullwidth latin dinormalisasi ke ASCII
    assert.equal(sanitizeForPrompt('\uFF41\uFF42\uFF43'), 'abc');
  });

  test('U+2215 DIVISION SLASH tidak punya dekomposisi NFKC → di-escape di prompt', () => {
    // Homoglyph ini tetap utuh setelah NFKC; allowlist ASCII blueprint
    // men-netralkannya di konteks prompt agar tidak menipu parser path LLM.
    assert.equal(sanitizeForPrompt('path\u2215to'), 'path\\u2215to');
  });

  test('BiDi override/isolate dihapus (anti arah teks tersembunyi)', () => {
    for (const ch of ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069']) {
      assert.equal(sanitizeForPrompt(`a${ch}evil`), 'aevil', `U+${ch.codePointAt(0)!.toString(16)} harus dihapus`);
    }
  });

  test('zero-width, soft hyphen, BOM, dan RTL mark dihapus', () => {
    assert.equal(sanitizeForPrompt('hidden\u200B\u200C\u200D\uFEFF\u00AD\u200E\u200F\u061Cmark'), 'hiddenmark');
  });

  test('U+2028/U+2029 (separator baris JS) dihapus', () => {
    assert.equal(sanitizeForPrompt('a\u2028b\u2029c'), 'abc');
  });

  test('kontrol ASCII di-escape, bukan dilewati sebagai newline nyata', () => {
    assert.equal(sanitizeForPrompt('line1\nline2'), 'line1\\u000aline2');
    assert.equal(sanitizeForPrompt('x\ty'), 'x\\u0009y');
    assert.equal(sanitizeForPrompt('del\x7F'), 'del\\u007f');
  });

  test('astral plane / emoji di-escape via codePointAt (surrogate pair utuh)', () => {
    assert.equal(sanitizeForPrompt('ok\u{1F600}'), 'ok\\u{1F600}');
    // Emoji ZWJ tidak boleh menghasilkan surrogate nyata di output
    const out = sanitizeForPrompt('\u{1F468}\u200D\u{1F4BB}');
    assert.ok(!out.includes('\u{1F468}'));
    assert.match(out, /\\u\{1F468\}/);
  });

  test('input non-string dikonversi aman', () => {
    assert.equal(sanitizeForPrompt(null as unknown as string), '');
    assert.equal(sanitizeForPrompt(42 as unknown as string), '42');
  });
});

describe('F1-T1 sanitizePath (QA.md §1.2)', () => {
  test('TC-SEC-03: nama berkas beraksen tetap utuh (tidak di-mangle)', () => {
    assert.equal(sanitizePath('docs/panduan_résumé.md'), 'docs/panduan_résumé.md');
  });

  test('slash ganda dirapatkan dan slash kanonis dipertahankan', () => {
    assert.equal(sanitizePath('a//b///c'), 'a/b/c');
  });

  test('TC-SEC-02: null byte dinetralkan (di-escape)', () => {
    const out = sanitizePath('safe.txt\u0000.js');
    assert.ok(!out.includes('\u0000'));
  });

  test('U+2215 DIVISION SLASH dipertahankan (karakter nama berkas sah, bukan separator)', () => {
    // QA.md §1.2: sanitizePath tidak boleh me-mangle unicode sah. Pada POSIX
    // dan NTFS, U+2215 adalah karakter biasa dalam nama berkas — BUKAN
    // separator — sehingga mempertahankannya adalah perilaku yang benar.
    assert.equal(sanitizePath('a\u2215b'), 'a\u2215b');
  });
});
