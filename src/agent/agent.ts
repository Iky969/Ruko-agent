import { Confirmer, guardedExecute } from '../core/approval.js';
import { Context } from '../core/context.js';
import {
  createSpinner,
  formatTerminalMarkdown,
  inferStepDescription,
  LineGate,
  RevealFilter,
  WorkflowTree,
  yellow,
} from '../core/ui.js';
import { AgentConfig, ContextMessage } from '../types.js';
import { LLMProvider } from './llm.js';
import { allRoles, buildSystemPrompt, getBuiltInRole, readProjectAgentDoc, RoleDef } from './roles.js';
import {
  detectSensitiveFileAccessInExec,
  getWorkspaceRoot,
  isSensitiveEnvCommand,
  parseToolCalls,
  runToolCall,
  stripToolBlocks,
  ToolCall,
} from './tools.js';
import { readMemorySafe } from '../core/memory.js';
import { formatSkillsForPrompt, listSkills } from '../core/skills.js';

/** Safety cap on how many tool iterations one instruction may trigger. */
const MAX_TOOL_ITERATIONS = 6;

/** §5.35 — same tool+args invoked more than this many times = likely loop. */
const LOOP_REPEAT_LIMIT = 2;

/** Per-instruction token-ish usage snapshot (chars, provider-agnostic). */
export interface TurnUsage {
  promptChars: number;
  completionChars: number;
}

/** Cumulative token usage tracked across an entire interactive session. */
export interface SessionUsage {
  promptChars: number;
  completionChars: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalTurns: number;
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
  /** Cumulative token and character usage across all turns in the active session. */
  sessionUsage: SessionUsage = {
    promptChars: 0,
    completionChars: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalTurns: 0,
  };
  /** Plan mode toggle — enforced at the tool layer, not just in the prompt. */
  planMode = false;
  private callCounts = new Map<string, number>();
  /** Tracks the most recent executed tool call signature to guard against consecutive duplicates (§5). */
  private lastCallSignature: string | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly llmProvider: LLMProvider,
    private readonly config: AgentConfig,
    confirm?: Confirmer | null,
    private readonly workspaceRoot?: string,
    public readonly subagentDepth: number = 0,
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

