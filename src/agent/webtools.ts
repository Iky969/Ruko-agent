import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

/**
 * Web fetch and HTML sanitization tool for Ruko Agent.
 *
 * Requirements:
 *  - Zero external dependencies: uses built-in node:http and node:https with Native IP Pinning.
 *  - 10-second timeout via AbortController.
 *  - Validates content-type: processes text/html, text/plain, or application/json.
 *    If content-type is missing, treats as text/plain.
 *    Rejects binary/image/pdf files.
 *  - SSRF protection & Native IP Pinning: blocks loopback, private IPv4/IPv6, cloud metadata (169.254.169.254),
 *    non-http/https protocols, and pins TCP socket to the verified IP at EVERY hop (eliminates DNS rebinding).
 *  - Sanitizes HTML tags to clean readable text.
 *  - Caps responses at 5,000 characters for token efficiency.
 */

export const MAX_WEB_FETCH_CHARS = 5_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
export const MAX_FETCH_REDIRECTS = 5;

export interface PinnedRequestOptions {
  pinnedIp: string;
  ipFamily: 4 | 6;
  timeoutMs: number;
  signal?: AbortSignal;
  headers: Record<string, string>;
}

export interface PinnedResponse {
  status: number;
  statusText?: string;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

export type TransportFn = (
  url: URL,
  options: PinnedRequestOptions,
) => Promise<PinnedResponse>;

export interface WebFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Internal test-only override to permit loopback in test harnesses. Default: false. */
  allowLocalhost?: boolean;
  /** Custom DNS lookup function (for testing). */
  lookupFn?: typeof lookup;
  /** Custom transport request function (for testing). Default: pinnedHttpFetch. */
  transportFn?: TransportFn;
}

export interface WebFetchResult {
  ok: boolean;
  text: string;
  status?: number;
  contentType?: string;
  truncated?: boolean;
}

/** Sanitizes HTML tags and entities into clean readable text. */
export function sanitizeHtml(html: string): string {
  let text = html;

  // 1. Remove scripts, styles, noscripts, svg, iframe along with their inner contents
  // Using an iterative loop prevents nested/interleaved tag injection bypasses
  const dangerousBlockRegex = /<(script|style|noscript|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let prev = '';
  while (text !== prev) {
    prev = text;
    text = text.replace(dangerousBlockRegex, '');
  }

  // 2. Convert structural block tags to newline
  text = text
    .replace(/<\/(div|p|h[1-6]|li|tr|section|article|header|footer|nav|blockquote)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n');

  // 3. Iteratively remove all remaining HTML tags to prevent nested tag remnants
  const tagRegex = /<[^>]+>/g;
  prev = '';
  while (text !== prev) {
    prev = text;
    text = text.replace(tagRegex, '');
  }

  // 4. Decode HTML entities
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&copy;/gi, '©')
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCharCode(n) : '';
    })
    // 5. Normalize consecutive spaces and newlines
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Checks if a content-type string represents an acceptable text-like payload. */
export function isAllowedContentType(contentTypeHeader: string | null): { allowed: boolean; reason?: string } {
  if (!contentTypeHeader) {
    // Missing content-type: assume text/plain per specification
    return { allowed: true };
  }
  const ct = contentTypeHeader.toLowerCase();

  // Explicitly rejected binary types
  if (
    ct.includes('application/pdf') ||
    ct.startsWith('image/') ||
    ct.startsWith('audio/') ||
    ct.startsWith('video/') ||
    ct.includes('application/octet-stream') ||
    ct.includes('application/zip') ||
    ct.includes('application/gzip')
  ) {
    return {
      allowed: false,
      reason: `tipe konten biner/tidak didukung (${contentTypeHeader})`,
    };
  }

  // Allowed types
  if (
    ct.includes('text/html') ||
    ct.includes('text/plain') ||
    ct.includes('application/json') ||
    ct.includes('text/')
  ) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `tipe konten bukan text/html, text/plain, atau application/json (${contentTypeHeader})`,
  };
}

/**
 * Known local / internal hostnames that must be rejected to prevent SSRF.
 */
const INTERNAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'local',
  'internal',
  'instance-data',
]);

