import { Confirmer, guardedExecute } from '../core/approval.js';
import { Context } from '../core/context.js';
import { saveConfig } from '../core/config.js';
import { execute } from '../core/executor.js';
import { listSessions, loadSession, saveSession } from '../core/session.js';
import { AgentConfig } from '../types.js';
import { LLMProvider } from './llm.js';

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
  /** Approval prompt hook (from the loop's readline). */
  confirm: Confirmer;
  /** Persists a config patch back to .ruko/config.json. */
  updateConfig: (patch: Partial<AgentConfig>) => void;
  handle: LoopHandle;
}

type CommandHandler = (args: string, env: CommandEnv) => Promise<void> | void;

interface CommandDef {
  name: string;
  aliases?: string[];
  help: string;
  run: CommandHandler;
}

const COMMANDS: CommandDef[] = [
  {
    name: 'help',
    help: 'Show this help.',
    run: () => {
      console.log(HELP_TEXT);
    },
  },
  {
    name: 'exit',
    aliases: ['quit'],
    help: 'Exit the CLI (session disimpan otomatis).',
    run: (_args, env) => env.handle.stop(),
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
      const sessions = listSessions();
      if (sessions.length === 0) {
        console.log('(belum ada sesi tersimpan)');
        return;
      }
      for (const s of sessions) {
        console.log(`${s.id}  [${s.messageCount} msg, ${s.updatedAt.slice(0, 19)}]  ${s.title}`);
      }
    },
  },
  {
    name: 'resume',
    help: 'Lanjutkan sesi: /resume <id>.',
    run: (args, env) => {
      const id = args.trim();
      if (!id) {
        console.log('Usage: /resume <session-id>  (lihat /sessions)');
        return;
      }
      const session = loadSession(id);
      if (!session) {
        console.log(`Sesi tidak ditemukan: ${id}`);
        return;
      }
      if (env.ctx.size > 0) {
        saveSession(env.ctx.toJSON(), undefined, env.handle.getSessionId() ?? undefined);
      }
      env.ctx.replace(session.messages);
      env.handle.setSessionId(session.id);
      console.log(`Sesi dimuat: ${session.title} (${session.messages.length} pesan).`);
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
    name: 'exec',
    help: 'Jalankan perintah shell (output di-summarize otomatis).',
    run: async (args, env) => {
      if (!args) {
        console.log('Usage: /exec <command>');
        return;
      }
      const result = await guardedExecute(
        args,
        { timeoutMs: env.config.execTimeoutMs, confirm: env.confirm },
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
    help: 'Statistik konteks (pesan, karakter, budget).',
    run: (_args, env) => {
      console.log(`messages: ${env.ctx.size}`);
      console.log(
        `total chars: ${env.ctx.totalChars} (budget: ${env.config.maxContextChars})`,
      );
      console.log(`log summarizer threshold: ${env.config.maxLogChars} chars`);
      console.log(`exec timeout: ${env.config.execTimeoutMs}ms`);
    },
  },
  {
    name: 'config',
    help: 'Tampilkan / ubah konfigurasi: /config atau /config set <key> <value>.',
    run: (args, env) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length === 0 || parts[0] === '') {
        const c = env.config;
        console.log(`maxLogChars: ${c.maxLogChars}`);
        console.log(`maxContextChars: ${c.maxContextChars}`);
        console.log(`execTimeoutMs: ${c.execTimeoutMs}`);
        console.log(`approvalEnabled: ${c.approvalEnabled}`);
        console.log(`approvalAllowlist: ${c.approvalAllowlist.length > 0 ? c.approvalAllowlist.join(', ') : '(kosong)'}`);
        console.log(`model: ${c.model}`);
        return;
      }
      if (parts[0] === 'set' && parts.length >= 3) {
        const key = parts[1];
        const value = parts.slice(2).join(' ');
        applyConfigPatch(env, key, value);
      } else {
        console.log('Usage: /config  atau  /config set <key> <value>');
      }
    },
  },
  {
    name: 'model',
    help: 'Tampilkan model aktif, atau ganti: /model <nama>.',
    run: (args, env) => {
      const name = args.trim();
      if (!name) {
        console.log(`provider: ${env.llm.name}`);
        console.log(`model: ${env.llm.model}`);
        return;
      }
      env.llm.setModel(name);
      env.updateConfig({ model: name });
      console.log(`Model diganti: ${name}`);
    },
  },
];

function applyConfigPatch(env: CommandEnv, key: string, value: string): void {
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
    case 'model':
      patch.model = value;
      if (patch.model !== env.llm.model) env.llm.setModel(patch.model);
      break;
    default:
      console.log(`Key tidak dikenal: ${key} (maxLogChars, maxContextChars, execTimeoutMs, approvalEnabled, model)`);
      return;
  }
  env.updateConfig(patch);
  console.log(`Konfigurasi diupdate: ${key} = ${JSON.stringify(patch[key])}`);
}

/** True when the input looks like a slash command. */
export function isCommand(input: string): boolean {
  return input.startsWith('/');
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
    console.log(`Perintah tidak dikenal: ${rawName} (coba /help)`);
    return;
  }
  await def.run(args, env);
}

export const HELP_TEXT = `Ruko — AI Coding Agent CLI
===========================
Slash commands:
  /help                 Bantuan ini
  /exit, /quit          Keluar (sesi disimpan otomatis)
  /new, /reset          Simpan sesi lalu mulai percakapan baru
  /resume <id>          Lanjutkan sesi tersimpan (lihat /sessions)
  /sessions             Daftar sesi tersimpan
  /clear                Hapus konteks percakapan saat ini
  /exec <cmd>           Jalankan perintah shell (output di-summarize)
  /history [n]          Tampilkan n pesan konteks terakhir
  /context              Statistik konteks
  /config [set k v]     Lihat/ubah konfigurasi (.ruko/config.json)
  /model [nama]         Lihat/ganti model LLM

Input biasa:
  run <cmd>             Eksekusi perintah shell langsung (manual mode)
  lainnya               Disimpan ke konteks; dikirim ke AI backend jika aktif

Catatan:
  Perintah berisiko (rm -rf, sudo, git push, dll) butuh konfirmasi y/N.
  Set OPENAI_API_KEY (opsional OPENAI_BASE_URL / AGENT_MODEL) untuk LLM mode.
  Bypass persetujuan: RUKO_YOLO_MODE=1 atau approvalEnabled=false.`;