import { Confirmer, guardedExecute } from '../core/approval.js';
import { Context } from '../core/context.js';
import { createSpinner, LineGate, RevealFilter } from '../core/ui.js';
import { AgentConfig, ContextMessage } from '../types.js';
import { LLMProvider } from './llm.js';
import { allRoles, buildSystemPrompt, getBuiltInRole, readProjectAgentDoc, RoleDef } from './roles.js';
import { parseToolCalls, runToolCall, stripToolBlocks, ToolCall } from './tools.js';

/** Safety cap on how many tool iterations one instruction may trigger. */
const MAX_TOOL_ITERATIONS = 6;

/** §5.35 — same tool+args invoked more than this many times = likely loop. */
const LOOP_REPEAT_LIMIT = 2;

/** Per-instruction token-ish usage snapshot (chars, provider-agnostic). */
export interface TurnUsage {
  promptChars: number;
  completionChars: number;
}

/**
 * Orchestrates user instructions.
 *
 * Two modes:
 *  - Manual mode (no LLM configured): heuristics only — "run <cmd>" executes,
 *    everything else is acknowledged and stored in context.
 *  - LLM mode: sends the instruction plus context history to the backend and
 *    runs the tool loop (exec → observe → decide) until the model answers.
 *
 * Cross-cutting guarantees enforced in CODE (not prompt): plan-mode tool
 * blocking (§6), repeat-call loop detection (§5), tool-output char cap (§5).
 */
export class Agent {
  private confirm: Confirmer | null = null;
  /** True when the last LLM reply was already printed live to stdout. */
  lastResponseStreamed = false;
  /** Usage of the most recent handled instruction (for the per-turn line). */
  lastUsage: TurnUsage | null = null;
  /** Plan mode toggle — enforced at the tool layer, not just in the prompt. */
  planMode = false;
  private callCounts = new Map<string, number>();

  constructor(
    private readonly ctx: Context,
    private readonly llmProvider: LLMProvider,
    private readonly config: AgentConfig,
    confirm?: Confirmer | null,
  ) {
    this.confirm = confirm ?? null;
  }

  /** Replaces the approval prompt hook (wired by the loop once stdin is open). */
  setConfirm(confirm: Confirmer | null): void {
    this.confirm = confirm ?? null;
  }

  /** The LLM backend in use (exposed so the loop can report status). */
  get llm(): LLMProvider {
    return this.llmProvider;
  }

  /** True when the AI backend is configured and will be used. */
  get isLlmMode(): boolean {
    return this.llmProvider.isConfigured;
  }

  /** Active role (built-in or custom file), resolved from config (§4). */
  activeRole(): RoleDef {
    const name = this.config.role ?? 'default';
    return (
      allRoles().find((r) => r.name === name) ??
      getBuiltInRole('default') ??
      { name: 'default', description: '', prompt: '' }
    );
  }

  /** Layered system prompt: identity + tools + role + AGENT.md + mode (§4). */
  systemPrompt(): string {
    return buildSystemPrompt({
      role: this.activeRole(),
      planMode: this.planMode,
      mode: this.config.mode ?? 'beginner',
      agentDoc: readAgentDocSafe(),
    });
  }

  /** Returns the assistant's textual response ('' when nothing to say). */
  async handleInstruction(instruction: string, signal?: AbortSignal): Promise<string> {
    this.callCounts.clear();
    this.lastUsage = null;
    return this.llmProvider.isConfigured
      ? this.runWithLlm(instruction, signal)
      : this.runManual(instruction);
  }

  /** Manual mode: heuristic instruction handling without an AI backend. */
  private async runManual(instruction: string): Promise<string> {
    const match = instruction.match(/^(?:run|exec|jalankan)\s+([\s\S]+)$/i);
    if (match) {
      const result = await guardedExecute(
        match[1],
        { timeoutMs: this.config.execTimeoutMs, confirm: this.confirm },
        this.config,
      );
      return (
        `${result.output || '(no output)'}\n` +
        `[exit code: ${result.code ?? 'killed'} | ${result.durationMs}ms` +
        `${result.truncated ? ' | output truncated' : ''}]`
      );
    }
    return [
      'Instruction recorded (manual mode — no AI backend configured).',
      '• Prefix a command with "run " to execute it:  run ls -la',
      '• Or use slash commands: /help, /exec <cmd>, /context',
      '• Set OPENAI_API_KEY to enable the AI-driven loop.',
    ].join('\n');
  }

