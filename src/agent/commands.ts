import { existsSync } from 'node:fs';
import { Confirmer, guardedExecute } from '../core/approval.js';
import { join, relative as relativeFromCwd, resolve as resolvePath } from 'node:path';
import { Context } from '../core/context.js';
import { isPrivateOrLocalHost, saveConfig } from '../core/config.js';
import { execute } from '../core/executor.js';
import { promptSetup, SetupResult } from '../core/wizard.js';
import { bold, cyan, dim, formatDuration, formatK, green, renderBox, red, yellow } from '../core/ui.js';
import { listSnapshots, revertFile, undoLast } from '../core/undo.js';
import { exportSessionTrajectory, listSessions, loadSession, saveSession, searchSessions } from '../core/session.js';
import { checkMemoryWarning, clearMemory, hasMeaningfulMemory, readMemory } from '../core/memory.js';
import { assertInsideWorkspace, getWorkspaceRoot } from './tools.js';
import { AgentConfig, ProviderProfile, UiMode } from '../types.js';
import { ConnectionResult, LLMProvider } from './llm.js';
import { allRoles } from './roles.js';
import type { Agent } from './agent.js';

/** Loop internals a command may touch. */
export interface LoopHandle {
  stop: () => void;
  getSessionId: () => string | null;
  setSessionId: (id: string | null) => void;
}

/** Everything a slash command may need. */
export interface CommandEnv {
  ctx: Context;
  config: AgentConfig;
  llm: LLMProvider;
  /** Agent runtime (plan mode, active role) — available inside the REPL. */
  agent?: Agent;
  /** Approval prompt hook (from the loop's readline). */
  confirm: Confirmer;
  /** Asks a free-text question through the loop's readline (for `/config setup`). */
  ask?: (question: string) => Promise<string>;
  /** Masked free-text question (API key) — falls back to `ask` when absent (§5). */
  askSecret?: (question: string) => Promise<string>;
  /** Persists a config patch back to .ruko/config.json. */
  updateConfig: (patch: Partial<AgentConfig>) => void;
  handle: LoopHandle;
}

type CommandHandler = (args: string, env: CommandEnv) => Promise<void> | void;

interface CommandDef {
  name: string;
  aliases?: string[];
  help: string;
  /** Argument hint shown by autocomplete/`/help` (§3.19). */
  hint?: string;
  run: CommandHandler;
}

