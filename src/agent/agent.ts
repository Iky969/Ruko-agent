import { Confirmer, guardedExecute } from '../core/approval.js';
import { Context } from '../core/context.js';
import { AgentConfig, ContextMessage } from '../types.js';
import { LLMProvider } from './llm.js';
import { parseToolCalls, runToolCall, stripToolBlocks } from './tools.js';

/** Safety cap on how many tool iterations one instruction may trigger. */
const MAX_TOOL_ITERATIONS = 6;

/**
 * System prompt for the AI backend. The backtick blocks instruct the model
 * how to request shell execution through the tool protocol.
 */
const SYSTEM_PROMPT =
  'You are an AI coding agent CLI running on the user\'s machine. ' +
  'You help with software engineering tasks by reading files and executing terminal commands.\n\n' +
  'Rules:\n' +
  '- To run a shell command, reply with a single fenced block:\n' +
  '```tool\n{"tool": "exec", "command": "<command>", "cwd": null, "timeoutMs": 30000}\n```\n' +
  '- To read a text file (numbered lines, paginated), reply with:\n' +
  '```tool\n{"tool": "read_file", "path": "<file>", "offset": 1, "limit": 200}\n```\n' +
  '  Use offset/limit to page through large files; the result reports the total line count.\n' +
  '- Prefer read_file over cat/head/tail; use exec for everything else.\n' +
  '- After receiving the tool result, either run another tool or answer in plain text.\n' +
  '- Large command output is summarized with [... TRUNCATED ...] markers; work with what remains and re-run a narrower command if needed.\n' +
  '- Prefer safe, non-destructive commands. Never run git push unless the user asks.\n' +
  '- Keep replies concise: quote key log lines (errors, exit codes) and explain what they mean.\n';

/**
 * Orchestrates user instructions.
 *
 * Two modes:
 *  - Manual mode (no LLM configured): heuristics only — "run <cmd>" executes,
 *    everything else is acknowledged and stored in context.
 *  - LLM mode: sends the instruction plus context history to the backend and
 *    runs the tool loop (exec → observe → decide) until the model answers.
 */
export class Agent {
  private confirm: Confirmer | null = null;

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
    this.confirm = confirm;
  }

  /** The LLM backend in use (exposed so the loop can report status). */
  get llm(): LLMProvider {
    return this.llmProvider;
  }

  /** True when the AI backend is configured and will be used. */
  get isLlmMode(): boolean {
    return this.llmProvider.isConfigured;
  }

  /** Returns the assistant's textual response ('' when nothing to say). */
  async handleInstruction(instruction: string): Promise<string> {
    return this.llmProvider.isConfigured
      ? this.runWithLlm(instruction)
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

  /** LLM mode: agent loop with tool calls. */
  private async runWithLlm(instruction: string): Promise<string> {
    const history = this.ctx.window(this.config.maxContextChars);
    const messages: ContextMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT, timestamp: '' },
      ...history,
      { role: 'user', content: instruction, timestamp: '' },
    ];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i += 1) {
      const raw = await this.llmProvider.chat(messages);
      const calls = parseToolCalls(raw);
      if (calls.length === 0) {
        return stripToolBlocks(raw) || '(no response)';
      }

      const text = stripToolBlocks(raw);
      if (text) {
        messages.push({ role: 'assistant', content: text, timestamp: '' });
      }
      for (const call of calls) {
        const result = await runToolCall(call, {
          confirm: this.confirm,
          config: this.config,
        });
        messages.push({
          role: 'tool',
          content: `Result of tool "${call.tool}":\n${result}`,
          timestamp: '',
        });
      }
    }

    return '[agent] reached max tool iterations without a final answer; stopping.';
  }
}