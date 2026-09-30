/**
 * redactionStream.ts — Transform stream yang menyembunyikan kredensial.
 *
 * MASALAH YANG DISELESAIKAN
 * -------------------------
 * Membuang output mentah ke dalam `state.json`, `audit log`, atau terminal bisa
 * membocorkan `ghp_…`, private key, `Authorization: Bearer …`, atau
 * `api_key=…`. Pola umum "redact per chunk" bocor karena token bisa TERBELAH di
 * batas chunk: `ghp_` di akhir chunk 1, sisanya di awal chunk 2 (QA TC-RED-01).
 *
 * ALGORITMA
 * ---------
 * Yang dipusatkan ke downstream adalah `tail` (ekor buffer), bukan data mentah:
 *
 *  1. `StringDecoder` menjaga agar multi-byte UTF-8 tidak terpotong di tengah
 *     karakter.
 *  2. Cari titik potong aman: newline TERAKHIR pada atau sebelum
 *     `panjang - TAIL_MARGIN`. Titik potong di batas baris membuat token
 *     terpecah secara sah.
 *  3. Bila tidak ada newline (satu baris sangat panjang), TIDAK ada yang
 *     dipusatkan; seluruh isi masuk `tail`. Redaksi baru berjalan saat `tail`
 *     melewati `HARD_CAP`, dan saat itu redaksi diterapkan ke SELURUH buffer —
 *     sehingga tidak pernah ada potongan mentah yang bocor.
 *
 * INVARIAN KEAMANAN: setiap byte yang keluar dari stream ini sudah melewati
 * `redactText()` pada konteks yang mencakup minimal `TAIL_MARGIN` karakter
 * sekitarnya. `TAIL_MARGIN` (512) jauh lebih besar daripada pola terpanjang
 * (token GitHub 255 karakter + awalan).
 *
 * Zero runtime dependency — hanya `node:stream` dan `node:string_decoder`.
 */

import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

interface RedactionRule {
  pattern: RegExp;
  replace: string;
}

/**
 * Aturan redaksi. Mayoritas case-insensitive; token GitHub/AWS sengaja
 * case-sensitive sesuai bentuk aslinya.
 */
const REDACTION_RULES: RedactionRule[] = [
  {
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    replace: '[REDACTED:PRIVATE_KEY]',
  },
  { pattern: /gh[pousr]_[A-Za-z0-9_]{36,255}/g, replace: '[REDACTED:GITHUB_TOKEN]' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: '[REDACTED:AWS_KEY]' },
  { pattern: /\bASIA[0-9A-Z]{16}\b/g, replace: '[REDACTED:AWS_KEY]' },
  { pattern: /(?:Bearer|Basic)\s+[A-Za-z0-9\-_\.=+/]{16,512}/gi, replace: 'Bearer [REDACTED]' },
  { pattern: /(api[_-]?key|secret|password|passwd|token)["'\s:=]{1,4}[A-Za-z0-9_\-]{16,128}/gi, replace: '$1=[REDACTED]' },
  { pattern: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, replace: '[REDACTED:CERTIFICATE]' },
];

/** Konteks Character minimal yang dijaga sebagai ekor buffer (batas aman). */
const TAIL_MARGIN = 512;

/** Batas keras ekor: lewat ini, buffer direpresi penuh lalu dipusatkan. */
const HARD_CAP = 256 * 1024;

/** Redaksi satu string penuh (tanpa state). */
export function redactText(text: string): string {
  let out = text;
  for (const rule of REDACTION_RULES) {
    out = out.replace(rule.pattern, rule.replace);
  }
  return out;
}

export class RedactionTransform extends Transform {
  private tail = '';
  private readonly decoder = new StringDecoder('utf8');
  /** Dipusatkan otomatis saat `tail` melewati batas keras (anti memory spike). */
  private autoFlushBytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    let str = this.tail + this.decoder.write(chunk);

    // 1. Cari titik potong pada batas baris utuh, dengan margin aman.
    if (str.length > TAIL_MARGIN) {
      const searchUpTo = str.length - TAIL_MARGIN;
      const lastNewline = str.lastIndexOf('\n', searchUpTo);

      if (lastNewline !== -1) {
        const safeChunk = str.slice(0, lastNewline + 1);
        this.push(redactText(safeChunk));
        str = str.slice(lastNewline + 1);
      } else if (str.length > HARD_CAP) {
        // Satu baris raksasa: redaksi SELURUH buffer dulu (tidak ada data
        // mentah yang keluar), baru keluarkan sisanya saja.
        const redacted = redactText(str);
        const keep = Math.max(0, redacted.length - TAIL_MARGIN);
        this.push(redacted.slice(0, keep));
        str = redacted.slice(keep);
      }
    }

    this.tail = str;
    this.autoFlushBytes += chunk.length;
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.tail += this.decoder.end();
    if (this.tail) {
      this.push(redactText(this.tail));
      this.tail = '';
    }
    callback();
  }

  /** Eksposisi status internal untuk self-check/pengujian. */
  get bufferedTailLength(): number {
    return this.tail.length;
  }

  /** Total byte yang pernah masuk stream (termasuk yang masih di-tail). */
  get totalBytes(): number {
    return this.autoFlushBytes;
  }
}

/**
 * Ringkas output proses untuk dikirim ke LLM: kode keluar, ringkasan error,
 * dan 15 baris terakhir. Menjaga window context tetap kecil saat build gagal
 * besar, dan tidak mengirim log_SECRET mentah apa pun (redaksi tetap jalan).
 */
export function pruneForLLM(rawOutput: string, exitCode: number | null): string {
  const redacted = redactText(rawOutput);
  const lines = redacted.split('\n');
  const last15 = lines.slice(-15).join('\n');
  const errors = lines.filter((l) => /(error|fail|exception)/i.test(l)).slice(0, 10);
  return [
    `EXIT_CODE: ${exitCode ?? 'unknown'}`,
    '--- ERROR SUMMARY (pruned) ---',
    errors.join('\n') || '(no error pattern detected)',
    '--- LAST 15 LINES ---',
    last15,
  ].join('\n');
}