const COMMANDS: CommandDef[] = [
  {
    name: 'help',
    aliases: ['?'],
    help: 'Show this help.',
    run: () => {
      console.log(buildHelpText());
    },
  },
  {
    name: 'exit',
    aliases: ['quit'],
    help: 'Keluar (sesi disimpan otomatis).',
    run: (_args, env) => env.handle.stop(),
  },
  {
    name: 'login',
    help: 'Wizard provider: kredensial + tes koneksi langsung.',
    run: async (_args, env) => {
      await runSetupFlow(env);
    },
  },
  {
    name: 'new',
    aliases: ['reset'],
    help: 'Simpan sesi saat ini lalu mulai percakapan baru.',
    run: (_args, env) => {
      if (env.ctx.size > 0) {
        saveSession(env.ctx.toJSON(), undefined, env.handle.getSessionId() ?? undefined);
      }
      env.ctx.clear();
      env.handle.setSessionId(null);
      console.log('Percakapan baru dimulai (sesi sebelumnya tersimpan).');
    },
  },
  {
    name: 'sessions',
    help: 'Daftar sesi tersimpan.',
    run: () => {
      const dir = join(getWorkspaceRoot(), '.ruko', 'sessions');
      const sessions = listSessions(dir);
      if (sessions.length === 0) {
        console.log(renderBox('Sessions', ['(belum ada sesi tersimpan)']));
        return;
      }
      console.log(
        renderBox(
          'Sessions',
          sessions.map(
            (s) => `${s.id}  [${s.messageCount} msg, ${s.updatedAt.slice(0, 19)}]  ${s.title}`,
          ),
        ),
      );
    },
  },
  {
    name: 'search',
    help: 'Cari kata kunci lintas sesi tersimpan.',
    hint: '<query>',
    run: (args) => {
      const query = args.trim();
      if (!query) {
        console.log('Usage: /search <kata kunci>');
        return;
      }
      const dir = join(getWorkspaceRoot(), '.ruko', 'sessions');
      const results = searchSessions(query, dir, 5);
      if (results.length === 0) {
        console.log(renderBox('Search Sessions', [`Tidak ditemukan sesi yang cocok dengan "${query}"`]));
        return;
      }
      const lines: string[] = [];
      for (const r of results) {
        lines.push(`${bold(cyan(r.sessionId))}  [${r.messageCount} msg, ${r.updatedAt.slice(0, 19)}]  ${r.title}`);
        lines.push(`  ${dim(r.role)}: ${r.snippet}`);
        lines.push(`  → Untuk melanjutkan: /resume ${r.sessionId}`);
        lines.push('');
      }
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      console.log(renderBox(`Search: "${query}" (${results.length} hasil)`, lines));
    },
  },
  {
    name: 'resume',
    help: 'Lanjutkan sesi tersimpan.',
    hint: '<id>  (lihat /sessions)',
    run: (args, env) => {
      const id = args.trim();
      if (!id) {
        console.log(`Usage: /resume <session-id>  (contoh id: ${exampleSessionIds() || 'belum ada — lihat /sessions'})`);
        return;
      }
      const dir = join(getWorkspaceRoot(), '.ruko', 'sessions');
      const session = loadSession(id, dir);
      if (!session) {
        console.log(`Sesi tidak ditemukan: ${id}`);
        return;
      }
      if (env.ctx.size > 0) {
        saveSession(env.ctx.toJSON(), dir, env.handle.getSessionId() ?? undefined);
      }
      env.ctx.replace(session.messages);
      env.handle.setSessionId(session.id);
      console.log(`Sesi dimuat: ${session.title} (${session.messages.length} pesan).`);
    },
  },
  {
    name: 'export',
    help: 'Ekspor log giliran percakapan dan jejak tool sesi aktif.',
    hint: '[json|markdown]',
    run: (args, env) => {
      const trimmed = args.trim().toLowerCase();
      const format: 'jsonl' | 'md' =
        trimmed === 'markdown' || trimmed === 'md' ? 'md' : 'jsonl';
      if (env.ctx.size === 0) {
        console.log('Belum ada pesan dalam sesi aktif untuk diekspor.');
        return;
      }
      const res = exportSessionTrajectory(
        env.ctx.toJSON(),
        format,
        undefined,
        env.handle.getSessionId() ?? undefined,
      );
      console.log(`✔ Trajectory diekspor ke: ${res.filePath} (${res.entryCount} langkah)`);
    },
  },
  {
    name: 'clear',
    help: 'Hapus konteks percakapan saat ini.',
    run: (_args, env) => {
      const removed = env.ctx.size;
      env.ctx.clear();
      console.log(`Konteks dibersihkan (${removed} pesan dihapus).`);
    },
  },
  {
    name: 'compact',
    help: 'Paksa ringkas history lama sekarang (tanpa tunggu budget).',
    run: (_args, env) => {
      const before = env.ctx.totalChars;
      // Keep only the last 4 turns verbatim; fold the rest into the digest.
      const removed = env.ctx.compressNow(4);
      if (removed > 0) {
        console.log(green(`✔ History diringkas: ${before} → ${env.ctx.totalChars} chars (-${removed}).`));
      } else {
        console.log('(riwayat sudah cukup kecil / tidak bisa dikompres lagi)');
      }
    },
  },
  {
    name: 'plan',
    help: 'Mode rencana: hanya baca & usulkan, eksekusi diblokir di kode.',
    hint: 'on | off',
    run: (args, env) => {
      if (!env.agent) {
        console.log('Plan mode hanya tersedia di dalam REPL.');
        return;
      }
      const arg = args.trim().toLowerCase();
      const on = arg === 'on' || (arg === '' && !env.agent.planMode);
      env.agent.planMode = on;
      console.log(
        on
          ? yellow('PLAN MODE aktif — tool eksekusi/write diblok; model hanya boleh membaca & menyusun langkah. /plan off untuk lanjut.')
          : green('Plan mode dinonaktifkan — eksekusi normal.'),
      );
    },
  },
  {
    name: 'undo',
    help: 'Batalkan perubahan file (snapshot .ruko/undo atau git rollback).',
    hint: '[path-file]',
    run: (args, _env) => {
      const target = args.trim();
      if (target) {
        const ws = getWorkspaceRoot();
        const abs = resolvePath(ws, target);
        try {
          assertInsideWorkspace(abs, ws);
        } catch (err) {
          console.log(`(gagal membatalkan perubahan "${target}": ${err instanceof Error ? err.message : String(err)})`);
          return;
        }
        const result = revertFile(abs, { workspaceRoot: ws });
        if (!result.ok) {
          console.log(`(gagal membatalkan perubahan "${target}": ${result.error})`);
          return;
        }
        console.log(
          result.source === 'git'
            ? `↩ File dikembalikan ke versi git (git checkout): ${shortPath(result.restored!)}`
            : result.action === 'restored'
              ? `↩ File dikembalikan ke kondisi sebelum edit (snapshot): ${shortPath(result.restored!)}`
              : `↩ File baru hasil edit dihapus (snapshot): ${shortPath(result.restored!)}`,
        );
        return;
      }
      const result = undoLast();
      if (!result) {
        console.log('(tidak ada perubahan file yang bisa dibatalkan)');
        return;
      }
      console.log(
        result.action === 'restored'
          ? `↩ File dikembalikan ke kondisi sebelum edit: ${shortPath(result.restored)}`
          : `↩ File baru hasil edit terakhir dihapus: ${shortPath(result.restored)}`,
      );
      const remaining = listSnapshots().length;
      if (remaining > 0) console.log(dim(`  (${remaining} snapshot tersisa — /undo lagi untuk mundur lebih jauh)`));
    },
  },
  {
    name: 'role',
    help: 'Lihat/ganti role AI (default, reviewer, teacher, minimal, kustom).',
    hint: '[nama role]',
    run: (args, env) => {
      const roles = allRoles();
      const wanted = args.trim().toLowerCase();
      if (!wanted) {
        const active = env.config.role ?? 'default';
        console.log(
          renderBox(
            `Roles (aktif: ${active})`,
            roles.map((r) => `${r.name === active ? green('●') : '○'} ${r.name.padEnd(10)} ${r.description}`),
          ),
        );
        console.log(dim('Ganti: /role <nama> — role kustom: .ruko/roles/<nama>.md (frontmatter name/description).'));
        return;
      }
      const role = roles.find((r) => r.name === wanted);
      if (!role) {
        console.log(`Role tidak dikenal: ${wanted} — tersedia: ${roles.map((r) => r.name).join(', ')}`);
        return;
      }
      env.updateConfig({ role: role.name });
      console.log(`Role aktif: ${role.name} — ${role.description}`);
    },
  },
  {
    name: 'mode',
    help: 'Mode pengguna: beginner (guide penuh) atau pro (ringkas).',
    hint: 'beginner | pro',
    run: (args, env) => {
      const wanted = args.trim().toLowerCase() as UiMode | '';
      if (wanted !== 'beginner' && wanted !== 'pro') {
        console.log(`Mode aktif: ${(env.config.mode ?? 'beginner')}  — ganti: /mode beginner|pro`);
        return;
      }
      // §7: each mode ships sensible defaults; same engine, less/no training wheels.
      const patch: Partial<AgentConfig> = { mode: wanted };
      const current = env.config.role ?? 'default';
      if (wanted === 'beginner' && (current === 'default' || current === 'minimal')) patch.role = 'teacher';
      if (wanted === 'pro' && (current === 'default' || current === 'teacher')) patch.role = 'minimal';
      patch.funAnimations = wanted !== 'pro';
      env.updateConfig(patch);
      if (wanted === 'beginner') {
        // The beginner guide is rendered by the CLI through the SHARED box
        // helper (feedback v0.6.1 audit) — never left to the model to draw.
        console.log(
          renderBox('Mode BEGINNER aktif', [
            'Role: teacher — setiap langkah dijelaskan dengan bahasa sederhana.',
            'Konfirmasi penuh: perintah berisiko selalu ditanya dulu (y/N).',
            'Tips slash command aktif di setiap jawaban AI.',
            'Animasi Pac-Man thinking: aktif.',
            '',
            'Mulai cepat: /help daftar perintah · /undo batal edit terakhir · /mode pro untuk ringkas.',
          ]),
        );
      } else {
        console.log('Mode PRO: role minimal, spinner polos cepat, hanya aksi destruktif yang dikonfirmasi. (pemula: /mode beginner)');
      }
    },
  },
  {
    name: 'anim',
    help: 'Toggle animasi Pac-Man saat AI berpikir (on/off).',
    hint: '[on|off]',
    run: (args, env) => {
      const arg = args.trim().toLowerCase();
      let next: boolean;
      if (arg === 'on' || arg === 'true' || arg === '1') {
        next = true;
      } else if (arg === 'off' || arg === 'false' || arg === '0') {
        next = false;
      } else if (!arg) {
        const current = env.config.funAnimations ?? (env.config.mode !== 'pro');
        next = !current;
      } else {
        console.log('Usage: /anim  |  /anim on  |  /anim off');
        return;
      }
      env.updateConfig({ funAnimations: next });
      console.log(`Animasi Pac-Man ${next ? 'DIAKTIFKAN' : 'DIMATIKAN'}.`);
    },
  },
  {
    name: 'profile',
    help: 'Provider multi-profil: ganti cepat alias (hemat, kuat, lokal).',
    hint: '[alias]',
    run: async (args, env) => {
      const profiles = env.config.profiles ?? {};
      const alias = args.trim();
      const names = Object.keys(profiles);
      if (!alias) {
        const active = env.config.activeProfile ?? env.config.defaultProfile;
        if (names.length === 0) {
          console.log('(belum ada profil — tambahkan lewat .ruko/config.json → "profiles": { "hemat": { "baseUrl": ..., "model": ..., "apiKeyEnv": ... } })');
          return;
        }
        console.log(
          renderBox(
            `Profiles (aktif: ${active ?? '(top-level)'} )`,
            names.map((n) => `${n === active ? green('●') : '○'} ${n.padEnd(10)} ${describeProfile(profiles[n])}`),
          ),
        );
        console.log(dim('Ganti: /profile <alias>  |  /model untuk daftar model.'));
        return;
      }
      const profile = profiles[alias];
      if (!profile) {
        console.log(`Profil tidak dikenal: ${alias} — tersedia: ${names.join(', ')}`);
        return;
      }
      applyProfile(env, alias, profile);
    },
  },
  {
    name: 'exec',
    help: 'Jalankan perintah shell (output di-summarize otomatis).',
    hint: '<command>',
    run: async (args, env) => {
      if (!args) {
        console.log('Usage: /exec <command>');
        return;
      }
      const result = await guardedExecute(
        args,
        { timeoutMs: env.config.execTimeoutMs, confirm: env.confirm, llmProvider: env.llm },
        env.config,
      );
      console.log(result.output || '(no output)');
      console.log(
        `\n[exit code: ${result.code ?? 'killed'} | ${result.durationMs}ms` +
          `${result.truncated ? ' | output truncated' : ''}]`,
      );
    },
  },
  {
    name: 'history',
    help: 'Tampilkan n pesan konteks terakhir (default 5).',
    hint: '[n]',
    run: (args, env) => {
      const n = Math.min(parseInt(args, 10) || 5, 50);
      const messages = env.ctx.toJSON().slice(-n);
      if (messages.length === 0) {
        console.log('(kosong)');
        return;
      }
      for (const m of messages) {
        console.log(`[${m.role}] ${m.content.split('\n')[0].slice(0, 140)}`);
      }
    },
  },
  {
    name: 'context',
    help: 'Lihat statistik atau ubah budget konteks (/context set <jumlah>).',
    hint: '[set <jumlah>]',
    run: (args, env) => {
      const trimmed = args.trim();
      if (!trimmed) {
        console.log(
          renderBox('Context', [
            `messages: ${env.ctx.size}`,
            `total chars: ${env.ctx.totalChars} (budget: ${env.config.maxContextChars})`,
            `log summarizer threshold: ${env.config.maxLogChars} chars`,
            `exec timeout: ${env.config.execTimeoutMs}ms`,
          ]),
        );
        return;
      }

      const match = trimmed.match(/^set(?:\s+(.+))?$/i);
      if (match) {
        const valStr = match[1]?.trim();
        if (!valStr) {
          console.log('Penggunaan: /context set <jumlah>');
          return;
        }
        let newLimit: number;
        if (/^\d+[kK]$/.test(valStr)) {
          newLimit = parseInt(valStr.slice(0, -1), 10) * 1_000;
        } else {
          newLimit = Number(valStr.replace(/_/g, ''));
        }

        if (!Number.isFinite(newLimit) || newLimit <= 0 || !Number.isInteger(newLimit)) {
          console.log('Error: nilai limit context harus berupa angka positif dalam satuan karakter.');
          return;
        }

        if (newLimit < env.ctx.totalChars) {
          console.log(
            `Error: nilai baru (${newLimit} karakter) tidak boleh lebih rendah dari jumlah karakter aktif (${env.ctx.totalChars} karakter).`,
          );
          return;
        }

        env.updateConfig({ maxContextChars: newLimit });
        console.log(green(`✔ Limit context aktif diperbarui menjadi ${newLimit} karakter.`));
        return;
      }

      console.log('Penggunaan: /context  |  /context set <jumlah>');
    },
  },
  {
    name: 'settings',
    aliases: ['setting', 'set'],
    help: 'Dashboard konfigurasi: lihat & ubah budget context, max token, model, role, approval, dan mode.',
    hint: '[context|max-tokens|role|mode|approval|anim|save] [nilai]',
    run: async (args, env) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase();
      const val = parts.slice(1).join(' ').trim();

      if (!sub) {
        const budgetChars = env.config.maxContextChars;
        const budgetTokens = Math.round(budgetChars / 4);
        const usedChars = env.ctx.totalChars;
        const usedTokens = Math.round(usedChars / 4);
        const pct = budgetChars > 0 ? Math.min(100, Math.round((usedChars / budgetChars) * 100)) : 0;
        const maxOut = env.config.maxOutputTokens ?? 4096;

        const lines = [
          `MODEL & PROVIDER:`,
          `  • Model:            ${env.llm.model || '(belum dikonfigurasi)'}`,
          `  • Provider:         ${env.llm.name} ${env.config.baseUrl ? `(${env.config.baseUrl})` : ''}`,
          `  • Profile:          ${env.config.activeProfile || env.config.defaultProfile || 'default'}`,
          ``,
          `TOKEN & CONTEXT BUDGET:`,
          `  • Context Window:   ${budgetChars.toLocaleString()} chars (~${budgetTokens.toLocaleString()} tokens)`,
          `  • Status Konteks:   ${usedChars.toLocaleString()} chars (~${usedTokens.toLocaleString()} tokens) — ${pct}% terpakai`,
          `  • Max Output:       ${maxOut.toLocaleString()} tokens per-turn (max_tokens)`,
          ``,
          `BEHAVIOR & SAFETY:`,
          `  • Role:             ${env.config.role ?? 'default'}`,
          `  • Mode:             ${env.config.mode ?? 'beginner'}`,
          `  • Approval Gate:    ${env.config.approvalEnabled ? 'ON (konfirmasi perintah berisiko)' : 'OFF (YOLO mode)'}`,
          `  • Exec Timeout:     ${Math.round(env.config.execTimeoutMs / 1000)} detik`,
          `  • Fun Animations:   ${env.config.funAnimations ?? true ? 'ON (Pac-Man spinner)' : 'OFF'}`,
          `───────────────────────────────────────────────────────`,
          `Ubah pengaturan dengan perintah:`,
          `  • /settings context <128k|500k|unlimited>   Atur limit context window`,
          `  • /settings max-tokens <jumlah|4096>       Atur limit token output per-turn`,
          `  • /settings role <default|reviewer|teacher> Atur peran aktif`,
          `  • /settings mode <beginner|pro>             Ganti mode UI`,
          `  • /settings approval <on|off|yolo>          Atur konfirmasi perintah`,
          `  • /settings anim <on|off>                   Animasi berpikir Pac-Man`,
          `  • /settings save                            Simpan ke .ruko/config.json`,
        ];

        console.log(renderBox('Settings & Configuration Dashboard', lines));
        return;
      }

      if (sub === 'context' || sub === 'ctx') {
        if (!val) {
          const activeTokens = Math.round(env.ctx.totalChars / 4);
          const budgetTokens = Math.round(env.config.maxContextChars / 4);
          console.log(
            renderBox('Context Budget', [
              `Karakter aktif: ${env.ctx.totalChars.toLocaleString()} chars (~${activeTokens.toLocaleString()} tokens)`,
              `Budget limit: ${env.config.maxContextChars.toLocaleString()} chars (~${budgetTokens.toLocaleString()} tokens)`,
              `Penggunaan: ${Math.round((env.ctx.totalChars / Math.max(env.config.maxContextChars, 1)) * 100)}%`,
              `Hint: /settings context <128k|500k|unlimited|angka>`,
            ]),
          );
          return;
        }
        if (val.toLowerCase() === 'unlimited' || val.toLowerCase() === 'inf' || val.toLowerCase() === 'bebas') {
          const unlimitedChars = 2_000_000;
          env.updateConfig({ maxContextChars: unlimitedChars });
          console.log(green(`✔ Context window diatur bebas/unlimited (~${Math.round(unlimitedChars / 4).toLocaleString()} token / ${unlimitedChars.toLocaleString()} karakter).`));
          return;
        }
        let tokens: number;
        if (/^\d+[kK]$/.test(val)) {
          tokens = parseInt(val.slice(0, -1), 10) * 1_000;
        } else if (/^\d+[mM]$/.test(val)) {
          tokens = parseInt(val.slice(0, -1), 10) * 1_000_000;
        } else {
          tokens = Number(val.replace(/_/g, ''));
        }
        if (!Number.isFinite(tokens) || tokens <= 0) {
          console.log('Error: nilai context harus berupa angka positif (contoh: /settings context 128k, /settings context 500k, atau unlimited).');
          return;
        }
        const newChars = (val.endsWith('k') || val.endsWith('K') || val.endsWith('m') || val.endsWith('M'))
          ? tokens * 4
          : (tokens < 50_000 ? tokens * 4 : tokens);
        if (newChars < env.ctx.totalChars) {
          console.log(
            `Error: budget ${newChars.toLocaleString()} karakter tidak boleh lebih rendah dari jumlah karakter aktif saat ini (${env.ctx.totalChars.toLocaleString()} karakter / ~${Math.round(env.ctx.totalChars / 4).toLocaleString()} token).`,
          );
          return;
        }
        env.updateConfig({ maxContextChars: newChars });
        console.log(green(`✔ Limit context window diperbarui menjadi ${newChars.toLocaleString()} karakter (~${Math.round(newChars / 4).toLocaleString()} token).`));
        return;
      }

      if (sub === 'max-tokens' || sub === 'maxtokens' || sub === 'tokens' || sub === 'output') {
        if (!val) {
          console.log(`Max output tokens saat ini: ${env.config.maxOutputTokens ?? 4096} token.`);
          console.log(`Gunakan: /settings max-tokens <jumlah> (contoh: /settings max-tokens 4096)`);
          return;
        }
        let count = Number(val.replace(/[kK]/, '000'));
        if (!Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) {
          console.log('Error: nilai max-tokens harus berupa bilangan bulat positif (contoh: 2048, 4096, 8192).');
          return;
        }
        env.updateConfig({ maxOutputTokens: count });
        console.log(green(`✔ Max output tokens per-turn diperbarui menjadi ${count.toLocaleString()} token.`));
        return;
      }

      if (sub === 'role') {
        if (!val) {
          console.log(`Peran aktif saat ini: ${env.config.role ?? 'default'}.`);
          console.log(`Pilihan: default, reviewer, teacher, minimal`);
          return;
        }
        const allowedRoles = ['default', 'reviewer', 'teacher', 'minimal'];
        const chosen = val.toLowerCase();
        if (!allowedRoles.includes(chosen)) {
          console.log(`Error: peran tidak dikenal "${val}". Pilihan: ${allowedRoles.join(', ')}`);
          return;
        }
        env.updateConfig({ role: chosen });
        console.log(green(`✔ Peran aktif diubah menjadi "${chosen}".`));
        return;
      }

      if (sub === 'mode') {
        if (!val) {
          console.log(`Mode UI saat ini: ${env.config.mode ?? 'beginner'}. Pilihan: beginner, pro`);
          return;
        }
        const chosen = val.toLowerCase();
        if (chosen !== 'beginner' && chosen !== 'pro') {
          console.log('Error: mode hanya dapat berupa "beginner" atau "pro".');
          return;
        }
        env.updateConfig({ mode: chosen as UiMode });
        console.log(green(`✔ Mode UI diubah menjadi "${chosen}".`));
        return;
      }

      if (sub === 'approval') {
        const v = val.toLowerCase();
        if (v === 'on' || v === '1' || v === 'true') {
          env.updateConfig({ approvalEnabled: true });
          console.log(green('✔ Approval gate diaktifkan (perintah berisiko memerlukan konfirmasi).'));
        } else if (v === 'off' || v === 'yolo' || v === '0' || v === 'false') {
          env.updateConfig({ approvalEnabled: false });
          console.log(yellow('⚠ Approval gate dinonaktifkan (YOLO mode aktif — perintah berisiko langsung dieksekusi).'));
        } else {
          console.log('Gunakan: /settings approval <on|off|yolo>');
        }
        return;
      }

      if (sub === 'anim') {
        const v = val.toLowerCase();
        if (v === 'on' || v === '1' || v === 'true') {
          env.updateConfig({ funAnimations: true });
          console.log(green('✔ Animasi terminal (Pac-Man spinner) diaktifkan.'));
        } else if (v === 'off' || v === '0' || v === 'false') {
          env.updateConfig({ funAnimations: false });
          console.log(green('✔ Animasi terminal dinonaktifkan (spinner titik minimalis).'));
        } else {
          console.log('Gunakan: /settings anim <on|off>');
        }
        return;
      }

      if (sub === 'save') {
        const ws = getWorkspaceRoot();
        const configPath = join(ws, '.ruko', 'config.json');
        saveConfig(env.config, configPath);
        console.log(green(`✔ Konfigurasi aktif disimpan ke ${configPath}.`));
        return;
      }

      console.log(`Perintah settings tidak dikenal: "${sub}". Ketik /settings untuk melihat daftar opsi.`);
    },
  },
  {
    name: 'setctx',
    help: 'Atur batas karakter context window (/setctx <jumlah_karakter|50k>).',
    hint: '[jumlah|50k]',
    run: (args, env) => {
      const trimmed = args.trim();
      if (!trimmed) {
        console.log(
          renderBox('Context Budget', [
            `Karakter aktif: ${env.ctx.totalChars} chars`,
            `Budget limit: ${env.config.maxContextChars} chars (~${Math.round(env.config.maxContextChars / 4)} tokens)`,
            `Penggunaan: ${Math.round((env.ctx.totalChars / Math.max(env.config.maxContextChars, 1)) * 100)}%`,
            `Hint: /settings context <128k|500k|unlimited> atau /setctx <angka|50k>`,
          ]),
        );
        return;
      }

      let newLimit: number;
      if (/^\d+[kK]$/.test(trimmed)) {
        newLimit = parseInt(trimmed.slice(0, -1), 10) * 1_000;
      } else {
        newLimit = Number(trimmed.replace(/_/g, ''));
      }

      if (!Number.isFinite(newLimit) || newLimit <= 0 || !Number.isInteger(newLimit)) {
        console.log('Error: nilai limit context harus berupa angka positif dalam satuan karakter (contoh: /setctx 50k atau /setctx 80000).');
        return;
      }

      if (newLimit < env.ctx.totalChars) {
        console.log(
          `Error: nilai baru (${newLimit} karakter) tidak boleh lebih rendah dari jumlah karakter aktif (${env.ctx.totalChars} karakter).`,
        );
        return;
      }

      env.updateConfig({ maxContextChars: newLimit });
      console.log(green(`✔ Limit context window diperbarui menjadi ${newLimit} karakter (~${Math.round(newLimit / 4)} token).`));
    },
  },
  {
    name: 'settoken',
    help: 'Atur budget context window berdasarkan estimasi token (/settoken <token|16k>).',
    hint: '[token|16k]',
    run: (args, env) => {
      const trimmed = args.trim();
      if (!trimmed) {
        const activeTokens = Math.round(env.ctx.totalChars / 4);
        const budgetTokens = Math.round(env.config.maxContextChars / 4);
        console.log(
          renderBox('Token Budget (1 token ≈ 4 chars)', [
            `Estimasi token aktif: ~${activeTokens} tokens (${env.ctx.totalChars} chars)`,
            `Budget token: ~${budgetTokens} tokens (${env.config.maxContextChars} chars)`,
            `Penggunaan: ${Math.round((env.ctx.totalChars / Math.max(env.config.maxContextChars, 1)) * 100)}%`,
            `Hint: /settings context <token|16k> atau /settoken 16k`,
          ]),
        );
        return;
      }

      let tokens: number;
      if (/^\d+[kK]$/.test(trimmed)) {
        tokens = parseInt(trimmed.slice(0, -1), 10) * 1_000;
      } else {
        tokens = Number(trimmed.replace(/_/g, ''));
      }

      if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isInteger(tokens)) {
        console.log('Error: nilai token harus berupa angka positif (contoh: /settoken 16k atau /settoken 32000).');
        return;
      }

      const newChars = tokens * 4;
      if (newChars < env.ctx.totalChars) {
        console.log(
          `Error: budget ${tokens} token (${newChars} karakter) tidak boleh lebih rendah dari jumlah karakter aktif saat ini (${env.ctx.totalChars} karakter / ~${Math.round(env.ctx.totalChars / 4)} token).`,
        );
        return;
      }

      env.updateConfig({ maxContextChars: newChars });
      console.log(green(`✔ Budget context window diperbarui menjadi ${tokens} token (${newChars} karakter, rasio 1 token ≈ 4 karakter).`));
    },
  },
  {
    name: 'ctx',
    aliases: ['status'],
    help: 'Lihat limit context aktif, token budget, dan persentase penggunaan saat ini.',
    run: (_args, env) => {
      const budgetChars = env.config.maxContextChars;
      const budgetTokens = Math.round(budgetChars / 4);
      const usedChars = env.ctx.totalChars;
      const usedTokens = Math.round(usedChars / 4);
      const pct = budgetChars > 0 ? Math.min(100, Math.round((usedChars / budgetChars) * 100)) : 0;
      const ws = getWorkspaceRoot();
      const cfgPath = join(ws, '.ruko', 'config.json');
      const isPersistent = existsSync(cfgPath);

      console.log(
        renderBox('Context Budget & Status Aktif', [
          `Model aktif: ${env.llm.model} (${env.llm.name})`,
          `Context window limit aktif: ${budgetChars.toLocaleString()} karakter (~${formatK(budgetChars)})`,
          `Token budget aktif: ~${budgetTokens.toLocaleString()} tokens (1 token ≈ 4 karakter)`,
          `Karakter aktif saat ini: ${usedChars.toLocaleString()} chars (~${usedTokens.toLocaleString()} tokens) — ${pct}%`,
          `Pesan dalam konteks: ${env.ctx.size} pesan`,
          `Status konfigurasi: ${isPersistent ? 'Tersimpan di .ruko/config.json (survive lintas sesi)' : 'Menggunakan nilai default sesi (belum disimpan)'}`,
          `───────────────────────────────────────────────────────`,
          `Hint: Atur budget dengan /settings context <128k|500k|unlimited>`,
        ]),
      );
    },
  },
  {
    name: 'memory',
    help: 'Lihat isi persistent memory (.ruko/memory.md) atau reset.',
    hint: '[clear]',
    run: (args) => {
      const ws = getWorkspaceRoot();
      const sub = args.trim().toLowerCase();
      if (sub === 'clear') {
        clearMemory(ws);
        console.log(green('✔ Persistent memory telah dibersihkan (.ruko/memory.md di-reset).'));
        return;
      }
      if (sub && sub !== '') {
        console.log('Usage: /memory  |  /memory clear');
        return;
      }
      const raw = readMemory(ws);
      if (!raw || !hasMeaningfulMemory(raw)) {
        console.log(
          renderBox('Persistent Memory', [
            '(belum ada catatan tersimpan)',
            dim('Gunakan tool remember atau edit .ruko/memory.md secara manual.'),
          ]),
        );
        return;
      }
      const lines = raw.trim().split('\n');
      console.log(renderBox('Persistent Memory (.ruko/memory.md)', lines));
      const warn = checkMemoryWarning(ws);
      if (warn) {
        console.log(yellow(`⚠ ${warn}`));
      } else {
        console.log(dim(`Ukuran: ${raw.length} karakter — ketik /memory clear untuk reset`));
      }
    },
  },
  {
    name: 'usage',
    aliases: ['stats', 'tokens'],
    help: 'Statistik pemakaian sesi (context window, model, akumulasi token sesi).',
    hint: '[clear]',
    run: (args, env) => {
      const sub = args.trim().toLowerCase();
      if (sub === 'clear' || sub === 'reset') {
        env.agent?.resetSessionUsage();
        console.log(green('✔ Statistik pemakaian token sesi telah di-reset ke 0.'));
        return;
      }

      const budget = env.config.maxContextChars;
      const used = env.ctx.totalChars;
      const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
      const activeCtxTokens = Math.round(used / 4);
      const budgetTokens = Math.round(budget / 4);

      const s = env.agent?.sessionUsage;
      const totalPromptTokens = s?.promptTokens ?? 0;
      const totalCompTokens = s?.completionTokens ?? 0;
      const totalCacheTokens = s?.cacheTokens ?? 0;
      const totalTokens = s?.totalTokens ?? 0;
      const totalTurns = s?.totalTurns ?? 0;
      const activeMs = s?.activeWorkingMs ?? 0;
      const avgMs = totalTurns > 0 ? activeMs / totalTurns : 0;

      const lines = [
        `model: ${env.llm.model || '(none)'} (${env.llm.name})`,
        `role: ${env.config.role ?? 'default'}  |  mode: ${env.config.mode ?? 'beginner'}`,
        `backend: ${env.llm.isConfigured ? 'LLM mode' : 'manual mode'}`,
        `messages: ${env.ctx.size} pesan`,
        `context window: ${used.toLocaleString()}/${budget.toLocaleString()} chars (${pct}%) ~${activeCtxTokens.toLocaleString()}/${budgetTokens.toLocaleString()} tokens`,
        `session id: ${env.handle.getSessionId() ?? '(belum disimpan)'}`,
        `───────────────────────────────────────────────────────`,
        `WAKTU KERJA AKTIF AGENT:`,
        `  • Total waktu kerja:  ${formatDuration(activeMs)} (${totalTurns} turn)`,
        `  • Rata-rata per turn: ${totalTurns > 0 ? formatDuration(avgMs) : '-'}`,
        `───────────────────────────────────────────────────────`,
        `total token sesi ini (${totalTurns} turn):`,
        `  ↑ prompt:     ~${totalPromptTokens} tokens (${formatK(s?.promptChars ?? 0)} chars)`,
        `  ⚡ cache:      ~${totalCacheTokens} tokens`,
        `  ↓ completion: ~${totalCompTokens} tokens (${formatK(s?.completionChars ?? 0)} chars)`,
        `  Σ total:      ~${totalTokens} tokens (rasio estimasi 1 token ≈ 4 chars)`,
      ];

      const u = env.agent?.lastUsage;
      if (u && (u.promptChars > 0 || u.completionChars > 0)) {
        const uPromptTok = Math.round(u.promptChars / 4);
        const uCompTok = Math.round(u.completionChars / 4);
        const uDur = u.durationMs ? `⏱ ${formatDuration(u.durationMs)} · ` : '';
        lines.push(
          `turn terakhir: ${uDur}↑ ${formatK(u.promptChars)} chars (~${uPromptTok} tok) · ↓ ${formatK(u.completionChars)} chars (~${uCompTok} tok)`,
        );
      }

      console.log(renderBox('Usage & Token Statistics', lines));
    },
  },
  {
    name: 'config',
    help: 'Tampilkan / ubah konfigurasi (.ruko/config.json).',
    hint: '[set <k> <v> | setup]',
    run: async (args, env) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length === 0 || parts[0] === '') {
        const c = env.config;
        const key = maskApiKey(c.apiKey);
        console.log(
          renderBox('Config', [
            `apiKey: ${key}`,
            `baseUrl: ${maskBaseUrl(c)}`,
            `maxLogChars: ${c.maxLogChars}`,
            `maxContextChars: ${c.maxContextChars}`,
            `execTimeoutMs: ${c.execTimeoutMs}`,
            `approvalEnabled: ${c.approvalEnabled}`,
            `approvalAllowlist: ${c.approvalAllowlist.length > 0 ? c.approvalAllowlist.join(', ') : '(kosong)'}`,
            `model: ${c.model}`,
            `funAnimations: ${c.funAnimations ?? (c.mode !== 'pro')}`,
            `mode: ${c.mode ?? 'beginner'}  |  role: ${c.role ?? 'default'}  |  profile: ${c.activeProfile ?? c.defaultProfile ?? '(none)'}`,
            dim('Ubah: /login (wizard) atau /config set <key> <value>'),
          ]),
        );
        return;
      }
      if (parts[0] === 'setup') {
        await runSetupFlow(env);
        return;
      }
      if (parts[0] === 'set' && parts.length >= 3) {
        const key = parts[1];
        const value = parts.slice(2).join(' ');
        await applyConfigPatch(env, key, value);
      } else {
        console.log('Usage: /config  |  /config set <key> <value>  |  /config setup (wizard)');
      }
    },
  },
  {
    name: 'model',
    help: 'Lihat model aktif + daftar model, atau ganti.',
    hint: '[nama]',
    run: async (args, env) => {
      const name = args.trim();
      if (!name) {
        console.log(`provider: ${env.llm.name}`);
        console.log(`model: ${env.llm.model}`);
        const profiles = Object.keys(env.config.profiles ?? {});
        if (profiles.length > 0) {
          console.log(dim(`profil tersimpan: ${profiles.join(', ')} — /profile <alias> untuk pindah`));
        }
        // §2: auto-fetch the endpoint's model list — never type names by heart.
        if (env.llm.isConfigured && env.llm.listModels) {
          try {
            const models = await env.llm.listModels();
            if (models.length > 0) {
              const shown = models.slice(0, 20);
              console.log(
                renderBox(`Models (${models.length}${models.length > shown.length ? ', 20 pertama' : ''})`, shown),
              );
              console.log(dim('Ganti: /model <nama>'));
            }
          } catch (err) {
            console.log(dim(`(daftar model tidak tersedia: ${err instanceof Error ? err.message : String(err)})`));
          }
        }
        return;
      }
      env.llm.setModel(name);
      env.updateConfig({ model: name });
      console.log(`Model diganti: ${name}`);
    },
  },
];

