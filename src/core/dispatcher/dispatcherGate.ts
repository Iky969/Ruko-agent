/**
 * dispatcherGate.ts — F2-T1 (Fase 2, Blueprint v2.0.0)
 *
 * Dispatcher Gate Lock di Hulu Pipeline:
 * Gerbang evaluasi hulu paling awal pada dispatcher tool sebelum instruksi
 * diproses atau menyentuh sistem berkas / subprocess.
 *
 * Invarian (PROGRESS2.md / Blueprint DoD #1 & #2):
 *  1. Host-Governed Invariant: Seluruh mutasi disk dan eksekusi subprocess
 *     tertolak mekanis di level dispatcher selama Plan Mode aktif.
 *     Flag /yolo (approvalEnabled: false) terbukti TIDAK MAMPU membatalkan
 *     batasan plan mode ini.
 *  2. Kriptografi Kontrak Scope: Dalam mode 'act', mutasi berkas di luar
 *     subtree yang disetujui dievaluasi melalui ScopeAmendmentManager.
 *
 * ZERO dependency — hanya `node:*`.
 */

import { HostState } from '../state/hostState.js';
import { ScopeAmendmentManager } from '../approval/scopeAmendment.js';

export const MUTATION_AND_SUBPROCESS_TOOLS = new Set([
  'exec',
  'start_process',
  'write_file',
  'edit_file',
  'patch_file',
  'delete_file',
  'move_file',
  'revert_file',
  'remember',
  'save_skill',
  'delete_skill',
]);

/**
 * Research mode (mode cari bug): BACA + TEST, TANPA MUTASI.
 * Sama seperti plan mode, `exec` dikeluarkan dari set ini karena exec tidak
 * diblok mentah-mentah — exec dibatasi ke allowlist perintah test
 * (isResearchModeAllowedExec di bawah).
 */
export const RESEARCH_MODE_BLOCKED_TOOLS = new Set([
  'start_process',
  'write_file',
  'edit_file',
  'patch_file',
  'delete_file',
  'move_file',
  'revert_file',
  'remember',
  'save_skill',
  'delete_skill',
]);

/**
 * Perintah test yang diizinkan di research mode (exec). Dijalankan lewat
 * shell, jadi argumennya tetap diperiksa pola mutasi (lihat
 * RESEARCH_EXEC_FORBIDDEN_STRUCTURE / WORDS). Daftar ini sengaja eksplisit:
 * perintah di luar daftar ditolak, bukan diizinkan.
 */
const RESEARCH_TEST_COMMANDS: RegExp[] = [
  /^(npm|yarn|pnpm|bun)\s+test(?:\s|$)/,
  /^(npm|yarn|pnpm|bun)\s+run\s+test[\w:.-]*(?:\s|$)/,
  /^(npx|bunx)\s+(vitest|jest|mocha|ava|tap)(?:\s|$)/,
  /^pnpm\s+dlx\s+(vitest|jest|mocha|ava|tap)(?:\s|$)/,
  /^yarn\s+dlx\s+(vitest|jest|mocha|ava|tap)(?:\s|$)/,
  /^(vitest|jest|mocha|ava|tap)(?:\s|$)/,
  /^playwright\s+test(?:\s|$)/,
  /^cypress\s+run(?:\s|$)/,
  /^node\s+--test(?:\s|$)/,
  /^deno\s+test(?:\s|$)/,
  /^go\s+test(?:\s|$)/,
  /^cargo\s+test(?:\s|$)/,
  /^pytest(?:\s|$)/,
  /^python3?\s+-m\s+(pytest|unittest)(?:\s|$)/,
  /^(?:vendor\/bin\/)?phpunit(?:\s|$)/,
  /^(?:bundle\s+exec\s+)?rspec(?:\s|$)/,
  /^dotnet\s+test(?:\s|$)/,
  /^(?:\.\/)?(?:mvn|mvnw|gradle|gradlew)\s+test(?:\s|$)/,
  /^make\s+test(?:\s|$)/,
  /^ctest(?:\s|$)/,
  /^bats(?:\s|$)/,
];

