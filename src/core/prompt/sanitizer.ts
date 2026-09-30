/**
 * sanitizer.ts — Sanitasi masukan tak tepercaya sebelum masuk ke prompt LLM.
 *
 * KONTEKS KEAMANAN
 * ----------------
 * Seluruh luaran model, isi berkas workspace, dan keluaran tool adalah DATA
 * TAK TEPERCAYA (tainted). Karena itu sanitasi di sini dibuat defensif berlapis:
 *
 *  1. Normalisasi NFKC  — memetakan homoglyph & separator kompatibilitas
 *     (mis. U+2215 DIVISION SLASH → '/', U+2025 TWO DOT LEADER → '..').
 *  2. Pembersihan karakter tersembunyi — zero-width, BiDi override, BOM,
 *     soft hyphen, line/paragraph separator.
 *  3. Escape kontrol ASCII  — termasuk `\n`/`\r` yang bisa memecah blok
 *     instruksi sistem ("prompt delimiter injection").
 *  4. Iterasi code point — AMAN terhadap surrogate pair (emoji/karakter
 *     astral) yang akan rusak bila dipindai per `char` (UTF-16 code unit).
 *
 * PEMBELAAN ANTI-MANGLING (QA.md §1.2)
 * -------------------------------------
 * Sapuan allowlist ASCII TIDAK BOLEH dipakai untuk jalur berkas:
 * `résumé.md` akan menjadi `r\u00e9sum\u00e9.md` dan nama berkas sah
 * rusak. Karena itu domain tanggung jawab dipecah tegas:
 *
 *  - `sanitizeForPrompt()` → teks tak tepercaya untuk prompt (allowlist).
 *  - `sanitizePath()`      → validasi jalur sistem berkas (blokir traversal,
 *                           null byte, nama reserved Win32; karakter multibyte
 *                           UTF-8 yang sah tetap utuh).
 *
 * Zero runtime dependency — hanya `node:*` internal, tanpa import eksternal.
 */

/** Karakter ASCII yang boleh tampil apa adanya di dalam prompt. */
const ALLOWED_ASCII_RE = /^[a-zA-Z0-9._\-\/: ]$/;

/** Zero-width, BiDi override/isolate, BOM, soft hyphen, line/paragraph separator. */
const STRIP_RE = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF\u2028\u2029\u00AD\u200E\u200F\u061C]/g;

/**
 * Batas defensif anti-DoS: masukan lebih panjang dipotong sebelum dipindai.
 * 2 MB jauh di atas ambang context window model mana pun, jadi tidak
 * ada masukan sah yang ikut terpotong, tapi biaya pemindaian tetap terbatas.
 */
export const DEFAULT_MAX_PROMPT_CHARS = 2_000_000;

/** Kode error sanitasi jalur — stabil, dipakai pemanggil untuk logging/audit. */
export type PathSanitizeCode = 'NULL_BYTE' | 'PATH_TRAVERSAL' | 'EMPTY_PATH';

export class PathSanitizationError extends Error {
  constructor(
    public code: PathSanitizeCode,
    message: string,
  ) {
    super(message);
    this.name = 'PathSanitizationError';
  }
}

export interface SanitizeOptions {
  /** Panjang maksimum masukan sebelum dipotong (anti-DoS). */
  maxChars?: number;
}

function toInputString(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input === null || input === undefined) return '';
  try {
    return String(input);
  } catch {
    return '';
  }
}

/**
 * Sanitasi teks tak tepercaya untuk injeksi ke prompt LLM.
 *
 * Kontrak: hasil SELALU berupa ASCII "aman" — karakter non-ASCII ditulis ulang
 * sebagai escape `\uXXXX` (BMP) atau `\u{XXXXX}` (astral), sehingga model tidak
 * bisa ditipu homoglyph visual maupun direksi teks BiDi.
 */