export function maskApiKey(apiKey?: string): string {
  if (!apiKey || apiKey.trim().length === 0) return '•••••• (belum diatur)';
  const k = apiKey.trim();
  if (k.length <= 8) return '•••••••• (masked)';
  if (k.length <= 14) return `${k.slice(0, 2)}…${k.slice(-2)} (masked)`;
  return `${k.slice(0, 3)}…${k.slice(-4)} (masked)`;
}

function maskBaseUrl(c: AgentConfig): string {
  if (c.baseUrl && c.baseUrl.trim()) return c.baseUrl;
  const fromEnv = process.env.OPENAI_BASE_URL;
  return fromEnv ? `${fromEnv} (env)` : '(belum diatur — jalankan /login)';
}

function exampleSessionIds(): string {
  return listSessions()[0]?.id ?? '';
}

function shortPath(abs: string): string {
  const rel = relativeFromCwd(process.cwd(), abs);
  return rel && !rel.startsWith('..') ? rel : abs;
}

function describeProfile(p: ProviderProfile): string {
  const bits: string[] = [];
  if (p.model) bits.push(p.model);
  if (p.baseUrl) bits.push(p.baseUrl);
  if (p.apiKeyEnv) bits.push(`key:$${p.apiKeyEnv}`);
  return bits.join('  ') || '(kosong)';
}

