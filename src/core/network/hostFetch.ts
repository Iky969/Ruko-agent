/**
 * hostFetch.ts — Klien HTTP/HTTPS dengan proteksi SSRF berlapis.
 *
 * ANCAMAN YANG DIALAWAN
 * ---------------------
 * Workspace adalah input tak tepercaya. Instruksi IPI (Indirect Prompt
 * Injection) di dalam README/issue bisa menyuruh agen melakukan
 * `web_fetch('http://127.0.0.1:8080/...')` atau menembak endpoint metadata
 * cloud `169.254.169.254`. Modul ini menutupnya secara deterministik.
 *
 * LIMA LAPIS PERTAHANAN
 * ---------------------
 *  1. Allowlist protokol (`http:`/`https:` saja) dan larangan kredensial inline.
 *  2. Resolusi DNS eksplisit per hop; SEMUA record diperiksa. Satu record privat
 *     sudah cukup untuk menolak (TC-NET-03) — jangan pilih "IP terbaik".
 *  3. IP pinning: alamat hasil verifikasi itu sendiri yang disocket-kan lewat
 *     callback `lookup`, sehingga tidak ada resolusi DNS kedua di level kernel
 *     (mitigasi DNS rebinding TOCTOU).
 *  4. SNI TLS dan `Host` header tetap memakai hostname asli, sementara
 *     socket diarahkan ke IP yang sudah diverifikasi. `agent: false` +
 *     `Connection: close` menutup celah socket-reuse dari connection pool.
 *  5. Redirect ditangani manual: setiap hop dievaluasi ULANG dari awal, dengan
 *     batas jumlah hop.
 *
 * HARDENING QA.md §1.1
 * --------------------
 *  - IPv6 literal berkurung siku (`http://[::1]:8080/`) membuat `net.isIP`
 *    mengembalikan 0 sehingga lolos klasifikasi. Fix: kurung siku dibuang
 *    sebelum validasi.
 *  - Redirect ke alamat privat harus ditolak SEBELUM request hop berikutnya
 *    dikirim (TC-NET-02) — bukan setelah responsnya dibaca.
 *
 * SEAM PENGUJIAN
 * --------------
 * `HostFetchDeps` (resolver + sendRequest) hanya diisi oleh kode pengujian.
 * Hasil resolver seam tetap melewati seluruh pemeriksaan IP privat, sehingga
 * menyuntipkan deps tidak dapat melemahkan proteksi.
 *
 * Zero runtime dependency — hanya `node:http`, `node:https`, `node:dns`,
 * `node:net`, `node:url`.
 */

import * as dns from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { URL } from 'node:url';

export class SSRFError extends Error {
  readonly code = 'PRIVATE_IP_BLOCKED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SSRFError';
  }
}

export class HostFetchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HostFetchError';
  }
}

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MB batas DoS
const REQUEST_TIMEOUT_MS = 10_000; // 10 detik
const DEFAULT_MAX_REDIRECTS = 3;
const USER_AGENT = 'ruko-agent/2.0.0';

/**
 * CIDR yang tidak boleh disentuh dari dalam Ruko. Termasuk link-local
 * (169.254.0.0/16 — endpoint metadata cloud), CGNAT (100.64.0.0/10),
 * multicast, dan reserved. Bentuk IPv4-mapped IPv6 ditangani terpisah.
 */
const PRIVATE_CIDRS = [
  { ip: '0.0.0.0', mask: 8 },
  { ip: '10.0.0.0', mask: 8 },
  { ip: '100.64.0.0', mask: 10 },
  { ip: '127.0.0.0', mask: 8 },
  { ip: '169.254.0.0', mask: 16 },
  { ip: '172.16.0.0', mask: 12 },
  { ip: '192.168.0.0', mask: 16 },
  { ip: '224.0.0.0', mask: 4 },
  { ip: '240.0.0.0', mask: 4 },
];

