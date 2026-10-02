/**
 * fase1_redactionStream.test.ts — Test F1-T4 (Fase 1, Blueprint v2.0.0)
 *
 * Mencakup matriks QA.md TC-RED-01 (token terbelah di batas chunk 512 byte),
 * verifikasi boundary newline (QA.md §1.6), StringDecoder untuk UTF-8
 * multi-byte yang terbelah antar chunk, _flush tail, aturan redactText
 * (GitHub token, AWS key, Bearer, private key, api key/password), dan
 * pruneForLLM.
 */
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { describe, test } from 'node:test';
import { RedactionTransform, pruneForLLM, redactText } from '../core/logging/redactionStream.js';

/** Mengalirkan data ke RedactionTransform (chunking dikontrol test) dan mengumpulkan hasil. */
async function streamThrough(chunks: (string | Buffer)[]): Promise<string> {
  const transform = new RedactionTransform();
  const collected: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      collected.push(chunk.toString('utf8'));
      cb();
    },
  });
  const source = Readable.from(chunks);
  source.pipe(transform);
  transform.pipe(sink);
  await new Promise<void>((resolve, reject) => {
    sink.on('finish', () => resolve());
    sink.on('error', reject);
    source.on('error', reject);
  });
  return collected.join('');
}

describe('F1-T4 redactText', () => {
  test('GitHub token penuh disensor', () => {
    const token = `ghp_${'a'.repeat(40)}`;
    assert.equal(redactText(`token: ${token}`), 'token: [REDACTED:GITHUB_TOKEN]');
  });

  test('AWS access key disensor (AKIA + tepat 16 karakter)', () => {
    const key = `AKIA${'B2C3D4F5G6H7J8K9'}`;
    assert.equal(redactText(`aws ${key} end`), 'aws [REDACTED:AWS_KEY] end');
    // 17 karakter: hanya 16 pertama yang cocok (semantik regex blueprint)
    const overlong = `AKIA${'B2C3D4F5G6H7J8K9L0M1'}`;
    assert.ok(redactText(overlong).includes('[REDACTED:AWS_KEY]'));
  });

  test('Bearer token disensor (case-insensitive; replacement kanonis Blueprint)', () => {
    assert.equal(redactText('Authorization: Bearer abcdef0123456789abcdef'), 'Authorization: Bearer [REDACTED:BEARER]');
    // Literal replacement blueprint selalu 'Bearer [REDACTED:BEARER]'
    // meskipun kata kunci sumber ditulis huruf kapital/bawah.
    assert.equal(redactText('AUTHORIZATION bearer ABCDEF0123456789'), 'AUTHORIZATION Bearer [REDACTED:BEARER]');
  });

  test('private key PEM disensor menyeluruh', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA7',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    assert.equal(redactText(`header\n${pem}\nfooter`), 'header\n[REDACTED:PRIVATE_KEY]\nfooter');
  });

  test('api key / secret / password disensor (butuh secret ≥16 karakter)', () => {
    assert.equal(redactText('api_key = s3cr3t_value_123456'), 'api_key=[REDACTED]');
    assert.equal(redactText('PASSWORD: hunter2hunter2hunter2'), 'PASSWORD=[REDACTED]');
    assert.equal(redactText('my-secret: abcdef0123456789'), 'my-secret=[REDACTED]');
    // Secret terlalu pendek (<16) tidak dianggap kredensial
    assert.equal(redactText('password: pendek'), 'password: pendek');
  });

  test('teks bersih tidak berubah', () => {
    const clean = 'Build sukses: 42 test lulus dalam 3.2s';
    assert.equal(redactText(clean), clean);
  });
});

