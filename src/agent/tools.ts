import { Confirmer, guardedExecute } from '../core/approval.js';
import { AgentConfig } from '../types.js';
import { renderFileDiff, splitLines } from '../core/diff.js';
import { takeSnapshot } from '../core/undo.js';
import { dim, green, red, yellow } from '../core/ui.js';
import { codeSearchTool, globTool, readFileTool } from './filetools.js';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Hard cap (§5: batasi output tool) applied to every tool result before it
 * re-enters the model context: head + tail, middle folded with a marker.
 */
export const TOOL_RESULT_CHAR_LIMIT = 8_000;

export function capToolResult(text: string, maxChars = TOOL_RESULT_CHAR_LIMIT): string {
  if (text.length <= maxChars) return text;
  const keep = Math.floor((maxChars - 80) / 2);
  return (
    `${text.slice(0, keep)}\n[... TRUNCATED ${text.length - 2 * keep} chars — persempit filter/offset ...]\n` +
    text.slice(text.length - keep)
  );
}

/**
 * Search-replace patch (§5: edit via search-replace, not full rewrite).
 * `oldText` must occur exactly once unless `replaceAll` is set.
 * Throws Error with a human message when the match is missing or ambiguous.
 */
export function applySearchReplace(
  content: string,
  oldText: string,
  newText: string,
  replaceAll = false,
): string {
  if (!oldText) throw new Error('patch_file: "oldText" kosong.');
  if (oldText === newText) throw new Error('patch_file: oldText dan newText identik — tidak ada yang diubah.');
  const first = content.indexOf(oldText);
  if (first === -1) {
    throw new Error('patch_file: oldText tidak ditemukan — baca ulang file dan salin snippet persis (spasi/indentasi).');
  }
  const second = content.indexOf(oldText, first + 1);
  if (second !== -1 && !replaceAll) {
    throw new Error('patch_file: oldText lebih dari satu kali — perluas snippet agar unik, atau set "replaceAll": true.');
  }
  return replaceAll
    ? content.split(oldText).join(newText)
    : `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
}


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

/** Dependencies a tool call may need (approval gate, UI logger). */
export interface ToolDeps {
  confirm?: Confirmer | null;
  config?: AgentConfig;
  /** Called with lines to display live in the terminal (action logs, diffs). */
  onLog?: (line: string) => void;
  /**
   * Plan mode (§6): enforced in CODE, not just prompt — mutating tools are
   * refused outright while the CLI has it active.
   */
  planMode?: boolean;
  /** v0.7: abort signal — an interrupted turn kills its running exec child. */
  signal?: AbortSignal;
  /**
   * Roadmap #5: LLM provider for the guardian second layer.
   * Passed through to guardedExecute for semantic command analysis.
   */
  llmProvider?: import('../agent/llm.js').LLMProvider | null;
  /** Callback for guardian status UI indicator. */
  onGuardianStatus?: (message: string | null) => void;
}

/** Tools refused while plan mode is active (read_file stays available). */
const PLAN_MODE_BLOCKED = new Set(['exec', 'write_file', 'edit_file', 'patch_file']);

/** Working directory used by file tools (always the user's cwd). */
function resolveToolPath(p: string): string {
  return path.resolve(process.cwd(), p);
}

/** Shared implementation for edit_file / write_file with colored diff display. */
async function writeWithDiff(
  abs: string,
  fileLabel: string,
  newContent: string,
  onLog?: (line: string) => void,
): Promise<string> {
  const existed = existsSync(abs);
  const oldContent = existed ? await readFile(abs, 'utf8') : '';
  if (existed && oldContent === newContent) {
    onLog?.(yellow(`🟡 Edit(${fileLabel}) — tidak ada perubahan`));
    return JSON.stringify({ ok: true, note: 'File sudah berisi konten yang sama; tidak ada perubahan.' });
  }
  // Undo safety net (§6): snapshot the old state before any mutation.
  takeSnapshot(abs);
  await writeFile(abs, newContent, 'utf8');
  onLog?.(green(`🟢 Edit(${fileLabel})`));
  const diff = renderFileDiff(
    fileLabel,
    oldContent,
    newContent,
    { context: 3, maxLines: 120 },
  );
  onLog?.(diff);
  return JSON.stringify(
    existed
      ? { ok: true, path: fileLabel, message: 'File diperbarui sesuai diff di atas.' }
      : { ok: true, path: fileLabel, message: 'File baru dibuat.', lines: splitLines(newContent).length },
    null,
    2,
  );
}

/** Executes a parsed tool call; the result is char-capped before re-entering context. */
export async function runToolCall(call: ToolCall, deps: ToolDeps = {}): Promise<string> {
  // §6: plan mode is a CODE guarantee, not a prompt request.
  if (deps.planMode && PLAN_MODE_BLOCKED.has(call.tool)) {
    return capToolResult(
      JSON.stringify({
        error: `plan mode aktif: tool "${call.tool}" diblok (hanya baca yang boleh). Matikan dengan /plan off setelah rencana disetujui.`,
      }),
    );
  }
  return capToolResult(await runToolCallRaw(call, deps));
}

async function runToolCallRaw(call: ToolCall, deps: ToolDeps): Promise<string> {
  switch (call.tool) {
    case 'exec': {
      const command = String(call.command ?? '');
      if (!command) {
        return JSON.stringify({ error: 'exec: missing "command" field' });
      }
      const config = deps.config ?? ({ approvalEnabled: false } as AgentConfig);
      const short = command.length > 60 ? `${command.slice(0, 57)}…` : command;
      deps.onLog?.(green(`🟢 Bash(${short})`));
      const result = await guardedExecute(
        command,
        {
          timeoutMs: typeof call.timeoutMs === 'number' ? call.timeoutMs : undefined,
          confirm: deps.confirm ?? null,
          signal: deps.signal,
          llmProvider: deps.llmProvider,
          onGuardianStatus: deps.onGuardianStatus,
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
      deps.onLog?.(green(`🟢 Read(${file})`));
      const result = await readFileTool(file, {
        offset: typeof call.offset === 'number' ? call.offset : undefined,
        limit: typeof call.limit === 'number' ? call.limit : undefined,
      });
      return result.ok
        ? result.text
        : JSON.stringify({ error: result.text });
    }
    case 'glob': {
      const pattern = typeof call.pattern === 'string'
        ? call.pattern
        : (typeof call.query === 'string' ? call.query : '');
      const searchPath = typeof call.path === 'string'
        ? call.path
        : (typeof call.dir === 'string' ? call.dir : '.');
      deps.onLog?.(green(`🟢 Glob(${pattern || searchPath})`));
      const result = await globTool(pattern, {
        path: searchPath,
        limit: typeof call.limit === 'number' ? call.limit : undefined,
      });
      return result.ok
        ? result.text
        : JSON.stringify({ error: result.text });
    }
    case 'code_search': {
      const query = String(call.query ?? call.keyword ?? call.pattern ?? '');
      if (!query) {
        return JSON.stringify({ error: 'code_search: missing "query" field' });
      }
      const searchPath = typeof call.path === 'string'
        ? call.path
        : (typeof call.dir === 'string' ? call.dir : '.');
      const ext = typeof call.extension === 'string'
        ? call.extension
        : (typeof call.ext === 'string' ? call.ext : undefined);
      deps.onLog?.(green(`🟢 Search(${query})`));
      const result = await codeSearchTool(query, {
        path: searchPath,
        extension: ext,
        isRegex: call.isRegex === true,
        caseSensitive: call.caseSensitive === true,
        limit: typeof call.limit === 'number'
          ? call.limit
          : (typeof call.maxMatches === 'number' ? call.maxMatches : undefined),
        contextLines: typeof call.contextLines === 'number' ? call.contextLines : undefined,
      });
      return result.ok
        ? result.text
        : JSON.stringify({ error: result.text });
    }
    case 'edit_file':
    case 'write_file': {
      const file = String(call.path ?? call.file ?? '');
      if (!file) {
        return JSON.stringify({ error: `${call.tool}: missing "path" field` });
      }
      const content = typeof call.content === 'string' ? call.content : null;
      if (content == null) {
        return JSON.stringify({ error: `${call.tool}: missing "content" field (string)` });
      }
      const abs = resolveToolPath(file);
      const rel = path.relative(process.cwd(), abs) || file;
      if (call.tool === 'write_file' && existsSync(abs)) {
        return JSON.stringify({
          error: 'write_file: file sudah ada. Gunakan tool "edit_file" untuk menimpa dengan diff.',
        });
      }
      try {
        return await writeWithDiff(abs, rel, content, deps.onLog);
      } catch (err) {
        return JSON.stringify({
          error: `${call.tool}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    case 'patch_file': {
      const file = String(call.path ?? call.file ?? '');
      if (!file) {
        return JSON.stringify({ error: 'patch_file: missing "path" field' });
      }
      const oldText = typeof call.oldText === 'string' ? call.oldText : null;
      const newText = typeof call.newText === 'string' ? call.newText : null;
      if (oldText == null || newText == null) {
        return JSON.stringify({ error: 'patch_file: missing "oldText"/"newText" (strings)' });
      }
      const abs = resolveToolPath(file);
      const rel = path.relative(process.cwd(), abs) || file;
      if (!existsSync(abs)) {
        return JSON.stringify({ error: `patch_file: file tidak ada: ${rel} (pakai write_file untuk file baru)` });
      }
      try {
        const before = await readFile(abs, 'utf8');
        const after = applySearchReplace(before, oldText, newText, call.replaceAll === true);
        return await writeWithDiff(abs, rel, after, deps.onLog);
      } catch (err) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    default:
      return JSON.stringify({ error: `unknown tool: ${call.tool}` });
  }
}