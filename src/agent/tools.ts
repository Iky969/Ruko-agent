import { chainedSegments, Confirmer, guardedExecute, isYoloMode } from '../core/approval.js';
import { AgentConfig, DEFAULT_CONFIG } from '../types.js';
import { renderFileDiff, splitLines } from '../core/diff.js';
import { takeSnapshot } from '../core/undo.js';
import { cyan, dim, green, magenta, red, yellow } from '../core/ui.js';
import { codeSearchTool, globTool, readFileTool } from './filetools.js';
import { appendMemory } from '../core/memory.js';
import { listSkills, readSkill, saveSkill } from '../core/skills.js';
import { searchSessions } from '../core/session.js';
import { runSubagent } from './subagent.js';
import { webFetchTool } from './webtools.js';
import { defaultProcessManager } from './processManager.js';
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
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
  /**
   * Workspace root directory for file sandboxing (H1 fix).
   * Defaults to process.cwd() in production, but tests or callers can set
   * an explicit workspace boundary.
   */
  workspaceRoot?: string;
}

/** Tools refused while plan mode is active (read_file stays available). */
const PLAN_MODE_BLOCKED = new Set([
  'exec',
  'start_process',
  'write_file',
  'edit_file',
  'patch_file',
  'delete_file',
  'move_file',
  'remember',
  'save_skill',
]);

let customWorkspaceRoot: string | null = null;

/** Sets an explicit global workspace root (e.g. for test suites). */
export function setWorkspaceRoot(root: string | null): void {
  customWorkspaceRoot = root ? path.resolve(root) : null;
}

/** Resolves the active workspace root. */
export function getWorkspaceRoot(): string {
  return customWorkspaceRoot ?? process.env.RUKO_WORKSPACE ?? process.cwd();
}

/**
 * Asserts that an absolute path is inside the workspace boundary.
 * Exported for use by filetools.ts path validation.
 */
export function assertInsideWorkspace(abs: string, workspaceRoot: string = getWorkspaceRoot()): void {
  const cwd = path.resolve(workspaceRoot);
  // Normalise both to trailing-sep for prefix comparison so that
  // /project-foo doesn't match /project as a valid workspace.
  const cwdPrefix = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  if (abs !== cwd && !abs.startsWith(cwdPrefix)) {
    throw new Error(
      `Path "${abs}" di luar working directory — akses file di luar project tidak diizinkan. ` +
      `Workspace: ${cwd}`,
    );
  }
}

/**
 * Resolves a tool file path relative to workspace root and validates sandbox boundary.
 */