/**
 * Checks if an IPv4 address belongs to a private, loopback, link-local, or reserved range.
 */
export function isPrivateOrLocalIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => isNaN(n) || n < 0 || n > 255)) {
    return true; // Malformed IPv4 is treated as unsafe
  }

  const [a, b] = parts;

  // 0.0.0.0/8 (Current network / "this" host)
  if (a === 0) return true;

  // 127.0.0.0/8 (Loopback: 127.0.0.0 – 127.255.255.255)
  if (a === 127) return true;

  // 10.0.0.0/8 (Private class A)
  if (a === 10) return true;

  // 172.16.0.0/12 (Private class B: 172.16.0.0 – 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16 (Private class C: 192.168.0.0 – 192.168.255.255)
  if (a === 192 && b === 168) return true;

  // 169.254.0.0/16 (Link-local & Cloud instance metadata: 169.254.169.254)
  if (a === 169 && b === 254) return true;

  // 100.64.0.0/10 (Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && parts[2] === 0) return true;

  // 192.0.2.0/24 (TEST-NET-1), 198.51.100.0/24 (TEST-NET-2), 203.0.113.0/24 (TEST-NET-3)
  if (a === 192 && b === 0 && parts[2] === 2) return true;
  if (a === 198 && b === 51 && parts[2] === 100) return true;
  if (a === 203 && b === 0 && parts[2] === 113) return true;

  // 198.18.0.0/15 (Network benchmark tests)
  if (a === 198 && (b === 18 || b === 19)) return true;

  // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
  if (a >= 224 && a <= 239) return true;

  // 240.0.0.0/4 (Reserved / Future use)
  if (a >= 240) return true;

  return false;
}

/**
 * Checks if an IPv6 address belongs to a private, loopback, link-local, or unique-local range.
 */
export function isPrivateOrLocalIPv6(ip: string): boolean {
  const clean = ip.toLowerCase().replace(/^\[|\]$/g, '');

  // Loopback (::1) and Unspecified (::)
  if (clean === '::1' || clean === '::' || /^0*(?::0*)*:1$/.test(clean) || /^0*(?::0*)*$/.test(clean)) {
    return true;
  }

  // IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1 or ::ffff:a9fe:a9fe)
  if (clean.startsWith('::ffff:') || /(?:^|:)ffff:([0-9a-f:.]+)$/i.test(clean)) {
    const v4Match = clean.match(/(?:^|:)ffff:([0-9a-f:.]+)$/i);
    const v4Part = v4Match ? v4Match[1] : clean.slice(7);
    if (v4Part.includes('.')) {
      const alt = parseAlternativeIPv4(v4Part) || v4Part;
      return isPrivateOrLocalIPv4(alt);
    }
    const hexSegments = v4Part.split(':');
    if (hexSegments.length === 2) {
      const high = parseInt(hexSegments[0], 16);
      const low = parseInt(hexSegments[1], 16);
      if (!isNaN(high) && !isNaN(low)) {
        const a = (high >> 8) & 0xff;
        const b = high & 0xff;
        const c = (low >> 8) & 0xff;
        const d = low & 0xff;
        return isPrivateOrLocalIPv4(`${a}.${b}.${c}.${d}`);
      }
    }
    return true; // Malformed / unrecognized ::ffff: notation treated as unsafe
  }

  // fe80::/10 (Link-local unicast: fe80:: - febf::)
  if (/^fe[89ab]/i.test(clean)) return true;

  // fc00::/7 (Unique local address / ULA: fc00:: - fdff::)
  if (/^f[cd]/i.test(clean)) return true;

  // ff00::/8 (Multicast)
  if (/^ff/i.test(clean)) return true;

  // 2001:db8::/32 (Documentation)
  if (clean.startsWith('2001:db8:') || clean.startsWith('2001:0db8:')) return true;

  // 64:ff9b::/96 (IPv4/IPv6 translation)
  if (clean.startsWith('64:ff9b:')) return true;

  return false;
}

/**
 * Normalizes alternative IPv4 representations (decimal integer, octal, hex, or shorthand notation)
 * to standard dotted-decimal notation. Returns null if not a valid alternative representation.
 */