/** Applies a provider profile live: credentials + model + persist alias. */
function applyProfile(env: CommandEnv, alias: string, profile: ProviderProfile): void {
  const apiKey = (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : profile.apiKey) ?? '';
  if (profile.baseUrl || apiKey) {
    env.llm.setCredentials?.(apiKey || (env.config.apiKey ?? ''), profile.baseUrl ?? (env.config.baseUrl ?? ''));
  }
  if (profile.model) env.llm.setModel(profile.model);
  env.updateConfig({
    activeProfile: alias,
    ...(apiKey ? { apiKey } : {}),
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    ...(profile.model ? { model: profile.model } : {}),
  });
  console.log(`✔ Profil aktif: ${alias} (${describeProfile(profile)})`);
}

/** Shared wizard flow for `/login` and `/config setup` (§2: test right away). */
async function runSetupFlow(env: CommandEnv): Promise<void> {
  if (!env.ask) {
    console.log(yellow('Interactive setup butuh terminal TTY. Set lewat env atau edit .ruko/config.json langsung.'));
    return;
  }
  const probe = async (r: SetupResult): Promise<ConnectionResult> => {
    const { OpenAiCompatibleProvider } = await import('./llm.js');
    return new OpenAiCompatibleProvider({ apiKey: r.apiKey, baseUrl: r.baseUrl, model: r.model })
      .testConnection();
  };
  const result = await promptSetup({ question: env.ask, readSecret: env.askSecret }, { probe });
  if (!result) return;
  env.llm.setCredentials?.(result.apiKey, result.baseUrl);
  env.llm.setModel(result.model);
  env.updateConfig({ apiKey: result.apiKey, baseUrl: result.baseUrl, model: result.model, activeProfile: undefined });
  console.log(`Konfigurasi tersimpan: baseUrl=${result.baseUrl}, model=${result.model} (API key di-mask).`);
}

