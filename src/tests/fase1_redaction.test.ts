/**
 * F1-T4 — RedactionTransform: penyensoran kredensial pada stream log.
 *
 * Matriks acuan: QA.md §1.6 (secret bocor di batas chunk) dan TC-RED-01
 * (token `ghp_` terbelah persis di batas byte 512).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RedactionTransform, pruneForLLM, redactText } from '../core/logging/redactionStream.js';

const GITHUB_TOKEN = `ghp_${'A'.repeat(36)}`;

/** Kumpulkan seluruh output stream sampai `_flush` selesai. */
function collect(chunks: (Buffer | string)[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = new RedactionTransform();
    const out: string[] = [];
    stream.on('data', (c: Buffer | string) => out.push(c.toString()));
    stream.on('end', () => resolve(out.join('')));
    stream.on('error', reject);
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
}

describe('F1-T4 redactText — pola dasar', () => {
  test('token GitHub disensor penuh', () => {
    const out = redactText(`token=${GITHUB_TOKEN} selesai`);
    assert.equal(out, 'token=[REDACTED:GITHUB_TOKEN] selesai');
  });

  test('kunci AWS disensor', () => {
    assert.equal(redactText('AKIAIOSFODNN7EXAMPLE'), '[REDACTED:AWS_KEY]');
  });

  test('header Authorization disensor', () => {
    const out = redactText('Authorization: Bearer abcdef0123456789ABCDEF');
    assert.ok(!out.includes('abcdef0123456789ABCDEF'), out);
    assert.ok(out.includes('[REDACTED]'), out);
  });

  test('pasangan api_key/secret/password disensor, labelnya dipertahankan', () => {
    const out = redactText('api_key=0123456789abcdefghij');
    assert.equal(out, 'api_key=[REDACTED]');
    assert.ok(!redactText('password: hunter2hunter2hunter2').includes('hunter2hunter2hunter2'));
  });

  test('blok private key disensor utuh (multiline)', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEAx0000000000000000000000000000000000000000',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactText(pem);
    assert.equal(out, '[REDACTED:PRIVATE_KEY]');
    assert.ok(!out.includes('MIIEowIBAAKCAQEAx'));
  });

  test('teks biasa tidak berubah', () => {
    const plain = 'compile succeeded in 42ms (src/index.ts:10)';
    assert.equal(redactText(plain), plain);
  });
});

describe('F1-T4 RedactionTransform — keamanan batas chunk', () => {
  test('TC-RED-01: token yang terbelah tepat di batas 512 byte tetap disensor', async () => {
    // Baris pendek sebagai bantalan, lalu token ditempatkan melintasi offset 512.
    const prefix = `${'a'.repeat(500)}\n`;
    const body = `token=${GITHUB_TOKEN}\n`;
    const splitAt = prefix.length + 10; // memotong di tengah token
    const full = prefix + body;

    const out = await collect([Buffer.from(full.slice(0, splitAt)), Buffer.from(full.slice(splitAt))]);

    assert.ok(!out.includes(GITHUB_TOKEN), `token bocor: ${out}`);
    assert.ok(!out.includes('ghp_AAAA'), `prefix token bocor: ${out}`);
    assert.ok(out.includes('[REDACTED:GITHUB_TOKEN]'), out);
  });

  test('token yang dikirim 1 karakter demi 1 tidak pernah bocor', async () => {
    const line = `export TOKEN = "${GITHUB_TOKEN}";\n`;
    const out = await collect([...line].map((c) => Buffer.from(c, 'utf8')));
    assert.ok(!out.includes(GITHUB_TOKEN), out);
    assert.ok(out.includes('[REDACTED:GITHUB_TOKEN]'), out);
  });

  test('beberapa secret dalam satu baris panjang tanpa newline tetap aman', async () => {
    const line = `A=${GITHUB_TOKEN} B=AKIAIOSFODNN7EXAMPLE C=${GITHUB_TOKEN}`;
    const out = await collect([Buffer.from(line.slice(0, 60)), Buffer.from(line.slice(60))]);
    assert.ok(!out.includes(GITHUB_TOKEN), out);
    assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'), out);
  });

  test('private key yang terbelah antar chunk tetap terensor', async () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAAB\n-----END OPENSSH PRIVATE KEY-----\n';
    const out = await collect([Buffer.from(pem.slice(0, 20)), Buffer.from(pem.slice(20))]);
    assert.ok(!out.includes('b3BlbnNzaC1rZXktdjEAAAAAB'), out);
    assert.ok(out.includes('[REDACTED:PRIVATE_KEY]'), out);
  });

  test('karakter multi-byte UTF-8 tidak rusak saat chunk dipotong di tengah byte', async () => {
    const text = 'log: deploy selesai — semua layanan sehat\n';
    const bytes = Buffer.from(text, 'utf8');
    // Potong tepat di tengah byte karakter '—' (3 byte).
    const emDashIndex = bytes.indexOf(Buffer.from('—', 'utf8'));
    const out = await collect([bytes.subarray(0, emDashIndex + 1), bytes.subarray(emDashIndex + 1)]);
    assert.ok(out.includes('—'), out);
  });

  test('baris pendek ditahan di tail dan dipusatkan saat flush (tanpa bocor)', async () => {
    const stream = new RedactionTransform();
    const out: string[] = [];
    stream.on('data', (c: Buffer) => out.push(c.toString()));
    const line = 'npm run build\n';
    stream.write(Buffer.from(line));
    await new Promise((r) => setImmediate(r));

    // Belum dipusatkan: masih di ekor buffer (itulah yang mencegah token
    // terbelah bocor keluar).
    assert.equal(stream.bufferedTailLength, line.length);
    assert.equal(out.length, 0);

    const flushed = new Promise((resolve) => stream.on('end', resolve));
    stream.end();
    await flushed;
    assert.equal(out.join(''), line);
    assert.equal(stream.bufferedTailLength, 0);
  });
});

describe('F1-T4 pruneForLLM', () => {
  test('memakai exit code, ringkasan error, dan 15 baris terakhir', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    lines[5] = 'error: TS2304 Cannot find name';
    const out = pruneForLLM(lines.join('\n'), 2);
    assert.ok(out.includes('EXIT_CODE: 2'));
    assert.ok(out.includes('Cannot find name'));
    assert.ok(out.includes('line 39'));
    assert.ok(!out.includes('line 0\n'));
  });

  test('secret ikut tersensor di ringkasan (tidak ada kebocoran ke prompt)', () => {
    const out = pruneForLLM(`deploy gagal: token=${GITHUB_TOKEN}`, 1);
    assert.ok(!out.includes(GITHUB_TOKEN), out);
    assert.ok(out.includes('[REDACTED:GITHUB_TOKEN]'), out);
  });

  test('exit code null ditulis sebagai unknown', () => {
    assert.ok(pruneForLLM('output', null).includes('EXIT_CODE: unknown'));
  });
});
