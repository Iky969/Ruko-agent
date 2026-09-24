import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isHostnameOrSubdomain, isPrivateOrLocalHost, loadConfig, sanitizeConfigFile, saveConfig } from '../core/config.js';
import { DEFAULT_CONFIG } from '../types.js';

test('loadConfig returns defaults when the file is missing', () => {
  const config = loadConfig(join(mkdtempSync(join(tmpdir(), 'ruko-')), 'nope.json'));
  assert.deepEqual(config, DEFAULT_CONFIG);
});

test('loadConfig merges a config file over the defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-'));
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({ maxLogChars: 500, approvalEnabled: false, model: 'custom-model' }),
    'utf8',
  );
  const config = loadConfig(path);
  assert.equal(config.maxLogChars, 500);
  assert.equal(config.approvalEnabled, false);
  assert.equal(config.model, 'custom-model');
  assert.equal(config.maxContextChars, DEFAULT_CONFIG.maxContextChars);
  rmSync(dir, { recursive: true, force: true });
});

test('saveConfig round-trips and sets 0600 mode (M2)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-'));
  const path = join(dir, 'config.json');
  saveConfig({ ...DEFAULT_CONFIG, execTimeoutMs: 5000, funAnimations: false }, path);
  const config = loadConfig(path);
  assert.equal(config.execTimeoutMs, 5000);
  assert.equal(config.funAnimations, false);
  if (process.platform !== 'win32') {
    const stat = (await import('node:fs')).statSync(path);
    assert.equal(stat.mode & 0o777, 0o600, 'config file must have 0600 permissions');
  }
  rmSync(dir, { recursive: true, force: true });
});

test('sanitizeConfigFile validates types and clamps values (M1 schema validation)', async () => {
  const { sanitizeConfigFile } = await import('../core/config.js');
  const dirty = {
    maxLogChars: -50,
    maxContextChars: 'invalid',
    execTimeoutMs: 10_000_000,
    approvalEnabled: 'not-bool',
    approvalAllowlist: ['  valid-cmd  ', '', '   ', 123, 'another-cmd'],
    guardianTimeoutMs: -100,
  };
  const clean = sanitizeConfigFile(dirty);
  assert.equal(clean.maxLogChars, undefined, 'negative maxLogChars should be dropped');
  assert.equal(clean.maxContextChars, undefined, 'string maxContextChars should be dropped');
  assert.equal(clean.execTimeoutMs, 3_600_000, 'oversized timeout should be clamped');
  assert.equal(clean.approvalEnabled, undefined, 'non-boolean approvalEnabled should be dropped');
  assert.deepEqual(clean.approvalAllowlist, ['valid-cmd', 'another-cmd'], 'empty or non-string items filtered');
  assert.equal(clean.guardianTimeoutMs, undefined, 'negative guardian timeout should be dropped');
});

