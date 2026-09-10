/**
 * Shared type definitions for the AI Coding Agent CLI.
 */

/** Role of a message inside the agent's conversation context. */
export type ContextRole = 'system' | 'user' | 'assistant' | 'tool';

/** One entry in the conversation context (the agent's memory). */
export interface ContextMessage {
  role: ContextRole;
  content: string;
  /** ISO timestamp when the message was recorded. */
  timestamp: string;
}

/** Result of running a shell command. */
export interface ExecResult {
  command: string;
  /** Process exit code; `null` when the process was killed (e.g. timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr combined. */
  output: string;
  durationMs: number;
  /** `true` when the log summarizer cut the captured output. */
  truncated: boolean;
}

/** Result of the log summarizer. */
export interface SummaryResult {
  originalLength: number;
  truncated: boolean;
  summary: string;
}

/** Tuning knobs for the agent. */
export interface AgentConfig {
  /** Context budget in chars; the loop compresses memory above this. */
  maxContextChars: number;
  /** Log summarizer threshold in chars (spec: 1000). */
  maxLogChars: number;
  /** Default timeout for shell commands, in ms. */
  execTimeoutMs: number;
  /** Ask the user before running risky commands (approval gate). */
  approvalEnabled: boolean;
  /** Commands containing these substrings skip the approval gate. */
  approvalAllowlist: string[];
  /** Default LLM model name (used by the OpenAI-compatible provider). */
  model: string;
}

export const DEFAULT_CONFIG: AgentConfig = {
  maxContextChars: 30_000,
  maxLogChars: 1_000,
  execTimeoutMs: 30_000,
  approvalEnabled: true,
  approvalAllowlist: [],
  model: 'gpt-4o-mini',
};