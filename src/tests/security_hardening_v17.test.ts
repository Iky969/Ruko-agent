import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, symlinkSync, writeFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {
  assertInsideWorkspace,
  assertNotSensitivePath,
  isPathInsideWorkspace,
  isSensitivePath,
  runToolCall,
} from '../agent/tools.js';
import { webFetchTool, TransportFn, pinnedHttpFetch } from '../agent/webtools.js';
import { codeSearchTool, globTool, readFileTool } from '../agent/filetools.js';
import { deleteSkill, readSkill, sanitizeSkillName, saveSkill } from '../core/skills.js';
import { exportSessionTrajectory, loadSession, saveSession } from '../core/session.js';
import { takeSnapshot } from '../core/undo.js';
import { inferStepDescription } from '../core/ui.js';

test('start_process rejects chained commands, subshell, variable expansions, and blocked commands', async () => {
  const ws = path.join(os.tmpdir(), `ruko-test-startproc-${Date.now()}`);
  mkdirSync(ws, { recursive: true });

  try {
    // 1. Blocked command (fork bomb & rm -rf / in chain)
    const resBlocked = await runToolCall(
      { tool: 'start_process', command: ':(){ :|:& };:' },
      { workspaceRoot: ws },
    );
    assert.ok(JSON.parse(resBlocked).error.includes('BLOCKED'));

    const resBlockedChain = await runToolCall(
      { tool: 'start_process', command: 'echo starting && rm -rf /' },
      { workspaceRoot: ws },
    );
    assert.ok(JSON.parse(resBlockedChain).error.includes('BLOCKED'));

    // 2. Sensitive env command in chain and variable expansion
    const resEnvChain = await runToolCall(
      { tool: 'start_process', command: 'echo ok && printenv' },
      { workspaceRoot: ws },
    );
    assert.ok(JSON.parse(resEnvChain).error.includes('environment variable sensitif'));

    const resVarExpand1 = await runToolCall(
      { tool: 'start_process', command: 'echo $RUKO_API_KEY' },
      { workspaceRoot: ws },
    );
    assert.ok(JSON.parse(resVarExpand1).error.includes('environment variable sensitif'));

    const resVarExpand2 = await runToolCall(
      { tool: 'start_process', command: 'node -e "console.log(\'${SECRET_PASSWORD}\')"' },
      { workspaceRoot: ws },
    );
    assert.ok(JSON.parse(resVarExpand2).error.includes('environment variable sensitif'));

    // 3. Sensitive file access in chain
    const resFileChain = await runToolCall(
      { tool: 'start_process', command: 'echo note ; cat .ruko/config.json' },
      { workspaceRoot: ws },
    );
    assert.ok(JSON.parse(resFileChain).error.includes('file sensitif'));

    const resEnvFileChain = await runToolCall(
      { tool: 'start_process', command: 'head -n 5 .env' },
      { workspaceRoot: ws },
    );
    assert.ok(JSON.parse(resEnvFileChain).error.includes('file sensitif'));

    // 4. Mutation bypass
    const resMut = await runToolCall(
      { tool: 'start_process', command: 'rm -f somefile.txt' },
      { workspaceRoot: ws },
    );
    assert.ok(JSON.parse(resMut).error.includes('delete_file'));

    const resRedirect = await runToolCall(
      { tool: 'start_process', command: '> somefile.txt' },
      { workspaceRoot: ws },
    );
    assert.ok(JSON.parse(resRedirect).error.includes('write_file'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('assertInsideWorkspace blocks symlinked directories and non-existent files inside symlink directory', () => {
  const ws = path.join(os.tmpdir(), `ruko-test-symdir-${Date.now()}`);
  const outsideDir = path.join(os.tmpdir(), `outside-dir-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const outsideFile = path.join(outsideDir, 'secret.txt');
  writeFileSync(outsideFile, 'secret outside');

  const evilDirLink = path.join(ws, 'evil_dir');
  symlinkSync(outsideDir, evilDirLink);

  try {
    // 1. Existing file accessed through symlinked directory is rejected
    const existingFileThroughLink = path.join(evilDirLink, 'secret.txt');
    assert.throws(
      () => assertInsideWorkspace(existingFileThroughLink, ws),
      /symlink di luar working directory/i,
    );

    // 2. Non-existent file inside symlinked directory is rejected via ancestor check
    const newFileThroughLink = path.join(evilDirLink, 'new_file.txt');
    assert.throws(
      () => assertInsideWorkspace(newFileThroughLink, ws),
      /symlink di luar working directory/i,
    );

    // 3. Normal nested subdirectories inside workspace pass
    const legitSubdir = path.join(ws, 'legit');
    mkdirSync(legitSubdir, { recursive: true });
    const legitNewFile = path.join(legitSubdir, 'new.txt');
    assert.doesNotThrow(() => assertInsideWorkspace(legitNewFile, ws));
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('assertNotSensitivePath detects symlinks pointing to sensitive files and .git/config', () => {
  const ws = path.join(os.tmpdir(), `ruko-test-senssym-${Date.now()}`);
  mkdirSync(path.join(ws, '.ruko'), { recursive: true });

  const envFile = path.join(ws, '.env');
  writeFileSync(envFile, 'API_KEY=123');

  const symlinkToEnv = path.join(ws, 'innocent_name.txt');
  symlinkSync(envFile, symlinkToEnv);

  try {
    // Symlink pointing to .env is caught
    assert.throws(
      () => assertNotSensitivePath(symlinkToEnv, ws),
      /file sensitif/i,
    );

    // .git/config is recognized as sensitive
    assert.equal(isSensitivePath('.git/config', ws), true);
    assert.equal(isSensitivePath(path.join(ws, '.git', 'config'), ws), true);
    assert.throws(
      () => assertNotSensitivePath('.git/config', ws),
      /file sensitif/i,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('file tools (read, write, edit, glob, code_search) resist symlink traversal and escapes', async () => {
  const ws = path.join(os.tmpdir(), `ruko-test-filetools-${Date.now()}`);
  const outsideDir = path.join(os.tmpdir(), `outside-data-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const outsideSecret = path.join(outsideDir, 'outside-secret.txt');
  writeFileSync(outsideSecret, 'SUPER_SECRET_TOKEN_XYZ_123');

  const leakLink = path.join(ws, 'leak.txt');
  symlinkSync(outsideSecret, leakLink);

  const evilDirLink = path.join(ws, 'evil_dir');
  symlinkSync(outsideDir, evilDirLink);

  try {
    // 1. readFileTool refuses to read through escaping symlink file
    const readRes = await readFileTool('leak.txt', {}, ws);
    assert.equal(readRes.ok, false);
    assert.ok(readRes.text.includes('symlink di luar working directory'));

    // 2. readFileTool refuses to read through escaping symlink directory
    const readDirRes = await readFileTool('evil_dir/outside-secret.txt', {}, ws);
    assert.equal(readDirRes.ok, false);
    assert.ok(readDirRes.text.includes('symlink di luar working directory'));

    // 3. globTool ignores escaping symlinks and symlinked directories
    const globRes = await globTool('*', {}, ws);
    assert.equal(globRes.ok, true);
    assert.ok(!globRes.files.includes('leak.txt'));
    assert.ok(!globRes.files.some((f: string) => f.startsWith('evil_dir/')));

    // 4. codeSearchTool ignores outside content and does NOT leak outside secrets
    const searchRes = await codeSearchTool('SUPER_SECRET_TOKEN_XYZ_123', {}, ws);
    assert.equal(searchRes.ok, true);
    assert.equal(searchRes.totalMatches, 0, 'code_search must not return matches from outside symlinks');

    // 5. write_file / edit_file refuses writing through symlinks
    // Case A: External symlink is rejected by workspace boundary guard
    const writeExternalRes = await runToolCall(
      { tool: 'edit_file', path: 'leak.txt', content: 'hacked content' },
      { workspaceRoot: ws },
    );
    assert.ok(JSON.parse(writeExternalRes).error.includes('symlink di luar working directory'));

    // Case B: Internal symlink is rejected by anti-TOCTOU write guard (no symlink writing allowed)
    const innerTarget = path.join(ws, 'inner_target.txt');
    writeFileSync(innerTarget, 'initial inner');
    const innerLink = path.join(ws, 'inner_link.txt');
    symlinkSync(innerTarget, innerLink);

    const writeInternalRes = await runToolCall(
      { tool: 'edit_file', path: 'inner_link.txt', content: 'modified inner' },
      { workspaceRoot: ws },
    );
    assert.ok(JSON.parse(writeInternalRes).error.includes('symbolic link'));
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('webFetchTool adversarial SSRF: re-resolves DNS at redirect hop, catches private IP, blocks protocol smuggling and IPv6', async () => {
  let callCount = 0;
  const pinnedIpsUsed: string[] = [];
  const mockTransport: TransportFn = async (url, options) => {
    callCount++;
    pinnedIpsUsed.push(options.pinnedIp);
    if (callCount === 1) {
      return {
        status: 302,
        headers: { location: 'http://attacker-redirect.internal/metadata' },
        text: '',
      };
    }
    return { status: 200, headers: {}, text: 'internal leak' };
  };

  const mockLookup = (async (host: string) => {
    if (host === 'attacker-redirect.internal') {
      return [{ address: '169.254.169.254', family: 4 }];
    }
    return [{ address: '93.184.216.34', family: 4 }];
  }) as any;

  // 1. SSRF DNS re-resolution test on redirect hop
  const resDns = await webFetchTool('https://example.com/start', {
    lookupFn: mockLookup,
    transportFn: mockTransport,
  });
  assert.equal(resDns.ok, false);
  assert.ok(
    resDns.text.includes('redirect mengarah ke alamat internal/tidak diizinkan'),
    'Must re-resolve DNS and block redirect to domain resolving to 169.254.169.254',
  );
  assert.equal(callCount, 1, 'Must not follow redirect when DNS resolves to internal IP');
  assert.deepEqual(pinnedIpsUsed, ['93.184.216.34'], 'Request 1 must be pinned to verified safe IP');

  // 2. Protocol smuggling redirect (file:///etc/passwd)
  const fileRedirectTransport: TransportFn = async () => ({
    status: 302,
    headers: { location: 'file:///etc/passwd' },
    text: '',
  });
  const resProto = await webFetchTool('https://example.com/proto', {
    transportFn: fileRedirectTransport,
    lookupFn: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
  });
  assert.equal(resProto.ok, false);
  assert.ok(resProto.text.includes('protokol "file:" tidak diizinkan'));

  // 3. IPv6 loopback redirect (http://[::1]:8080/)
  const ipv6RedirectTransport: TransportFn = async () => ({
    status: 302,
    headers: { location: 'http://[::1]:8080/admin' },
    text: '',
  });
  const resIpv6 = await webFetchTool('https://example.com/ipv6', {
    transportFn: ipv6RedirectTransport,
    lookupFn: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
  });
  assert.equal(resIpv6.ok, false);
  assert.ok(resIpv6.text.includes('redirect mengarah ke alamat internal/tidak diizinkan'));
});

test('webFetchTool detects redirect loops and exceeds limit', async () => {
  const loopTransport: TransportFn = async (url) => ({
    status: 302,
    headers: { location: url.href },
    text: '',
  });
  const res = await webFetchTool('https://example.com/loop', {
    transportFn: loopTransport,
    lookupFn: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
  });
  assert.equal(res.ok, false);
  assert.ok(res.text.includes('siklus redirect terdeteksi'));
});

test('skills system rejects path traversal in readSkill and deleteSkill', () => {
  const ws = path.join(os.tmpdir(), `ruko-test-skills-${Date.now()}`);
  mkdirSync(ws, { recursive: true });

  try {
    // Normal save works
    const saved = saveSkill('deploy-guide', 'Deployment skill', 'Step 1: build', ws);
    assert.equal(saved.name, 'deploy-guide');

    // Traversal names are sanitized or blocked
    assert.equal(sanitizeSkillName('../../etc/passwd'), '------etc-passwd');
    assert.equal(readSkill('../../etc/passwd', ws), null);
    assert.equal(deleteSkill('../../etc/passwd', ws), false);

    // Normal skill can be read and deleted
    const read = readSkill('deploy-guide', ws);
    assert.ok(read);
    assert.equal(read.name, 'deploy-guide');
    assert.equal(deleteSkill('deploy-guide', ws), true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('session system rejects path traversal in loadSession and saveSession', () => {
  const ws = path.join(os.tmpdir(), `ruko-test-sess-${Date.now()}`);
  const sessDir = path.join(ws, '.ruko', 'sessions');
  mkdirSync(sessDir, { recursive: true });

  try {
    // 1. Normal save and load
    const session = saveSession([{ role: 'user', content: 'test message', timestamp: new Date().toISOString() }], sessDir, 'safe-session');
    assert.equal(session.id, 'safe-session');

    const loaded = loadSession('safe-session', sessDir);
    assert.ok(loaded);
    assert.equal(loaded.id, 'safe-session');

    // 2. Traversal attempt on loadSession returns null
    const evilLoaded = loadSession('../../../etc/passwd', sessDir);
    assert.equal(evilLoaded, null);

    // 3. Traversal attempt on saveSession is strictly rejected with an explicit error
    assert.throws(
      () => saveSession([{ role: 'user', content: 'malicious', timestamp: new Date().toISOString() }], sessDir, '../../../etc/passwd'),
      /saveSession ditolak.*tidak valid atau mengandung karakter traversal/i,
    );
    assert.throws(
      () => saveSession([{ role: 'user', content: 'malicious', timestamp: new Date().toISOString() }], sessDir, 'evil/subpath'),
      /saveSession ditolak.*tidak valid atau mengandung karakter traversal/i,
    );

    // 4. Traversal attempt on exportSessionTrajectory is strictly rejected
    const exportDir = path.join(ws, '.ruko', 'exports');
    assert.throws(
      () => exportSessionTrajectory([{ role: 'user', content: 'export exploit', timestamp: new Date().toISOString() }], 'jsonl', exportDir, '../../../etc/passwd'),
      /exportSessionTrajectory ditolak.*tidak valid atau mengandung karakter traversal/i,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('webFetchTool adversarial SSRF: detects and blocks active dynamic DNS rebinding (TTL=0 flip and redirect rebinding)', async () => {
  // 1. Active DNS Rebinding via TTL=0 flipping on pre-flight lookup:
  // Query 1 returns public IP, Query 2 (active double-check) flips to AWS metadata IP
  let flipCount = 0;
  const flippingLookup = (async (host: string) => {
    flipCount++;
    if (flipCount === 1) {
      return [{ address: '93.184.216.34', family: 4 }];
    }
    return [{ address: '169.254.169.254', family: 4 }];
  }) as any;

  const resPreflightFlip = await webFetchTool('https://flipping-attacker.example.com/data', {
    lookupFn: flippingLookup,
  });
  assert.equal(resPreflightFlip.ok, false);
  assert.ok(
    resPreflightFlip.text.includes('terdeteksi aktif rebinding') ||
    resPreflightFlip.text.includes('mengarah ke IP internal/privat'),
    'Must detect and block active DNS rebinding flip during pre-flight lookup',
  );

  // 2. Active DNS Rebinding across HTTP Redirect:
  // Host resolves to public IP during initial check & fetch, but on 302 redirect back to the host,
  // subsequent DNS resolution flips to local loopback (127.0.0.1)
  let redirectQueries = 0;
  const redirectRebindingLookup = (async (host: string) => {
    redirectQueries++;
    // First 2 queries (initial preflight check + double-check) return public IP
    if (redirectQueries <= 2) {
      return [{ address: '93.184.216.34', family: 4 }];
    }
    // Rebound! On redirect hop queries, return loopback
    return [{ address: '127.0.0.1', family: 4 }];
  }) as any;

  let fetchCalls = 0;
  const pinnedHops: string[] = [];
  const redirectTransport: TransportFn = async (url, options) => {
    fetchCalls++;
    pinnedHops.push(options.pinnedIp);
    if (fetchCalls === 1) {
      return {
        status: 302,
        headers: { location: 'https://redirect-rebind.example.com/internal-secret' },
        text: '',
      };
    }
    return { status: 200, headers: {}, text: 'secret data leaked' };
  };

  const resRedirectRebind = await webFetchTool('https://redirect-rebind.example.com/start', {
    lookupFn: redirectRebindingLookup,
    transportFn: redirectTransport,
  });
  assert.equal(resRedirectRebind.ok, false);
  assert.ok(
    resRedirectRebind.text.includes('redirect mengarah ke alamat internal/tidak diizinkan'),
    'Must catch DNS rebinding on redirect hop and refuse to fetch',
  );
  assert.equal(fetchCalls, 1, 'Must not execute fetch on the redirected hop after rebinding detected');
  assert.deepEqual(pinnedHops, ['93.184.216.34'], 'Hop 1 was safely pinned to verified public IP');

  // 3. Dual-homed / round-robin DNS rebinding (returns both public and private IP in one response)
  const dualLookup = (async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ]) as any;

  const resDual = await webFetchTool('https://dual-homed.example.com', {
    lookupFn: dualLookup,
  });
  assert.equal(resDual.ok, false);
  assert.ok(resDual.text.includes('mengarah ke IP internal/privat'));
});

test('pinnedHttpFetch connects socket strictly to pinnedIp (zero secondary DNS queries)', async () => {
  let server: http.Server;
  const testPort = 34589;
  let receivedHostHeader = '';
  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      receivedHostHeader = req.headers['host'] || '';
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('pinned success');
    });
    server.listen(testPort, '127.0.0.1', () => resolve());
  });

  try {
    // We send request for fake domain 'pinned.mock-domain.internal' but pin socket to 127.0.0.1!
    const res = await pinnedHttpFetch(new URL(`http://pinned.mock-domain.internal:${testPort}/check`), {
      pinnedIp: '127.0.0.1',
      ipFamily: 4,
      timeoutMs: 3000,
      headers: { 'X-Custom-Test': '1' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.text, 'pinned success');
    assert.equal(receivedHostHeader, `pinned.mock-domain.internal:${testPort}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('subagent delegation recursion limit rejects nested delegate calls', async () => {
  // Call delegate with subagentDepth >= 1
  const res = await runToolCall(
    { tool: 'delegate', task: 'nested subtask' },
    { subagentDepth: 1 },
  );
  const parsed = JSON.parse(res);
  assert.ok(parsed.error.includes('delegation recursion limit'));
});

test('takeSnapshot sets mode 0600 on snapshot content and meta files', () => {
  const ws = path.join(os.tmpdir(), `ruko-test-undo-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const testFile = path.join(ws, 'test.txt');
  writeFileSync(testFile, 'initial content');

  const undoDir = path.join(ws, '.ruko', 'undo');
  try {
    const snapshot = takeSnapshot(testFile, undoDir);
    const contentFile = path.join(undoDir, `${snapshot.id}.content`);
    const metaFile = path.join(undoDir, `${snapshot.id}.meta.json`);

    const statContent = statSync(contentFile);
    const statMeta = statSync(metaFile);

    // Check mode permissions (0o600 -> 0o100600)
    assert.equal(statContent.mode & 0o777, 0o600);
    assert.equal(statMeta.mode & 0o777, 0o600);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test('inferStepDescription recognizes delete_file, move_file, and web_fetch', () => {
  assert.equal(
    inferStepDescription([{ tool: 'delete_file', path: 'old.ts' }], 1),
    'Pengelolaan & reorganisasi berkas proyek',
  );
  assert.equal(
    inferStepDescription([{ tool: 'move_file', source: 'a.ts', target: 'b.ts' }], 2),
    'Pengelolaan & reorganisasi berkas proyek',
  );
  assert.equal(
    inferStepDescription([{ tool: 'web_fetch', url: 'https://example.com' }], 3),
    'Mengambil konten referensi web eksternal',
  );
});
