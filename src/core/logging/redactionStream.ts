/**
 * redactionStream.ts — F1-T4 (Fase 1, Blueprint v2.0.0)
 *
 * Redaksi data sensitif pada stream log: Transform tanpa sintaks regex
 * `(?i)` PCRE (diaktifkan via flag `i`), menggunakan StringDecoder agar
 * token multi-byte tidak terbelah di batas chunk buffer.
 *
 * Hardening dari temuan QA.md §1.6 (boundary splitting):
 *  - Buffer TIDAK dipotong secara mentah di batas 512 byte — token rahasia
 *    yang terbelah (mis. `ghp_` di chunk awal, sisa token di chunk berikut)
 *    akan lolos dari deteksi regex. Sebaliknya, pemotongan hanya dilakukan
 *    pada batas baris baru (`\n`) terakhir sebelum safe margin 512 byte.
 *  - Bila satu baris lebih panjang dari safe margin, seluruh buffer
 *    direduksi DULU lalu sisanya (512 byte terakhir) ditahan sebagai tail.
 *
 * ZERO dependency — hanya `node:stream` dan `node:string_decoder`.
 */

import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** Safe margin: sisa teks maksimal yang ditahan antar chunk (byte/char). */
const SAFE_MARGIN = 512;

const REDACTION_RULES = [
  {
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    replace: '[REDACTED:PRIVATE_KEY]',
  },
  { pattern: /gh[pousr]_[A-Za-z0-9_]{36,255}/g, replace: '[REDACTED:GITHUB_TOKEN]' },
  { pattern: /AKIA[0-9A-Z]{16}/g, replace: '[REDACTED:AWS_KEY]' },
  { pattern: /Bearer\s+[A-Za-z0-9\-_.=]{16,512}/gi, replace: 'Bearer [REDACTED:BEARER]' },
  {
    pattern: /(api[_-]?key|secret|password)["'\s:=]{1,4}[A-Za-z0-9_\-]{16,128}/gi,
    replace: '$1=[REDACTED]',
  },
];

/** Menerapkan seluruh aturan redaksi terhadap satu potongan teks. */
export function redactText(text: string): string {
  let out = text;
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.pattern, rule.replace);
  }
  return out;
}

/**
 * Transform stream pensoran kredensial. Potongan teks hanya dilepas ke
 * downstream pada batas baris utuh (di luar safe margin 512 byte), sehingga
 * token rahasia yang berada di dekat batas chunk tetap terbelah secara UTUH
 * dalam satu pass redaksi — bukan terpotong di antara dua chunk.
 */
export class RedactionTransform extends Transform {
  private tail = '';
  private decoder = new StringDecoder('utf8');

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    let str = this.tail + this.decoder.write(chunk);

    if (str.length > SAFE_MARGIN) {
      // Cari newline terakhir sebelum safe margin 512 byte
      const searchBoundary = str.length - SAFE_MARGIN;
      const lastNewline = str.lastIndexOf('\n', searchBoundary);

      if (lastNewline !== -1) {
        // Potong hanya pada batas baris utuh → redaksi aman per baris
        const safeChunk = str.slice(0, lastNewline + 1);
        this.push(redactText(safeChunk));
        this.tail = str.slice(lastNewline + 1);
      } else {
        // Satu baris sangat panjang (> safe margin): redaksikan SELURUHnya
        // dahulu, baru simpan 512 karakter terakhir sebagai tail. Token yang
        // terbelah di titik ini tetap berada dalam jendela redaksi yang sama.
        const redacted = redactText(str);
        const processUpTo = redacted.length - SAFE_MARGIN;
        this.push(redacted.slice(0, processUpTo));
        this.tail = redacted.slice(processUpTo);
      }
    } else {
      this.tail = str;
    }
    callback();
  }

  _flush(callback: TransformCallback) {
    this.tail += this.decoder.end();
    if (this.tail) {
      this.push(redactText(this.tail));
      this.tail = '';
    }
    callback();
  }
}

/**
 * Memangkas keluaran subprocess untuk konsumsi LLM: hanya ringkasan baris
 * error (maks. 10) dan 15 baris terakhir yang dikembalikan.
 */
export function pruneForLLM(rawOutput: string, exitCode: number | null): string {
  const lines = rawOutput.split('\n');
  const last15 = lines.slice(-15).join('\n');
  const errors = lines.filter((l) => /(error|fail|exception)/i.test(l)).slice(0, 10);
  return [
    `EXIT_CODE: ${exitCode ?? 'unknown'}`,
    `--- ERROR SUMMARY (pruned) ---`,
    errors.join('\n') || '(no error pattern detected)',
    `--- LAST 15 LINES ---`,
    last15,
  ].join('\n');
}