function resolveToolPath(p: string, workspaceRoot: string = getWorkspaceRoot()): string {
  const cwd = path.resolve(workspaceRoot);
  const abs = path.resolve(cwd, p);
  assertInsideWorkspace(abs, cwd);
  return abs;
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

export interface WorkspaceMutationCheck {
  blocked: boolean;
  toolAdvice?: string;
  message?: string;
}

/**
 * Checks if a target path is located inside the workspace boundary.
 */
export function isPathInsideWorkspace(targetPath: string, workspaceRoot: string = getWorkspaceRoot()): boolean {
  try {
    const cwd = path.resolve(workspaceRoot);
    const clean = targetPath.replace(/^['"]|['"]$/g, '').trim();
    if (!clean) return false;
    const abs = path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(cwd, clean);
    const cwdPrefix = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
    return abs === cwd || abs.startsWith(cwdPrefix);
  } catch {
    return false;
  }
}

/**
 * Helper to extract non-flag arguments from a command string.
 */
function extractCommandArgs(argStr: string): string[] {
  const tokens: string[] = [];
  const re = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(argStr)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[0]);
  }
  return tokens;
}

/**
 * Point 6: Detects if a shell command in exec is attempting basic file mutation operations
 * ('rm', 'mv', 'truncate', or empty redirect '> file') on files inside the workspace.
 * When detected, execution is refused and directed to official tools ('delete_file'/'move_file')
 * which enforce approval gates and automatic undo snapshots (.ruko/undo/).
 */
export function detectWorkspaceMutationInExec(
  command: string,
  workspaceRoot: string = getWorkspaceRoot(),
): WorkspaceMutationCheck {
  const segments = chainedSegments(command);

  for (const seg of segments) {
    const s = seg.trim().replace(/^sudo\s+/, '');

    // 1. Empty redirect (e.g. `> file`, `: > file`, `true > file`, `cat /dev/null > file`, `cp /dev/null file`, `echo -n "" > file`)
    const redirectPatterns = [
      /^(?::|true)?\s*>\s*(\S+)/,
      /^cat\s+\/dev\/null\s*>\s*(\S+)/,
      /^cp\s+\/dev\/null\s+(\S+)/,
      /^(?:echo\s+-[a-z]*n[a-z]*\s*["']{2}|printf\s+["']{2})\s*>\s*(\S+)/,
    ];
    for (const pat of redirectPatterns) {
      const match = s.match(pat);
      if (match) {
        const target = match[1];
        if (isPathInsideWorkspace(target, workspaceRoot)) {
          return {
            blocked: true,
            toolAdvice: 'write_file / edit_file',
            message: `exec ditolak: Perintah redirect kosong ('>') mendeteksi target di dalam workspace ("${target}"). Gunakan tool resmi 'write_file' atau 'edit_file' yang memiliki pencadangan otomatis (.ruko/undo/).`,
          };
        }
      }
    }

    // 2. rm / rmdir
    const rmMatch = s.match(/^(?:(?:\/usr)?\/bin\/)?(?:rm|rmdir)(?:\s+|$)(.*)/i);
    if (rmMatch) {
      const args = extractCommandArgs(rmMatch[1] ?? '');
      const targets = args.filter((arg) => !arg.startsWith('-'));
      for (const target of targets) {
        if (isPathInsideWorkspace(target, workspaceRoot)) {
          return {
            blocked: true,
            toolAdvice: 'delete_file',
            message: `exec ditolak: Perintah dasar 'rm' terdeteksi pada path workspace ("${target}"). Gunakan tool resmi 'delete_file' yang sudah wajib approval gate dan backup otomatis (.ruko/undo/).`,
          };
        }
      }
    }

    // 3. mv
    const mvMatch = s.match(/^(?:(?:\/usr)?\/bin\/)?mv(?:\s+|$)(.*)/i);
    if (mvMatch) {
      const args = extractCommandArgs(mvMatch[1] ?? '');
      const targets = args.filter((arg) => !arg.startsWith('-'));
      for (const target of targets) {
        if (isPathInsideWorkspace(target, workspaceRoot)) {
          return {
            blocked: true,
            toolAdvice: 'move_file',
            message: `exec ditolak: Perintah dasar 'mv' terdeteksi pada path workspace ("${target}"). Gunakan tool resmi 'move_file' yang sudah wajib approval gate dan backup otomatis (.ruko/undo/).`,
          };
        }
      }
    }

    // 4. truncate
    const truncMatch = s.match(/^(?:(?:\/usr)?\/bin\/)?truncate(?:\s+|$)(.*)/i);
    if (truncMatch) {
      const args = extractCommandArgs(truncMatch[1] ?? '');
      const targets: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-s' || a === '--size' || a === '-c' || a === '--no-create') {
          if (a === '-s' || a === '--size') i++; // skip size argument
          continue;
        }
        if (a.startsWith('-')) continue;
        targets.push(a);
      }
      for (const target of targets) {
        if (isPathInsideWorkspace(target, workspaceRoot)) {
          return {
            blocked: true,
            toolAdvice: 'write_file / edit_file',
            message: `exec ditolak: Perintah dasar 'truncate' terdeteksi pada path workspace ("${target}"). Gunakan tool resmi 'write_file' atau 'edit_file' yang memiliki pencadangan otomatis (.ruko/undo/).`,
          };
        }
      }
    }
  }

  return { blocked: false };
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
  const ws = deps.workspaceRoot ?? getWorkspaceRoot();
  switch (call.tool) {
    case 'exec': {
      const command = String(call.command ?? '');
      if (!command) {
        return JSON.stringify({ error: 'exec: missing "command" field' });
      }

      const mutationCheck = detectWorkspaceMutationInExec(command, ws);
      if (mutationCheck.blocked) {
        deps.onLog?.(yellow(`⚠ Exec ditolak: gunakan tool resmi ${mutationCheck.toolAdvice}`));
        return JSON.stringify({
          error: mutationCheck.message,
        });
      }

      const config = deps.config ?? DEFAULT_CONFIG;
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
          onLog: deps.onLog,
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
      }, ws);
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
      }, ws);
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
      }, ws);
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
      let abs: string;
      let rel: string;
      try {
        abs = resolveToolPath(file, ws);
        rel = path.relative(ws, abs) || file;
      } catch (err) {
        return JSON.stringify({
          error: `${call.tool}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
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
      let abs: string;
      let rel: string;
      try {
        abs = resolveToolPath(file, ws);
        rel = path.relative(ws, abs) || file;
      } catch (err) {
        return JSON.stringify({
          error: `patch_file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
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
    case 'delete_file': {
      const file = String(call.path ?? call.file ?? '');
      if (!file) {
        return JSON.stringify({ error: 'delete_file: missing "path" field' });
      }
      let abs: string;
      let rel: string;
      try {
        abs = resolveToolPath(file, ws);
        rel = path.relative(ws, abs) || file;
      } catch (err) {
        return JSON.stringify({
          error: `delete_file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      if (!existsSync(abs)) {
        return JSON.stringify({ error: `delete_file: file tidak ditemukan: ${rel}` });
      }
      try {
        const stat = statSync(abs);
        if (stat.isDirectory()) {
          return JSON.stringify({ error: `delete_file: path "${rel}" adalah direktori, bukan file.` });
        }
      } catch (err) {
        return JSON.stringify({
          error: `delete_file: gagal memeriksa file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const config = deps.config ?? DEFAULT_CONFIG;
      if (config.approvalEnabled && !isYoloMode()) {
        if (!deps.confirm) {
          return JSON.stringify({
            error: `[Persetujuan ditolak: konfirmasi pengguna diperlukan untuk menghapus "${rel}"]`,
          });
        }
        const ok = await deps.confirm(`delete_file ${rel}`, `menghapus file "${rel}" secara permanen`);
        if (!ok) {
          return JSON.stringify({
            error: `[Persetujuan ditolak: menghapus file "${rel}"]`,
          });
        }
      }

      try {
        takeSnapshot(abs);
      } catch (err) {
        return JSON.stringify({
          error: `delete_file: gagal membuat snapshot undo: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      try {
        unlinkSync(abs);
        deps.onLog?.(red(`🔴 Delete(${rel})`));
        return JSON.stringify(
          {
            ok: true,
            path: rel,
            message: `File "${rel}" berhasil dihapus (snapshot undo disimpan).`,
          },
          null,
          2,
        );
      } catch (err) {
        return JSON.stringify({
          error: `delete_file: gagal menghapus file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    case 'move_file': {
      const source = String(call.source ?? call.from ?? call.path ?? '');
      const target = String(call.target ?? call.to ?? call.destination ?? '');
      if (!source) {
        return JSON.stringify({ error: 'move_file: missing "source" field' });
      }
      if (!target) {
        return JSON.stringify({ error: 'move_file: missing "target" field' });
      }
      let sourceAbs: string;
      let sourceRel: string;
      let targetAbs: string;
      let targetRel: string;
      try {
        sourceAbs = resolveToolPath(source, ws);
        sourceRel = path.relative(ws, sourceAbs) || source;
      } catch (err) {
        return JSON.stringify({
          error: `move_file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      try {
        targetAbs = resolveToolPath(target, ws);
        targetRel = path.relative(ws, targetAbs) || target;
      } catch (err) {
        return JSON.stringify({
          error: `move_file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      if (!existsSync(sourceAbs)) {
        return JSON.stringify({ error: `move_file: file sumber tidak ditemukan: ${sourceRel}` });
      }
      try {
        const stat = statSync(sourceAbs);
        if (stat.isDirectory()) {
          return JSON.stringify({ error: `move_file: source "${sourceRel}" adalah direktori, bukan file.` });
        }
      } catch (err) {
        return JSON.stringify({
          error: `move_file: gagal memeriksa file sumber: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const config = deps.config ?? DEFAULT_CONFIG;
      if (config.approvalEnabled && !isYoloMode()) {
        if (!deps.confirm) {
          return JSON.stringify({
            error: `[Persetujuan ditolak: konfirmasi pengguna diperlukan untuk memindahkan "${sourceRel}" ke "${targetRel}"]`,
          });
        }
        const ok = await deps.confirm(
          `move_file ${sourceRel} -> ${targetRel}`,
          `memindahkan/mengubah nama file "${sourceRel}" ke "${targetRel}"`,
        );
        if (!ok) {
          return JSON.stringify({
            error: `[Persetujuan ditolak: memindahkan file "${sourceRel}" ke "${targetRel}"]`,
          });
        }
      }

      try {
        takeSnapshot(sourceAbs);
        takeSnapshot(targetAbs);
      } catch (err) {
        return JSON.stringify({
          error: `move_file: gagal membuat snapshot undo: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      try {
        mkdirSync(path.dirname(targetAbs), { recursive: true });
        try {
          renameSync(sourceAbs, targetAbs);
        } catch {
          copyFileSync(sourceAbs, targetAbs);
          unlinkSync(sourceAbs);
        }
        deps.onLog?.(green(`🟢 Move(${sourceRel} -> ${targetRel})`));
        return JSON.stringify(
          {
            ok: true,
            source: sourceRel,
            target: targetRel,
            message: `File "${sourceRel}" berhasil dipindahkan ke "${targetRel}" (snapshot undo disimpan).`,
          },
          null,
          2,
        );
      } catch (err) {
        return JSON.stringify({
          error: `move_file: gagal memindahkan file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    case 'remember': {
      const content = typeof call.content === 'string' ? call.content : null;
      if (!content || !content.trim()) {
        return JSON.stringify({ error: 'remember: missing "content" field (string)' });
      }
      try {
        const result = await appendMemory(content, ws);
        const short = result.entry.length > 60 ? `${result.entry.slice(0, 57)}…` : result.entry;
        deps.onLog?.(green(`🟢 Remember(${short})`));
        return JSON.stringify(
          {
            ok: true,
            message: 'Catatan berhasil disimpan ke persistent memory (.ruko/memory.md).',
            entry: result.entry,
            ...(result.warning ? { warning: result.warning } : {}),
          },
          null,
          2,
        );
      } catch (err) {
        return JSON.stringify({
          error: `remember: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    case 'load_skill': {
      const name = String(call.name ?? '');
      if (!name) {
        return JSON.stringify({ error: 'load_skill: missing "name" field' });
      }
      deps.onLog?.(green(`🟢 Skill(${name})`));
      const skill = readSkill(name, ws);
      if (!skill) {
        return JSON.stringify({ error: `load_skill: skill "${name}" tidak ditemukan di .ruko/skills/` });
      }
      return JSON.stringify(
        {
          ok: true,
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
        },
        null,
        2,
      );
    }
    case 'save_skill': {
      const name = String(call.name ?? '');
      const description = String(call.description ?? '');
      const instructions = String(call.instructions ?? '');
      if (!name || !instructions) {
        return JSON.stringify({ error: 'save_skill: missing "name" or "instructions" field' });
      }
      deps.onLog?.(green(`🟢 SaveSkill(${name})`));
      const saved = saveSkill(name, description || name, instructions, ws);
      return JSON.stringify(
        {
          ok: true,
          message: `Skill "${saved.name}" berhasil disimpan ke .ruko/skills/${saved.name}.md`,
          name: saved.name,
          description: saved.description,
        },
        null,
        2,
      );
    }
    case 'list_skills': {
      deps.onLog?.(green('🟢 Skills()'));
      const skills = listSkills(ws);
      return JSON.stringify(
        {
          ok: true,
          count: skills.length,
          skills: skills.map((s) => ({
            name: s.name,
            description: s.description,
          })),
        },
        null,
        2,
      );
    }
    case 'web_fetch': {
      const url = String(call.url ?? call.link ?? '');
      if (!url) {
        return JSON.stringify({ error: 'web_fetch: missing "url" field' });
      }
      deps.onLog?.(green(`🟢 Fetch(${url.length > 50 ? url.slice(0, 47) + '…' : url})`));
      const res = await webFetchTool(url, { signal: deps.signal });
      if (!res.ok) {
        return JSON.stringify({ ok: false, error: res.text, status: res.status });
      }
      return JSON.stringify(
        {
          ok: true,
          status: res.status,
          contentType: res.contentType,
          truncated: res.truncated,
          content: res.text,
        },
        null,
        2,
      );
    }
    case 'search_sessions': {
      const query = String(call.query ?? '');
      if (!query.trim()) {
        return JSON.stringify({ error: 'search_sessions: missing "query" field' });
      }
      deps.onLog?.(green(`🟢 SearchSessions(${query})`));
      const results = searchSessions(query);
      return JSON.stringify(
        {
          ok: true,
          query,
          count: results.length,
          results: results.slice(0, 10),
        },
        null,
        2,
      );
    }
    case 'delegate': {
      const task = String(call.task ?? call.instruction ?? '');
      if (!task.trim()) {
        return JSON.stringify({ error: 'delegate: missing "task" field' });
      }
      if (!deps.llmProvider || !deps.llmProvider.isConfigured) {
        return JSON.stringify({ error: 'delegate: LLM provider tidak tersedia untuk subagent' });
      }
      const short = task.length > 50 ? `${task.slice(0, 47)}…` : task;
      deps.onLog?.(magenta(`🟣 Subagent(${short})`));
      try {
        const subResult = await runSubagent(
          task,
          {
            config: deps.config ?? DEFAULT_CONFIG,
            llmProvider: deps.llmProvider,
            confirm: deps.confirm,
            onLog: deps.onLog,
            signal: deps.signal,
          },
          {
            planMode: deps.planMode,
            workspaceRoot: ws,
          },
        );
        return JSON.stringify(
          {
            ok: true,
            task,
            result: subResult,
          },
          null,
          2,
        );
      } catch (err) {
        return JSON.stringify({
          error: `delegate failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    case 'start_process': {
      const command = String(call.command ?? '');
      if (!command.trim()) {
        return JSON.stringify({ error: 'start_process: missing "command" field' });
      }

      const cwdArg = call.cwd ? String(call.cwd) : '';
      let resolvedCwd: string;
      try {
        resolvedCwd = cwdArg ? resolveToolPath(cwdArg, ws) : ws;
        assertInsideWorkspace(resolvedCwd, ws);
      } catch (err) {
        return JSON.stringify({
          error: `start_process: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const activeProcesses = defaultProcessManager.getActiveProcesses();
      if (activeProcesses.length >= 3) {
        const list = activeProcesses
          .map((p) => `${p.id} (PID ${p.pid}, cmd: "${p.command}")`)
          .join(', ');
        return JSON.stringify({
          error: `start_process ditolak: batas maksimal 3 proses aktif tercapai. Proses aktif saat ini: ${list}. Silakan gunakan stop_process(<process_id>) untuk menghentikan salah satunya terlebih dahulu.`,
        });
      }

      const config = deps.config ?? DEFAULT_CONFIG;
      if (config.approvalEnabled && !isYoloMode()) {
        if (!deps.confirm) {
          return JSON.stringify({
            error: `[Persetujuan ditolak: konfirmasi pengguna diperlukan untuk menjalankan proses latar belakang "${command}"]`,
          });
        }
        const ok = await deps.confirm(
          `start_process ${command}`,
          `menjalankan proses latar belakang "${command}"`,
        );
        if (!ok) {
          return JSON.stringify({
            error: `[Persetujuan ditolak: menjalankan proses latar belakang "${command}"]`,
          });
        }
      }

      try {
        const proc = defaultProcessManager.startProcess(command, resolvedCwd);
        const short = command.length > 50 ? `${command.slice(0, 47)}…` : command;
        deps.onLog?.(green(`🟢 StartProcess(${proc.id}: ${short})`));
        return JSON.stringify(
          {
            ok: true,
            process_id: proc.id,
            pid: proc.pid,
            command: proc.command,
            cwd: path.relative(ws, resolvedCwd) || '.',
            status: proc.status,
            message: `Proses latar belakang berhasil dijalankan dengan ID "${proc.id}" (PID: ${proc.pid}).`,
          },
          null,
          2,
        );
      } catch (err) {
        return JSON.stringify({
          error: `start_process: gagal memulai proses: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    case 'read_process_logs': {
      const processId = String(call.process_id ?? call.id ?? '');
      if (!processId) {
        return JSON.stringify({ error: 'read_process_logs: missing "process_id" field' });
      }
      if (!defaultProcessManager.hasProcess(processId)) {
        return JSON.stringify({
          error: `read_process_logs: proses dengan ID "${processId}" tidak ditemukan.`,
        });
      }
      deps.onLog?.(cyan(`🔵 ReadLogs(${processId})`));
      const logs = defaultProcessManager.readProcessLogs(processId) ?? [];
      return JSON.stringify(
        {
          ok: true,
          process_id: processId,
          lines: logs.length,
          logs,
          output: logs.join('\n'),
        },
        null,
        2,
      );
    }
    case 'get_status': {
      const processId = String(call.process_id ?? call.id ?? '');
      if (!processId) {
        return JSON.stringify({ error: 'get_status: missing "process_id" field' });
      }
      const status = defaultProcessManager.getProcessStatus(processId);
      if (!status) {
        return JSON.stringify({
          error: `get_status: proses dengan ID "${processId}" tidak ditemukan.`,
        });
      }
      deps.onLog?.(cyan(`🔵 ProcessStatus(${processId})`));
      return JSON.stringify(status, null, 2);
    }
    case 'stop_process': {
      const processId = String(call.process_id ?? call.id ?? '');
      if (!processId) {
        return JSON.stringify({ error: 'stop_process: missing "process_id" field' });
      }
      // CATATAN KEAMANAN (Asimetri Approval Gate):
      // stop_process TIDAK memerlukan Approval Gate [Y/N] karena menghentikan proses
      // bersifat non-destruktif terhadap berkas/data pengguna, berbeda dengan start_process
      // yang berpotensi memiliki efek samping tidak terduga pada sistem.
      // Asimetri ini disengaja, bukan kelalaian.
      deps.onLog?.(yellow(`🟡 StopProcess(${processId})`));
      const timeoutMs = typeof call.timeoutMs === 'number' ? call.timeoutMs : 5000;
      const result = await defaultProcessManager.stopProcess(processId, timeoutMs);
      return JSON.stringify(result, null, 2);
    }
    default:
      return JSON.stringify({ error: `unknown tool: ${call.tool}` });
  }
}