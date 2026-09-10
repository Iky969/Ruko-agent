import { AgentConfig, ContextMessage, ContextRole } from '../types.js';
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

  /** Replaces the whole history (used when resuming a saved session). */
  replace(messages: ContextMessage[]): void {
    this.messages = [...messages];
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
   * Compresses the oldest turns into one digest message until the total fits
   * the configured budget. Returns the number of chars removed (0 when the
   * history already fits or cannot be compressed further).
   */
  compress(keepLast = 6): number {
    return this.compressTo(this.config.maxContextChars, keepLast);
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