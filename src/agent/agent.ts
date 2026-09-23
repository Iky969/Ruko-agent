import { Confirmer, guardedExecute } from '../core/approval.js';
import { Context } from '../core/context.js';
import { ActivityTray } from '../core/activity.js';
import {
  activityIconForTool,
  activityLabelForTool,
  describeToolCallForLog,
  formatDuration,
  formatTerminalMarkdown,
  green,
  inferStepDescription,
  LineGate,
  RevealFilter,
  stripThoughtBlocks,
  TerminalMarkdownFormatter,
  ThinkingTicker,
  ThoughtStreamParser,
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
import { formatSkillsForPrompt, initDefaultSkills, loadSkillsContext, scanSkills } from '../core/skills.js';

/** Safety cap on how many tool iterations one instruction may trigger (default 30). */
export const DEFAULT_MAX_TOOL_ITERATIONS = 30;

/** §5.35 — same tool+args invoked more than this many times = likely loop. */
const LOOP_REPEAT_LIMIT = 2;

/** Per-instruction token-ish usage snapshot (chars, provider-agnostic). */
export interface TurnUsage {
  promptChars: number;
  completionChars: number;
  durationMs?: number;
  cacheTokens?: number;
}

/** Cumulative token usage tracked across an entire interactive session. */
export interface SessionUsage {
  promptChars: number;
  completionChars: number;
  promptTokens: number;
  completionTokens: number;
  cacheTokens: number;
  totalTokens: number;
  totalTurns: number;
  activeWorkingMs: number;
  lastTurnDurationMs: number;
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
    cacheTokens: 0,
    totalTokens: 0,
    totalTurns: 0,
    activeWorkingMs: 0,
    lastTurnDurationMs: 0,
  };
  /** Plan mode toggle — enforced at the tool layer, not just in the prompt. */
  planMode = false;
  /**
   * Live bottom activity tray (feedback §4). Shared with the REPL: the loop
   * draws `activityTray.renderRows()` inside the editor's live region, and a
   * subagent inherits its parent's tray so delegation is visible while it runs.
   */
  activityTray: ActivityTray = new ActivityTray();
  /** Monotonic id source for tray activities (unique per depth). */
  private activitySeq = 0;
  private callCounts = new Map<string, number>();
  /** Tracks the most recent executed tool call signature to guard against consecutive duplicates (§5). */
  private lastCallSignature: string | null = null;
  /** Tracks consecutive repetitive calls with identical signature. */
  private consecutiveRepeatCount = 0;
  /** Sliding window history of recent tool call signatures for N-gram cycle detection. */
  private callHistory: string[] = [];

  constructor(
    private readonly ctx: Context,
    private llmProvider: LLMProvider,
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

  /** Replaces the LLM provider instance live in memory (e.g. after /login). */
  setLlmProvider(provider: LLMProvider): void {
    this.llmProvider = provider;
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
      cacheTokens: 0,
      totalTokens: 0,
      totalTurns: 0,
      activeWorkingMs: 0,
      lastTurnDurationMs: 0,
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
    initDefaultSkills(ws);
    const skills = scanSkills(ws, { includeGlobal: true });
    const availableSkillsXml = formatSkillsForPrompt(skills);
    const skillsInstructions = loadSkillsContext(skills);
    const combinedSkills = [availableSkillsXml, skillsInstructions].filter(Boolean).join('\n\n');

    return buildSystemPrompt({
      role: this.activeRole(),
      planMode: this.planMode,
      mode: this.config.mode ?? 'beginner',
      agentDoc: readAgentDocSafe(),
      memory: readMemorySafe(ws),
      skills: combinedSkills,
    });
  }

  /** Returns the assistant's textual response ('' when nothing to say). */
  async handleInstruction(instruction: string, signal?: AbortSignal): Promise<string> {
    const startTime = Date.now();
    this.callCounts.clear();
    this.lastCallSignature = null;
    this.consecutiveRepeatCount = 0;
    this.lastUsage = null;
    try {
      return await (this.llmProvider.isConfigured
        ? this.runWithLlm(instruction, signal)
        : this.runManual(instruction));
    } finally {
      const elapsed = Date.now() - startTime;
      this.sessionUsage.activeWorkingMs += elapsed;
      this.sessionUsage.lastTurnDurationMs = elapsed;
      const u = this.lastUsage as TurnUsage | null;
      if (u) {
        u.durationMs = elapsed;
      }
    }
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
    const history = this.ctx.window(this.config.maxContextChars).filter(
      (m) => m.role !== 'tool_call' && m.role !== 'tool'
    );
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
    // Branch action-log history (feedback §3/§4): each tool call is committed
    // to scrollback exactly once, as `├── [n] …`, the moment it finishes.
    const tree = new WorkflowTree((line) => {
      process.stdout.write('\r\u001b[2K');
      console.log(line);
    }, { compact: true, branch: true });

    let emptyFollowUpSent = false;
    let actionNudgeSent = false;
    const executedMutatingTools = new Set<string>();
    const MUTATING_TOOLS = new Set([
      'write_file',
      'edit_file',
      'patch_file',
      'delete_file',
      'move_file',
      'revert_file',
    ]);
    const IDEMPOTENT_READ_TOOLS = new Set([
      'read_file',
      'glob',
      'list_dir',
      'list_directory',
      'code_search',
      'read_logs',
    ]);
    const turnToolCache = new Map<string, string>();

    const maxIterations = this.config.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    let hasSeparatedFromTools = false;

    this.callHistory = [];
    this.callCounts.clear();
    this.consecutiveRepeatCount = 0;
    this.lastCallSignature = null;

    try {
      for (let i = 0; i < maxIterations; i += 1) {
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
        const ticker = new ThinkingTicker();
        const mdFormatter = new TerminalMarkdownFormatter();

        const finishThinking = () => {
          if (ticker.isFinished()) return;
          const showFull = process.env.RUKO_SHOW_REASONING === '1' || process.env.RUKO_REASONING === '1';
          if (showFull && ticker.getBuffered().trim()) {
            const framed = ticker.renderFramedReasoning();
            ticker.flush();
            if (framed) {
              console.log(framed);
            }
            return;
          }
          const summary = ticker.flush();
          if (summary) {
            console.log(summary);
          }
        };

        const gate = new LineGate((text) => {
          finishThinking();
          process.stdout.write('\r\u001b[2K');
          if (tree.currentStep > 0 && !hasSeparatedFromTools) {
            hasSeparatedFromTools = true;
            process.stdout.write('\n');
          }
          process.stdout.write(mdFormatter.format(text));
        });
        const reveal = new RevealFilter((text) => gate.push(text));
        const thoughtParser = new ThoughtStreamParser({
          onText: (text) => reveal.feed(text),
          onThought: (thoughtChunk) => ticker.feed(thoughtChunk),
          onThoughtEnd: () => {
            finishThinking();
          },
        });
        let raw: string;
        try {
          raw = await this.llmProvider.chat(messages, {
            onToken: (token) => thoughtParser.feed(token),
            onThought: (chunk) => ticker.feed(chunk),
            signal,
            maxTokens: this.config.maxOutputTokens ?? 4096,
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
          thoughtParser.end();
          finishThinking();
          reveal.end();
        }
        usage.completionChars += raw.length;
        const { calls, malformedBlocks } = parseToolCalls(raw);
        // Final answers keep their trailing line; tool iterations drop the dangling
        // preamble that sat right before the hidden ```tool block (§2).
        const iterStreamed = gate.finish(calls.length === 0 && malformedBlocks.length === 0);
        finishThinking();

        if (malformedBlocks.length > 0 && calls.length === 0) {
          if (process.env.DEBUG || process.env.RUKO_DEBUG) {
            console.error(`[DEBUG] Malformed tool-call detected: ${malformedBlocks.join('; ')}`);
          }
          messages.push({
            role: 'assistant',
            content: raw.trim(),
            timestamp: new Date().toISOString(),
          });
          const isTagError = malformedBlocks.some((b) => /^[<＜]/.test(b.trim()));
          messages.push({
            role: 'tool',
            content: isTagError
              ? '[FORMAT ERROR: Tag tool-call tidak valid atau rusak (terdeteksi tag malformed / karakter non-ASCII di nama tag). Jangan gunakan tag mentah atau rusak. Gunakan format blok tool Markdown standar yang valid:\n```tool\n{"tool": "<nama_tool>", ...}\n```\nSilakan ulangi pemanggilan tool dengan format yang benar.]'
              : '[FORMAT ERROR: Tool call JSON tidak valid. Periksa format JSON Anda — pastikan tidak ada trailing commas, semua string menggunakan double quotes, dan struktur JSON valid. Coba ulangi tool call dengan format yang benar.]',
            timestamp: new Date().toISOString(),
          });
          continue;
        }

        if (calls.length === 0) {
          const text = stripThoughtBlocks(stripToolBlocks(raw));

          // Multi-step task completion guard:
          // If the instruction requested modification (edit/fix/write), but only inspection tools ran,
          // nudge the agent to apply the requested edit instead of prematurely halting.
          const isActionTask = /\b(perbaiki|edit|ubah|ganti|tulis|buat|hapus|fix|patch|write|modify|repair|update|implement|resolve)\b/i.test(instruction);
          const hasMutated = executedMutatingTools.size > 0;

          if (isActionTask && !hasMutated && (tree.currentStep > 0 || i > 0) && !actionNudgeSent && i < maxIterations - 1) {
            actionNudgeSent = true;
            messages.push({
              role: 'assistant',
              content: raw.trim(),
              timestamp: new Date().toISOString(),
            });
            messages.push({
              role: 'user',
              content: 'Instruksi meminta untuk memperbaiki/mengubah kode atau berkas, namun sejauh ini baru tahap pemeriksaan/pembacaan dan belum ada tool modifikasi (seperti patch_file, edit_file, atau write_file) yang dipanggil. Silakan bernalar dalam <thought> dan lanjutkan dengan memanggil tool yang sesuai untuk menerapkan perbaikan tersebut sekarang.',
              timestamp: new Date().toISOString(),
            });
            continue;
          }

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
          if (tree.currentStep > 0 && !hasSeparatedFromTools) {
            hasSeparatedFromTools = true;
            process.stdout.write('\n');
          }
          if (tree.isTreeActive || tree.currentStep > 0) {
            tree.finish('Semua langkah tuntas');
            process.stdout.write('\n');
          } else if (iterStreamed) {
            process.stdout.write('\n');
          }
          this.lastResponseStreamed = iterStreamed;
          return finalText;
        }

        hasSeparatedFromTools = false;

        for (const call of calls) {
          if (MUTATING_TOOLS.has(call.tool)) {
            executedMutatingTools.add(call.tool);
          }
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

        const batchSignatures = new Set<string>();

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

          // Item 2 & Solusi 2: Deteksi pemanggilan tool berulang & siklus N-gram
          const sig = this.getCallSignature(call);
          const isBatchDuplicate = batchSignatures.has(sig);
          batchSignatures.add(sig);

          if (sig === this.lastCallSignature) {
            this.consecutiveRepeatCount += 1;
          } else {
            this.consecutiveRepeatCount = 1;
            this.lastCallSignature = sig;
          }

          // Cycle detection across steps (N-gram cycle detector)
          const cycle = this.detectCycle(this.callHistory, sig);

          // 1. Interupsi loop agen jika:
          // - Pemanggilan berturut-turut > 2 kali (consecutive loop)
          // - Terdeteksi siklus N-gram berulang > 2 kali (cycle loop)
          // - Tool signature dipanggil ulang melebihi repeat cap (> LOOP_REPEAT_LIMIT)
          if (
            this.consecutiveRepeatCount > 2 ||
            (cycle && cycle.count > 2) ||
            (this.callCounts.get(sig) ?? 0) > LOOP_REPEAT_LIMIT
          ) {
            if (tree.isTreeActive) {
              tree.finish('Dihentikan karena deteksi loop');
            }
            const cycleInfo = (cycle && cycle.count > 2)
              ? `siklus pemanggilan ${cycle.cycleLength} tool berulang ${cycle.count}×`
              : `tool "${call.tool}" dengan argumen sama sudah dipanggil > ${LOOP_REPEAT_LIMIT}×`;
            return (
              `[deteksi loop] ${cycleInfo} — eksekusi dihentikan. Silakan simpulkan atau lanjutkan ke respons akhir berdasarkan data yang sudah ada di riwayat.`
            );
          }

          // 2. Jika perintah terdeteksi identik berturut-turut atau duplikat dalam batch yang sama,
          // cegah eksekusi ulang I/O dan kirim warning terstandarisasi.
          if (this.consecutiveRepeatCount === 2 || isBatchDuplicate) {
            const warn = 'Perintah identik terdeteksi berulang, dilewati';
            tree.log(yellow(`⚠ ${warn}`));
            messages.push({
              role: 'tool',
              content: `[WARNING: Tindakan ini baru saja dijalankan dengan hasil yang sama. Dilarang memanggil ulang tool ini. Gunakan data yang sudah ada di riwayat dan segera lanjutkan ke langkah analisis atau eksekusi berikutnya.]\n(Tool "${call.tool}" dengan argumen identik baru saja dijalankan pada langkah sebelumnya dan hasilnya sudah ada di konteks percakapan di atas. Eksekusi kedua dilewati; silakan lanjutkan dengan menganalisis hasil yang sudah ada atau jalankan aksi berikutnya.)`,
              timestamp: new Date().toISOString(),
              tool_call_id: toolCallId,
              name: call.tool,
            });
            this.callHistory.push(sig);
            continue;
          }

          // Solusi 3: In-turn idempotent tool cache.
          // Jika tool read-only sudah pernah dijalankan pada turn ini dengan argumen identik
          // dan tidak ada mutasi file sejak itu, gunakan hasil dari cache tanpa disk I/O ulang.
          if (IDEMPOTENT_READ_TOOLS.has(call.tool) && turnToolCache.has(sig)) {
            const cachedResult = turnToolCache.get(sig)!;
            tree.beginAction();
            tree.completeAction(`${describeToolCallForLog(call)} — cached`, 0);
            this.ctx.addToolCall(call.tool, call as Record<string, unknown>);
            this.ctx.addToolResult(call.tool, cachedResult);
            messages.push({
              role: 'tool',
              content: cachedResult,
              timestamp: new Date().toISOString(),
              tool_call_id: toolCallId,
              name: call.tool,
            });
            this.callHistory.push(sig);
            continue;
          }

          const toolStart = Date.now();
          // Feedback §4: the call is a live runner in the bottom tray while it
          // runs, and becomes ONE `├── ` history line when it finishes.
          tree.beginAction();
          const activityId = `tool:${this.subagentDepth}:${++this.activitySeq}`;
          this.activityTray.start(activityId, activityLabelForTool(call), {
            icon: activityIconForTool(call),
            group: 'tool',
          });
          let result: string;
          try {
            result = await runToolCall(call, {
              confirm: this.confirm,
              config: this.config,
              onLog: (line) => tree.log(line),
              planMode: this.planMode,
              signal,
              llmProvider: this.llmProvider,
              workspaceRoot: this.workspaceRoot,
              subagentDepth: this.subagentDepth,
              activityTray: this.activityTray,
            });
          } finally {
            const toolElapsedMs = Date.now() - toolStart;
            this.activityTray.finish(activityId);
            tree.completeAction(describeToolCallForLog(call), toolElapsedMs);
          }
          if (signal?.aborted) {
            if (tree.isTreeActive) {
              tree.finish('Dibatalkan oleh pengguna');
            } else {
              process.stdout.write(yellow('\n⚠ Dibatalkan oleh pengguna\n'));
            }
            return '';
          }
          if (IDEMPOTENT_READ_TOOLS.has(call.tool)) {
            turnToolCache.set(sig, result);
          } else if (MUTATING_TOOLS.has(call.tool) || call.tool === 'exec') {
            turnToolCache.clear();
          }
          this.ctx.addToolCall(call.tool, call as Record<string, unknown>);
          this.ctx.addToolResult(call.tool, result);
          messages.push({
            role: 'tool',
            content: `Result of tool "${call.tool}":\n${result}`,
            timestamp: new Date().toISOString(),
            tool_call_id: toolCallId,
            name: call.tool,
          });
          this.callHistory.push(sig);
          if (this.callHistory.length > 100) {
            this.callHistory.shift();
          }
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
        const cached = (this.llmProvider as any)?.lastUsage?.cachedTokens ?? 0;
        if (cached > 0) {
          usage.cacheTokens = cached;
          this.sessionUsage.cacheTokens += cached;
        }
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

  /**
   * Detects if appending `nextSig` creates a repeating cycle of length k (where 2 <= k <= 25)
   * that has occurred at least twice consecutively in execution history.
   */
  private detectCycle(history: string[], nextSig: string): { cycleLength: number; count: number } | null {
    const seq = [...history, nextSig];
    const maxK = Math.min(25, Math.floor(seq.length / 2));
    for (let k = 2; k <= maxK; k++) {
      const pattern = seq.slice(-k);
      let count = 1;
      let pos = seq.length - 2 * k;
      while (pos >= 0) {
        let match = true;
        for (let i = 0; i < k; i++) {
          if (seq[pos + i] !== pattern[i]) {
            match = false;
            break;
          }
        }
        if (match) {
          count++;
          pos -= k;
        } else {
          break;
        }
      }
      if (count >= 2) {
        return { cycleLength: k, count };
      }
    }
    return null;
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
