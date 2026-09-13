import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { globToRegex, globTool, parseMultiGlobPatterns } from '../agent/filetools.js';
import { runToolCall, setWorkspaceRoot } from '../agent/tools.js';
import {
  checkSsrfSafety,
  isAllowedContentType,
  isPrivateOrLocalIp,
  sanitizeHtml,
  webFetchTool,
} from '../agent/webtools.js';
import { saveSkill } from '../core/skills.js';
import { DEFAULT_CONFIG } from '../types.js';

function inTempWorkspace<T>(fn: (ws: string) => Promise<T> | T): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-quickwins-'));
  setWorkspaceRoot(ws);
  const prev = process.cwd();
  process.chdir(ws);
  return Promise.resolve(fn(ws)).finally(() => {
    setWorkspaceRoot(null);
    process.chdir(prev);
    rmSync(ws, { recursive: true, force: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// list_skills tool tests
// ─────────────────────────────────────────────────────────────────────────────

test('list_skills returns all skills with name and description', async () => {
  await inTempWorkspace(async (ws) => {
    saveSkill('deploy', 'Deploy application to cloud', 'steps...', ws);
    saveSkill('test-runner', 'Run automated tests', 'steps...', ws);

    const resRaw = await runToolCall(
      { tool: 'list_skills' },
      { workspaceRoot: ws, planMode: true }, // Should work in plan mode too!
    );
    const res = JSON.parse(resRaw);
    assert.equal(res.ok, true);
    assert.equal(res.count, 2);
    assert.deepEqual(
      res.skills.map((s: { name: string }) => s.name).sort(),
      ['deploy', 'test-runner'],
    );
    assert.equal(res.skills.find((s: { name: string }) => s.name === 'deploy')?.description, 'Deploy application to cloud');
  });
});

test('list_skills returns empty array when no skills are defined', async () => {
  await inTempWorkspace(async (ws) => {
    const resRaw = await runToolCall({ tool: 'list_skills' }, { workspaceRoot: ws });
    const res = JSON.parse(resRaw);
    assert.equal(res.ok, true);
    assert.equal(res.count, 0);
    assert.deepEqual(res.skills, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// web_fetch tool & HTML sanitizer tests
// ─────────────────────────────────────────────────────────────────────────────

test('sanitizeHtml removes script, style, structural tags and decodes entities', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Test Page</title>
        <style>body { color: red; }</style>
        <script>alert('xss');</script>
      </head>
      <body>
        <h1>Judul Artikel</h1>
        <p>Paragraf <b>pertama</b> &amp; penting.</p>
        <div>Item list:</div>
        <ul>
          <li>Item 1 &copy; 2026</li>
          <li>Item 2 &lt;script&gt;</li>
        </ul>
      </body>
    </html>
  `;
  const text = sanitizeHtml(html);
  assert.ok(!text.includes('alert'), 'scripts removed');
  assert.ok(!text.includes('color: red'), 'styles removed');
  assert.ok(text.includes('Judul Artikel'));
  assert.ok(text.includes('Paragraf pertama & penting.'));
  assert.ok(text.includes('Item 1 © 2026'));
  assert.ok(text.includes('Item 2 <script>'));
});

test('isAllowedContentType validates allowed and rejected content types', () => {
  // Allowed
  assert.equal(isAllowedContentType('text/html; charset=utf-8').allowed, true);
  assert.equal(isAllowedContentType('text/plain').allowed, true);
  assert.equal(isAllowedContentType('application/json').allowed, true);
  assert.equal(isAllowedContentType(null).allowed, true, 'missing header defaults to text/plain');
  assert.equal(isAllowedContentType('').allowed, true);

  // Rejected
  assert.equal(isAllowedContentType('application/pdf').allowed, false);
  assert.equal(isAllowedContentType('image/png').allowed, false);
  assert.equal(isAllowedContentType('image/jpeg').allowed, false);
  assert.equal(isAllowedContentType('application/octet-stream').allowed, false);
  assert.equal(isAllowedContentType('audio/mpeg').allowed, false);
});

test('webFetchTool fetches, parses HTML, and enforces timeout and content length', async () => {
  let server: Server;
  const port = 34567;

  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      if (req.url === '/html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>Halo Web</h1><p>Konten deskriptif.</p></body></html>');
      } else if (req.url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', value: 42 }));
      } else if (req.url === '/no-header') {
        // Missing content-type
        res.writeHead(200);
        res.end('Plain text payload without content-type header.');
      } else if (req.url === '/pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end('%PDF-1.4 binary data...');
      } else if (req.url === '/large') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('X'.repeat(6000));
      } else if (req.url === '/slow') {
        // Don't respond to trigger timeout
        setTimeout(() => res.end('slow response'), 500);
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(port, () => resolve());
  });

  try {
    // 1. Fetch HTML (mock test permits localhost via allowLocalhost: true)
    const htmlRes = await webFetchTool(`http://localhost:${port}/html`, { allowLocalhost: true });
    assert.equal(htmlRes.ok, true);
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.text.includes('Halo Web'));
    assert.ok(htmlRes.text.includes('Konten deskriptif.'));
    assert.ok(!htmlRes.text.includes('<h1>'), 'html tags sanitized');

    // 2. Fetch JSON
    const jsonRes = await webFetchTool(`http://localhost:${port}/json`, { allowLocalhost: true });
    assert.equal(jsonRes.ok, true);
    assert.equal(JSON.parse(jsonRes.text).value, 42);

    // 3. Missing header -> treated as text/plain
    const noHeaderRes = await webFetchTool(`http://localhost:${port}/no-header`, { allowLocalhost: true });
    assert.equal(noHeaderRes.ok, true);
    assert.ok(noHeaderRes.text.includes('Plain text payload'));

    // 4. Binary PDF -> rejected
    const pdfRes = await webFetchTool(`http://localhost:${port}/pdf`, { allowLocalhost: true });
    assert.equal(pdfRes.ok, false);
    assert.ok(pdfRes.text.includes('berkas biner') || pdfRes.text.includes('ditolak'));

    // 5. Large payload -> truncated to 5,000 chars
    const largeRes = await webFetchTool(`http://localhost:${port}/large`, { allowLocalhost: true });
    assert.equal(largeRes.ok, true);
    assert.equal(largeRes.truncated, true);
    assert.ok(largeRes.text.includes('[... TRUNCATED'));

    // 6. Timeout handling (via small timeoutMs)
    const timeoutRes = await webFetchTool(`http://localhost:${port}/slow`, { timeoutMs: 50, allowLocalhost: true });
    assert.equal(timeoutRes.ok, false);
    assert.ok(timeoutRes.text.includes('timeout'));

    // 7. Integration via runToolCall: default production mode blocks localhost (SSRF protection)
    const runResRaw = await runToolCall({ tool: 'web_fetch', url: `http://localhost:${port}/html` });
    const runRes = JSON.parse(runResRaw);
    assert.equal(runRes.ok, false);
    assert.ok(runRes.error.includes('web_fetch ditolak: target mengarah ke alamat internal/tidak diizinkan'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('web_fetch rejects invalid URLs and non-http protocols', async () => {
  const fileRes = await webFetchTool('file:///etc/passwd');
  assert.equal(fileRes.ok, false);
  assert.ok(fileRes.text.includes('tidak diizinkan') || fileRes.text.includes('tidak didukung'));

  const badUrlRes = await webFetchTool('not a valid url');
  assert.equal(badUrlRes.ok, false);
  assert.ok(badUrlRes.text.includes('tidak valid'));
});

test('SSRF Guard: webFetchTool and checkSsrfSafety reject localhost, private IPs, link-local, and cloud metadata', async () => {
  const ssrfTargets = [
    'http://localhost',
    'http://localhost:3000',
    'http://sub.localhost/api',
    'http://127.0.0.1',
    'http://127.0.0.1:8080/admin',
    'http://127.1.2.3',
    'http://0.0.0.0:8000',
    'http://[::1]',
    'http://[::1]:8080',
    'http://10.0.0.1/internal',
    'http://10.254.0.1',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://192.168.1.1/router',
    'http://192.168.0.100',
    'http://169.254.169.254/latest/meta-data/', // AWS/GCP metadata
    'http://169.254.1.1',
    'http://100.64.0.1',
    'http://[fe80::1]',
    'http://[fc00::1]',
    'http://[fd00::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:169.254.169.254]',
    'file:///etc/passwd',
    'ftp://10.0.0.1/file',
  ];

  for (const url of ssrfTargets) {
    const res = await webFetchTool(url);
    assert.equal(res.ok, false, `Expected blocked SSRF target: ${url}`);
    assert.match(
      res.text,
      /web_fetch ditolak: target mengarah ke alamat internal\/tidak diizinkan|URL tidak valid|protokol.*tidak diizinkan/i,
      `Expected SSRF rejection message for ${url}`,
    );
  }
});

test('SSRF Guard: checkSsrfSafety detects private IP resolution via mock DNS lookup', async () => {
  const mockPrivateLookup = async () => [
    { address: '192.168.1.50', family: 4 },
  ];
  const rebindingCheck = await checkSsrfSafety(new URL('https://evil-internal-domain.com'), {
    lookupFn: mockPrivateLookup as any,
  });
  assert.equal(rebindingCheck.safe, false);
  assert.match(rebindingCheck.reason ?? '', /mengarah ke IP internal\/privat/);

  const mockPublicLookup = async () => [
    { address: '93.184.216.34', family: 4 },
  ];
  const publicCheck = await checkSsrfSafety(new URL('https://example.com'), {
    lookupFn: mockPublicLookup as any,
  });
  assert.equal(publicCheck.safe, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-pattern glob tests
// ─────────────────────────────────────────────────────────────────────────────

test('parseMultiGlobPatterns splits comma-separated patterns respecting braces', () => {
  assert.deepEqual(parseMultiGlobPatterns('*.ts, *.js'), ['*.ts', '*.js']);
  assert.deepEqual(parseMultiGlobPatterns('*.{ts,js}'), ['*.{ts,js}']);
  assert.deepEqual(parseMultiGlobPatterns('src/**/*.{ts,tsx}, test/**/*.{ts,js}'), [
    'src/**/*.{ts,tsx}',
    'test/**/*.{ts,js}',
  ]);
  assert.deepEqual(parseMultiGlobPatterns(''), ['']);
});

test('globToRegex supports brace expansion like *.{ts,js}', () => {
  const re = globToRegex('*.{ts,js}');
  assert.ok(re.test('app.ts'));
  assert.ok(re.test('index.js'));
  assert.ok(re.test('src/index.js'));
  assert.ok(!re.test('style.css'));
  assert.ok(!re.test('image.png'));
});

test('globTool matches multiple patterns in a workspace', async () => {
  await inTempWorkspace(async (ws) => {
    writeFileSync(join(ws, 'a.ts'), 'typescript', 'utf8');
    writeFileSync(join(ws, 'b.js'), 'javascript', 'utf8');
    writeFileSync(join(ws, 'c.json'), 'json', 'utf8');
    writeFileSync(join(ws, 'd.txt'), 'text', 'utf8');

    // Comma-separated pattern
    const resMulti = await globTool('*.ts, *.js', {}, ws);
    assert.equal(resMulti.ok, true);
    assert.equal(resMulti.totalFound, 2);
    assert.deepEqual(resMulti.files.sort(), ['a.ts', 'b.js']);

    // Brace expansion pattern
    const resBrace = await globTool('*.{ts,json}', {}, ws);
    assert.equal(resBrace.ok, true);
    assert.equal(resBrace.totalFound, 2);
    assert.deepEqual(resBrace.files.sort(), ['a.ts', 'c.json']);
  });
});
