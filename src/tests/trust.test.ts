import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isWorkspaceTrusted,
  markWorkspaceTrusted,
  promptWorkspaceTrust,
  TRUST_MARKER_FILE,
  globalTrustStorePath,
  hashWorkspacePath,
} from '../core/trust.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { DEFAULT_CONFIG } from '../types.js';

function inTempWorkspace<T>(fn: (ws: string) => Promise<T> | T): Promise<T> {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-trust-'));
  return Promise.resolve(fn(ws)).finally(() => {
    rmSync(ws, { recursive: true, force: true });
  });
}

test('isWorkspaceTrusted returns false by default for new folder', async () => {
  await inTempWorkspace(async (ws) => {
    const configPath = join(ws, '.ruko', 'config.json');
    assert.equal(isWorkspaceTrusted(ws, configPath), false);
  });
});

test('isWorkspaceTrusted returns true when RUKO_TRUST_FOLDER=1', async () => {
  await inTempWorkspace(async (ws) => {
    const prev = process.env.RUKO_TRUST_FOLDER;
    try {
      process.env.RUKO_TRUST_FOLDER = '1';
      assert.equal(isWorkspaceTrusted(ws), true);
    } finally {
      if (prev !== undefined) process.env.RUKO_TRUST_FOLDER = prev;
      else delete process.env.RUKO_TRUST_FOLDER;
    }
  });
});

test('markWorkspaceTrusted writes marker file and sets trustedWorkspace in config', async () => {
  await inTempWorkspace(async (ws) => {
    const configPath = join(ws, '.ruko', 'config.json');
    const cfg = { ...DEFAULT_CONFIG };
    saveConfig(cfg, configPath);

    assert.equal(isWorkspaceTrusted(ws, configPath), false);

    markWorkspaceTrusted(ws, configPath);

    assert.equal(existsSync(join(ws, '.ruko', TRUST_MARKER_FILE)), true);
    assert.equal(isWorkspaceTrusted(ws, configPath), true);

    const loaded = loadConfig(configPath);
    assert.equal(loaded.trustedWorkspace, true);
  });
});

test('promptWorkspaceTrust marks folder trusted when user answers y', async () => {
  await inTempWorkspace(async (ws) => {
    const configPath = join(ws, '.ruko', 'config.json');
    const asked: string[] = [];
    const io = {
      question: async (q: string) => {
        asked.push(q);
        return 'y';
      },
    };

    const trusted = await promptWorkspaceTrust(io, ws, configPath);
    assert.equal(trusted, true);
    assert.ok(asked.some((q) => q.includes('Percayai folder')));
    assert.equal(isWorkspaceTrusted(ws, configPath), true);
  });
});

