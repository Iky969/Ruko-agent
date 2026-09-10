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

/** User experience mode — affects defaults only, never the engine (§7). */
export type UiMode = 'beginner' | 'pro';

/**
 * A named provider profile (§2 multi-profil): switch quickly with
 * `/profile <alias>` (hemat, kuat, lokal, ...).
 */
export interface ProviderProfile {
  /** Currently only 'openai-compatible' is supported. */
  provider?: string;
  baseUrl?: string;
  model?: string;
  /** Env var holding the API key (preferred for CI/pro — key never on disk). */
  apiKeyEnv?: string;
  /** Literal key stored in the config file (file is chmod 600). */
  apiKey?: string;
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
  /** API key for the OpenAI-compatible endpoint (set by `/config setup`). */
  apiKey?: string;
  /** Custom base URL for the OpenAI-compatible endpoint. */
  baseUrl?: string;
  /** beginner (role teacher + tips) or pro (role minimal, terse). */
  mode?: UiMode;
  /** Active role name: default|reviewer|teacher|minimal or a custom file. */
  role?: string;
  /** Named provider profiles keyed by alias. */
  profiles?: Record<string, ProviderProfile>;
  /** Alias used when no explicit activeProfile is set. */
  defaultProfile?: string;
  /** Alias currently in effect (set by `/profile`). */
  activeProfile?: string;
}

export const DEFAULT_CONFIG: AgentConfig = {
  maxContextChars: 30_000,
  maxLogChars: 1_000,
  execTimeoutMs: 30_000,
  approvalEnabled: true,
  approvalAllowlist: [],
  model: 'qwen3.8-flash',
  mode: 'beginner',
  role: 'default',
};

/**
 * Resolve the active provider profile over a base config (§2).
 *
 * Priority: `activeProfile` → `defaultProfile` → no profile (fields untouched).
 * Key resolution inside a profile: `apiKeyEnv` (environment) wins, then the
 * literal `apiKey`. Missing profile / empty fields fall back gracefully.
 * Pure — returns a new object, never mutates the input.
 */
export function resolveProfileCredentials(
  config: AgentConfig,
  env: Record<string, string | undefined> = process.env,
): AgentConfig {
  const alias = config.activeProfile || config.defaultProfile;
  if (!alias) return config;
  const profile = config.profiles?.[alias];
  if (!profile) return config;
  const out: AgentConfig = { ...config, activeProfile: alias };
  if (profile.baseUrl) out.baseUrl = profile.baseUrl;
  if (profile.model) out.model = profile.model;
  const envKey = profile.apiKeyEnv ? env[profile.apiKeyEnv] : undefined;
  const key = (envKey || profile.apiKey || '').trim();
  if (key) out.apiKey = key;
  return out;
}