async function applyConfigPatch(env: CommandEnv, key: string, value: string): Promise<void> {
  const patch: Partial<AgentConfig> = {};
  switch (key) {
    case 'maxLogChars':
    case 'maxContextChars':
    case 'execTimeoutMs': {
      const n = parseInt(value, 10);
      if (Number.isNaN(n) || n <= 0) {
        console.log(`Nilai tidak valid untuk ${key}: ${value}`);
        return;
      }
      patch[key] = n;
      break;
    }
    case 'approvalEnabled':
      if (!/^(true|false|1|0)$/i.test(value)) {
        console.log('Nilai harus true/false');
        return;
      }
      patch.approvalEnabled = /^(true|1)$/i.test(value);
      break;
    case 'funAnimations':
      if (!/^(true|false|1|0)$/i.test(value)) {
        console.log('Nilai harus true/false');
        return;
      }
      patch.funAnimations = /^(true|1)$/i.test(value);
      break;
    case 'apiKey':
      patch.apiKey = value;
      env.llm.setCredentials?.(value, env.config.baseUrl ?? '');
      break;
    case 'baseUrl': {
      const trimmedVal = value.trim();
      const allowInsecure = /--(?:insecure|force|allow-http)\b/i.test(trimmedVal);
      const cleanUrl = trimmedVal.replace(/--(?:insecure|force|allow-http)\b/gi, '').trim();

      try {
        const parsed = new URL(cleanUrl);
        const isHttp = parsed.protocol === 'http:';
        const isHttps = parsed.protocol === 'https:';
        if (!isHttp && !isHttps) {
          console.log('URL tidak valid: protokol harus http:// atau https://');
          return;
        }
        const isSafeLocalOrLan = isPrivateOrLocalHost(parsed.hostname);

        if (isHttp && !isSafeLocalOrLan && !allowInsecure) {
          console.log(
            yellow(
              `Peringatan keamanan: Base URL "${cleanUrl}" menggunakan skema HTTP (cleartext) untuk host remote "${parsed.hostname}". ` +
                'Risiko eksfiltrasi API key via MITM. Gunakan HTTPS atau tambahkan flag --insecure jika memang disengaja.',
            ),
          );
          return;
        }

        if (isHttp && !allowInsecure) {
          let trusted = true;
          if (env.ask) {
            const answer = (
              await env.ask(
                yellow(
                  `Protokol HTTP (cleartext) terdeteksi untuk "${cleanUrl}". Apakah kamu mempercayai protokol/URL ini? (y/n): `,
                ),
              )
            )
              .trim()
              .toLowerCase();
            trusted = /^(y|yes|ya)$/i.test(answer);
          } else if (env.confirm) {
            trusted = await env.confirm(
              `Set Base URL ke "${cleanUrl}" (HTTP cleartext)`,
              'Apakah kamu mempercayai protokol/URL ini?',
            );
          }
          if (!trusted) {
            console.log(dim('  (Dibatalkan: protokol/URL HTTP tidak disetujui)'));
            return;
          }
        }

        patch.baseUrl = cleanUrl;
        env.llm.setCredentials?.(env.config.apiKey ?? '', cleanUrl);
      } catch {
        console.log(`Nilai URL tidak valid: "${value}"`);
        return;
      }
      break;
    }
    case 'model':
      patch.model = value;
      if (patch.model !== env.llm.model) env.llm.setModel(patch.model);
      break;
    default:
      console.log(`Key tidak dikenal: ${key} (maxLogChars, maxContextChars, execTimeoutMs, approvalEnabled, funAnimations, apiKey, baseUrl, model)`);
      return;
  }
  env.updateConfig(patch);
  const shown = key === 'apiKey' ? '(tersembunyi)' : JSON.stringify(patch[key as keyof AgentConfig]);
  console.log(`Konfigurasi diupdate: ${key} = ${shown}`);
}

