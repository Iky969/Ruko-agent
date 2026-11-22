import { AgentConfig, ContextMessage, ContextRole, DEFAULT_AUTO_COMPRESS_THRESHOLD_CHARS } from '../types.js';
import { compressHistory } from './compressor.js';

/**
 * Bounded conversation memory for the agent.
 *
 * Messages accumulate during the session; `window()` provides the most recent
 * messages that fit a char budget, and `trim()` drops the oldest messages once
 * the total size exceeds `config.maxContextChars`.
 */
export class Context {
  private messages: ContextMessage[] = [];

  constructor(private readonly config: AgentConfig) {}

  get size(): number {
    return this.messages.length;
  }

  get totalChars(): number {
    return this.messages.reduce((sum, m) => sum + m.content.length, 0);
  }

  add(role: ContextRole, content: string): void {
    this.messages.push({ role, content, timestamp: new Date().toISOString() });
  }

  clear(): void {
    this.messages = [];
  }

  /** Add a tool call record to the conversation history. */
  addToolCall(toolName: string, args: Record<string, unknown>): void {
    this.messages.push({
      role: 'tool_call' as ContextRole,
      content: JSON.stringify({ tool: toolName, args }),
      timestamp: new Date().toISOString(),
    });
  }

  /** Add a tool result record to the conversation history. */
  addToolResult(toolName: string, result: string): void {
    this.messages.push({
      role: 'tool' as ContextRole,
      content: `[${toolName}] ${result}`,
      timestamp: new Date().toISOString(),
    });
  }

  /** Replaces the whole history (used when resuming a saved session). */
  replace(messages: ContextMessage[]): void {
    this.messages = [...messages];
  }

  getMessages(): ContextMessage[] {
    return [...this.messages];
  }

  toJSON(): ContextMessage[] {
    return [...this.messages];
  }

  /** Most recent messages that fit inside `maxChars`. */
  window(maxChars: number): ContextMessage[] {
    const out: ContextMessage[] = [];
    let used = 0;
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      const m = this.messages[i];
      if (used + m.content.length > maxChars) break;
      out.unshift(m);
      used += m.content.length;
    }
    return out;
  }

  /**
   * Auto-compress: folds the oldest turns into one digest message, but ONLY
   * when auto-compress is enabled and the history has reached
   * autoCompressThresholdChars (default 500_000). Below the threshold the
   * history is left intact, so long sessions keep full detail and the agent
   * does not re-do early steps it has "forgotten". Returns the number of
   * chars removed (0 when auto-compress is off, the threshold is not
   * reached yet, or the history already fits / cannot be compressed).
   *
   * The fold target is the threshold itself, capped by maxContextChars —
   * the per-turn window() still only sends the most recent maxContextChars,
   * so raising the threshold above maxContextChars alone does not widen
   * what the model sees per turn. Use /compact (compressNow) for a manual
   * fold at any time; it is not affected by this setting.
   */
  compress(keepLast = 6): number {
    if (this.config.autoCompress === false) return 0;
    const threshold = this.config.autoCompressThresholdChars ?? DEFAULT_AUTO_COMPRESS_THRESHOLD_CHARS;
    if (this.totalChars < threshold) return 0;
    return this.compressTo(Math.min(this.config.maxContextChars, threshold), keepLast);
  }

  /** Forced compaction (`/compact`): folds toward 65% of the budget (§5). */
  compressNow(keepLast = 4): number {
    return this.compressTo(Math.floor(this.config.maxContextChars * 0.65), keepLast);
  }

  private compressTo(targetChars: number, keepLast: number): number {
    const before = this.totalChars;
    const result = compressHistory(this.messages, {
      targetChars,
      keepLast,
      maxPerMessageChars: 200,
    });
    const removed = before - totalChars(result);
    if (removed > 0) {
      this.messages = result;
    }
    return removed;
  }
}

function totalChars(messages: ContextMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.length, 0);
}