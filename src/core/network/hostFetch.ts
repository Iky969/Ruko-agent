/**
 * hostFetch.ts — F1-T0 (Fase 1, Blueprint v2.0.0)
 *
 * Pembatas jaringan & proteksi SSRF: isolasi permintaan HTTP/HTTPS melalui
 * resolusi DNS manual per-hop, validasi CIDR privat, pencegahan socket-reuse,
 * dan preservasi TLS SNI.
 *
 * Mekanisme pertahanan (berlapis):
 *  1. Validasi protokol (hanya http/https) dan larangan kredensial inline.
 *  2. Resolusi DNS eksplisit di SETIAP hop redirect — deny-by-default bila
 *     salah satu record mengarah ke IP privat/loopback/link-local (TC-NET-03).
 *  3. Normalisasi hostname IPv6 berkurung siku sebelum validasi (QA.md §1.1:
 *     `[::1]` lolos `net.isIP()` mentah).
 *  4. IP Pinning: hasil lookup terverifikasi disuplai langsung ke callback
 *     `lookup` soket — mencegah DNS rebinding TOCTOU (lookup sekunder kernel).
 *  5. Anti socket-reuse: `agent: false` + `Connection: close` (QA.md §1.1)
 *     sehingga redirect tidak memakai soket lama yang melewati pinning.
 *  6. SNI TLS dipertahankan via `servername` = hostname asli.
 *  7. Batas DoS: respons maksimal 5MB, timeout koneksi 10 detik, maksimal
 *     3 redirect (evaluasi DNS ulang di tiap hop — TC-NET-02).
 *
 * ZERO dependency — hanya `node:*`.
 */

import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

/** Kesalahan pembatasan jaringan (SSRF/protokol/redirect/batas ukuran). */
export class SSRFError extends Error {
  code = 'PRIVATE_IP_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'SSRFError';
  }
}

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB batas DoS
const REQUEST_TIMEOUT_MS = 10_000; // 10 detik

/** CIDR privat/loopback/link-local yang diblokir (IPv4). */
const PRIVATE_CIDRS = [
  { ip: '10.0.0.0', mask: 8 },
  { ip: '172.16.0.0', mask: 12 },
  { ip: '192.168.0.0', mask: 16 },
  { ip: '127.0.0.0', mask: 8 },
  { ip: '0.0.0.0', mask: 8 },
  { ip: '169.254.0.0', mask: 16 },
  { ip: '100.64.0.0', mask: 10 },
  { ip: '224.0.0.0', mask: 4 },
];

function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

/** Klasifikasi IP privat: IPv4 via CIDR, IPv6 via prefiks loopback/ULA/link-local. */
export function isPrivateIP(ip: string): boolean {
  let normalized = ip.toLowerCase();

  // Ekstraksi IPv4-mapped IPv6 sebelum klasifikasi
  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.substring(7);
  }

  // TC-NET-04: Blokir literal IPv4 non-standar (hex 0x..., octal 0..., dword integer)
  // yang bisa disalahartikan oleh resolver OS legacy getaddrinfo / inet_aton
  if (/^0x[0-9a-f]+(\.|$)/i.test(normalized) || /^0[0-7]+(\.|$)/.test(normalized) || /^\d+$/.test(normalized)) {
    return true;
  }

  if (net.isIP(normalized) === 4) {
    const long = ipToLong(normalized);
    return PRIVATE_CIDRS.some((cidr) => {
      const mask = ~((1 << (32 - cidr.mask)) - 1) >>> 0;
      return (long & mask) === (ipToLong(cidr.ip) & mask);
    });
  }

  if (net.isIP(normalized) === 6) {
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('ff')
    );
  }

  return false;
}

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface HostFetchOptions {
  method?: string;
  body?: string;
  maxRedirects?: number;
}

/** Mengupas kurung siku hostname IPv6 literal (`[::1]` → `::1`). */
function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

/**
 * Memvalidasi satu URL tujuan: protokol, kredensial inline, dan seluruh
 * record DNS host. Mengembalikan IP terpilih (pinning) bila lolos.
 */
