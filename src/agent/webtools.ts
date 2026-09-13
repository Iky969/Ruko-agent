import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * Web fetch and HTML sanitization tool for Ruko Agent.
 *
 * Requirements:
 *  - Zero external dependencies: uses built-in global fetch without importing node:fetch.
 *  - 10-second timeout via AbortController.
 *  - Validates content-type: processes text/html, text/plain, or application/json.
 *    If content-type is missing, treats as text/plain.
 *    Rejects binary/image/pdf files.
 *  - SSRF protection: blocks loopback, private IPv4/IPv6, cloud metadata (169.254.169.254),
 *    non-http/https protocols, and performs DNS resolution validation.
 *  - Sanitizes HTML tags to clean readable text.
 *  - Caps responses at 5,000 characters for token efficiency.
 */

export const MAX_WEB_FETCH_CHARS = 5_000;
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export interface WebFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Internal test-only override to permit loopback in test harnesses. Default: false. */
  allowLocalhost?: boolean;
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
  return html
    // Remove scripts, styles, noscripts, svg, iframe
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    // Convert structural block tags to newline
    .replace(/<\/(div|p|h[1-6]|li|tr|section|article|header|footer|nav|blockquote)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    // Remove all remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
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
    // Normalize consecutive spaces and newlines
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
  if (clean.startsWith('::ffff:')) {
    const v4Part = clean.slice(7);
    if (v4Part.includes('.')) {
      return isPrivateOrLocalIPv4(v4Part);
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
 * Checks if an IP address (v4 or v6) is private or internal.
 */
export function isPrivateOrLocalIp(ip: string): boolean {
  const version = isIP(ip.replace(/^\[|\]$/g, ''));
  if (version === 4) return isPrivateOrLocalIPv4(ip);
  if (version === 6) return isPrivateOrLocalIPv6(ip);
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
export async function checkSsrfSafety(
  parsed: URL,
  opts: SsrfCheckOptions = {},
): Promise<{ safe: boolean; reason?: string }> {
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
    return { safe: true };
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

  // 3. Literal IP check
  const ipVersion = isIP(cleanHost);
  if (ipVersion !== 0) {
    if (isPrivateOrLocalIp(cleanHost)) {
      return {
        safe: false,
        reason: `target mengarah ke alamat IP lokal/privat ("${cleanHost}")`,
      };
    }
    return { safe: true };
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
  } catch (err) {
    return {
      safe: false,
      reason: `resolusi DNS gagal untuk "${cleanHost}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { safe: true };
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

  // SSRF guard: validate protocol, private/loopback/link-local IP, cloud metadata, and DNS
  const ssrf = await checkSsrfSafety(parsed, { allowLocalhost: opts.allowLocalhost });
  if (!ssrf.safe) {
    return {
      ok: false,
      text: `web_fetch ditolak: target mengarah ke alamat internal/tidak diizinkan (${ssrf.reason}).`,
    };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onParentAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onParentAbort);

  try {
    const res = await fetch(parsed.href, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Ruko-Agent/1.1 (zero-dependency CLI coding agent)',
        Accept: 'text/html, text/plain, application/json;q=0.9, */*;q=0.1',
      },
    });

    const ctHeader = res.headers.get('content-type');
    const ctCheck = isAllowedContentType(ctHeader);
    if (!ctCheck.allowed) {
      return {
        ok: false,
        status: res.status,
        contentType: ctHeader ?? undefined,
        text: `web_fetch ditolak: ${ctCheck.reason}. Hanya text/html, text/plain, atau application/json yang diproses.`,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        contentType: ctHeader ?? undefined,
        text: `web_fetch gagal: HTTP ${res.status} ${res.statusText}`,
      };
    }

    const rawBody = await res.text();
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
    return {
      ok: false,
      text: `web_fetch error jaringan: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onParentAbort);
  }
}