export function parseAlternativeIPv4(ipStr: string): string | null {
  if (!ipStr || typeof ipStr !== 'string') return null;
  const clean = ipStr.trim().toLowerCase().replace(/^\[|\]$/g, '');

  // 1. Single 32-bit integer (decimal e.g. 2130706433, hex 0x7f000001, octal 017700000001)
  if (/^(?:0x[0-9a-f]+|0[0-7]+|[1-9][0-9]*|0)$/.test(clean)) {
    try {
      let num: bigint;
      if (clean.startsWith('0x')) {
        num = BigInt(clean);
      } else if (clean.startsWith('0') && clean.length > 1) {
        num = BigInt('0o' + clean.slice(1));
      } else {
        num = BigInt(clean);
      }
      if (num >= 0n && num <= 4294967295n) {
        const n = Number(num);
        const a = (n >>> 24) & 0xff;
        const b = (n >>> 16) & 0xff;
        const c = (n >>> 8) & 0xff;
        const d = n & 0xff;
        return `${a}.${b}.${c}.${d}`;
      }
    } catch {
      return null;
    }
  }

  // 2. Dot-separated notation with 1-4 parts (e.g. 0177.0.0.1, 0x7f.1, 127.1, 10.1)
  if (/^[0-9a-fx.]*$/i.test(clean) && clean.includes('.')) {
    const parts = clean.split('.');
    if (parts.length >= 1 && parts.length <= 4) {
      const nums: number[] = [];
      for (const p of parts) {
        if (!p) return null;
        let val: number;
        if (p.startsWith('0x')) {
          val = parseInt(p.slice(2), 16);
        } else if (p.startsWith('0') && p.length > 1) {
          val = parseInt(p, 8);
        } else {
          val = parseInt(p, 10);
        }
        if (isNaN(val) || val < 0) return null;
        nums.push(val);
      }

      if (nums.length === 4) {
        if (nums.some((n) => n > 255)) return null;
        return `${nums[0]}.${nums[1]}.${nums[2]}.${nums[3]}`;
      } else if (nums.length === 3) {
        // a.b.c -> a.b.(c >> 8).(c & 0xff)
        if (nums[0] > 255 || nums[1] > 255 || nums[2] > 65535) return null;
        return `${nums[0]}.${nums[1]}.${(nums[2] >>> 8) & 0xff}.${nums[2] & 0xff}`;
      } else if (nums.length === 2) {
        // a.b -> a.(b >> 16).(b >> 8).(b & 0xff)
        if (nums[0] > 255 || nums[1] > 16777215) return null;
        return `${nums[0]}.${(nums[1] >>> 16) & 0xff}.${(nums[1] >>> 8) & 0xff}.${nums[1] & 0xff}`;
      }
    }
  }

  return null;
}

/**
 * Checks if an IP address (v4, v6, or alternative representation like decimal/octal) is private or internal.
 */
export function isPrivateOrLocalIp(ip: string): boolean {
  const clean = ip.trim().replace(/^\[|\]$/g, '');
  const alt = parseAlternativeIPv4(clean);
  if (alt) {
    return isPrivateOrLocalIPv4(alt);
  }
  const version = isIP(clean);
  if (version === 4) return isPrivateOrLocalIPv4(clean);
  if (version === 6) return isPrivateOrLocalIPv6(clean);
  return false;
}

export interface SsrfCheckOptions {
  allowLocalhost?: boolean;
  lookupFn?: typeof lookup;
}

/**
 * Validates a parsed URL against SSRF vulnerabilities.
 * Checks protocol, internal hostnames, private/loopback/link-local IP addresses,
 * and performs DNS lookup to prevent split-horizon/private resolution.
 *
 * Known Limitation (DNS Rebinding / TOCTOU):
 * Pre-fetch DNS lookup catches hostnames that resolve to internal IPs at request time.
 * In scenarios with TTL=0 and adversarial multi-homed DNS servers, full defense requires
 * a custom network dispatcher or outbound proxy that pins the socket IP.
 */
export interface SsrfCheckResult {
  safe: boolean;
  reason?: string;
  pinnedIp?: string;
  ipFamily?: 4 | 6;
}

