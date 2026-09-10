import * as readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { Agent } from '../agent/agent.js';
import { handleCommand, listCommands } from '../agent/commands.js';
import { Confirmer } from './approval.js';
import { saveConfig } from './config.js';
import { AgentConfig } from '../types.js';
import { Context } from './context.js';
import { saveSession } from './session.js';
import { buildStatusBar, buildUsageLine, colorsEnabled, cyan, dim, promptGlyph, renderBox, stripAnsi, yellow } from './ui.js';

/** Prompt line shown under the status bar. */
const PROMPT_HINT = 'Ask anything, or type / for commands';

function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * System Loop — the interactive REPL that receives instructions from the user.
 *
 * Every line of input is either:
 *  - a slash command (e.g. /exec, /help) — dispatched to the command registry
 *    (typing just `/` pops up the command menu);
 *  - a plain instruction — recorded in the conversation context, handed to the
 *    Agent (replies stream to the terminal token-by-token), then the context
 *    is compressed when over budget and the session auto-saved.
 *
 * The loop also provides the approval prompt hook (Confirmer) used before any
 * risky shell command runs.
 */
export class SystemLoop {
  private rl: readline.Interface | null = null;
  private running = true;
  private sessionId: string | null = null;
  private slashMenuShown = false;

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    private readonly config: AgentConfig,
    private readonly configPath: string,
  ) {}

  /** Starts the loop. Blocks until the user exits (Ctrl+C, /exit, or EOF). */
  start(): void {
    const mode = this.agent.isLlmMode ? 'LLM mode' : 'manual mode';
    console.log(
      renderBox(`Ruko ${packageVersion()} — AI Coding Agent CLI`, [
        `mode: ${mode}`,
        `model: ${this.agent.llm.model}`,
        dim('Ketik / untuk daftar perintah, Ctrl+C untuk keluar.'),
      ]),
    );

    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.rl.setPrompt(this.composePrompt());
    this.rl.prompt();
    this.wireSlashMenu();

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

  /** Status bar (dark green) + `›` prompt, refreshed before each input. */
  private composePrompt(): string {
    const bar = buildStatusBar({
      model: this.agent.llm.model,
      usedChars: this.ctx.totalChars,
      budgetChars: this.config.maxContextChars,
      role: this.config.role ?? 'default',
      planMode: this.agent.planMode,
    });
    return `${bar}\n${promptGlyph()}${dim(PROMPT_HINT)} `;
  }

  /**
   * Interactive slash-command recommendations: the moment the user types `/`
   * as the whole line, print the command list under the prompt. Resets when
   * the line moves past `/` so a re-typed `/` shows the menu again.
   */
  private wireSlashMenu(): void {
    if (!this.rl || !colorsEnabled()) return;
    const rl = this.rl;
    rl.on('keypress', () => {
      // line reflects the buffer *before* this keypress; recompute after tick.
      setImmediate(() => {
        if (!this.rl) return;
        if (this.rl.line === '/') {
          if (!this.slashMenuShown) {
            this.slashMenuShown = true;
            this.printSlashMenu();
          }
        } else if (this.slashMenuShown && !this.rl.line.startsWith('/')) {
          this.slashMenuShown = false;
        }
      });
    });
  }

  private printSlashMenu(): void {
    const items = listCommands().map((c) =>
      colorsEnabled()
        ? `${cyan('/' + c.name + (c.hint ? ` ${c.hint}` : ''))}  ${c.help}`
        : `/${c.name}  ${c.help}`,
    );
    // Print the menu below the prompt; the caller re-establishes the prompt
    // afterwards (handleLine refreshes it; the keypress path lets readline
    // redraw the in-progress line on the next keystroke).
    process.stdout.write(`\n${renderBox('Slash commands', items)}\n`);
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

  /** Free-text question hook for commands (`/config setup`). */
  private makeAsk(): (question: string) => Promise<string> {
    return (question) =>
      new Promise((resolve, reject) => {
        if (!this.rl) {
          reject(new Error('readline tidak aktif'));
          return;
        }
        this.rl.question(question, (answer) => resolve(answer));
      });
  }

  private async handleLine(line: string): Promise<void> {
    const input = line.trim();
    if (!input) {
      this.slashMenuShown = false;
      this.refreshPrompt();
      return;
    }

    try {
      if (input.startsWith('/')) {
        this.slashMenuShown = false;
        if (stripAnsi(input) === '/') {
          this.printSlashMenu();
        } else {
          await handleCommand(input, {
            ctx: this.ctx,
            config: this.config,
            llm: this.agent.llm,
            agent: this.agent,
            confirm: this.makeConfirmer(),
            ask: this.makeAsk(),
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
        }
      } else {
        this.ctx.add('user', input);
        const response = await this.agent.handleInstruction(input);
        if (response) {
          this.ctx.add('assistant', response);
          // With streaming the text was already revealed live by the agent.
          if (!this.agent.lastResponseStreamed) console.log(response);
        }
        // §7.47: per-turn transparency line + proactive ctx warning at 50%.
        const usage = this.agent.lastUsage;
        if (usage) {
          console.log(
            dim(
              buildUsageLine({
                promptChars: usage.promptChars,
                completionChars: usage.completionChars,
                usedChars: this.ctx.totalChars,
                budgetChars: this.config.maxContextChars,
              }),
            ),
          );
          if (this.ctx.totalChars / this.config.maxContextChars > 0.5 && (this.ctx.size & 1) === 0) {
            // warn at most every other turn to stay quiet (§5 token discipline)
            console.log(yellow('⚠ konteks > 50% — pertimbangkan /compact-equivalent: riwayat lama otomatis dikompres.'));
          }
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
      this.refreshPrompt();
    }
  }

  private refreshPrompt(): void {
    if (!this.rl) return;
    this.rl.setPrompt(this.composePrompt());
    this.rl.prompt();
  }
}