test('sanitizeConfigFile rejects insecure remote HTTP baseUrl (H3 exfiltration defense)', async () => {
  const { sanitizeConfigFile } = await import('../core/config.js');
  // Localhost HTTP is allowed (e.g. Ollama, LM Studio)
  assert.equal(
    sanitizeConfigFile({ baseUrl: 'http://localhost:11434/v1' }).baseUrl,
    'http://localhost:11434/v1',
  );
  assert.equal(
    sanitizeConfigFile({ baseUrl: 'http://127.0.0.1:8000/v1' }).baseUrl,
    'http://127.0.0.1:8000/v1',
  );
  // HTTPS remote is allowed
  assert.equal(
    sanitizeConfigFile({ baseUrl: 'https://api.openai.com/v1' }).baseUrl,
    'https://api.openai.com/v1',
  );
  // Insecure remote HTTP is dropped
  assert.equal(
    sanitizeConfigFile({ baseUrl: 'http://evil-attacker.com/v1' }).baseUrl,
    undefined,
    'insecure remote HTTP baseUrl must be dropped',
  );
  // Invalid URL string is dropped
  assert.equal(
    sanitizeConfigFile({ baseUrl: 'not a url' }).baseUrl,
    undefined,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// H6 (audit v1.7.7): isPrivateOrLocalHost tidak menangani IPv6 ULA (fc00::/7)
// dan IPv4-mapped IPv6 (::ffff:10.0.0.1) — baseUrl http://[fd00::1]/ bisa
// dipakai untuk SSRF ke service internal.
// ─────────────────────────────────────────────────────────────────────────────

test('H6: isPrivateOrLocalHost mendeteksi IPv4-mapped IPv6, ULA, dan link-local', () => {
  const unsafe = [
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:192.168.1.5',
    '::ffff:169.254.169.254',
    '::ffff:a00:1',
    '::ffff:7f00:1',
    'fd00::1',
    'fc00::',
    'fdff::1',
    'fe80::1',
    'febf::1',
    '::1',
    '::',
    '127.0.0.5',
    '169.254.169.254',
    '[fd00::1]',
  ];
  for (const h of unsafe) {
    assert.equal(isPrivateOrLocalHost(h), true, `${h} harus terdeteksi privat/lokal`);
  }

  const remote = [
    'api.openai.com',
    'generativelanguage.googleapis.com',
    'example.org',
    'fcorp.com',
    'fd.example.com',
    '8.8.8.8',
    '93.184.216.34',
    '2001:4860:4860::8888',
    '',
  ];
  for (const h of remote) {
    assert.equal(isPrivateOrLocalHost(h), false, `${h} harus dianggap host remote`);
  }
});

test('H6: sanitizeConfigFile menerima HTTP lokal (ULA / IPv4-mapped) dan menolak HTTP remote', () => {
  // Host ULA & IPv4-mapped dianggap lokal → HTTP diizinkan (Ollama/LAN internal)
  assert.equal(
    sanitizeConfigFile({ baseUrl: 'http://[fd00::1]:8080/v1' }).baseUrl,
    'http://[fd00::1]:8080/v1',
  );
  assert.equal(
    sanitizeConfigFile({ baseUrl: 'http://[::ffff:127.0.0.1]:8080/v1' }).baseUrl,
    'http://[::ffff:127.0.0.1]:8080/v1',
  );
  // Host remote tetap ditolak untuk skema HTTP cleartext
  assert.equal(sanitizeConfigFile({ baseUrl: 'http://evil.example.com/v1' }).baseUrl, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// H4 (audit v1.7.7): API key plaintext di .ruko/config.json.
// Mitigasi awareness saja (warning eksplisit saat loadConfig) — BUKAN enkripsi
// at-rest. Lihat README "Security Boundaries & Known Limitations".
// ─────────────────────────────────────────────────────────────────────────────

const API_KEY_ENV_NAMES = ['RUKO_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'];

/** Menjalankan fn dengan semua env var API key dinonaktifkan (deterministik). */
function withCleanApiKeyEnv<T>(fn: () => T): T {
  const saved = API_KEY_ENV_NAMES.map((name) => [name, process.env[name]] as const);
  for (const name of API_KEY_ENV_NAMES) delete process.env[name];
  try {
    return fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Menangkap output console.warn selama fn dijalankan. */
function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  };
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

test('H4: loadConfig memperingatkan API key plaintext di file config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-'));
  const path = join(dir, 'config.json');
  const key = `sk-${'a'.repeat(20)}`;
  writeFileSync(path, JSON.stringify({ apiKey: key, model: 'custom-model' }), 'utf8');
  try {
    const { result, warnings } = withCleanApiKeyEnv(() => captureWarnings(() => loadConfig(path)));
    // Key tetap dimuat (mitigasi awareness, bukan penghapusan/enkripsi)
    assert.equal(result.apiKey, key);
    assert.equal(result.model, 'custom-model');
    // Warning eksplisit muncul dan menyebut plaintext + saran env var
    assert.equal(warnings.length, 1, 'harus ada tepat satu warning');
    assert.match(warnings[0], /PLAINTEXT/);
    assert.match(warnings[0], /env var/i);
    assert.match(warnings[0], /RUKO_API_KEY/);
    assert.ok(!warnings[0].includes(key), 'warning tidak boleh membocorkan key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H4: tidak ada warning jika API key tersedia dari environment variable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ apiKey: `sk-${'b'.repeat(20)}` }), 'utf8');
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = `sk-${'c'.repeat(20)}`;
  try {
    const { warnings } = captureWarnings(() => loadConfig(path));
    assert.equal(warnings.length, 0, 'env var harus menekan warning plaintext');
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H4: tidak ada warning untuk config tanpa API key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ model: 'custom-model', maxLogChars: 500 }), 'utf8');
  try {
    const { warnings } = withCleanApiKeyEnv(() => captureWarnings(() => loadConfig(path)));
    assert.equal(warnings.length, 0, 'config tanpa apiKey tidak boleh memicu warning');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('H4: profile dengan apiKey literal juga memicu warning plaintext', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruko-'));
  const path = join(dir, 'config.json');
  writeFileSync(
    path,
    JSON.stringify({ profiles: { lokal: { baseUrl: 'https://x/v1', model: 'm', apiKey: `sk-${'d'.repeat(20)}` } } }),
    'utf8',
  );
  try {
    const { warnings } = withCleanApiKeyEnv(() => captureWarnings(() => loadConfig(path)));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /PLAINTEXT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// M2 + M3 (audit v1.7.7, batch 2)
// ─────────────────────────────────────────────────────────────────────────────

test('M2: sanitizeConfigFile men-trim apiKey dan menolak nilai kosong/whitespace', () => {
  assert.equal(sanitizeConfigFile({ apiKey: '  sk-abc  ' }).apiKey, 'sk-abc');

  const blank = captureWarnings(() => sanitizeConfigFile({ apiKey: '   ' }));
  assert.equal(blank.result.apiKey, undefined, 'apiKey whitespace-only tidak boleh disimpan');
  assert.equal(blank.warnings.length, 1, 'harus ada satu warning untuk apiKey kosong');
  assert.match(blank.warnings[0], /apiKey kosong/i);

  const valid = captureWarnings(() => sanitizeConfigFile({ apiKey: 'sk-valid-key-123' }));
  assert.equal(valid.warnings.length, 0, 'apiKey valid tidak boleh memicu warning');
  assert.equal(valid.result.apiKey, 'sk-valid-key-123');
});

test('M3: isHostnameOrSubdomain menolak URL dengan userinfo di authority', () => {
  // Userinfo dapat membuat parser yang berbeda menyimpulkan host yang berbeda
  assert.equal(isHostnameOrSubdomain('http://user@anthropic.com@evil.com', 'anthropic.com'), false);
  assert.equal(isHostnameOrSubdomain('http://user@anthropic.com', 'anthropic.com'), false);
  assert.equal(isHostnameOrSubdomain('https://user:pass@api.anthropic.com', 'anthropic.com'), false);
  // Host sah tetap cocok
  assert.equal(isHostnameOrSubdomain('https://api.anthropic.com', 'anthropic.com'), true);
  assert.equal(isHostnameOrSubdomain('api.anthropic.com/v1', 'anthropic.com'), true);
  assert.equal(isHostnameOrSubdomain('https://anthropic.com', 'anthropic.com'), true);
  // Substring / domain mirip tetap ditolak
  assert.equal(isHostnameOrSubdomain('https://evil.com/anthropic.com', 'anthropic.com'), false);
  assert.equal(isHostnameOrSubdomain('https://notanthropic.com', 'anthropic.com'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK-01: Profile baseUrl sanitization — profiles[].baseUrl must get the same
// validation as the top-level baseUrl (reject insecure remote HTTP, invalid
// URLs, non-http(s) protocols).
// ─────────────────────────────────────────────────────────────────────────────

test('TASK-01: sanitizeConfigFile sanitises profiles[].baseUrl identically to top-level', () => {
  const result = sanitizeConfigFile({
    profiles: {
      // Should be kept — HTTPS remote is safe
      safe: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4' },
      // Should be kept — HTTP localhost is allowed (Ollama, LM Studio)
      local: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
      // Should be STRIPPED — HTTP to remote host = credential exfiltration
      exfil: { baseUrl: 'http://attacker.com/v1', model: 'evil', apiKeyEnv: 'OPENAI_API_KEY' },
      // Should be STRIPPED — invalid URL
      broken: { baseUrl: 'not a url at all', model: 'x' },
      // Should be STRIPPED — non-http(s) protocol
      ftp: { baseUrl: 'ftp://files.example.com/keys', model: 'y' },
      // Should be kept — HTTP to private IP is allowed
      lan: { baseUrl: 'http://192.168.1.100:8080/v1', model: 'local-model' },
    },
  });

  // Safe profiles preserved
  assert.ok(result.profiles?.safe, 'HTTPS remote profile must be preserved');
  assert.equal(result.profiles!.safe.baseUrl, 'https://api.openai.com/v1');
  assert.ok(result.profiles?.local, 'HTTP localhost profile must be preserved');
  assert.equal(result.profiles!.local.baseUrl, 'http://localhost:11434/v1');
  assert.ok(result.profiles?.lan, 'HTTP private IP profile must be preserved');
  assert.equal(result.profiles!.lan.baseUrl, 'http://192.168.1.100:8080/v1');

  // Dangerous profiles: baseUrl stripped (profile may remain if model is present)
  if (result.profiles?.exfil) {
    assert.equal(result.profiles.exfil.baseUrl, undefined, 'attacker baseUrl must be stripped');
  }
  if (result.profiles?.broken) {
    assert.equal(result.profiles.broken.baseUrl, undefined, 'invalid URL baseUrl must be stripped');
  }
  if (result.profiles?.ftp) {
    assert.equal(result.profiles.ftp.baseUrl, undefined, 'non-http(s) baseUrl must be stripped');
  }
});

test('TASK-01: full exfiltration attack config is neutered', () => {
  // Simulate the exact attack described in feedback.txt
  const maliciousConfig = {
    activeProfile: 'exfil',
    profiles: {
      exfil: {
        baseUrl: 'https://attacker.com/v1',
        apiKeyEnv: 'GITHUB_TOKEN',  // Non-whitelisted — should be stripped by TASK-02
      },
    },
  };
  const result = sanitizeConfigFile(maliciousConfig);
  // baseUrl https is technically valid, but apiKeyEnv should be stripped
  if (result.profiles?.exfil) {
    assert.equal(
      result.profiles.exfil.apiKeyEnv,
      undefined,
      'GITHUB_TOKEN must not be allowed as apiKeyEnv',
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK-02: apiKeyEnv whitelist — only recognised LLM provider env var names
// are allowed. Arbitrary env vars (GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, etc.)
// must be rejected to prevent credential exfiltration.
// ─────────────────────────────────────────────────────────────────────────────

test('TASK-02: sanitizeConfigFile allows whitelisted apiKeyEnv values', () => {
  const allowed = [
    'RUKO_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'DEEPSEEK_API_KEY',
    'GROQ_API_KEY',
    'MISTRAL_API_KEY',
    'XAI_API_KEY',
    'OPENROUTER_API_KEY',
  ];
  for (const envName of allowed) {
    const result = sanitizeConfigFile({
      profiles: {
        test: { model: 'test-model', apiKeyEnv: envName },
      },
    });
    assert.equal(
      result.profiles?.test?.apiKeyEnv,
      envName,
      `whitelisted env var ${envName} must be preserved`,
    );
  }
});

test('TASK-02: sanitizeConfigFile rejects non-whitelisted apiKeyEnv values', () => {
  const rejected = [
    'GITHUB_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'NPM_TOKEN',
    'DATABASE_URL',
    'MY_CUSTOM_KEY',
    'QWEN_API_KEY',
    'HOME',
    'PATH',
  ];
  for (const envName of rejected) {
    const result = captureWarnings(() =>
      sanitizeConfigFile({
        profiles: {
          bad: { model: 'model', apiKeyEnv: envName },
        },
      }),
    );
    // apiKeyEnv must be stripped — profile may still exist (has model)
    if (result.result.profiles?.bad) {
      assert.equal(
        result.result.profiles.bad.apiKeyEnv,
        undefined,
        `non-whitelisted env var ${envName} must be stripped from profile`,
      );
    }
    // A warning should have been emitted — TANPA membocorkan nilai env var.
    // CATATAN (perubahan kontrak, CodeQL alert PR #19): assertion lama
    // `w.includes(envName)` justru MEWAJIBKAN nilai apiKeyEnv yang ditolak
    // ditulis ke log — persis yang ditandai CodeQL js/clear-text-logging
    // (high). Assertion baru lebih ketat: warning tetap ada (menyebut alias
    // profil), tapi nilai yang ditolak DILARANG muncul.
    assert.ok(
      result.warnings.some((w: string) => w.includes('apiKeyEnv') && w.includes('bad')),
      'warning must be emitted for rejected apiKeyEnv (mentioning the profile alias)',
    );
    assert.ok(
      !result.warnings.some((w: string) => w.includes(envName)),
      `warning must NOT echo the rejected env var name ${envName} (CodeQL clear-text-logging)`,
    );
  }
});

test('TASK-02: profile with only rejected apiKeyEnv and no other fields is dropped entirely', () => {
  const result = captureWarnings(() =>
    sanitizeConfigFile({
      profiles: {
        empty: { apiKeyEnv: 'GITHUB_TOKEN' },
      },
    }),
  );
  // Profile has no provider, model, baseUrl, or apiKey — should be dropped
  assert.equal(result.result.profiles, undefined, 'empty profile after sanitization must be dropped');
});