  /** Resets accumulated session token statistics back to zero. */
  resetSessionUsage(): void {
    this.sessionUsage = {
      promptChars: 0,
      completionChars: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      totalTurns: 0,
    };
    this.lastUsage = null;
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

  /** Layered system prompt: identity + tools + role + AGENT.md + mode (§4) + memory + skills. */
  systemPrompt(): string {
    const ws = this.workspaceRoot ?? getWorkspaceRoot();
    return buildSystemPrompt({
      role: this.activeRole(),
      planMode: this.planMode,
      mode: this.config.mode ?? 'beginner',
      agentDoc: readAgentDocSafe(),
      memory: readMemorySafe(ws),
      skills: formatSkillsForPrompt(listSkills(ws)),
    });
  }

  /** Returns the assistant's textual response ('' when nothing to say). */
  async handleInstruction(instruction: string, signal?: AbortSignal): Promise<string> {
    this.callCounts.clear();
    this.lastCallSignature = null;
    this.lastUsage = null;
    return this.llmProvider.isConfigured
      ? this.runWithLlm(instruction, signal)
      : this.runManual(instruction);
  }

  /** Manual mode: heuristic instruction handling without an AI backend. */
  private async runManual(instruction: string): Promise<string> {
    const match = instruction.match(/^(?:run|exec|jalankan)\s+([\s\S]+)$/i);
    if (match) {
      const cmd = match[1];
      const ws = this.workspaceRoot ?? getWorkspaceRoot();
      if (isSensitiveEnvCommand(cmd)) {
        return `exec ditolak: command berpotensi membocorkan environment variable sensitif. Kredensial tidak dapat diakses lewat tool ini.`;
      }
      const fileCheck = detectSensitiveFileAccessInExec(cmd, ws);
      if (fileCheck.blocked) {
        return fileCheck.message ?? 'exec ditolak: akses ke file sensitif diblokir.';
      }
      const result = await guardedExecute(
        cmd,
        { timeoutMs: this.config.execTimeoutMs, confirm: this.confirm, llmProvider: this.llmProvider },
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
    const last = history[history.length - 1];
    const userAlreadyInHistory = Boolean(
      last && last.role === 'user' && last.content === instruction
    );
    const messages: ContextMessage[] = [
      { role: 'system', content: this.systemPrompt(), timestamp: '' },
      ...history,
      ...(userAlreadyInHistory ? [] : [{ role: 'user' as const, content: instruction, timestamp: '' }]),
    ];
    const usage: TurnUsage = { promptChars: 0, completionChars: 0 };
    this.lastUsage = usage;

    this.lastResponseStreamed = false;
    const tree = new WorkflowTree((line) => {
      process.stdout.write('\r\u001b[2K');
      console.log(line);
    });

    let emptyFollowUpSent = false;

    try {
      for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
        // v0.7: user chose "kirim sekarang" — stop before the next request so
        // the interrupted turn ends cleanly instead of starting new work.
        if (signal?.aborted) {
          if (tree.isTreeActive) {
            tree.finish('Dibatalkan oleh pengguna');
          } else {
            process.stdout.write(yellow('\n⚠ Dibatalkan oleh pengguna\n'));
          }
          return '';
        }
        usage.promptChars += messages.reduce((s, m) => s + m.content.length, 0);
        const usePacman = this.config.funAnimations ?? (this.config.mode !== 'pro');
        const spinner = createSpinner('Thinking', { pacman: usePacman });
        const gate = new LineGate((text) => {
          spinner.stop();
          process.stdout.write('\r\u001b[2K');
          process.stdout.write(formatTerminalMarkdown(text));
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
          if (signal?.aborted || isAbortError(err)) {
            if (tree.isTreeActive) {
              tree.finish('Dibatalkan oleh pengguna');
            } else {
              process.stdout.write(yellow('\n⚠ Dibatalkan oleh pengguna\n'));
            }
            return '';
          }
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
          const text = stripToolBlocks(raw);
          // Tangani Empty Content: Jika respons model setelah eksekusi tool menghasilkan
          // text/content kosong padahal finish_reason adalah "stop", jangan langsung mencetak "(no response)".
          // Kirimkan follow-up message internal (role: "user") untuk meminta model merangkum hasil tool yang baru dijalankan.
          if (!text.trim() && (tree.currentStep > 0 || i > 0) && !emptyFollowUpSent) {
            const finishReason = this.llmProvider.lastFinishReason ?? 'stop';
            if (finishReason === 'stop') {
              emptyFollowUpSent = true;
              messages.push({
                role: 'assistant',
                content: raw.trim(),
                timestamp: new Date().toISOString(),
              });
              messages.push({
                role: 'user',
                content: 'Tolong berikan ringkasan atau rangkuman penjelasan mengenai hasil eksekusi tool di atas untuk menjawab permintaan pengguna.',
                timestamp: new Date().toISOString(),
              });
              continue;
            }
          }

          const finalText = text || (tree.currentStep > 0 ? 'Semua langkah tool telah selesai dijalankan.' : '');
          if (tree.isTreeActive || tree.currentStep > 0) {
            tree.finish('Semua langkah tuntas');
            process.stdout.write('\n');
          } else if (iterStreamed) {
            process.stdout.write('\n');
          }
          this.lastResponseStreamed = iterStreamed;
          return finalText;
        }

        // Text streamed before a tool call needs a line break before the logs.
        if (iterStreamed) process.stdout.write('\n');
        const assistantContent = raw.trim();
        const toolCalls = calls.map((c, idx) => ({
          id: (typeof c.id === 'string' && c.id.trim())
            ? c.id.trim()
            : `call_${c.tool}_${i}_${idx}_${Date.now()}`,
          type: 'function' as const,
          function: {
            name: c.tool,
            arguments: JSON.stringify(c),
          },
        }));
        messages.push({
          role: 'assistant',
          content: assistantContent,
          timestamp: new Date().toISOString(),
          tool_calls: toolCalls,
        });

        // Spacing before tool tree begins if not already spaced
        if (tree.currentStep === 0 && !iterStreamed) {
          process.stdout.write('\n');
        }

        // Start workflow step in tree
        const desc = inferStepDescription(calls, tree.currentStep + 1);
        tree.startStep(desc);

        for (let callIdx = 0; callIdx < calls.length; callIdx += 1) {
          const call = calls[callIdx];
          const toolCallId = toolCalls[callIdx]?.id || `call_${call.tool}_${Date.now()}`;
          if (signal?.aborted) {
            if (tree.isTreeActive) {
              tree.finish('Dibatalkan oleh pengguna');
            } else {
              process.stdout.write(yellow('\n⚠ Dibatalkan oleh pengguna\n'));
            }
            return '';
          }
          // §5: Guard mekanis — tolak eksekusi ganda jika tool call berturut-turut persis identik
          const sig = this.getCallSignature(call);
          if (this.lastCallSignature === sig) {
            const warn = 'Perintah identik terdeteksi berulang, dilewati';
            tree.log(yellow(`⚠ ${warn}`));
            messages.push({
              role: 'tool',
              content: `Result of tool "${call.tool}":\n${JSON.stringify({
                skipped: true,
                warning: warn,
                message: `Tool "${call.tool}" dengan argumen identik baru saja dijalankan pada langkah sebelumnya dan hasilnya sudah ada di konteks percakapan di atas. Eksekusi kedua dilewati; silakan lanjutkan dengan menganalisis hasil yang sudah ada atau jalankan aksi berikutnya.`,
              })}`,
              timestamp: new Date().toISOString(),
              tool_call_id: toolCallId,
              name: call.tool,
            });
            continue;
          }
          this.lastCallSignature = sig;

          // §5: loop breaker — identical tool call repeated is a stuck model.
          if (this.seenRepeat(call)) {
            tree.finish('Dihentikan karena deteksi loop');
            return (
              `[deteksi loop] tool "${call.tool}" dengan argumen sama sudah dipanggil ` +
              `> ${LOOP_REPEAT_LIMIT}× — eksekusi dihentikan. Ulangi dengan instruksi lain, ` +
              `atau jalankan manual lewat /exec.`
            );
          }
          const result = await runToolCall(call, {
            confirm: this.confirm,
            config: this.config,
            onLog: (line) => tree.log(line),
            planMode: this.planMode,
            signal,
            llmProvider: this.llmProvider,
            workspaceRoot: this.workspaceRoot,
            subagentDepth: this.subagentDepth,
          });
          if (signal?.aborted) {
            if (tree.isTreeActive) {
              tree.finish('Dibatalkan oleh pengguna');
            } else {
              process.stdout.write(yellow('\n⚠ Dibatalkan oleh pengguna\n'));
            }
            return '';
          }
          messages.push({
            role: 'tool',
            content: `Result of tool "${call.tool}":\n${result}`,
            timestamp: new Date().toISOString(),
            tool_call_id: toolCallId,
            name: call.tool,
          });
        }
      }

      if (tree.isTreeActive) {
        tree.finish('Mencapai batas iterasi tool');
      }

      return '[agent] reached max tool iterations without a final answer; stopping.';
    } finally {
      if (usage.promptChars > 0 || usage.completionChars > 0) {
        const pTok = Math.round(usage.promptChars / 4);
        const cTok = Math.round(usage.completionChars / 4);
        this.sessionUsage.promptChars += usage.promptChars;
        this.sessionUsage.completionChars += usage.completionChars;
        this.sessionUsage.promptTokens += pTok;
        this.sessionUsage.completionTokens += cTok;
        this.sessionUsage.totalTokens += (pTok + cTok);
        this.sessionUsage.totalTurns += 1;
      }
    }
  }

  /** Generates a normalized signature for a tool call to detect exact identical duplicates. */
  private getCallSignature(call: ToolCall): string {
    const { tool, ...rest } = call;
    const sortedKeys = Object.keys(rest).sort();
    const sortedObj: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      sortedObj[k] = rest[k];
    }
    return `${tool}:${JSON.stringify(sortedObj)}`;
  }

  /** Counts tool+args signatures; true when this call crossed the repeat cap. */
  private seenRepeat(call: ToolCall): boolean {
    const sig = this.getCallSignature(call);
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