describe('F1-T4 RedactionTransform (boundary safety)', () => {
  test('TC-RED-01: token GITHUB terbelah di batas baris 512B tetap disensor utuh', async () => {
    const token = `ghp_${'x'.repeat(40)}`;
    // Susun baris sehingga token TEPAT menyentuh area batas 512 byte
    const fillerLen = 480;
    const line1 = 'a'.repeat(fillerLen) + '\n';
    const line2 = `TOKEN=${token}\n`;
    const out = await streamThrough([line1 + line2]);
    assert.ok(!out.includes(token), 'token tidak boleh bocor di output');
    assert.ok(out.includes('[REDACTED:GITHUB_TOKEN]'));
  });

  test('TC-RED-01 ekstrem: token terbelah persis di batas byte antar chunk', async () => {
    const token = `ghp_${'y'.repeat(40)}`;
    const full = 'Z'.repeat(510) + ` TOKEN=${token}\n`;
    // Pecah TE PAT di tengah token: 'ghp_' di chunk 1, sisanya di chunk 2
    const cut = full.indexOf('ghp_') + 2;
    const out = await streamThrough([full.slice(0, cut), full.slice(cut)]);
    assert.ok(!out.includes(token), `token terbelah antar chunk tidak boleh bocor:\n${out}`);
    assert.ok(out.includes('[REDACTED:GITHUB_TOKEN]'));
  });

  test('UTF-8 multi-byte terbelah antar chunk tidak menghasilkan karakter rusak', async () => {
    const text = `résumé: ${'é'.repeat(200)}\n`;
    const bytes = Buffer.from(text, 'utf8');
    const cut = 1 + bytes.indexOf(Buffer.from([0xC3])); // persis sebelum byte lead 'é'
    const chunk1 = bytes.subarray(0, cut).toString('latin1');
    const chunk2 = bytes.subarray(cut).toString('latin1');
    const out = await streamThrough([Buffer.from(chunk1, 'latin1'), Buffer.from(chunk2, 'latin1')]);
    assert.ok(out.includes('résumé'), `StringDecoder harus merekonstruksi utuh: ${JSON.stringify(out.slice(0, 40))}`);
  });

  test('stream besar tanpa newline: redaksi dijalankan sebelum pemotongan tail', async () => {
    const token = `ghp_${'z'.repeat(40)}`;
    const blob = `S${'Q'.repeat(600)}${token}E${'R'.repeat(600)}\n`;
    const out = await streamThrough([blob]);
    assert.ok(!out.includes(token), 'token di baris sangat panjang tidak boleh bocor');
    assert.ok(out.includes('[REDACTED:GITHUB_TOKEN]'));
  });

  test('_flush melepas tail tersisa (chunk terakhir < 512)', async () => {
    const token = `ghp_${'w'.repeat(40)}`;
    const out = await streamThrough([`akhir kecil: ${token}`]);
    assert.ok(out.includes('[REDACTED:GITHUB_TOKEN]'));
  });

  test('banyak chunk berturut-turut: tidak ada tail yang hilang atau duplikat', async () => {
    const payload = 'abcdefghij\n'.repeat(80); // 880 baris kecil → banyak boundary pass
    const out = await streamThrough([payload.slice(0, 300), payload.slice(300, 700), payload.slice(700)]);
    const count = (out.match(/abcdefghij/g) ?? []).length;
    assert.equal(count, 80, `semua baris harus utuh, dapat ${count}`);
  });
});

describe('F1-T4 pruneForLLM', () => {
  test('menghasilkan EXIT_CODE + error summary + last 15 lines', () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(`baris biasa ${i}`);
    lines[10] = 'TypeError: cannot read property x of undefined';
    const out = pruneForLLM(lines.join('\n'), 1);
    assert.match(out, /EXIT_CODE: 1/);
    assert.match(out, /ERROR SUMMARY \(pruned\)/);
    assert.match(out, /TypeError: cannot read property/);
    assert.match(out, /--- LAST 15 LINES ---/);
  });

  test('exit code null → "unknown"', () => {
    const out = pruneForLLM('ok', null);
    assert.match(out, /EXIT_CODE: unknown/);
  });

  test('tanpa pola error → placeholder', () => {
    const out = pruneForLLM('semua aman', 0);
    assert.match(out, /\(no error pattern detected\)/);
  });
});