/** Operator shell yang selalu berarti chaining / redirect / substitusi. */
const RESEARCH_EXEC_FORBIDDEN_STRUCTURE: RegExp[] = [
  /;/,
  />/,
  /</,
  /\|/,
  /&/,
  /`/,
  /\$\(/,
  /\$\{/,
  /\n/,
  /\r/,
];

/** Kata perintah mutasi / shell yang ditolak bila muncul sebagai token utuh. */
const RESEARCH_EXEC_FORBIDDEN_WORDS = new Set([
  'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'touch', 'chmod', 'chown', 'ln', 'tee',
  'sed', 'awk', 'git', 'curl', 'wget', 'sh', 'bash', 'zsh', 'powershell', 'cmd',
]);

export function isResearchModeBlockedTool(tool: string): boolean {
  return RESEARCH_MODE_BLOCKED_TOOLS.has(tool);
}

/**
 * Menilai apakah sebuah perintah exec boleh jalan di research mode.
 *
 * Aturan:
 *  1. Kupas prefix `cd <dir> &&` (sekali) dan assignment env `VAR=val`.
 *  2. Tolak operator struktur shell (chaining, redirect, pipe, substitusi).
 *  3. Tolak kata perintah mutasi sebagai token utuh (rm, git, curl, ...).
 *  4. Perintah inti harus cocok dengan allowlist perintah test.
 *
 * BATASAN (jujur, bukan klaim kedap): ini mencegah mutasi yang JELAS, bukan
 * sandbox. Script test proyek sendiri (`npm test` menjalankan script `test`
 * di package.json) tetap menjalankan kode apa pun — termasuk yang menulis
 * file — karena menjalankan test pada dasarnya mempercayai kode test itu.
 * Perintah test juga bisa menerima argumen file yang isinya kode arbitrer
 * (mis. `node --test evil.js`). Jangan pakai research mode sebagai pengganti
 * sandbox bila kode yang diuji tidak dipercaya.
 */
export function isResearchModeAllowedExec(
  command: string,
): { allowed: boolean; reason?: string } {
  const raw = (command ?? '').trim();
  if (!raw) {
    return { allowed: false, reason: 'research mode aktif: exec kosong — hanya perintah test yang boleh dijalankan.' };
  }

  // 1. Kupas prefix `cd <dir> &&` (sekali) dan assignment env.
  let rest = raw;
  const cdPrefix = rest.match(/^cd\s+[^\s;&|><`$]+?\s+&&\s+/);
  if (cdPrefix) {
    rest = rest.slice(cdPrefix[0].length);
  }
  rest = rest.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+/, '');
  // Prefix biner lokal yang umum.
  rest = rest.replace(/^\.\/node_modules\/\.bin\//, '');
  if (!rest) {
    return { allowed: false, reason: 'research mode aktif: exec hanya boleh menjalankan perintah test.' };
  }

  // 2. Tolak operator struktur shell di sisa perintah.
  for (const re of RESEARCH_EXEC_FORBIDDEN_STRUCTURE) {
    if (re.test(rest)) {
      return {
        allowed: false,
        reason:
          'research mode aktif: exec ditolak — operator shell (chaining / redirect / pipe / substitusi) tidak diizinkan; jalankan satu perintah test saja tanpa operator shell.',
      };
    }
  }

  // 3. Tolak kata perintah mutasi sebagai token utuh (cek basename tiap token
  // supaya path seperti test/sed.test.js tidak ikut terblokir — basename-nya
  // "sed.test.js", bukan "sed").
  const tokens = rest.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const base = token.replace(/^["']|["']$/g, '').split('/').pop() ?? '';
    if (RESEARCH_EXEC_FORBIDDEN_WORDS.has(base.toLowerCase())) {
      return {
        allowed: false,
        reason: `research mode aktif: exec ditolak — kata perintah "${base}" berpotensi mutasi dan tidak diizinkan di research mode.`,
      };
    }
  }

  // 4. Perintah inti harus ada di allowlist perintah test.
  for (const re of RESEARCH_TEST_COMMANDS) {
    if (re.test(rest)) {
      return { allowed: true };
    }
  }
  const short = rest.length > 80 ? `${rest.slice(0, 80)}…` : rest;
  return {
    allowed: false,
    reason:
      `research mode aktif: exec hanya boleh menjalankan perintah test (mis. npm test, npm run test:unit, npx vitest run, node --test, go test, cargo test, pytest). ` +
      `Perintah "${short}" tidak ada di allowlist — pindah ke /mode default bila perlu menjalankan perintah lain.`,
  };
}

export interface DispatcherGateOptions {
  tool: string;
  args?: Record<string, any>;
  hostState?: HostState | null;
  planMode?: boolean;
  /** Research mode (mode cari bug): baca + test saja, tanpa mutasi. */
  researchMode?: boolean;
  /** @deprecated Ignored compatibility field. Approval policy cannot bypass PLAN or scope; never read here. */
  yoloMode?: boolean;
  scopeManager?: ScopeAmendmentManager | null;
  isInteractive?: boolean;
  workspaceRoot?: string;
}

export interface DispatcherGateDecision {
  allowed: boolean;
  reason?: string;
}

export function isPlanModeBlockedTool(tool: string): boolean {
  return MUTATION_AND_SUBPROCESS_TOOLS.has(tool);
}

export async function evaluateDispatcherGate(
  opts: DispatcherGateOptions,
): Promise<DispatcherGateDecision> {
  const isPlanMode = opts.hostState ? opts.hostState.mode === 'plan' : Boolean(opts.planMode);

  // 1. Host-Governed Invariant (DoD #1):
  // Plan Mode memblokir mekanis seluruh mutasi disk dan eksekusi subprocess.
  // Flag /yolo (yoloMode: true / approvalEnabled: false) tidak dapat membypass ini.
  if (isPlanMode && isPlanModeBlockedTool(opts.tool)) {
    return {
      allowed: false,
      reason: `plan mode aktif: tool "${opts.tool}" diblok (hanya baca yang boleh). Matikan dengan /plan off setelah rencana disetujui.`,
    };
  }

  // 1b. Research mode (mode cari bug): baca + test saja, tanpa mutasi.
  // Penegakan di level kode seperti plan mode — bukan cuma prompt.
  if (opts.researchMode) {
    if (isResearchModeBlockedTool(opts.tool)) {
      return {
        allowed: false,
        reason: `research mode aktif: tool "${opts.tool}" diblok (mode cari bug: hanya baca + test, tanpa mutasi). Pindah ke /mode default untuk mengubah file.`,
      };
    }
    if (opts.tool === 'exec') {
      const verdict = isResearchModeAllowedExec(String(opts.args?.command ?? ''));
      if (!verdict.allowed) {
        return { allowed: false, reason: verdict.reason };
      }
    }
  }

  // 2. Evaluasi Scope Amendment jika ScopeAmendmentManager tersedia
  if (opts.scopeManager && isMutationTool(opts.tool)) {
    // Untuk move_file: periksa KEDUA sisi (source dan target) terhadap scope.
    // Fail-closed: jika salah satu di luar scope, tolak operasi.
    if (opts.tool === 'move_file') {
      const args = opts.args || {};
      // Match runToolCallRaw's aliases and precedence exactly: checking a
      // different alias would authorize a decoy instead of the executed path.
      const sourcePath = String(args.source ?? args.from ?? args.path ?? '');
      const targetPath = String(args.target ?? args.to ?? args.destination ?? '');

      if (sourcePath) {
        const sourceDecision = await opts.scopeManager.evaluateMutationDecision(
          sourcePath,
          opts.args?.reason || `move_file: pemeriksaan source`,
          Boolean(opts.isInteractive),
          { tool: opts.tool, args: opts.args },
        );
        if (!sourceDecision.allowed) return sourceDecision;
      }

      if (targetPath) {
        const targetDecision = await opts.scopeManager.evaluateMutationDecision(
          targetPath,
          opts.args?.reason || `move_file: pemeriksaan destination`,
          Boolean(opts.isInteractive),
          { tool: opts.tool, args: opts.args },
        );
        if (!targetDecision.allowed) return targetDecision;
      }
    } else {
      // Tool lain: periksa hanya target path
      const targetPath = extractTargetPath(opts.tool, opts.args || {});
      if (targetPath) {
        const decision = await opts.scopeManager.evaluateMutationDecision(
          targetPath,
          opts.args?.reason || `Mutasi berkas via ${opts.tool}`,
          Boolean(opts.isInteractive),
          // WP-05: binding persetujuan + tampilan fakta teknis memakai nama tool
          // dan muatan argumen asli (referensi, dibandingkan ulang pasca-konfirmasi).
          { tool: opts.tool, args: opts.args },
        );
        if (!decision.allowed) return decision;
      }
    }
  }

  return { allowed: true };
}

function isMutationTool(tool: string): boolean {
  return (
    tool === 'write_file' ||
    tool === 'edit_file' ||
    tool === 'patch_file' ||
    tool === 'delete_file' ||
    tool === 'move_file' ||
    tool === 'revert_file'
  );
}

function extractTargetPath(tool: string, args: Record<string, any>): string | null {
  if (tool === 'move_file') {
    return args.destination || args.targetPath || args.path || null;
  }
  // Issue #38-2: harus sama persis dengan alias precedence handler
  // (runToolCall): revert_file memakai `path ?? file ?? target`, tanpa ini
  // `{target}` lolos scope check (decoy alias, celah yang sama dengan move_file).
  return args.path || args.file || args.target || args.targetPath || null;
}