async function resolveAndValidateTarget(currentUrl: string): Promise<{ url: URL; pinnedIP: string }> {
  const url = new URL(currentUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new SSRFError(`Protokol diblokir: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new SSRFError('Kredensial inline pada URL dilarang');
  }

  // QA.md §1.1: upas kurung siku sebelum validasi IP agar `[::1]` tidak lolos
  const hostname = stripBrackets(url.hostname);

  // 1. Resolusi DNS eksplisit di setiap hop (kegagalan DNS juga fail-closed
  // sebagai SSRFError — bukan error mentah getaddrinfo)
  let records: { address: string; family: number }[];
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new SSRFError(`Resolusi DNS gagal: ${hostname} (${(err as Error)?.message ?? err})`);
  }
  if (records.length === 0) throw new SSRFError(`Resolusi DNS gagal: ${hostname}`);

  // 2. Blokir jika setidaknya satu record mengarah ke IP privat (TC-NET-03)
  for (const r of records) {
    if (isPrivateIP(r.address)) {
      throw new SSRFError(`IP terlarang terdeteksi: ${hostname} -> ${r.address}`);
    }
  }

  const pinnedIP = records[0].address;
  return { url, pinnedIP };
}

export class HostFetch {
  /**
   * Melakukan permintaan HTTP(S) dengan validasi SSRF penuh per hop.
   * Redirect dievaluasi manual: setiap hop mengulang resolusi + validasi DNS.
   */
  static async fetch(urlStr: string, opts: HostFetchOptions = {}): Promise<FetchResult> {
    const maxRedirects = opts.maxRedirects ?? 3;
    let currentUrl = urlStr;
    let remainingBody = opts.body;

    for (let i = 0; i <= maxRedirects; i++) {
      const { url, pinnedIP } = await resolveAndValidateTarget(currentUrl);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      // 3. Eksekusi koneksi: IP Pinning + SNI utuh + Anti Socket-Reuse
      const response = await new Promise<FetchResult>((resolve, reject) => {
        let settled = false;
        let req: http.ClientRequest;
        try {
          req = lib.request(
            {
              hostname: pinnedIP,
              port: url.port || (isHttps ? 443 : 80),
              path: url.pathname + url.search,
              method: opts.method || 'GET',
              agent: false, // Nonaktifkan connection pool (celah socket reuse)
              headers: {
                Host: url.host,
                Connection: 'close', // Paksa penutupan TCP setelah respons
                'User-Agent': 'ruko-agent/2.0.0',
                Accept: '*/*',
              },
              servername: isHttps ? stripBrackets(url.hostname) : undefined, // SNI TLS
              timeout: REQUEST_TIMEOUT_MS,
              // QA.md §4.A.1: Runtime DNS lookup diblokir mutlak.
              // Seluruh koneksi wajib langsung terikat ke pinnedIP terverifikasi.
              lookup: (_hostname: any, _opts: any, cb: any) => {
                const err = new SSRFError('Runtime DNS lookup diblokir: seluruh koneksi wajib menggunakan pinnedIP');
                if (typeof cb === 'function') {
                  cb(err);
                } else {
                  throw err;
                }
              },
            },
            (res) => {
              let body = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                body += chunk;
                if (body.length > MAX_RESPONSE_SIZE) {
                  req.destroy(new SSRFError('Ukuran respons melebihi batas 5MB'));
                }
              });
              res.on('end', () => {
                if (settled) return;
                settled = true;
                resolve({
                  status: res.statusCode || 0,
                  headers: res.headers as Record<string, string>,
                  body,
                });
              });
              res.on('error', (err) => {
                if (settled) return;
                settled = true;
                reject(err);
              });
            },
          );
        } catch (err) {
          // URL/port tidak valid gagal sinkron — jangan biarkan unhandled
          reject(err instanceof SSRFError ? err : new SSRFError(`Request gagal dibangun: ${(err as Error)?.message ?? err}`));
          return;
        }

        req.on('timeout', () => req.destroy(new SSRFError('Batas waktu koneksi terlampaui')));
        req.on('error', (err) => {
          if (settled) return;
          settled = true;
          reject(err instanceof SSRFError ? err : new SSRFError(`Request gagal: ${(err as Error)?.message ?? err}`));
        });
        if (remainingBody) req.write(remainingBody);
        req.end();
      });

      // 4. Manual redirect handler (evaluasi ulang DNS di setiap hop)
      if (response.status >= 300 && response.status < 400 && response.headers.location) {
        if (i === maxRedirects) throw new SSRFError('Batas redirect terlampaui');
        // 303 selalu turun ke GET; 307/308 mempertahankan method+body.
        if (response.status === 303) remainingBody = undefined;
        currentUrl = new URL(response.headers.location, currentUrl).toString();
        continue;
      }

      return response;
    }
    throw new SSRFError('Redirect loop terdeteksi');
  }
}