/** True when the input looks like a slash command. */
export function isCommand(input: string): boolean {
  return input.startsWith('/');
}

/** Command registry exposed for the `/` menu + generated docs (§3.17). */
export function listCommands(): Array<{ name: string; help: string; hint?: string }> {
  return COMMANDS.map((c) => ({ name: c.name, help: c.help, hint: c.hint }));
}

/** Filtered registry for incremental autocomplete. */
export function matchCommands(prefix: string): Array<{ name: string; help: string; hint?: string }> {
  const p = prefix.replace(/^\//, '').toLowerCase();
  return listCommands().filter((c) => c.name.startsWith(p));
}

/**
 * `/help` text GENERATED from the registry — the single source of truth also
 * used by autocomplete and README output, so they never drift (§3.17).
 */
export function buildHelpText(): string {
  const lines = [
    'Ruko — AI Coding Agent CLI',
    '===========================',
    'Slash commands:',
  ];
  for (const c of COMMANDS) {
    const names = `/${c.name}${(c.aliases ?? []).map((a) => `, /${a}`).join('')}`;
    const usage = (names + (c.hint ? ` ${c.hint}` : '')).padEnd(24);
    lines.push(`  ${usage} ${c.help}`);
  }
  lines.push(
    '',
    'Input biasa:',
    '  run <cmd>             Eksekusi perintah shell langsung (manual mode)',
    '  lainnya               Disimpan ke konteks; dikirim ke AI backend jika aktif',
    '                        (jawaban LLM di-stream real-time, tool pakai diff visual)',
    '',
    'Catatan:',
    '  Perintah berisiko (rm -rf, sudo, git push, dll) butuh konfirmasi y/N.',
    '  Tanpa API key: jalankan ruko → wizard /login tes koneksi langsung.',
    '  Plan mode (/plan) memblokir eksekusi di level kode, bukan cuma prompt.',
    '  Perubahan file bisa dibatalkan dengan /undo (snapshot .ruko/undo).',
    '  Bypass persetujuan: RUKO_YOLO_MODE=1 atau approvalEnabled=false.',
  );
  return lines.join('\n');
}

/** Dispatches a slash command line (e.g. "/exec ls -la"). */
export async function handleCommand(input: string, env: CommandEnv): Promise<void> {
  const [rawName, ...rest] = input.split(/\s+/);
  const name = rawName.slice(1).toLowerCase();
  const args = rest.join(' ').trim();

  const def = COMMANDS.find(
    (c) => c.name === name || (c.aliases ?? []).includes(name),
  );
  if (!def) {
    const near = matchCommands(rawName).map((c) => `/${c.name}`).join(' ');
    console.log(`Perintah tidak dikenal: ${rawName}${near ? `  — mungkin maksud: ${near}` : ''} (coba /help)`);
    return;
  }
  await def.run(args, env);
}
