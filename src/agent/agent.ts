import { sep } from 'node:path';
import type { Confirmer } from '../core/approval.js';
import { Context } from '../core/context.js';
import { ActivityTray } from '../core/activity.js';
import { isFileMutationLogLine, parseFileMutationLogLine, renderMutationSummary } from '../core/diffui.js';
import {
  activityIconForTool,
  activityLabelForTool,
  describeToolCallForLog,
  extractThoughts,
  inferStepDescription,
  LineGate,
  RevealFilter,
  stripThoughtBlocks,
  TerminalMarkdownFormatter,
  ReasoningPanel,
  ThoughtStreamParser,
  WorkflowTree,
  yellow,
} from '../core/ui.js';
import { AgentConfig, ContextMessage, createDefaultSessionState, SessionState } from '../types.js';
import { LLMProvider } from './llm.js';
import {
  allRoles,
  buildSystemPrompt,
  formatEnvironmentContext,
  getBuiltInRole,
  readProjectAgentDoc,
  RoleDef,
} from './roles.js';
import {
  getWorkspaceRoot,
  parseToolCalls,
  runToolCall,
  safeExecPrecheck,
  stripToolBlocks,
  ToolCall,
} from './tools.js';
import { getEnvProfile } from '../core/env.js';
import { readMemorySafe } from '../core/memory.js';
import { formatSkillsForPrompt, initDefaultSkills, loadSkillsContext, scanSkills } from '../core/skills.js';
import { detectPlanOptionSelection } from '../core/plan.js';
import { saveHostState, type HostState } from '../core/state/hostState.js';
import type { ScopeAmendmentManager } from '../core/approval/scopeAmendment.js';

/** Safety cap on how many tool iterations one instruction may trigger (default 30). */
export const DEFAULT_MAX_TOOL_ITERATIONS = 30;

/** §5.35 — same tool+args invoked more than this many times = likely loop. */
const LOOP_REPEAT_LIMIT = 2;

/** Tool read-only resmi yang terdaftar di codebase (rujuk IDEMPOTENT_READ_TOOLS). */
export const IDEMPOTENT_READ_TOOLS = new Set([
  'read_file',
  'glob',
  'list_dir',
  'list_directory',
  'code_search',
  'read_logs',
  'read_process_logs',
]);

/** Tool mutating untuk Build mode phase transition (Fase 1). */
export const BUILD_MUTATING_TOOLS = new Set([
  'write_file',
  'edit_file',
  'patch_file',
  'delete_file',
  'exec',
]);