/**
 * Validates a parsed URL against SSRF vulnerabilities and resolves its safe pinned IP.
 * Checks protocol, internal hostnames, private/loopback/link-local IP addresses,
 * and performs DNS lookup with active double-check resolution.
 */
export async function checkSsrfSafety(
  parsed: URL,
  opts: SsrfCheckOptions = {},
): Promise<SsrfCheckResult> {
  // 1. Protocol check: strictly http: and https: only
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      safe: false,
      reason: `protokol "${parsed.protocol}" tidak diizinkan (hanya http: dan https:)`,
    };
  }

  const rawHost = parsed.hostname.toLowerCase();
  const cleanHost = rawHost.replace(/^\[|\]$/g, '');

  if (!cleanHost) {
    return { safe: false, reason: 'hostname kosong' };
  }

  const isLoopbackHost =
    cleanHost === 'localhost' ||
    cleanHost === '127.0.0.1' ||
    cleanHost === '::1' ||
    cleanHost === '0.0.0.0' ||
    cleanHost === '::';

  if (opts.allowLocalhost && isLoopbackHost) {
    const isV6 = cleanHost === '::1' || cleanHost === '::';
    return {
      safe: true,
      pinnedIp: isV6 ? '::1' : '127.0.0.1',
      ipFamily: isV6 ? 6 : 4,
    };
  }

  // 2. Known internal hostnames and TLDs
  if (
    INTERNAL_HOSTNAMES.has(cleanHost) ||
    cleanHost.endsWith('.localhost') ||
    cleanHost.endsWith('.local') ||
    cleanHost.endsWith('.internal') ||
    cleanHost.endsWith('.intranet') ||
    cleanHost.endsWith('.corp')
  ) {
    return {
      safe: false,
      reason: `target mengarah ke hostname lokal/internal ("${cleanHost}")`,
    };
  }

  // 3. Literal IP or alternative IP check (e.g. decimal integer, octal, hex, shorthand)
  const altIp = parseAlternativeIPv4(cleanHost);
  if (altIp) {
    if (opts.allowLocalhost && isLoopbackHost) {
      return { safe: true, pinnedIp: altIp, ipFamily: 4 };
    }
    if (isPrivateOrLocalIPv4(altIp)) {
      return {
        safe: false,
        reason: `target mengarah ke alamat IP lokal/privat ("${cleanHost}" -> ${altIp})`,
      };
    }
    return { safe: true, pinnedIp: altIp, ipFamily: 4 };
  }

  const ipVersion = isIP(cleanHost);
  if (ipVersion !== 0) {
    if (isPrivateOrLocalIp(cleanHost)) {
      return {
        safe: false,
        reason: `target mengarah ke alamat IP lokal/privat ("${cleanHost}")`,
      };
    }
    return { safe: true, pinnedIp: cleanHost, ipFamily: ipVersion as 4 | 6 };
  }

  // 4. DNS resolution check (catches domains resolving to internal IPs)
  const lookupFn = opts.lookupFn ?? lookup;
  try {
    const addresses = await lookupFn(cleanHost, { all: true });
    if (!addresses || addresses.length === 0) {
      return {
        safe: false,
        reason: `resolusi DNS tidak menghasilkan alamat IP untuk "${cleanHost}"`,
      };
    }
    for (const addr of addresses) {
      if (opts.allowLocalhost && (addr.address === '127.0.0.1' || addr.address === '::1')) {
        continue;
      }
      if (isPrivateOrLocalIp(addr.address)) {
        return {
          safe: false,
          reason: `resolusi DNS host "${cleanHost}" mengarah ke IP internal/privat (${addr.address})`,
        };
      }
    }

    // Active DNS rebinding check: consecutive query to catch TTL=0 flapping or alternating records
    try {
      const secondCheck = await lookupFn(cleanHost, { all: true });
      if (secondCheck && Array.isArray(secondCheck)) {
        for (const addr of secondCheck) {
          if (opts.allowLocalhost && (addr.address === '127.0.0.1' || addr.address === '::1')) {
            continue;
          }
          if (isPrivateOrLocalIp(addr.address)) {
            return {
              safe: false,
              reason: `resolusi DNS host "${cleanHost}" terdeteksi aktif rebinding ke IP internal/privat (${addr.address})`,
            };
          }
        }
      }
    } catch {
      // abaikan error lookup kedua jika lookup primer sukses
    }

    const primary = addresses[0];
    return {
      safe: true,
      pinnedIp: primary.address,
      ipFamily: primary.family === 6 ? 6 : 4,
    };
  } catch (err) {
    return {
      safe: false,
      reason: `resolusi DNS gagal untuk "${cleanHost}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Executes an HTTP/HTTPS GET request pinned to a pre-validated IP address via custom socket lookup.
 * Guaranteed zero secondary DNS query by the runtime/OS, completely eliminating DNS rebinding TOCTOU.
 */
export function pinnedHttpFetch(
  targetUrl: URL,
  options: PinnedRequestOptions,
): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = targetUrl.protocol === 'https:';
    const client = isHttps ? https : http;
    const defaultPort = isHttps ? 443 : 80;
    const port = targetUrl.port ? parseInt(targetUrl.port, 10) : defaultPort;

    const req = client.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port,
      path: targetUrl.pathname + targetUrl.search,
      method: 'GET',
      headers: {
        Host: targetUrl.host,
        ...options.headers,
      },
      // Native IP Pinning: connect socket directly to pre-verified safe IP without DNS query
      lookup: (_hostname, lookupOpts, cb) => {
        const callback = typeof lookupOpts === 'function' ? lookupOpts : cb;
        const opts = typeof lookupOpts === 'object' && lookupOpts !== null ? lookupOpts : {};
        if (opts.all) {
          callback(null, [{ address: options.pinnedIp, family: options.ipFamily }]);
        } else {
          callback(null, options.pinnedIp, options.ipFamily);
        }
      },
    });

    let timeoutTimer: NodeJS.Timeout | undefined;
    if (options.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        req.destroy(new Error(`web_fetch timeout (${options.timeoutMs / 1000} detik terlampaui).`));
      }, options.timeoutMs);
    }

    const onAbort = () => {
      req.destroy(new Error('web_fetch dibatalkan (turn interrupted).'));
    };
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    let finished = false;
    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    };

    req.on('error', (err) => {
      cleanup();
      if (!finished) {
        finished = true;
        reject(err);
      }
    });

    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const maxStreamBytes = MAX_WEB_FETCH_CHARS * 8;

      res.on('data', (chunk: Buffer) => {
        if (totalBytes < maxStreamBytes) {
          chunks.push(chunk);
          totalBytes += chunk.length;
        } else {
          res.destroy();
        }
      });

      const onEnd = () => {
        cleanup();
        if (!finished) {
          finished = true;
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 200,
            statusText: res.statusMessage,
            headers: res.headers,
            text: body,
          });
        }
      };

      res.on('end', onEnd);
      res.on('close', onEnd);
    });

    req.end();
  });
}

export async function webFetchTool(
  urlInput: string,
  opts: WebFetchOptions = {},
): Promise<WebFetchResult> {
  const rawUrl = String(urlInput ?? '').trim();
  if (!rawUrl) {
    return { ok: false, text: 'web_fetch: missing "url" field' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, text: `web_fetch: URL tidak valid "${rawUrl}"` };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onParentAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onParentAbort);

  const transport = opts.transportFn ?? pinnedHttpFetch;

  try {
    let currentUrl = parsed;
    let redirectCount = 0;
    const visitedUrls = new Set<string>([currentUrl.href]);
    let res: PinnedResponse;

    while (true) {
      // 1. SSRF Guard & IP Pinning on EVERY hop (initial request and all redirect hops)
      const ssrf = await checkSsrfSafety(currentUrl, {
        allowLocalhost: opts.allowLocalhost,
        lookupFn: opts.lookupFn,
      });
      if (!ssrf.safe) {
        if (redirectCount > 0) {
          return {
            ok: false,
            status: 302,
            text: `web_fetch ditolak: redirect mengarah ke alamat internal/tidak diizinkan (${ssrf.reason}).`,
          };
        }
        return {
          ok: false,
          text: `web_fetch ditolak: target mengarah ke alamat internal/tidak diizinkan (${ssrf.reason}).`,
        };
      }

      // 2. Transport execution pinned to the verified safe IP
      res = await transport(currentUrl, {
        pinnedIp: ssrf.pinnedIp!,
        ipFamily: ssrf.ipFamily ?? 4,
        timeoutMs,
        signal: controller.signal,
        headers: {
          'User-Agent': 'Ruko-Agent/1.7 (zero-dependency CLI coding agent)',
          Accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.1',
        },
      });

      // 3. Handle HTTP redirects (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const rawLoc = res.headers['location'];
        const locationHeader = Array.isArray(rawLoc) ? rawLoc[0] : rawLoc;
        if (!locationHeader) {
          return {
            ok: false,
            status: res.status,
            text: `web_fetch gagal: HTTP ${res.status} redirect tanpa header Location.`,
          };
        }

        redirectCount++;
        if (redirectCount > MAX_FETCH_REDIRECTS) {
          return {
            ok: false,
            status: res.status,
            text: `web_fetch ditolak: batas maksimal ${MAX_FETCH_REDIRECTS} redirect terlampaui (indikasi loop).`,
          };
        }

        let nextUrl: URL;
        try {
          nextUrl = new URL(locationHeader, currentUrl.href);
        } catch {
          return {
            ok: false,
            status: res.status,
            text: `web_fetch gagal: header redirect Location tidak valid "${locationHeader}".`,
          };
        }

        if (visitedUrls.has(nextUrl.href)) {
          return {
            ok: false,
            status: res.status,
            text: `web_fetch ditolak: siklus redirect terdeteksi ke "${nextUrl.href}".`,
          };
        }
        visitedUrls.add(nextUrl.href);

        // Advance to nextUrl — the while loop will immediately evaluate checkSsrfSafety
        // on nextUrl, re-resolve DNS, enforce SSRF guard, pin the new IP, and connect!
        currentUrl = nextUrl;
        continue;
      }

      break;
    }

    const rawCt = res.headers['content-type'];
    const ctHeader = (Array.isArray(rawCt) ? rawCt[0] : rawCt) || null;
    const ctCheck = isAllowedContentType(ctHeader);
    if (!ctCheck.allowed) {
      return {
        ok: false,
        status: res.status,
        contentType: ctHeader ?? undefined,
        text: `web_fetch ditolak: ${ctCheck.reason}. Hanya text/html, text/plain, atau application/json yang diproses.`,
      };
    }

    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        status: res.status,
        contentType: ctHeader ?? undefined,
        text: `web_fetch gagal: HTTP ${res.status} ${res.statusText ?? ''}`.trim(),
      };
    }

    const rawBody = res.text;
    const effectiveCt = (ctHeader || 'text/plain').toLowerCase();
    const isHtml = effectiveCt.includes('text/html') || /<html\b[^>]*>/i.test(rawBody);

    let content = isHtml ? sanitizeHtml(rawBody) : rawBody.trim();
    const truncated = content.length > MAX_WEB_FETCH_CHARS;
    if (truncated) {
      content =
        content.slice(0, MAX_WEB_FETCH_CHARS) +
        '\n\n[... TRUNCATED — response melebihi batas 5.000 karakter ...]';
    }

    return {
      ok: true,
      status: res.status,
      contentType: ctHeader || 'text/plain',
      text: content,
      truncated,
    };
  } catch (err) {
    if (controller.signal.aborted) {
      if (opts.signal?.aborted) {
        return { ok: false, text: 'web_fetch dibatalkan (turn interrupted).' };
      }
      return {
        ok: false,
        text: `web_fetch timeout (${timeoutMs / 1000} detik terlampaui). Permintaan dibatalkan.`,
      };
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('timeout')) {
      return {
        ok: false,
        text: `web_fetch timeout (${timeoutMs / 1000} detik terlampaui). Permintaan dibatalkan.`,
      };
    }
    return {
      ok: false,
      text: `web_fetch error jaringan: ${errMsg}`,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onParentAbort);
  }
}