function ipToLong(ip: string): number {
  return ip
    .split('.')
    .reduce((acc, oct) => (((acc << 8) + Number.parseInt(oct, 10)) >>> 0), 0);
}

function cidrMatches(ipLong: number, cidr: { ip: string; mask: number }): boolean {
  const mask = cidr.mask === 0 ? 0 : (~((1 << (32 - cidr.mask)) - 1) >>> 0);
  return (ipLong & mask) === (ipToLong(cidr.ip) & mask);
}

/** Buang kurung siku IPv6 literal sebelum klasifikasi IP. */
export function stripIpv6Brackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

/**
 * True bila `ip` berada di jaringan terlarang (loopback, privat, link-local,
 * CGNAT, multicast, reserved) — termasuk bentuk IPv4-mapped IPv6.
 */
export function isPrivateIP(ip: string): boolean {
  let normalized = ip.trim().toLowerCase();
  normalized = stripIpv6Brackets(normalized);

  if (normalized.startsWith('::ffff:')) normalized = normalized.substring(7);

  if (net.isIP(normalized) === 4) {
    const long = ipToLong(normalized);
    return PRIVATE_CIDRS.some((cidr) => cidrMatches(long, cidr));
  }

  if (net.isIP(normalized) === 6) {
    // ::1 (loopback), :: (unspecified), fe80::/10 (link-local), fc00::/7 (ULA),
    // ff00::/8 (multicast), ::ffff:0:0/96 sudah ditangani di atas.
    if (normalized === '::' || normalized === '::1') return true;
    const firstHextet = normalized.split(':')[0];
    if (firstHextet.length === 0) return true; // bentuk ringkas
    const leading = Number.parseInt(firstHextet, 16);
    if (Number.isNaN(leading)) return true; // tidak bisa diverifikasi = tolak
    if ((leading & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((leading & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((leading & 0xff00) === 0xff00) return true; // ff00::/8
    // ::/96 selain yang sudah tertangani (mis. 0.0.0.0 mapped) tidak relevan.
    return false;
  }

  // Bukan IP yang valid sama sekali (mis. "example.com" tanpa resolusi).
  return true;
}

export interface DnsRecord {
  address: string;
  family: number;
}

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface FetchOptions {
  method?: string;
  body?: string;
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** Seam pengujian — jangan pernah diisi dari masukan tak tepercaya. */
  deps?: HostFetchDeps;
}

/** Parameter koneksi yang sudah divalidasi (dipakai seam `sendRequest`). */
export interface RequestPlan {
  url: URL;
  pinnedIP: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface HostFetchDeps {
  /** Resolusi hostname -> semua record. Default `dns.lookup(all, verbatim)`. */
  resolveHostname?: (hostname: string) => Promise<DnsRecord[]>;
  /** Eksekusi request terpin. Default: `http`/`https` dengan IP pinning. */
  sendRequest?: (plan: RequestPlan) => Promise<FetchResult>;
}

async function defaultResolveHostname(hostname: string): Promise<DnsRecord[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({ address: r.address, family: r.family }));
}

/** Melakukan socket ke IP yang sudah diverifikasi, dengan SNI/Host asli. */
function defaultSendRequest(plan: RequestPlan): Promise<FetchResult> {
  const { url, pinnedIP, method, headers, body } = plan;
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;

  return new Promise<FetchResult>((resolve, reject) => {
    const req = lib.request(
      {
        hostname: pinnedIP,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        // `agent: false` mematikan connection pool (mencegah socket reuse
        // melewati validasi IP kita).
        agent: false,
        headers: {
          Host: url.host,
          Connection: 'close',
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          ...headers,
        },
        // SNI TLS tetap memakai hostname asli (sertifikat tidak jadi salah).
        servername: isHttps ? url.hostname : undefined,
        timeout: plan.timeoutMs,
        // Mencegah resolusi DNS kedua di kernel: IP hasil verifikasi inilah
        // yang langsung disocket-kan (mitigasi DNS rebinding).
        lookup: (_hostname, _opts, cb) => cb(null, pinnedIP, net.isIP(pinnedIP)),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_SIZE) {
            req.destroy(new HostFetchError('RESPONSE_TOO_LARGE', 'Ukuran respons melebihi batas 5MB'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: { ...(res.headers as Record<string, string | string[] | undefined>) } as Record<
              string,
              string
            >,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );

    req.on('timeout', () => req.destroy(new HostFetchError('FETCH_TIMEOUT', 'Batas waktu koneksi terlampaui')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Validasi satu hop: protokol, kredensial inline, dan seluruh record DNS.
 * Melempar {@link SSRFError} sebelum socket dibuka.
 */
export async function validateAndResolve(
  target: URL,
  resolveHostname: (hostname: string) => Promise<DnsRecord[]>,
): Promise<DnsRecord[]> {
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new SSRFError(`PROTOCOL_BLOCKED: Protokol tidak diizinkan: ${target.protocol}`);
  }
  if (target.username || target.password) {
    throw new SSRFError('KREDENSIAL_INLINE_BLOCKED: Kredensial pada URL dilarang');
  }

  const rawHostname = stripIpv6Brackets(target.hostname);
  if (!rawHostname) throw new SSRFError('HOSTNAME_KOSONG');

  // IPv6 literal tidak perlu DNS, tapi tetap harus lolos klasifikasi IP.
  const literalFamily = net.isIP(rawHostname);
  const records: DnsRecord[] =
    literalFamily === 0
      ? await resolveHostname(rawHostname)
      : [{ address: rawHostname, family: literalFamily }];

  if (records.length === 0) {
    throw new SSRFError(`DNS_GAGAL: Resolusi DNS gagal untuk ${rawHostname}`);
  }

  for (const record of records) {
    if (isPrivateIP(record.address)) {
      throw new SSRFError(`IP_TERLARANG: ${rawHostname} -> ${record.address}`);
    }
  }
  return records;
}

export class HostFetch {
  /**
   * Fetch HTTP/HTTPS dengan pemeriksaan SSRF per hop.
   *
   * @throws {SSRFError} bila protokol/credential/IP privat terindikasi.
   * @throws {HostFetchError} bila timeout, respons over-limit, atau loop redirect.
   */
  static async fetch(urlStr: string, opts: FetchOptions = {}): Promise<FetchResult> {
    const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const resolve = opts.deps?.resolveHostname ?? defaultResolveHostname;
    const send = opts.deps?.sendRequest ?? defaultSendRequest;

    let currentUrl = urlStr;
    const visited: string[] = [];

    for (let hop = 0; hop <= maxRedirects; hop++) {
      let url: URL;
      try {
        url = new URL(currentUrl);
      } catch {
        throw new SSRFError(`URL_INVALID: ${currentUrl}`);
      }

      // 1-2. Validasi protokol/kredensial + resolusi & klasifikasi IP.
      const records = await validateAndResolve(url, resolve);
      const pinnedIP = records[0].address;

      if (visited.includes(url.toString())) {
        throw new HostFetchError('REDIRECT_LOOP', `Redirect loop terdeteksi: ${url.toString()}`);
      }
      visited.push(url.toString());

      // 3-4. Request terpin (SNI utuh, anti socket-reuse).
      const response = await send({
        url,
        pinnedIP,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
        body: opts.body,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });

      const location = response.headers['location'];
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop === maxRedirects) {
          throw new HostFetchError('REDIRECT_LIMIT', `Batas redirect terlampaui: ${maxRedirects}`);
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new SSRFError(`URL_INVALID: lokasi redirect ${location}`);
        }
        // Hop berikutnya dievaluasi ULANG dari awal oleh loop — inilah yang
        // membuat redirect ke 169.254.169.254 tertolak sebelum dikirim (TC-NET-02).
        currentUrl = next.toString();
        continue;
      }

      return response;
    }

    throw new HostFetchError('REDIRECT_LOOP', 'Redirect loop terdeteksi');
  }
}