export function sanitizeForPrompt(input: string, opts: SanitizeOptions = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_PROMPT_CHARS;
  let s = toInputString(input);

  // 0. Batas anti-DoS sebelum kerja mahal apa pun.
  if (s.length > maxChars) s = s.slice(0, maxChars);

  // 1. NFKC memetakan separator kompatibilitas ke bentuk ASCII
  //    (U+FF0F -> '/', U+FF0E -> '.', U+2025 -> '..', U+FB01 -> 'fi', ...).
  //    Homoglyph yang TIDAK punya dekomposisi kompatibilitas (mis. U+2215
  //    DIVISION SLASH) tidak dipetakan: ia jatuh ke allowlist dan ditulis
  //    sebagai escape di langkah 3 — hasil yang aman, bukan slash palsu.
  s = s.normalize('NFKC');

  // 2. Buang karakter tersembunyi (BiDi, zero-width, BOM, soft hyphen).
  s = s.replace(STRIP_RE, '');

  // 3. SATU lintasan per CODE POINT (bukan per code unit UTF-16). Kontrol ASCII
  //    ikut ditangani di sini, bukan lewat penggantian terpisah: dua tahap
  //    akan membuat backslash hasil escape ikut ter-escape lagi.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const codePoint = s.codePointAt(i)!;

    if (codePoint > 0xffff) {
      out += `\\u{${codePoint.toString(16).toUpperCase()}}`;
      i++; // lewati pasangan low surrogate
      continue;
    }

    const char = String.fromCodePoint(codePoint);
    if (ALLOWED_ASCII_RE.test(char)) {
      out += char;
      continue;
    }
    // Kontrol ASCII maupun karakter lain di luar allowlist memakai escape yang
    // sama: `\uXXXX` (newline, NUL, DEL, aksara non-Latin, dan karakter aus).
    out += `\\u${codePoint.toString(16).padStart(4, '0')}`;
  }
  return out;
}

/**
 * Nama berkas/direktori yang diprioritaskan oleh Win32, case-insensitive,
 * dengan atau tanpa ekstensi (`con`, `con.txt`, `NUL`, `COM1`, ...).
 */
const WIN_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** True bila segmen nama berkas dilarang Win32. */
export function isWinReservedSegment(segment: string): boolean {
  return WIN_RESERVED_RE.test(segment);
}

/**
 * Sanitasi & validasi jalur sistem berkas.
 *
 * Berbeda dari {@link sanitizeForPrompt}, fungsi ini TIDAK melakukan allowlist
 * ASCII: karakter multibyte yang sah (mis. `dokumen/panduan_résumé.md`) wajib
 * tetap terbaca utuh. Yang dilakukan:
 *
 *  - Tolak null byte (`\0`) — pemengalan jalur (QA TC-SEC-02).
 *  - Normalisasi NFKC sehingga `‥` (U+2025 → `..`) tidak bisa menyamar.
 *  - Tolak segmen `..` (path traversal) dan hasil di luar workspace bila
 *    `workspaceRoot` diberikan.
 *  - Escape nama reserved Win32 (`con` → `_con`) alih-alih menggagalkan.
 *  - Ratakan separator berulang & buang segmen `.`/kosong.
 */
export function sanitizePath(input: string, workspaceRoot?: string): string {
  if (typeof input !== 'string') input = toInputString(input);
  if (input.length === 0) throw new PathSanitizationError('EMPTY_PATH', 'Jalur kosong');

  if (input.includes('\0')) {
    throw new PathSanitizationError('NULL_BYTE', 'Null byte terdeteksi pada jalur berkas');
  }

  // Normalisasi kompatibilitas: U+2025/U+FF0E/U+FF0F semuanya memetakan ke
  // '.', '/', dan '\' sehingga tidak bisa dipakai menyamar traversal.
  let normalized = input.normalize('NFKC');
  normalized = normalized.replace(/\\/g, '/');

  const isAbsolute = normalized.startsWith('/');
  const hadTrailingSlash = normalized.length > 1 && normalized.endsWith('/');

  const segments = normalized.split('/');
  const outSegments: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue; // `./a//b` → `a/b`
    if (seg === '..') {
      if (outSegments.length === 0) {
        throw new PathSanitizationError('PATH_TRAVERSAL', `Path traversal terdeteksi: ${input}`);
      }
      outSegments.pop();
      continue;
    }
    outSegments.push(seg);
  }

  if (outSegments.length === 0) {
    throw new PathSanitizationError('EMPTY_PATH', 'Jalur tidak menghasilkan segmen valid');
  }

  if (process.platform === 'win32') {
    for (let i = 0; i < outSegments.length; i++) {
      if (isWinReservedSegment(outSegments[i])) outSegments[i] = `_${outSegments[i]}`;
    }
  }

  const joined = outSegments.join('/');
  const result = isAbsolute ? `/${joined}` : joined;

  // Jaring pengaman: bila `workspaceRoot` diberikan, jalur absolut wajib
  // menunjuk ke dalam root. Jalur relatif otomatis menempel pada root karena
  // setiap `..` yang keluar sudah ditolak di atas. Perbandingan murni leksikal
  // (tanpa I/O) — otoritas atas symlink fisik ada di lapisan secureRead.
  if (workspaceRoot && isAbsolute) {
    const rootSegments = workspaceRoot.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
    const insideRoot =
      outSegments.length >= rootSegments.length &&
      rootSegments.every((seg, idx) => outSegments[idx] === seg);
    if (!insideRoot) {
      throw new PathSanitizationError('PATH_TRAVERSAL', `Jalur absolut di luar workspace: ${input}`);
    }
  }

  return hadTrailingSlash ? `${result}/` : result;
}
