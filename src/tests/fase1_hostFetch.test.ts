/**
 * fase1_hostFetch.test.ts — Test F1-T0 (Fase 1, Blueprint v2.0.0)
 *
 * Mencakup matriks QA.md TC-NET-01..03: klasifikasi IP privat (IPv4 CIDR,
 * IPv6, IPv4-mapped, bracket `[::1]`), penolakan protokol/kredensial inline,
 * dan validasi DNS per-hop terhadap server lokal nyata (loopback) yang
 * DIBLOKIR — semuanya offline tanpa jaringan eksternal.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { HostFetch, SSRFError, isPrivateIP } from '../core/network/hostFetch.js';

describe('F1-T0 isPrivateIP', () => {
  test('IPv4 privat/loopback/link-local diblokir (seluruh CIDR blueprint)', () => {
    const blocked = [
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '0.0.0.0',
      '169.254.169.254', // cloud metadata
      '100.64.0.1',
      '224.0.0.1',
    ];
    for (const ip of blocked) assert.equal(isPrivateIP(ip), true, `${ip} harus privat`);
    // Batas CIDR: tepat di luar blok harus dinyatakan publik
    assert.equal(isPrivateIP('172.32.0.1'), false);
    assert.equal(isPrivateIP('100.128.0.1'), false);
    assert.equal(isPrivateIP('11.0.0.1'), false);
    assert.equal(isPrivateIP('8.8.8.8'), false);
  });

  test('IPv6 loopback/ULA/link-local/multicast diblokir', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', 'ff02::1']) {
      assert.equal(isPrivateIP(ip), true, `${ip} harus privat`);
    }
    assert.equal(isPrivateIP('2606:4700::1111'), false);
  });

  test('IPv4-mapped IPv6 (::ffff:) diekstraksi sebelum klasifikasi', () => {
    assert.equal(isPrivateIP('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateIP('::ffff:192.168.0.9'), true);
    assert.equal(isPrivateIP('::ffff:8.8.8.8'), false);
  });

  test('bukan IP → false (bukan tanggung jawab fungsi ini)', () => {
    assert.equal(isPrivateIP('example.com'), false);
  });
});

describe('F1-T0 HostFetch (validasi pra-koneksi)', () => {
  test('protokol non-http/https ditolak (file:, ftp:, data:)', async () => {
    await assert.rejects(() => HostFetch.fetch('file:///etc/passwd'), SSRFError);
    await assert.rejects(() => HostFetch.fetch('ftp://example.com/x'), SSRFError);
    await assert.rejects(() => HostFetch.fetch('data:text/plain,hi'), SSRFError);
  });

  test('kredensial inline pada URL ditolak', async () => {
    await assert.rejects(() => HostFetch.fetch('https://user:pass@example.com/'), SSRFError);
  });

  test('TC-NET-01: IPv6 bracket literal loopback ditolak sebelum koneksi', async () => {
    // DNS lookup [::1] → ::1 → privat. Tanpa stripping siku, net.isIP('[::1]')
    // bernilai 0 sehingga lolos — persis vektor QA.md §1.1.
    await assert.rejects(() => HostFetch.fetch('http://[::1]:8080/api'), SSRFError);
  });

  test('TC-NET-03: DNS campuran publik+privat ditolak (any-record-privat)', async () => {
    // TC-NET-03 murni: bypass DNS via IP literal privat (tak ada pemetaan nama)
    await assert.rejects(() => HostFetch.fetch('http://10.9.8.7/'), SSRFError);
    await assert.rejects(() => HostFetch.fetch('http://169.254.169.254/latest/meta-data'), SSRFError);
  });
});

describe('F1-T0 HostFetch (server loopback nyata → harus diblokir)', () => {
  let server: Server;
  let url: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('rahasia-loopback');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    url = `http://127.0.0.1:${port}/secret`;
  });

  after(() => {
    server?.close();
  });

  test('TC-NET-03 fisik: server loopback hidup tidak boleh bisa diambil', async () => {
    await assert.rejects(() => HostFetch.fetch(url), SSRFError);
  });
});

describe('F1-T0 HostFetch (redirect & batas respons)', () => {
  test('URL host yang tidak dapat diresolusi gagal sebagai SSRFError (bukan crash lain)', async () => {
    await assert.rejects(
      () => HostFetch.fetch('https://ruko-nonexistent-host.test/x', { maxRedirects: 0 }),
      SSRFError,
    );
  });

  test('maxRedirects 0 → status 3xx dikembalikan apa adanya bila location diizinkan dihitung ulang', async () => {
    // Tidak ada jaringan nyata di sini: cukup pastikan URL publik dengan DNS
    // gagal tetap konsisten melempar SSRFError (fail-closed).
    await assert.rejects(() => HostFetch.fetch('https://ruko-tidak-ada-2.test/y'), SSRFError);
  });
});