  /** LLM mode: agent loop with tool calls, streaming the visible reply. */
  private async runWithLlm(instruction: string, signal?: AbortSignal): Promise<string> {
    const history = this.ctx.window(this.config.maxContextChars);
    const messages: ContextMessage[] = [
      { role: 'system', content: this.systemPrompt(), timestamp: '' },
      ...history,
      { role: 'user', content: instruction, timestamp: '' },
    ];
    const usage: TurnUsage = { promptChars: 0, completionChars: 0 };
    this.lastUsage = usage;

    this.lastResponseStreamed = false;
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
      // v0.7: user chose "kirim sekarang" — stop before the next request so
      // the interrupted turn ends cleanly instead of starting new work.
      if (signal?.aborted) return '';
      usage.promptChars += messages.reduce((s, m) => s + m.content.length, 0);
      const usePacman = this.config.funAnimations ?? (this.config.mode !== 'pro');
      const spinner = createSpinner('Thinking', { pacman: usePacman });
      const gate = new LineGate((text) => {
        spinner.stop();
        process.stdout.write(text);
      });
      const reveal = new RevealFilter((text) => gate.push(text));
      let raw: string;
      try {
        raw = await this.llmProvider.chat(messages, {
          onToken: (token) => reveal.feed(token),
          signal,
        });
      } catch (err) {
        // v0.7: an interrupted stream rejects with AbortError — that is a
        // clean stop requested by the user, not a provider failure.
        if (signal?.aborted || isAbortError(err)) return '';
        throw err;
      } finally {
        reveal.end();
        spinner.stop();
      }
      usage.completionChars += raw.length;
      const calls = parseToolCalls(raw);
      // Final answers keep their trailing line; tool iterations drop the dangling
      // preamble that sat right before the hidden ```tool block (§2).
      const iterStreamed = gate.finish(calls.length === 0);
      if (calls.length === 0) {
        const text = stripToolBlocks(raw) || '(no response)';
        if (iterStreamed) process.stdout.write('\n');
        this.lastResponseStreamed = iterStreamed;
        return text;
      }

      // Text streamed before a tool call needs a line break before the logs.
      if (iterStreamed) process.stdout.write('\n');
      const text = stripToolBlocks(raw);
      if (text) {
        messages.push({ role: 'assistant', content: text, timestamp: '' });
      }
      for (const call of calls) {
        // §5: loop breaker — identical tool call repeated is a stuck model.
        if (this.seenRepeat(call)) {
          return (
            `[deteksi loop] tool "${call.tool}" dengan argumen sama sudah dipanggil ` +
            `> ${LOOP_REPEAT_LIMIT}× — eksekusi dihentikan. Ulangi dengan instruksi lain, ` +
            `atau jalankan manual lewat /exec.`
          );
        }
        const result = await runToolCall(call, {
          confirm: this.confirm,
          config: this.config,
          onLog: (line) => console.log(line),
          planMode: this.planMode,
          signal,
        });
        if (signal?.aborted) return '';
        messages.push({
          role: 'tool',
          content: `Result of tool "${call.tool}":\n${result}`,
          timestamp: '',
        });
      }
    }

    return '[agent] reached max tool iterations without a final answer; stopping.';
  }

  /** Counts tool+args signatures; true when this call crossed the repeat cap. */
  private seenRepeat(call: ToolCall): boolean {
    const { tool, ...rest } = call;
    const sig = `${tool}:${JSON.stringify(rest)}`;
    const n = (this.callCounts.get(sig) ?? 0) + 1;
    this.callCounts.set(sig, n);
    return n > LOOP_REPEAT_LIMIT;
  }
}

/** True for the DOM-style rejection an aborted fetch/stream throws. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** AGENT.md discovery, isolated for error-safety in the hot loop. */
function readAgentDocSafe(): string | null {
  try {
    return readProjectAgentDoc();
  } catch {
    return null;
  }
}
