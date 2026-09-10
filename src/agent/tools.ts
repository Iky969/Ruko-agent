import { Confirmer, guardedExecute } from '../core/approval.js';
import { AgentConfig } from '../types.js';
import { readFileTool } from './filetools.js';

/**
 * Minimal tool-calling protocol.
 *
 * The LLM asks for a tool by emitting a fenced block:
 *
 * ```tool
 * {"tool": "exec", "command": "ls -la", "cwd": null, "timeoutMs": 30000}
 * ```
 *
 * The agent extracts all such blocks, executes them, and feeds the results
 * back into the conversation as `tool` messages.
 */

export interface ToolCall {
  tool: string;
  [key: string]: unknown;
}

const TOOL_BLOCK_RE = /```tool\s*\n([\s\S]*?)```/g;

/** Extracts all tool-call blocks from a model reply. */
export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const match of text.matchAll(TOOL_BLOCK_RE)) {
    try {
      const parsed = JSON.parse(match[1].trim()) as ToolCall;
      if (parsed && typeof parsed.tool === 'string' && parsed.tool.length > 0) {
        calls.push(parsed);
      }
    } catch {
      // Malformed block — ignore it, the model may still have answered in text.
    }
  }
  return calls;
}

/** Removes tool-call blocks from a model reply, keeping any surrounding text. */
export function stripToolBlocks(text: string): string {
  return text.replace(TOOL_BLOCK_RE, '').trim();
}

/** Dependencies a tool call may need (approval gate). */
export interface ToolDeps {
  confirm?: Confirmer | null;
  config?: AgentConfig;
}

/** Executes a parsed tool call and returns a string result (already summarized). */
export async function runToolCall(call: ToolCall, deps: ToolDeps = {}): Promise<string> {
  switch (call.tool) {
    case 'exec': {
      const command = String(call.command ?? '');
      if (!command) {
        return JSON.stringify({ error: 'exec: missing "command" field' });
      }
      const config = deps.config ?? ({ approvalEnabled: false } as AgentConfig);
      const result = await guardedExecute(
        command,
        {
          timeoutMs: typeof call.timeoutMs === 'number' ? call.timeoutMs : undefined,
          confirm: deps.confirm ?? null,
        },
        config,
      );
      return JSON.stringify(
        {
          code: result.code,
          output: result.output,
          durationMs: result.durationMs,
          truncated: result.truncated,
        },
        null,
        2,
      );
    }
    case 'read_file': {
      const file = String(call.path ?? call.file ?? '');
      if (!file) {
        return JSON.stringify({ error: 'read_file: missing "path" field' });
      }
      const result = await readFileTool(file, {
        offset: typeof call.offset === 'number' ? call.offset : undefined,
        limit: typeof call.limit === 'number' ? call.limit : undefined,
      });
      return result.ok
        ? result.text
        : JSON.stringify({ error: result.text });
    }
    default:
      return JSON.stringify({ error: `unknown tool: ${call.tool}` });
  }
}