/** Parameter injection per-SessionState ke loop detector (Fase 1). */
export interface LoopDetectorParams {
  loopThreshold: number;
  consecutiveThreshold: number;
  cycleThreshold: number;
  softWarningThreshold: number;
  readOnlyRelaxed: boolean;
}

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
  private _planMode = false;

  /**
   * Status plan mode adalah PROYEKSI langsung dari
   * `hostState.mode` ('plan' | 'act') bila HostState terikat — sehingga
   * `/plan on`, auto-off pemilihan rencana, dan reset saat resume tidak pernah
   * menyimpang dari state kanonis di ~/.ruko/sessions/.
   * Tanpa HostState (unit test / subagent non-bound) nilai in-memory dipakai.
   */
  get planMode(): boolean {
    return this.hostState ? this.hostState.mode === 'plan' : this._planMode;
  }

  set planMode(value: boolean) {
    this._planMode = value;
    if (!this.hostState) return;
    const next = value ? 'plan' : 'act';
    if (this.hostState.mode !== next) {
      this.hostState.mode = next;
      // Persistensi atomik: setiap transisi mode plan/act langsung tersimpan.
      void saveHostState(this.hostState).catch(() => {});
    }
  }
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
  /** Tracks consecutive failed turns for context rollback (req.md Fase IV). */
  private consecutiveFailedTurns = 0;
  /** Maximum consecutive failed turns before rollback (default 2). */
  private readonly maxConsecutiveFailedTurns = 2;
  /** Fase 3: panel Reasoning aktif saat ini (null di luar turn). */
  private reasoningPanel: ReasoningPanel | null = null;
  /** Fase 3: mode expand/collapse panel Reasoning untuk turn berjalan. */
  private reasoningExpanded = false;
  /** Fase 4: mode expand/collapse block detail diff (Ctrl+D). */
  private diffDetailExpanded = false;

  /** Fase 3: toggle expand/collapse panel Reasoning (Ctrl+R dari loop/TUI). */
  toggleReasoningExpanded(): void {
    this.reasoningExpanded = !this.reasoningExpanded;
    this.reasoningPanel?.toggle(this.reasoningExpanded ? 'expanded' : 'collapsed');
  }

  /** Fase 3: status expand panel Reasoning saat ini (untuk status bar/test). */
  get isReasoningExpanded(): boolean {
    return this.reasoningExpanded;
  }

  /** Fase 4: toggle expand/collapse block detail diff (Ctrl+D dari loop/TUI). */
  toggleDiffDetailExpanded(): void {
    this.diffDetailExpanded = !this.diffDetailExpanded;
    // Me-render ulang SEMUA block mutasi turn berjalan dengan mode baru:
    // payload JSON (old/new) dari writeWithDiff membuat re-render persis
    // tanpa baca disk ulang. Console.log aman — patched stdout editor
    // memindah output di bawah area input (v0.7).
    if (this.mutationSummaryBuffer) {
      for (const line of this.mutationSummaryBuffer) {
        const info = parseFileMutationLogLine(line);
        if (!info) continue;
        const rendered = renderMutationSummary({
          tool: info.tool,
          fileLabel: info.fileLabel,
          stats: { added: info.added, removed: info.removed },
          mode: this.diffDetailExpanded ? 'expanded' : 'collapsed',
          oldText: info.oldText,
          newText: info.newText,
        });
        console.log(rendered);
      }
    }
  }

  /** Fase 4: status expand detail diff saat ini (untuk test). */
  get isDiffDetailExpanded(): boolean {
    return this.diffDetailExpanded;
  }

  /**
   * Fase 4: baris mutasi turn berjalan (ter-enkode) — sumber re-render
   * toggle Ctrl+D; state per-instance, bukan global singleton.
   */
  private mutationSummaryBuffer: string[] | null = null;

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

  private hostState: HostState | null = null;
  private scopeAmendmentManager: ScopeAmendmentManager | null = null;

  /** Mengikat HostState v2.0.0 (dual-plane state kanonis di ~/.ruko/sessions/). */
  setHostState(state: HostState | null): void {
    this.hostState = state;
    if (state) {
      this.planMode = state.mode === 'plan';
    }
  }

  getHostState(): HostState | null {
    return this.hostState;
  }

  /** Mengikat ScopeAmendmentManager v2.0.0 (subtree auto-approval & circuit breaker). */
  setScopeAmendmentManager(manager: ScopeAmendmentManager | null): void {
    this.scopeAmendmentManager = manager;
  }

  getScopeAmendmentManager(): ScopeAmendmentManager | null {
    return this.scopeAmendmentManager;
  }

  /** Persist the host mode and its scope before allowing the next tool call. */
  async setPlanMode(on: boolean, options: { userAuthorized?: boolean } = {}): Promise<void> {
    if (this.hostState) {
      const previousMode = this.hostState.mode;
      const previousScope = this.hostState.approvalScope;
      try {
        if (on) {
          this.hostState.approvalScope = null;
        } else if (!this.hostState.approvalScope) {
          if (!this.scopeAmendmentManager) {
            throw new Error('SCOPE_BOOTSTRAP_DENIED: scope manager belum terpasang.');
          }
          this.scopeAmendmentManager.seedWorkspaceScope(options.userAuthorized === true);
        }
        this.hostState.mode = on ? 'plan' : 'act';
        try {
          await saveHostState(this.hostState);
        } catch (cause) {
          const code = cause instanceof Error ? (cause as NodeJS.ErrnoException).code : undefined;
          const detail = cause instanceof Error ? cause.message : String(cause);
          // The REPL logs the propagated error once; direct callers retain its cause.
          throw new Error(
            `HOST_STATE_SAVE_FAILED: saveHostState gagal untuk transisi ${previousMode.toUpperCase()} → ${on ? 'PLAN' : 'ACT'}` +
            ` (${this.hostState.sessionId})${code ? ` [${code}]` : ''}: ${detail}. Transisi dibatalkan.`,
            { cause },
          );
        }
      } catch (err) {
        this.hostState.mode = previousMode;
        this.hostState.approvalScope = previousScope;
        throw err;
      }
    }
    this.planMode = on;
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

  /** State mode per-sesi in-memory (Fase 1: Default, Research, Code, Build). */
  public sessionState: SessionState = createDefaultSessionState();

  /** Reset state sesi ke nilai default tiap sesi baru. */
  resetSessionState(): void {
    this.sessionState = createDefaultSessionState();
  }

  /** Parameter injection loop detector per-SessionState (Fase 1). */
  public getLoopDetectorParams(tool: string): LoopDetectorParams {
    const isReadOnly = IDEMPOTENT_READ_TOOLS.has(tool);
    const mode = this.sessionState?.mode ?? 'default';
    let relaxed = false;

    if (mode === 'research' && isReadOnly) {
      relaxed = true;
    } else if (mode === 'build' && this.sessionState?.buildPhase === 'explore' && isReadOnly) {
      relaxed = true;
    }

    if (relaxed) {
      return {
        loopThreshold: 10,
        consecutiveThreshold: 10,
        cycleThreshold: 10,
        softWarningThreshold: 10,
        readOnlyRelaxed: true,
      };
    }

    return {
      loopThreshold: LOOP_REPEAT_LIMIT,
      consecutiveThreshold: 2,
      cycleThreshold: 2,
      softWarningThreshold: 2,
      readOnlyRelaxed: false,
    };
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

  /**
   * Layered system prompt: identity + tools + role + environment (OS/shell) +
   * AGENT.md + mode (§4) + memory + skills.
   *
   * Konteks lingkungan dirakit DI SINI (bukan di roles.ts) karena hanya agent
   * yang punya akses ke workspace root + envProfile aktif. `getEnvProfile()`
   * adalah sumber kebenaran yang sama dipakai `executor.ts` untuk memilih shell,
   * sehingga prompt dan eksekusi tidak pernah berbeda pendapat soal OS/shell.
   */
  systemPrompt(): string {
    const ws = this.workspaceRoot ?? getWorkspaceRoot();
    initDefaultSkills(ws);
    const skills = scanSkills(ws, { includeGlobal: true });
    const availableSkillsXml = formatSkillsForPrompt(skills);
    const skillsInstructions = loadSkillsContext(skills);
    const combinedSkills = [availableSkillsXml, skillsInstructions].filter(Boolean).join('\n\n');
    const envProfile = getEnvProfile();

    return buildSystemPrompt({
      role: this.activeRole(),
      planMode: this.planMode,
      mode: this.config.mode ?? 'beginner',
      agentDoc: readAgentDocSafe(),
      memory: readMemorySafe(ws),
      skills: combinedSkills,
      environment: formatEnvironmentContext({
        platform: process.platform,
        arch: process.arch,
        shellFamily: envProfile.shellFamily,
        shellBinary: envProfile.defaultShell,
        pathSeparator: sep,
        workspaceRoot: ws,
        flavor: envProfile.flavor,
      }),
    });
  }

  /** Returns the assistant's textual response ('' when nothing to say). */
  async handleInstruction(instruction: string, signal?: AbortSignal): Promise<string> {
    const startTime = Date.now();
    this.callCounts.clear();
    this.lastCallSignature = null;
    this.consecutiveRepeatCount = 0;
    this.lastUsage = null;

    // Plan Mode Auto-Off: jika Plan Mode aktif dan pengguna memilih salah satu opsi bernomor,
    // matikan plan mode otomatis dan arahkan instruksi untuk mengeksekusi opsi tersebut.
    if (this.planMode) {
      const lastAssistant = this.ctx
        .getMessages()
        .slice()
        .reverse()
        .find((m) => m.role === 'assistant');
      const planSelection = detectPlanOptionSelection(lastAssistant?.content, instruction);
      if (planSelection) {
        await this.setPlanMode(false, { userAuthorized: true });
        instruction = planSelection.augmentedInstruction;
      }
    }

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
      const result = JSON.parse(await runToolCall({ tool: 'exec', command: cmd }, {
        config: this.config, confirm: this.confirm, llmProvider: this.llmProvider,
        workspaceRoot: ws, hostState: this.hostState, planMode: this.planMode,
        scopeAmendmentManager: this.scopeAmendmentManager,
      }));
      if (result.error) return result.error;
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
    let lastRawResponse = '';
    let lastHadToolCalls = false;
    const executedMutatingTools = new Set<string>();
    const MUTATING_TOOLS = new Set([
      'write_file',
      'edit_file',
      'patch_file',
      'delete_file',
      'move_file',
      'revert_file',
    ]);
    const turnToolCache = new Map<string, string>();

    const maxIterations = this.config.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    let hasSeparatedFromTools = false;
    // Fase 3: setiap instruksi baru mulai dengan panel Reasoning COLLAPSED;
    // state expand hiduk di instance agar Ctrl+R bisa men-toggle saat turn jalan.
    this.reasoningExpanded = false;
    this.reasoningPanel = null;
    this.diffDetailExpanded = false;
    // Fase 4: log baris mutasi turn ini — sumber re-render toggle Ctrl+D.
    this.mutationSummaryBuffer = [];

    this.callHistory = [];
    this.callCounts.clear();
    this.consecutiveRepeatCount = 0;
    this.lastCallSignature = null;
    let consecutiveThoughtOnlyCount = 0;

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
        const mdFormatter = new TerminalMarkdownFormatter();

        // Fase 3: panel Reasoning TERPISAH dari log tool call — box section
        // sendiri, default COLLAPSED ("• Thought for Xs"), expand/collapse
        // via Ctrl+R. Env RUKO_SHOW_REASONING=1 tetap memaksa expanded.
        const showFullReasoning =
          process.env.RUKO_SHOW_REASONING === '1' || process.env.RUKO_REASONING === '1';
        const reasoningPanel = new ReasoningPanel({
          getMode: () =>
            showFullReasoning || this.reasoningExpanded ? 'expanded' : 'collapsed',
          // "Y tokens" HANYA dicetak bila API usage tersedia dari provider;
          // selain itu null → baris collapsed cukup "Thought for Xs".
          getTokens: () =>
            (this.llmProvider as { lastUsage?: { completionTokens?: number } | null }).lastUsage
              ?.completionTokens ?? null,
          onPermanent: (line) => console.log(line),
        });
        this.reasoningPanel = reasoningPanel;

        const finishThinking = () => {
          if (reasoningPanel.isFinished()) return;
          if (showFullReasoning) this.reasoningExpanded = true;
          reasoningPanel.finish();
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
        // feedback.txt item 1b: reasoning chunks run through their OWN reveal
        // filter, so a tool call emitted inside the thought stream can never
        // spill into the reasoning ticker as ordinary text.
        const thoughtReveal = new RevealFilter((text) => reasoningPanel.feed(text));
        let streamedThought = '';
        const thoughtParser = new ThoughtStreamParser({
          onText: (text) => reveal.feed(text),
          onThought: (thoughtChunk) => {
            streamedThought += thoughtChunk;
            thoughtReveal.feed(thoughtChunk);
          },
          onThoughtEnd: () => {
            // Fase 3: akhiri SEGMEN reasoning ini (baris collapsed / box per
            // segmen) tanpa mematikan panel — <thought> berikutnya buka segmen baru.
            reasoningPanel.finishSegment();
          },
        });
        let raw: string;
        try {
          raw = await this.llmProvider.chat(messages, {
            onToken: (token) => thoughtParser.feed(token),
            onThought: (chunk) => {
              streamedThought += chunk;
              thoughtReveal.feed(chunk);
            },
            signal,
            maxTokens: this.config.maxOutputTokens ?? 4096,
            // Fase 2: wiring /reasoning → parameter provider di llm.ts.
            reasoning: this.sessionState.reasoningLevel,
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
          thoughtReveal.end();
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
          const hasThought =
            streamedThought.trim().length > 0 ||
            extractThoughts(raw).length > 0 ||
            /<thought>|<think>|\*Thought:/i.test(raw) ||
            Boolean((this.llmProvider as { lastReasoning?: string | null }).lastReasoning);

          // Circuit breaker untuk thought loop (feedback.txt item 2):
          // Jika agent menghasilkan respons "thought" tanpa tool_calls DAN tanpa teks jawaban ke user
          // sebanyak 3-4 kali berturut-turut dalam satu turn, paksa loop berhenti dengan error deskriptif.
          if (hasThought && !text.trim()) {
            consecutiveThoughtOnlyCount += 1;
            if (consecutiveThoughtOnlyCount >= 4) {
              if (tree.isTreeActive) {
                tree.finish('Agent terjebak dalam thought loop');
              }
              const errMsg = 'Agent terjebak dalam thought loop tanpa memanggil tool.';
              this.lastResponseStreamed = false;
              lastRawResponse = errMsg;
              lastHadToolCalls = tree.currentStep > 0;
              return errMsg;
            }

            // Tambahkan jeda minimum (500ms-1s) sebelum mengirim giliran berikutnya jika turn sebelumnya
            // hanya menghasilkan thought tanpa aksi, untuk mengurangi risiko memicu rate limit provider.
            const configuredDelay = process.env.RUKO_THOUGHT_LOOP_DELAY_MS
              ? Number(process.env.RUKO_THOUGHT_LOOP_DELAY_MS)
              : 500;
            const delayMs = Number.isNaN(configuredDelay) ? 500 : configuredDelay;
            if (delayMs > 0 && !signal?.aborted) {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, delayMs);
                signal?.addEventListener('abort', () => {
                  clearTimeout(timer);
                  resolve();
                }, { once: true });
              });
            }

            if (signal?.aborted) {
              if (tree.isTreeActive) {
                tree.finish('Dibatalkan oleh pengguna');
              } else {
                process.stdout.write(yellow('\n⚠ Dibatalkan oleh pengguna\n'));
              }
              return '';
            }

            messages.push({
              role: 'assistant',
              content: raw.trim() || '<thought></thought>',
              timestamp: new Date().toISOString(),
            });
            messages.push({
              role: 'user',
              content: 'Fase thinking telah selesai. Silakan panggil tool yang diperlukan melalui interface function call resmi atau berikan jawaban akhir langsung kepada pengguna.',
              timestamp: new Date().toISOString(),
            });
            continue;
          }

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
          lastRawResponse = raw;
          lastHadToolCalls = tree.currentStep > 0;
          return finalText;
        }

        hasSeparatedFromTools = false;
        consecutiveThoughtOnlyCount = 0;

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

          // Build mode phase transition:
          // Begitu tool mutating (write_file, edit_file, patch_file, delete_file, exec) dipanggil pertama kali,
          // beralih ke 'mutate' (ketat) PERMANEN sampai /mode diganti manual atau sesi baru.
          if (
            this.sessionState.mode === 'build' &&
            this.sessionState.buildPhase === 'explore' &&
            BUILD_MUTATING_TOOLS.has(call.tool)
          ) {
            this.sessionState.buildPhase = 'mutate';
          }

          // Injected loop detector parameters based on SessionState and tool whitelist (Fase 1)
          const loopParams = this.getLoopDetectorParams(call.tool);

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
          // - Pemanggilan berturut-turut > params.consecutiveThreshold kali (consecutive loop)
          // - Terdeteksi siklus N-gram berulang > params.cycleThreshold kali (cycle loop)
          // - Tool signature dipanggil ulang melebihi repeat cap (> params.loopThreshold)
          if (
            this.consecutiveRepeatCount > loopParams.consecutiveThreshold ||
            (cycle && cycle.count > loopParams.cycleThreshold) ||
            (this.callCounts.get(sig) ?? 0) > loopParams.loopThreshold
          ) {
            if (tree.isTreeActive) {
              tree.finish('Dihentikan karena deteksi loop');
            }
            const cycleInfo = (cycle && cycle.count > loopParams.cycleThreshold)
              ? `siklus pemanggilan ${cycle.cycleLength} tool berulang ${cycle.count}×`
              : `tool "${call.tool}" dengan argumen sama sudah dipanggil > ${loopParams.loopThreshold}×`;
            return (
              `[deteksi loop] ${cycleInfo} — eksekusi dihentikan paksa. Dilarang melanjutkan pembacaan berulang atau printf. Berikan respons akhir sekarang berdasarkan data yang sudah terkumpul.`
            );
          }

          // 2. Jika perintah terdeteksi identik berturut-turut atau duplikat dalam batch yang sama,
          // cegah eksekusi ulang I/O dan kirim warning terstandarisasi dengan intervensi aktif.
          if (
            this.consecutiveRepeatCount === loopParams.softWarningThreshold ||
            (isBatchDuplicate && !loopParams.readOnlyRelaxed)
          ) {
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
              onLog: (line) => {
                // Fase 4: baris mutasi berkas (marker \f) — buffer untuk
                // re-render Ctrl+D, dan hanya RINGKASAN yang masuk UI tree
                // (diff legacy di belakang baris tidak ditampilkan saat
                // collapsed; tersedia via toggle Ctrl+D dari payload JSON).
                if (isFileMutationLogLine(line)) {
                  const summaryOnly = line.split('\n')[0];
                  if (this.mutationSummaryBuffer) this.mutationSummaryBuffer.push(summaryOnly);
                }
                tree.log(line);
              },
              planMode: this.planMode,
              signal,
              llmProvider: this.llmProvider,
              workspaceRoot: this.workspaceRoot,
              subagentDepth: this.subagentDepth,
              activityTray: this.activityTray,
              hostState: this.hostState ?? undefined,
              scopeAmendmentManager: this.scopeAmendmentManager ?? undefined,
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

      lastRawResponse = '[agent] reached max tool iterations without a final answer; stopping.';
      lastHadToolCalls = tree.currentStep > 0;
      return '[agent] reached max tool iterations without a final answer; stopping.';
    } finally {
      // Context sanitization / rollback (req.md Fase IV)
      this.maybeRollbackContext(lastRawResponse, lastHadToolCalls);
      
      this.reasoningPanel = null;
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

  /**
   * Detects anomalous token patterns in model output (token collapse, spam, etc.)
   * per req.md Fase IV - Context Contamination & Token Collapse.
   */
  private detectTokenCollapse(text: string): boolean {
    if (!text) return false;
    // Detect Mandarin spam tokens (from req.md)
    const mandarinSpam = /网彩票|大发娱乐|天天中彩票|彩票怎样/i;
    // Detect ChatML token leakage
    const chatmlLeak = /<\|channel\|>|commentary to=functions/;
    // Detect excessive repetition of same characters/tokens
    const excessiveRepeat = /(.)\1{50,}/; // same char 50+ times
    // Detect malformed analysis tags
    const malformedAnalysis = /<\/analysis>\s*[🎮\?\s]*<\/analysis>/i;
    
    return mandarinSpam.test(text) || chatmlLeak.test(text) || excessiveRepeat.test(text) || malformedAnalysis.test(text);
  }

  /**
   * Rolls back the last assistant message from context if turn failed
   * (req.md Fase IV: Context Sanitization / Rollback Middleware).
   */
  private maybeRollbackContext(rawResponse: string, hadToolCalls: boolean): void {
    const isFailedTurn = !hadToolCalls && (
      rawResponse.trim().length === 0 ||
      this.detectTokenCollapse(rawResponse) ||
      rawResponse.includes('[agent] reached max tool iterations')
    );

    if (isFailedTurn) {
      this.consecutiveFailedTurns += 1;
      if (this.consecutiveFailedTurns >= this.maxConsecutiveFailedTurns) {
        // Rollback: remove last assistant message from context
        const ctxMessages = this.ctx.toJSON();
        let lastIdx = -1;
        for (let i = ctxMessages.length - 1; i >= 0; i--) {
          if (ctxMessages[i].role === 'assistant') {
            lastIdx = i;
            break;
          }
        }
        if (lastIdx !== -1) {
          ctxMessages.splice(lastIdx, 1);
          // Rebuild context without the failed assistant message
          this.ctx.clear();
          for (const msg of ctxMessages) {
            this.ctx.add(msg.role, msg.content);
          }
        }
        this.consecutiveFailedTurns = 0;
      }
    } else {
      // Reset counter on successful turn
      this.consecutiveFailedTurns = 0;
    }
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