test('promptWorkspaceTrust returns false and does not trust folder when user answers n', async () => {
  await inTempWorkspace(async (ws) => {
    const configPath = join(ws, '.ruko', 'config.json');
    const asked: string[] = [];
    const io = {
      question: async (q: string) => {
        asked.push(q);
        return 'n';
      },
    };

    const trusted = await promptWorkspaceTrust(io, ws, configPath);
    assert.equal(trusted, false);
    assert.ok(asked.some((q) => q.includes('Percayai folder')));
    assert.equal(isWorkspaceTrusted(ws, configPath), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L1 (audit v1.7.7, batch 2): RUKO_TRUST_FOLDER mem-bypass trust check tanpa
// log/warning. Bypass tetap ada (escape hatch CI) tetapi harus terlihat.
// ─────────────────────────────────────────────────────────────────────────────

test('L1: RUKO_TRUST_FOLDER mem-bypass trust check DENGAN warning eksplisit', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ruko-trust-warn-'));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  const prev = process.env.RUKO_TRUST_FOLDER;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(' '));
  };
  try {
    process.env.RUKO_TRUST_FOLDER = '1';
    assert.equal(isWorkspaceTrusted(ws), true, 'bypass tetap berfungsi');
    assert.equal(warnings.length, 1, 'harus ada tepat satu warning');
    assert.match(warnings[0], /RUKO_TRUST_FOLDER/);
    assert.match(warnings[0], /DILEWATI/);
  } finally {
    if (prev === undefined) delete process.env.RUKO_TRUST_FOLDER;
    else process.env.RUKO_TRUST_FOLDER = prev;
    console.warn = originalWarn;
    rmSync(ws, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TASK-03: Global trust store — trust records live in
// ~/.ruko/trusted-workspaces.json instead of inside the repo.
// ─────────────────────────────────────────────────────────────────────────────

test('TASK-03: hashWorkspacePath produces a stable hex hash', () => {
  const ws = '/tmp/test-workspace';
  const h1 = hashWorkspacePath(ws);
  const h2 = hashWorkspacePath(ws);
  assert.equal(h1, h2, 'same path should produce same hash');
  assert.match(h1, /^[0-9a-f]{64}$/, 'hash should be 64-char hex');

  // Different paths produce different hashes
  const h3 = hashWorkspacePath('/tmp/other-workspace');
  assert.notEqual(h1, h3, 'different paths should produce different hashes');
});

test('TASK-03: markWorkspaceTrusted writes to global trust store', async () => {
  await inTempWorkspace(async (ws) => {
    const configPath = join(ws, '.ruko', 'config.json');
    const cfg = { ...DEFAULT_CONFIG };
    saveConfig(cfg, configPath);

    // Suppress migration warnings from console.warn
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      markWorkspaceTrusted(ws, configPath);

      // Verify global store was written
      const storePath = globalTrustStorePath();
      assert.ok(existsSync(storePath), 'global trust store should exist');

      const store = JSON.parse(readFileSync(storePath, 'utf8'));
      const hash = hashWorkspacePath(ws);
      assert.ok(store[hash], 'workspace hash should be in global store');
      assert.equal(store[hash].path, resolve(ws), 'stored path should be canonical');
      assert.ok(store[hash].trustedAt, 'trustedAt should be set');

      // Also verify isWorkspaceTrusted reads from global store
      assert.equal(isWorkspaceTrusted(ws, configPath), true);
    } finally {
      console.warn = originalWarn;
      // Clean up global store entry
      try {
        const storePath = globalTrustStorePath();
        const store = JSON.parse(readFileSync(storePath, 'utf8'));
        const hash = hashWorkspacePath(ws);
        delete store[hash];
        writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
      } catch {
        // best effort cleanup
      }
    }
  });
});

test('TASK-03: globalTrustStorePath points to ~/.ruko/', () => {
  const storePath = globalTrustStorePath();
  assert.ok(storePath.includes('.ruko'), 'store path should be under .ruko');
  assert.ok(storePath.endsWith('trusted-workspaces.json'), 'store should be named trusted-workspaces.json');
});

// ─────────────────────────────────────────────────────────────────────────────
// WP-01 (v2.1.0): Self-authorization dihapus. Marker `.ruko/trusted` di dalam
// workspace dan flag `trustedWorkspace` config TIDAK LAGI memberi status
// tepercaya — satu-satunya sumber kebenaran adalah global trust store.
// ─────────────────────────────────────────────────────────────────────────────

/** Menghapus entri global untuk workspace (best-effort, test-only). */
function removeGlobalTrustEntry(ws: string): void {
  try {
    const storePath = globalTrustStorePath();
    const store = JSON.parse(readFileSync(storePath, 'utf8'));
    delete store[hashWorkspacePath(ws)];
    writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
  } catch {
    // best effort
  }
}

test('WP-01: file .ruko/trusted di workspace TIDAK mengubah status trust global', async () => {
  await inTempWorkspace(async (ws) => {
    const configPath = join(ws, '.ruko', 'config.json');
    mkdirSync(join(ws, '.ruko'), { recursive: true });
    writeFileSync(
      join(ws, '.ruko', TRUST_MARKER_FILE),
      JSON.stringify({ trustedAt: new Date().toISOString(), cwd: ws }),
      'utf8',
    );
    removeGlobalTrustEntry(ws);

    assert.equal(
      isWorkspaceTrusted(ws, configPath),
      false,
      'marker .ruko/trusted dari repo tidak boleh memberi trust',
    );
  });
});

test('WP-01: config.json trustedWorkspace=true di workspace TIDAK mengubah status trust', async () => {
  await inTempWorkspace(async (ws) => {
    const configPath = join(ws, '.ruko', 'config.json');
    saveConfig({ ...DEFAULT_CONFIG, trustedWorkspace: true }, configPath);
    removeGlobalTrustEntry(ws);

    assert.equal(
      isWorkspaceTrusted(ws, configPath),
      false,
      'flag trustedWorkspace dari config ruang kerja tidak boleh memberi trust',
    );
  });
});

test('WP-01: mencabut entri global mencabut trust walau marker workspace masih ada', async () => {
  await inTempWorkspace(async (ws) => {
    const configPath = join(ws, '.ruko', 'config.json');
    saveConfig({ ...DEFAULT_CONFIG }, configPath);
    removeGlobalTrustEntry(ws);

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      markWorkspaceTrusted(ws, configPath);
      assert.equal(isWorkspaceTrusted(ws, configPath), true, 'global store memberi trust');
    } finally {
      console.warn = originalWarn;
    }

    // Marker/config workspace masih ada, tetapi status trust dicabut → false
    assert.equal(existsSync(join(ws, '.ruko', TRUST_MARKER_FILE)), true, 'marker legacy tetap ditulis');
    removeGlobalTrustEntry(ws);
    assert.equal(
      isWorkspaceTrusted(ws, configPath),
      false,
      'marker workspace tidak boleh menghidupkan kembali trust',
    );
  });
});
