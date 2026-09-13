import { Context } from '../core/context.js';
import { Agent } from './agent.js';
import { AgentConfig } from '../types.js';
import { LLMProvider } from './llm.js';
import { Confirmer } from '../core/approval.js';

/**
 * Subagent delegation runner (Roadmap #3).
 *
 * Spawns an isolated subagent instance with its own fresh Context to solve
 * a self-contained sub-problem or research query, and returns the final
 * condensed answer back to the parent turn to conserve context window.
 */

export interface SubagentOptions {
  /** Maximum tool iterations for the subagent (default 5). */
  maxIterations?: number;
  /** Role for the subagent (default: 'minimal' for concise token-efficient output). */
  role?: string;
  /** Workspace root directory boundary. */
  workspaceRoot?: string;
  /** Plan mode inheritance. */
  planMode?: boolean;
}

export interface SubagentDeps {
  config: AgentConfig;
  llmProvider: LLMProvider;
  confirm?: Confirmer | null;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
}

export async function runSubagent(
  task: string,
  deps: SubagentDeps,
  options: SubagentOptions = {},
): Promise<string> {
  // Create an isolated subagent context
  const subConfig: AgentConfig = {
    ...deps.config,
    role: options.role ?? 'minimal',
    maxContextChars: Math.min(deps.config.maxContextChars, 20_000),
  };

  const subCtx = new Context(subConfig);
  const subAgent = new Agent(subCtx, deps.llmProvider, subConfig, deps.confirm, options.workspaceRoot);
  if (options.planMode) {
    subAgent.planMode = true;
  }

  const prompt =
    `You are a delegated subagent working on a focused task.\n` +
    `Task: ${task}\n` +
    `Instructions: Solve the task using tools if necessary and provide a concise, direct summary of your findings or results.`;

  const result = await subAgent.handleInstruction(prompt, deps.signal);
  return result.trim() || '(subagent finished without output)';
}
