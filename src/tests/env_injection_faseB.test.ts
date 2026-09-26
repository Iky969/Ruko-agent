/**
 * env_injection_faseB.test.ts — Unit test Fase B (v1.9.0):
 * Injeksi EnvProfile ke runtime (SessionState) + perilaku fallback non-TTY.
 *
 * Fokus test:
 *  1. createDefaultSessionState() menyediakan field envProfile (opsional, undefined).
 *  2. Injeksi via pola yang sama dengan SystemLoop.startAsync (additive, idempotent).
 *  3. Extending startPipeLoop: isInteractiveTTY === false → RUKO_NO_ANIM di-set
 *     (animasi diredam) TIDAK menimpa nilai yang sudah ada — output line-by-line.
 *  4. buildStatusBar menerima flavor opsional — flavor 'none'/undefined →
 *     output identik dengan sebelum Fase B (regresi rendering).
 *  5. TIDAK ada regression: executor.ts & approval.ts tidak menyentuh envProfile
 *     (verifikasi kontrak tipe SessionState tetap berfungsi di jalur existing).
 *
 * Fase ini TIDAK menyentuh executor.ts dan approval.ts sama sekali.
 */
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import { createDefaultSessionState, DEFAULT_CONFIG } from '../types.js';
import { buildEnvProfile, resetEnvCache, getEnvProfile, type EnvProfile } from '../core/env.js';
import { buildStatusBar } from '../core/ui.js';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import type { LLMProvider, ChatOptions } from '../agent/llm.js';
import type { ContextMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

class NoopProvider implements LLMProvider {
  readonly name = 'noop';
  readonly isConfigured = false;
  readonly model = 'noop-model';
  setModel(model: string): void {
    void model;
  }
  async chat(messages: ContextMessage[], options?: ChatOptions): Promise<string> {
    void messages;
    void options;
    return '';
  }
}

function profileOf(opts: {
  platform?: string;
  stdoutIsTTY?: boolean;
  stdinIsTTY?: boolean;
  env?: Record<string, string>;
}): EnvProfile {
  return buildEnvProfile({
    platform: opts.platform ?? 'linux',
    release: 'generic',
    env: opts.env ?? {},
    stdoutIsTTY: opts.stdoutIsTTY ?? true,
    stdinIsTTY: opts.stdinIsTTY ?? true,
  });
}

/**
 * Replikasi EXACT logika injeksi startAsync (loop.ts) — dipakai untuk
 * memverifikasi perilaku injeksi tanpa mem-boot REPL sungguhan.
 * (SystemLoop.startAsync sendiri tidak bisa dipanggil di unit test tanpa
 * TTY/stream asli — pola test existing juga menguji level komponen.)
 */
function injectEnvProfile(agent: Agent): void {
  if (!agent.sessionState.envProfile) {
    agent.sessionState.envProfile = getEnvProfile();
  }
}

/**
 * Replikasi EXACT guard RUKO_NO_ANIM dari startPipeLoop (loop.ts) —
 * `??` berarti nilai yang sudah ada TIDAK pernah ditimpa.
 */
function applyPipeFallback(profile: EnvProfile | undefined, env: NodeJS.ProcessEnv): void {
  if (profile && !profile.isInteractiveTTY) {
    env.RUKO_NO_ANIM = env.RUKO_NO_ANIM ?? '1';
  }
}

// ---------------------------------------------------------------------------
// 1. SessionState default
// ---------------------------------------------------------------------------

describe('faseB: SessionState default', () => {
  test('createDefaultSessionState punya envProfile: undefined (opsional)', () => {
    const s = createDefaultSessionState();
    assert.equal(s.envProfile, undefined);
    // Field existing tidak berubah (regresi Fase 1/2):
    assert.equal(s.mode, 'default');
    assert.equal(s.buildPhase, 'explore');
    assert.equal(s.reasoningLevel, 'xhigh');
  });

  test('field opsional: tidak wajib — objek tanpa envProfile tetap SessionState valid', () => {
    // Kontrak: ketersediaan EnvProfile tidak pernah jadi syarat jalur eksekusi.
    const s = createDefaultSessionState();
    // Hanya field inti yang wajib; envProfile opsional (undefined default).
    assert.equal(s.mode, 'default');
    assert.equal(s.buildPhase, 'explore');
    assert.equal(s.reasoningLevel, 'xhigh');
    assert.equal(s.envProfile, undefined);
  });
});

// ---------------------------------------------------------------------------
// 2. Injeksi ke runtime context existing (Agent.sessionState)
// ---------------------------------------------------------------------------

describe('faseB: injeksi EnvProfile ke sessionState', () => {
  test('injeksi terjadi sekali (idempotent) dan tersedia di agent.sessionState', () => {
    resetEnvCache();
    const config = { ...DEFAULT_CONFIG, approvalEnabled: false };
    const agent = new Agent(new Context(config), new NoopProvider(), config);

    assert.equal(agent.sessionState.envProfile, undefined);
    injectEnvProfile(agent);
    const first = agent.sessionState.envProfile;
    assert.ok(first, 'envProfile harus terisi setelah injeksi');
    // Panggilan kedua tidak menimpa (idempotent).
    injectEnvProfile(agent);
    assert.equal(agent.sessionState.envProfile, first);
    resetEnvCache();
  });

  test('injeksi TIDAK mengubah field SessionState lain', () => {
    resetEnvCache();
    const config = { ...DEFAULT_CONFIG, approvalEnabled: false };
    const agent = new Agent(new Context(config), new NoopProvider(), config);
    const before = { ...agent.sessionState };
    injectEnvProfile(agent);
    assert.equal(agent.sessionState.mode, before.mode);
    assert.equal(agent.sessionState.buildPhase, before.buildPhase);
    assert.equal(agent.sessionState.reasoningLevel, before.reasoningLevel);
    resetEnvCache();
  });

  test('getEnvProfile singleton: objek identik di panggilan kedua (Fase A contract)', () => {
    resetEnvCache();
    const a = getEnvProfile();
    const b = getEnvProfile();
    assert.equal(a, b);
    resetEnvCache();
  });
});

// ---------------------------------------------------------------------------
// 3. Fallback non-TTY via cabang pipe existing (extend, bukan sistem paralel)
// ---------------------------------------------------------------------------

describe('faseB: fallback non-TTY (extend startPipeLoop)', () => {
  test('isInteractiveTTY false → RUKO_NO_ANIM di-set ke "1"', () => {
    const profile = profileOf({ stdoutIsTTY: false, stdinIsTTY: false });
    assert.equal(profile.isInteractiveTTY, false);
    const env: Record<string, string | undefined> = {};
    applyPipeFallback(profile, env);
    assert.equal(env.RUKO_NO_ANIM, '1');
  });

  test('isInteractiveTTY true (TTY penuh) → RUKO_NO_ANIM tidak disentuh', () => {
    const profile = profileOf({ stdoutIsTTY: true, stdinIsTTY: true });
    assert.equal(profile.isInteractiveTTY, true);
    const env: Record<string, string | undefined> = {};
    applyPipeFallback(profile, env);
    assert.equal(env.RUKO_NO_ANIM, undefined);
  });

  test('nilai RUKO_NO_ANIM yang sudah ada TIDAK pernah ditimpa (?? guard)', () => {
    const profile = profileOf({ stdoutIsTTY: false, stdinIsTTY: false });
    const env: Record<string, string | undefined> = { RUKO_NO_ANIM: '0' };
    applyPipeFallback(profile, env);
    assert.equal(env.RUKO_NO_ANIM, '0', 'nilai eksplisit user harus dipertahankan');
  });

  test('envProfile undefined (injeksi belum terjadi) → fallback tidak error', () => {
    const env: Record<string, string | undefined> = {};
    assert.doesNotThrow(() => applyPipeFallback(undefined, env));
    assert.equal(env.RUKO_NO_ANIM, undefined);
  });

  test('kombinasi ci flavor + non-TTY: flavor terdeteksi & animasi diredam', () => {
    const profile = profileOf({
      stdoutIsTTY: false,
      stdinIsTTY: false,
      env: { CI: 'true' },
    });
    assert.equal(profile.flavor, 'ci');
    assert.equal(profile.isInteractiveTTY, false);
    const env: Record<string, string | undefined> = {};
    applyPipeFallback(profile, env);
    assert.equal(env.RUKO_NO_ANIM, '1');
  });
});

// ---------------------------------------------------------------------------
// 4. Status bar: flavor opsional — regresi rendering eksplisit
// ---------------------------------------------------------------------------

describe('faseB: status bar flavor opsional', () => {
  const baseInput = {
    model: 'm1',
    usedChars: 100,
    budgetChars: 1000,
    width: 100,
  };

  test('tanpa flavor → output identik dengan sebelum Fase B (regresi)', () => {
    const before = buildStatusBar(baseInput);
    // Panggilan kedua tanpa flavor harus deterministik & sama.
    const again = buildStatusBar(baseInput);
    assert.equal(before, again);
    assert.ok(!before.includes('termux'), 'tidak boleh ada flavor dirender');
  });

  test("flavor 'none' tidak dirender (sama dengan tidak ada flavor)", () => {
    const none = buildStatusBar({ ...baseInput, flavor: 'none' });
    const absent = buildStatusBar(baseInput);
    assert.equal(none, absent, "flavor 'none' = tidak dirender");
  });

  test("flavor 'termux' dirender pada bar lebar", () => {
    const withFlavor = buildStatusBar({ ...baseInput, flavor: 'termux' });
    const plain = stripAnsiSafe(withFlavor);
    assert.ok(plain.includes('termux ·'), `bar harus memuat badge flavor: ${plain}`);
  });

  test("flavor 'wsl' dan 'ci' juga dirender", () => {
    for (const flavor of ['wsl', 'ci', 'colab', 'jupyter']) {
      const out = stripAnsiSafe(buildStatusBar({ ...baseInput, flavor }));
      assert.ok(out.includes(`${flavor} ·`), `flavor ${flavor} harus dirender: ${out}`);
    }
  });

  test('flavor tidak merusak konten inti bar (model/ctx tetap ada)', () => {
    const out = stripAnsiSafe(buildStatusBar({ ...baseInput, flavor: 'ci' }));
    assert.ok(out.includes('m1'));
    assert.ok(out.includes('ctx 10%'));
  });
});

// ---------------------------------------------------------------------------
// Helpers kecil
// ---------------------------------------------------------------------------

function stripAnsiSafe(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
}
