import * as readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { Agent } from '../agent/agent.js';
import { handleCommand, listCommands } from '../agent/commands.js';
import { Confirmer } from './approval.js';
import { saveConfig } from './config.js';
import { AgentConfig } from '../types.js';
import { Context } from './context.js';
import { saveSession } from './session.js';
import { createLineEditor, LineEditor, MenuItem } from './tui.js';
import { buildStatusBar, cyan, dim, promptGlyph, renderBox, stripAnsi, yellow } from './ui.js';
import { playSplash, SplashInfo } from './splash.js';

/** Prompt line shown under the status bar (placeholder until the user types). */
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
 * On a TTY it drives a raw-mode `LineEditor` (see tui.ts) so the `/` command
 * menu appears live as an overlay and the prompt placeholder disappears on the
 * first keystroke. Piped/non-TTY input keeps using node:readline so scripts and
 * smoke tests stay deterministic.
 *
 * Every line of input is either:
 *  - a slash command — dispatched to the command registry (`/` opens the menu);
 *  - a plain instruction — recorded in the conversation context and handed to
 *    the Agent (replies stream token-by-token), then compressed and saved.
 */
export class SystemLoop {
  private rl: readline.Interface | null = null;
  private editor: LineEditor | null = null;
  private running = true;
  private sessionId: string | null = null;
  /** True while the agent is thinking/executing (v0.7 live input). */
  private busy = false;
  /** FIFO of messages typed while the AI was busy (v0.7 #4/#5). */
  private queue: string[] = [];
  /** Abort handle for the in-flight turn (v0.7 #3 "kirim sekarang"). */
  private turnAbort: AbortController | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    private readonly config: AgentConfig,
    private readonly configPath: string,
  ) {}

  /** Starts the loop. Blocks (TTY: until exit) or wires piped line events. */
  start(): void {
    void this.startAsync();
  }

  private async startAsync(): Promise<void> {
    const model = this.agent.llm.model || '(belum diatur — /login)';
    const provider = this.agent.llm.name;
    const info: SplashInfo = {
      title: `Ruko-agent ${packageVersion()}`,
      version: `version ${packageVersion()} `,
      tagline: '"Masuk Ruko..."',
      modelLine: `model: ${model} ──── provider: ${provider}`,
      hint: 'Ketik / untuk daftar perintah, Ctrl+C untuk keluar.',
    };
    await playSplash(info);

    // Wire the approval prompt into the agent now that stdin is available.
    this.agent.setConfirm(this.makeConfirmer());

    if (process.stdin.isTTY) {
      this.editor = createLineEditor();
      // Raw mode swallows Ctrl+C while reading; when it fires while the agent
      // is working, save the session and leave cleanly instead of hard-killing.
      process.once('SIGINT', () => {
        process.stdout.write('\n^C\n');
        this.stop();
        process.exit(0);
      });
      void this.runInteractive();
      return;
    }
    this.startPipeLoop();
  }

  /** TTY path: one LIVE status bar + raw-mode line read, redrawn in place. */
  private async runInteractive(): Promise<void> {
    while (this.running) {
      // The bar rides INSIDE the editor's managed region (statusLine): every
      // frame redraws it in place and submit() erases it, so stale versions
      // can never pile up in scrollback (feedback v0.6.2 — third site of the
      // render-loop bug, after splash and the beginner guide).
      const line = await this.editor!.readLine({
        prompt: promptGlyph(),
        statusLine: () => this.statusBarLine(),
        placeholder: PROMPT_HINT,
        getMenu: (buffer) => this.slashMenuItems(buffer),
        // Enter on a lone "/" just closes the overlay — nothing is echoed
        // (feedback v0.6 #2: help listings must not settle in scrollback).
        menuOnlyClose: (buffer) => stripAnsi(buffer).trim() === '/',
      });
      if (line === null) {
        this.stop();
        return;
      }
      await this.handleLine(line);
      // v0.7 #4/#5: drain the queue FIFO — each queued message runs as its
      // own turn; new ambient submissions may extend the queue mid-drain.
      while (this.running && this.queue.length > 0) {
        const next = this.queue.shift()!;
        console.log(`${promptGlyph()}${next}`);
        await this.handleLine(next);
      }
    }
  }

  /** Non-TTY path: classic readline over piped stdin (smoke tests, CI). */
  private startPipeLoop(): void {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.rl.setPrompt(this.composePrompt());
    this.rl.prompt();
    let queue: Promise<void> = Promise.resolve();
    this.rl.on('line', (line) => {
      queue = queue.then(async () => {
        await this.handleLine(line);
        if (this.running) this.refreshPrompt();
      });
    });
    this.rl.on('SIGINT', () => {
      console.log('\n^C');
      this.stop();
    });
    this.rl.on('close', () => {
      this.running = false;
    });
  }

  /** Dark-green status bar, refreshed before every input (§3/§8). */
  private statusBarLine(): string {
    return buildStatusBar({
      model: this.agent.llm.model,
      usedChars: this.ctx.totalChars,
      budgetChars: this.config.maxContextChars,
      role: this.config.role ?? 'default',
      planMode: this.agent.planMode,
      // v0.7: busy flag + queue badge live in the bar (same redraw machine).
      busy: this.busy,
      pending: this.queue.length,
      // §8: last turn's token-ish stats ride in the bar, not a separate line.
      turn: this.agent.lastUsage ?? undefined,
    });
  }

  /** Status bar (dark green) + `›` prompt, refreshed before each piped input. */
  private composePrompt(): string {
    return `${this.statusBarLine()}\n${promptGlyph()}${dim(PROMPT_HINT)} `;
  }

  /** Live, filtered command overlay for the `/` menu (§4). */
  private slashMenuItems(buffer: string): MenuItem[] {
    if (!buffer.startsWith('/') || buffer.includes(' ')) return [];
    const query = buffer.slice(1).toLowerCase();
    return listCommands()
      .filter((c) => c.name.startsWith(query))
      .map((c) => ({
        label: `/${c.name}${c.hint ? ` ${c.hint}` : ''}`,
        detail: c.help,
        insert: `/${c.name} `,
      }));
  }

  /** Stops the loop, saves the session and closes input. */
  private stop(): void {
    this.running = false;
    this.saveSession();
    this.editor?.close();
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

  /** Approval prompt hook (auto-denies when not a TTY). */
  private makeConfirmer(): Confirmer {
    return async (command, reason) => {
      const heading = `⚠ Perintah berisiko (${reason})`;
      const detail = `  ${command}`;
      if (this.editor) {
        for (const line of [heading, detail]) process.stdout.write(`${line}\n`);
        const answer = await this.editor.readLine({ prompt: `${yellow('  Jalankan? [y/N] ')}` });
        return answer !== null && /^(y|yes|ya)$/i.test(answer.trim());
      }
      if (!process.stdin.isTTY || !this.rl) return false;
      return new Promise((resolve) => {
        this.rl?.question(`${heading}\n${detail}\n  Jalankan? [y/N] `, (answer) => {
          resolve(/^(y|yes|ya)$/i.test(answer.trim()));
        });
      });
    };
  }

  /** Free-text question hook for commands (`/config setup`). */
  private makeAsk(): (question: string) => Promise<string> {
    return async (question) => {
      if (this.editor) return (await this.editor.readLine({ prompt: question })) ?? '';
      return new Promise((resolve, reject) => {
        if (!this.rl) {
          reject(new Error('readline tidak aktif'));
          return;
        }
        this.rl.question(question, (answer) => resolve(answer));
      });
    };
  }

  /** Masked question hook — used for the API key in `/login` (§5). */
  private makeAskSecret(): (question: string) => Promise<string> {
    return async (question) => {
      if (this.editor) return (await this.editor.readLine({ prompt: question, mask: true })) ?? '';
      return this.makeAsk()(question);
    };
  }

  private async handleLine(line: string): Promise<void> {
    const input = line.trim();
    if (!input) return;

    try {
      if (input.startsWith('/')) {
        if (stripAnsi(input) === '/') {
          // Non-TTY has no overlay, so keep the one-shot static list there.
          if (!this.editor) this.printSlashMenu();
        } else {
          await handleCommand(input, {
            ctx: this.ctx,
            config: this.config,
            llm: this.agent.llm,
            agent: this.agent,
            confirm: this.makeConfirmer(),
            ask: this.makeAsk(),
            askSecret: this.makeAskSecret(),
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
        await this.runTurn(input);
        // §7.47/§8: per-turn stats moved into the status bar (statusBarLine),
        // so only the proactive >50% warning stays as an output line.
        if (
          this.agent.lastUsage &&
          this.ctx.totalChars / this.config.maxContextChars > 0.5 &&
          (this.ctx.size & 1) === 0
        ) {
          // warn at most every other turn to stay quiet (§5 token discipline)
          console.log(yellow('⚠ konteks > 50% — pertimbangkan /compact-equivalent: riwayat lama otomatis dikompres.'));
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
  }

  /**
   * One AI turn with the input kept LIVE (feedback v0.7 #1): the ambient
   * region (same redraw machine as readLine) stays typable while the agent
   * thinks/executes; Enter routes to the queue modal, Ctrl+C interrupts the
   * turn only.
   */
  private async runTurn(input: string): Promise<void> {
    this.ctx.add('user', input);
    this.busy = true;
    this.turnAbort = new AbortController();
    this.editor?.startAmbient({
      prompt: promptGlyph(),
      statusLine: () => this.statusBarLine(),
      placeholder: 'AI sedang bekerja — ketik tetap bisa, Enter untuk antre…',
      getMenu: (buffer) => this.slashMenuItems(buffer),
      onSubmit: (line) => {
        void this.handleAmbientSubmit(line);
      },
      onInterrupt: () => {
        this.turnAbort?.abort();
      },
    });
    try {
      const response = await this.agent.handleInstruction(input, this.turnAbort.signal);
      if (response) {
        this.ctx.add('assistant', response);
        // With streaming the text was already revealed live by the agent.
        if (!this.agent.lastResponseStreamed) console.log(response);
      }
    } finally {
      this.busy = false;
      this.turnAbort = null;
      this.editor?.stopAmbient();
    }
  }

  /**
   * Enter pressed while the AI is busy (feedback v0.7 #2–#5): never send
   * directly — ask [1] interrupt-and-send / [2] queue (default, safer).
   * The modal renders inside the SAME live region (no separate path).
   */
  private async handleAmbientSubmit(line: string): Promise<void> {
    const value = line.trim();
    // A lone "/" only opened the overlay — never queue it (feedback v0.6 #2).
    if (!value || stripAnsi(value) === '/') return;
    const answer = await this.editor!.askModal({
      prompt: yellow(
        ' Pesan disiapkan. [1] Kirim sekarang (hentikan AI) · [2] Antre, kirim setelah tugas ini — pilih: ',
      ),
      keys: ['1', '2'],
      defaultKey: '2',
    });
    if (answer === '1') {
      // Interrupt: the message goes to the FRONT of the queue so the drain
      // loop processes it as the very next turn once the abort unwinds.
      this.queue.unshift(value);
      this.turnAbort?.abort();
    } else {
      // '2' or Enter (default) or modal dismissed by turn end — queue FIFO.
      this.queue.push(value);
    }
  }

  /** Static command list (piped/non-TTY fallback); the TTY path uses an overlay. */
  private printSlashMenu(): void {
    const items = listCommands().map((c) => `${cyan('/' + c.name + (c.hint ? ` ${c.hint}` : ''))}  ${c.help}`);
    process.stdout.write(`${renderBox('Slash commands', items)}\n`);
  }

  private refreshPrompt(): void {
    if (!this.rl) return;
    this.rl.setPrompt(this.composePrompt());
    this.rl.prompt();
  }
}
