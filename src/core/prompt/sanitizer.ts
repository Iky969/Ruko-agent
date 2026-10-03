/**
 * sanitizer.ts — F1-T1 (Fase 1, Blueprint v2.0.0)
 *
 * Sanitasi teks tak tepercaya sebelum disuntikkan ke prompt LLM:
 *  - Normalisasi NFKC memetakan homoglyph fullwidth (mis. U+FF0F → `/`).
 *  - Stripping karakter BiDi (arah teks), zero-width, dan separator tersembunyi.
 *  - Escape kontrol ASCII (`\n` → `\u000a`) dan code point non-BMP/emoji
 *    menggunakan iterasi `codePointAt` yang aman terhadap surrogate pair.
 *
 * Catatan implementasi: escape kontrol dilakukan DALAM satu pass iterasi
 * code point (bukan pass `replace` terpisah) agar backslash hasil escape
 * tidak ter-escape ulang menjadi `\u005c` (double-escape).
 *
 * Pemisahan domain tanggung jawab (temuan QA.md §1.2):
 *  - `sanitizeForPrompt()` — eksklusif untuk konten teks tak tepercaya;
 *    allowlist ASCII ketat sesuai blueprint (karakter di luar itu di-escape).
 *  - `sanitizePath()` — validasi path yang TIDAK merusak karakter alfabet
 *    multibyte UTF-8 yang sah (mis. `résumé.md` tetap utuh).
 *
 * ZERO dependency — hanya `node:*` (modul ini murni logika string).
 */

/** Karakter ASCII yang diizinkan lolos tanpa escaping pada prompt. */
const ALLOWED_ASCII_RE = /^[a-zA-Z0-9._\-/: ]$/;

/** Karakter kontrol BiDi, zero-width, dan separator baris tersembunyi. */
const STRIP_RE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF\u2028\u2029\u00AD\u200E\u200F\u061C]/g;

/** Kontrol ASCII (C0 + DEL) di-escape dalam pass iterasi tunggal. */
function isControlCodePoint(codePoint: number): boolean {
  return codePoint < 0x20 || codePoint === 0x7F;
}

/** Format escape 4 digit heksadesimal kecil (`\u000a`). */
function escapeBmp(codePoint: number): string {
  return `\\u${codePoint.toString(16).padStart(4, '0')}`;
}

/**
 * Menyanitasi teks tak tepercaya agar aman disuntikkan ke prompt LLM.
 * Menerapkan NFKC, stripping BiDi/zero-width, lalu escape kontrol ASCII,
 * code point non-BMP, dan karakter di luar allowlist ASCII secara eksplisit.
 */
export function sanitizeForPrompt(input: string): string {
  if (typeof input !== 'string') input = String(input ?? '');

  // 1. Normalisasi NFKC memetakan homoglyph (mis. U+FF0F fullwidth → '/')
  let s = input.normalize('NFKC');

  // 2. Bersihkan karakter kontrol BiDi, zero-width, dan separator
  s = s.replace(STRIP_RE, '');

  // 3. Iterasi code point aman (menangani surrogate pair dan emoji)
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const codePoint = s.codePointAt(i);
    if (codePoint === undefined) continue;

    if (codePoint > 0xFFFF) {
      out += `\\u{${codePoint.toString(16).toUpperCase()}}`;
      i++; // Lewati pasangan low surrogate
      continue;
    }

    if (isControlCodePoint(codePoint)) {
      out += escapeBmp(codePoint);
      continue;
    }

    const char = String.fromCodePoint(codePoint);
    if (ALLOWED_ASCII_RE.test(char)) {
      out += char;
    } else {
      out += escapeBmp(codePoint);
    }
  }
  return out;
}

/** Nama-nama perangkat yang dicadangkan Windows (tidak boleh jadi nama berkas). */
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Kontrol ASCII + null byte dibuang total dari path (TC-SEC-02). */
const PATH_CONTROL_RE = /[\x00-\x1F\x7F]/g;

/**
 * Menyanitasi path berkas tanpa merusak karakter alfabet multibyte sah
 * (QA.md §1.2 / TC-SEC-03: `docs/panduan_résumé.md` tetap terbaca utuh).
 *
 * Berbeda dari `sanitizeForPrompt`, fungsi ini TIDAK menerapkan allowlist
 * ASCII ketat — fokusnya memblokir vektor nyata path: karakter tak terlihat
 * (BiDi/zero-width), null byte, kontrol ASCII, slash ganda, dan (khusus
 * Windows) nama berkas tercadangkan.
 */
export function sanitizePath(input: string): string {
  let s = (typeof input === 'string' ? input : String(input ?? '')).normalize('NFKC');

  // Karakter BiDi/zero-width/separator tersembunyi dihapus
  s = s.replace(STRIP_RE, '');

  // Null byte + kontrol ASCII dibuang total (bukan di-escape, agar tidak
  // menghasilkan nama berkas contoh `\u0000` yang menyesatkan)
  s = s.replace(PATH_CONTROL_RE, '');

  // Rapatkan slash ganda hasil NFKC/normalisasi
  s = s.replace(/\/{2,}/g, '/');

  if (process.platform === 'win32') {
    s = s
      .split('/')
      .map((seg) => (WIN_RESERVED_RE.test(seg) ? `_${seg}` : seg))
      .join('/');
  }
  return s;
}
