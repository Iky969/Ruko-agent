/**
 * F1-T0 — HostFetch: IP pinning, SNI, dan penolakan SSRF per hop.
 *
 * Matriks acuan: QA.md §1.1 dan TC-NET-01 / TC-NET-02 / TC-NET-03.
 *
 * Redirect diuji lewat seam `sendRequest` (respons sintetis) karena skenario
 * "hop 1 lolos lalu hop 2 ditolak" tidak bisa dibentuk dengan server lokal
 * (hop 1 di sana selalu privat). Resolver seam tetap melewati seluruh
 * pemeriksaan IP privat, jadi seam tidak melemahkan proteksi.
 */
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';

import {
  HostFetch,
  HostFetchError,
  SSRFError,
  isPrivateIP,
  stripIpv6Brackets,
  validateAndResolve,
  type DnsRecord,
  type FetchResult,
  type RequestPlan,
} from '../core/network/hostFetch.js';

/** Resolver seam: hostname -> daftar record yang telah disetujui test. */
function fakeResolver(table: Record<string, DnsRecord[]>) {
  return async (hostname: string): Promise<DnsRecord[]> => {
    const found = table[hostname];
    if (!found) throw new SSRFError(`DNS_GAGAL: ${hostname}`);
    return found;
  };
}

describe('F1-T0 isPrivateIP — klasifikasi jaringan terlarang', () => {
  test('IPv4 privat/loopback/link-local/CGNAT/multicast ditolak', () => {
    for (const ip of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '127.1.2.3',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      assert.equal(isPrivateIP(ip), true, ip);
    }
  });

  test('IPv4 publik diizinkan', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '192.169.0.1', '11.0.0.1']) {
      assert.equal(isPrivateIP(ip), false, ip);
    }
  });

  test('IPv6 loopback/ULA/link-local/multicast ditolak, publik diizinkan', () => {
    for (const ip of ['::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1']) {
      assert.equal(isPrivateIP(ip), true, ip);
    }
    assert.equal(isPrivateIP('2606:4700:4700::1111'), false);
  });

  test('IPv4-mapped IPv6 ikut diklasifikasi', () => {
    assert.equal(isPrivateIP('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateIP('::ffff:10.0.0.5'), true);
    assert.equal(isPrivateIP('::ffff:8.8.8.8'), false);
  });

  test('kurung siku IPv6 literal tidak menerobos klasifikasi (QA §1.1)', () => {
    assert.equal(stripIpv6Brackets('[::1]'), '::1');
    assert.equal(stripIpv6Brackets('example.com'), 'example.com');
    assert.equal(isPrivateIP('[::1]'), true);
  });

  test('input yang bukan IP dianggap terlarang (fail-closed)', () => {
    assert.equal(isPrivateIP('example.com'), true);
    assert.equal(isPrivateIP(''), true);
  });
});

describe('F1-T0 validateAndResolve — gerbang per hop', () => {
  test('protokol di luar allowlist ditolak', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://example.com/', 'data:text/plain,x']) {
      await assert.rejects(
        validateAndResolve(new URL(url), fakeResolver({})),
        (err: unknown) => err instanceof SSRFError,
        url,
      );
    }
  });

  test('kredensial inline pada URL ditolak', async () => {
    await assert.rejects(
      validateAndResolve(new URL('http://user:pass@example.com/'), fakeResolver({})),
      (err: unknown) => err instanceof SSRFError && err.message.includes('KREDENSIAL_INLINE'),
    );
  });

  test('TC-NET-03: satu record privat sudah cukup untuk menolak', async () => {
    await assert.rejects(
      validateAndResolve(
        new URL('http://mixed.example.com/'),
        fakeResolver({
          'mixed.example.com': [
            { address: '93.184.216.34', family: 4 },
            { address: '10.0.0.1', family: 4 },
          ],
        }),
      ),
      (err: unknown) => err instanceof SSRFError && err.message.includes('IP_TERLARANG'),
    );
  });

  test('semua record publik diteruskan sebagai kandidat', async () => {
    const records = await validateAndResolve(
      new URL('http://cdn.example.com/a'),
      fakeResolver({
        'cdn.example.com': [
          { address: '93.184.216.34', family: 4 },
          { address: '8.8.8.8', family: 4 },
        ],
      }),
    );
    assert.equal(records.length, 2);
  });
});

