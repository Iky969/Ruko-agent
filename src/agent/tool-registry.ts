/**
 * Dynamic Tool Registry — modular container for tool definitions and handlers.
 * Replaces the static TOOL_DEFINITIONS array and monolithic switch dispatcher.
 */
import type { ToolCall } from './tools.js';

/** OpenAI-compatible function tool definition. */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** Context passed to every tool handler at execution time. */
export interface ToolHandlerContext {
  confirm?: ((command: string, reason: string) => Promise<boolean>) | null;
  config: Record<string, unknown>;
  onLog?: (line: string) => void;
  planMode?: boolean;
  signal?: AbortSignal;
  llmProvider?: unknown;
  workspaceRoot?: string;
  subagentDepth?: number;
}

/** A tool handler function receives the parsed call and context, returns a string result. */
export type ToolHandler = (call: ToolCall, ctx: ToolHandlerContext) => Promise<string>;

/** Entry in the registry combining definition + handler. */
export interface ToolEntry {
  definition: ToolDefinition;
  handler: ToolHandler;
  source: 'builtin' | 'external';
}

/**
 * ToolRegistry — manages tool definitions and dispatches execution.
 * Supports dynamic registration of both built-in and external tools.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolEntry>();

  /** Register a tool with its definition and handler. */
  register(entry: ToolEntry): void {
    this.tools.set(entry.definition.function.name, entry);
  }

  /** Unregister a tool by name. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Check if a tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Get a single tool entry. */
  get(name: string): ToolEntry | undefined {
    return this.tools.get(name);
  }

  /** Get all tool definitions (for sending to LLM). */
  getDefinitions(filter?: { source?: 'builtin' | 'external' }): ToolDefinition[] {
    const entries = [...this.tools.values()];
    if (filter?.source) {
      return entries.filter(e => e.source === filter.source).map(e => e.definition);
    }
    return entries.map(e => e.definition);
  }

  /** Get all registered tool names. */
  getNames(): string[] {
    return [...this.tools.keys()];
  }

  /** Get count of registered tools. */
  get size(): number {
    return this.tools.size;
  }

  /** Execute a tool call by dispatching to the registered handler. */
  async execute(call: ToolCall, ctx: ToolHandlerContext): Promise<string> {
    const entry = this.tools.get(call.tool);
    if (!entry) {
      return `Error: Tool "${call.tool}" tidak ditemukan dalam registry.`;
    }
    return entry.handler(call, ctx);
  }

  /** List all tools with their source for debugging/display. */
  list(): Array<{ name: string; description: string; source: 'builtin' | 'external' }> {
    return [...this.tools.values()].map(e => ({
      name: e.definition.function.name,
      description: e.definition.function.description,
      source: e.source,
    }));
  }
}

/** Singleton default registry instance. */
export const defaultRegistry = new ToolRegistry();
