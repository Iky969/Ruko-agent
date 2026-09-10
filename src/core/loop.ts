import * as readline from 'node:readline';
import { Agent } from '../agent/agent.js';
import { handleCommand } from '../agent/commands.js';
import { Confirmer } from './approval.js';
import { saveConfig } from './config.js';
import { AgentConfig } from '../types.js';
import { Context } from './context.js';
import { saveSession } from './session.js';

/**
 * System Loop — the interactive REPL that receives instructions from the user.
 *
 * Every line of input is either:
 *  - a slash command (e.g. /exec, /help) — dispatched to the command registry;
 *  - a plain instruction — recorded in the conversation context, handed to the
 *    Agent, and answered; the context is then compressed when over budget and
 *    the session is auto-saved to `.ruko/sessions/`.
 *
 * The loop also provides the approval prompt hook (Confirmer) used before any
 * risky shell command runs.
 */
export class SystemLoop {
  private rl: readline.Interface | null = null;
  private running = true;
  private sessionId: string | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    private readonly config: AgentConfig,
    private readonly configPath: string,
    private readonly promptText = 'ruko> ',
  ) {}

  /** Starts the loop. Blocks until the user exits (Ctrl+C, /exit, or EOF). */
  start(): void {
    const mode = this.agent.isLlmMode ? 'LLM mode' : 'manual mode';
    console.log(`Ruko — AI Coding Agent CLI (${mode}). Ketik /help untuk bantuan, Ctrl+C untuk keluar.`);

    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.rl.setPrompt(this.promptText);
    this.rl.prompt();

    // Serialize input processing: each line is fully handled (including any
    // shell execution or LLM round-trip) before the next line is processed.
    let queue: Promise<void> = Promise.resolve();
    this.rl.on('line', (line) => {
      queue = queue.then(() => this.handleLine(line));
    });
    this.rl.on('SIGINT', () => {
      console.log('\n^C');
      this.stop();
    });
    this.rl.on('close', () => {
      this.running = false;
    });

    // Wire the approval prompt into the agent now that stdin is open.
    this.agent.setConfirm(this.makeConfirmer());
  }

  /** Stops the loop, saves the session and closes stdin. */
  private stop(): void {
    this.running = false;
    this.saveSession();
    this.rl?.close();
  }

  private saveSession(): void {
    if (this.ctx.size === 0) return;
    this.sessionId = saveSession(
      this.ctx.toJSON(),
      undefined,
      this.sessionId ?? undefined,
    ).id;
  }

  /** Approval prompt hook backed by readline (auto-denies when not a TTY). */
  private makeConfirmer(): Confirmer {
    return (command, reason) => {
      if (!process.stdin.isTTY || !this.rl) return Promise.resolve(false);
      return new Promise((resolve) => {
        this.rl?.question(
          `⚠ Perintah berisiko (${reason})\n  ${command}\n  Jalankan? [y/N] `,
          (answer) => {
            resolve(/^(y|yes|ya)$/i.test(answer.trim()));
          },
        );
      });
    };
  }

  private async handleLine(line: string): Promise<void> {
    const input = line.trim();
    if (!input) {
      this.rl?.prompt();
      return;
    }

    try {
      if (input.startsWith('/')) {
        await handleCommand(input, {
          ctx: this.ctx,
          config: this.config,
          llm: this.agent.llm,
          confirm: this.makeConfirmer(),
          updateConfig: (patch) => {
            Object.assign(this.config, patch);
            saveConfig(this.config, this.configPath);
          },
          handle: {
            stop: () => this.stop(),
            getSessionId: () => this.sessionId,
            setSessionId: (id) => {
              this.sessionId = id;
            },
          },
        });
      } else {
        this.ctx.add('user', input);
        const response = await this.agent.handleInstruction(input);
        if (response) {
          this.ctx.add('assistant', response);
          console.log(response);
        }
        const removed = this.ctx.compress();
        if (removed > 0) {
          console.log(`[konteks dikompres: -${removed} chars dari history lama]`);
        }
        this.saveSession();
      }
    } catch (err) {
      console.error(`[error] ${err instanceof Error ? err.message : String(err)}`);
    }

    if (this.running) {
      this.rl?.prompt();
    }
  }
}