describe('F1-T0 HostFetch — IP pinning & alur redirect', () => {
  test('request dikirim ke IP terverifikasi, sementara URL/Host tetap hostname asli', async () => {
    const plans: RequestPlan[] = [];
    await HostFetch.fetch('https://api.example.com/v1/data?q=1', {
      deps: {
        resolveHostname: fakeResolver({ 'api.example.com': [{ address: '93.184.216.34', family: 4 }] }),
        sendRequest: async (plan) => {
          plans.push(plan);
          return { status: 200, headers: {}, body: 'ok' };
        },
      },
    });

    assert.equal(plans.length, 1);
    const plan = plans[0];
    assert.equal(plan.pinnedIP, '93.184.216.34', 'socket harus diarahkan ke IP hasil verifikasi');
    assert.equal(plan.url.hostname, 'api.example.com', 'SNI/Host tetap hostname asli');
    assert.equal(plan.url.pathname, '/v1/data');
    assert.equal(plan.url.search, '?q=1');
  });

  test('TC-NET-02: redirect ke metadata cloud ditolak SEBELUM hop kedua dikirim', async () => {
    let sent = 0;
    await assert.rejects(
      HostFetch.fetch('http://safe.example.com/start', {
        deps: {
          resolveHostname: fakeResolver({
            'safe.example.com': [{ address: '93.184.216.34', family: 4 }],
            '169.254.169.254': [{ address: '169.254.169.254', family: 4 }],
          }),
          sendRequest: async () => {
            sent += 1;
            return {
              status: 302,
              headers: { location: 'http://169.254.169.254/latest/meta-data/' },
              body: '',
            };
          },
        },
      }),
      (err: unknown) => err instanceof SSRFError && err.message.includes('IP_TERLARANG'),
    );
    assert.equal(sent, 1, 'hanya hop 1 yang boleh terkirim');
  });

  test('TC-NET-01: IPv6 literal loopback ditolak tanpa membuka socket', async () => {
    let sent = 0;
    await assert.rejects(
      HostFetch.fetch('http://[::1]:8080/api', {
        deps: {
          sendRequest: async () => {
            sent += 1;
            return { status: 200, headers: {}, body: '' } as FetchResult;
          },
        },
      }),
      (err: unknown) => err instanceof SSRFError,
    );
    assert.equal(sent, 0);
  });

  test('redirect loop dideteksi, bukan dibiarkan berjalan', async () => {
    await assert.rejects(
      HostFetch.fetch('http://a.example.com/', {
        maxRedirects: 5,
        deps: {
          resolveHostname: fakeResolver({
            'a.example.com': [{ address: '93.184.216.34', family: 4 }],
            'b.example.com': [{ address: '8.8.8.8', family: 4 }],
          }),
          sendRequest: async (plan) =>
            plan.url.hostname === 'a.example.com'
              ? { status: 302, headers: { location: 'http://b.example.com/' }, body: '' }
              : { status: 302, headers: { location: 'http://a.example.com/' }, body: '' },
        },
      }),
      (err: unknown) => err instanceof HostFetchError && err.code === 'REDIRECT_LOOP',
    );
  });

  test('batas jumlah redirect dihormati', async () => {
    await assert.rejects(
      HostFetch.fetch('http://a.example.com/', {
        maxRedirects: 2,
        deps: {
          resolveHostname: fakeResolver({
            'a.example.com': [{ address: '93.184.216.34', family: 4 }],
            'b.example.com': [{ address: '8.8.8.8', family: 4 }],
            'c.example.com': [{ address: '1.1.1.1', family: 4 }],
          }),
          sendRequest: async (plan): Promise<FetchResult> => {
            const next: Record<string, string> = {
              'a.example.com': 'b',
              'b.example.com': 'c',
              'c.example.com': 'a',
            };
            return {
              status: 302,
              headers: { location: `http://${next[plan.url.hostname]}.example.com/` },
              body: '',
            };
          },
        },
      }),
      (err: unknown) => err instanceof HostFetchError,
    );
  });

  test('redirect relatif (Location tanpa host) tetap dievaluasi dari host yang sama', async () => {
    const plans: RequestPlan[] = [];
    const result = await HostFetch.fetch('http://a.example.com/first', {
      deps: {
        resolveHostname: fakeResolver({ 'a.example.com': [{ address: '93.184.216.34', family: 4 }] }),
        sendRequest: async (plan): Promise<FetchResult> => {
          plans.push(plan);
          if (plans.length === 1) {
            return { status: 301, headers: { location: '/second' }, body: '' };
          }
          return { status: 200, headers: {}, body: 'done' };
        },
      },
    });
    assert.equal(result.body, 'done');
    assert.equal(plans[1].url.pathname, '/second');
    assert.equal(plans[1].pinnedIP, '93.184.216.34');
  });

  test('body dan method diteruskan ke lapisan request', async () => {
    const plans: RequestPlan[] = [];
    await HostFetch.fetch('http://a.example.com/submit', {
      method: 'POST',
      body: 'payload=1',
      deps: {
        resolveHostname: fakeResolver({ 'a.example.com': [{ address: '93.184.216.34', family: 4 }] }),
        sendRequest: async (plan) => {
          plans.push(plan);
          return { status: 200, headers: {}, body: '' };
        },
      },
    });
    assert.equal(plans[0].method, 'POST');
    assert.equal(plans[0].body, 'payload=1');
  });

  test('URL rusak ditolak dengan SSRFError yang jelas', async () => {
    await assert.rejects(
      HostFetch.fetch('http://[oops', { deps: { resolveHostname: fakeResolver({}) } }),
      (err: unknown) => err instanceof SSRFError,
    );
  });
});

describe('F1-T0 HostFetch — jalur produksi (tanpa seam)', () => {
  test('server loopback lokal ditolak, dan tidak ada request yang sampai', async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.end('secret-internal');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await assert.rejects(
        HostFetch.fetch(`http://127.0.0.1:${port}/internal`),
        (err: unknown) => err instanceof SSRFError && err.code === 'PRIVATE_IP_BLOCKED',
      );
      assert.equal(hits, 0, 'request tidak boleh sampai ke server internal');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('localhost (nama host yang resolve ke loopback) ikut ditolak', async () => {
    await assert.rejects(
      HostFetch.fetch('http://localhost:9999/'),
      (err: unknown) => err instanceof SSRFError,
    );
  });
});
