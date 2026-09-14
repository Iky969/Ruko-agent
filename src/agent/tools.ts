import { chainedSegments, Confirmer, guardedExecute, isYoloMode } from '../core/approval.js';
import { AgentConfig, DEFAULT_CONFIG } from '../types.js';
import { DEFAULT_TIMEOUT_MS } from '../core/executor.js';
import { renderFileDiff, splitLines } from '../core/diff.js';
import { revertFile, takeSnapshot } from '../core/undo.js';
import { cyan, dim, green, magenta, red, yellow } from '../core/ui.js';
import { codeSearchTool, globTool, listDirTool, readFileTool } from './filetools.js';
import { appendMemory } from '../core/memory.js';
import { deleteSkill, listSkills, readSkill, saveSkill } from '../core/skills.js';
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
export const MAX_TOOL_OUTPUT_CHARS = 8_000;
export const TOOL_RESULT_CHAR_LIMIT = MAX_TOOL_OUTPUT_CHARS;

export function capToolResult(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 200) / 2);
  const head = text.slice(0, keep);
  const tail = text.slice(-keep);
  const dropped = text.length - head.length - tail.length;
  return `${head}\n\n[... TRUNCATED — ${dropped} chars folded; sesuaikan query/perintah ...]\n\n${tail}`;
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
  'revert_file',
  'remember',
  'save_skill',
  'delete_skill',
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
 * Checks if a target path points to a sensitive file or directory:
 * - .ruko/config.json
 * - .ruko/undo/**
 * - .env, .env.*
 * - id_rsa, id_ed25519, *.pem, *.key
 *
 * Case-insensitive, matches relative and absolute variations.
 */
export function isSensitivePath(targetPath: string, workspaceRoot: string = getWorkspaceRoot()): boolean {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const clean = targetPath.trim().replace(/^['"]|['"]$/g, '');
  if (!clean) return false;

  const cwd = path.resolve(workspaceRoot);
  const abs = path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(cwd, clean);
  const rel = path.relative(cwd, abs).replace(/\\/g, '/');
  const relLower = rel.toLowerCase();
  const baseLower = path.basename(abs).toLowerCase();
  const extLower = path.extname(abs).toLowerCase();

  // 1. .ruko/config.json
  if (relLower === '.ruko/config.json' || relLower.endsWith('/.ruko/config.json')) {
    return true;
  }

  // 2. .ruko/undo/**
  if (
    relLower === '.ruko/undo' ||
    relLower.startsWith('.ruko/undo/') ||
    relLower.includes('/.ruko/undo/') ||
    relLower.endsWith('/.ruko/undo')
  ) {
    return true;
  }

  // 3. .env, .env.*
  if (baseLower === '.env' || baseLower.startsWith('.env.')) {
    return true;
  }

  // 4. id_rsa, id_ed25519, *.pem, *.key
  if (
    baseLower === 'id_rsa' ||
    baseLower.startsWith('id_rsa.') ||
    baseLower === 'id_ed25519' ||
    baseLower.startsWith('id_ed25519.')
  ) {
    return true;
  }
  if (extLower === '.pem' || extLower === '.key') {
    return true;
  }

  return false;
}

/**
 * Asserts that a target path is not a sensitive file or directory.
 * Throws an Error if sensitive access is attempted.
 */
export function assertNotSensitivePath(targetPath: string, workspaceRoot: string = getWorkspaceRoot()): void {
  if (isSensitivePath(targetPath, workspaceRoot)) {
    throw new Error(
      `Akses ke file sensitif "${targetPath}" ditolak demi keamanan kredensial/data sensitif.`,
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
  assertNotSensitivePath(abs, cwd);
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

/** Regex pattern for detecting sensitive environment variable names. */
export const SENSITIVE_VAR_REGEX = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|API_KEY|TOKEN|SECRET|PASSWORD)/i;

/** Helper to check printenv arguments for broad dump or sensitive targets. */
function checkPrintenvSegment(segment: string): boolean {
  const m = segment.trim().match(/^(?:(?:\/usr)?\/bin\/)?printenv(?:\s+(.*))?$/i);
  if (!m) return false;
  const rawArgs = m[1]?.trim();
  if (!rawArgs) {
    // Bare printenv dumps entire environment
    return true;
  }

  // Strip redirection e.g. printenv > out.txt
  const withoutRedirect = rawArgs.replace(/[><].*$/, '').trim();
  if (!withoutRedirect) {
    return true;
  }

  const tokens = extractCommandArgs(withoutRedirect);
  if (tokens.length === 0) return true;

  // If all tokens are flags (e.g. -0, --null), it's still a dump
  const nonFlags = tokens.filter((t) => !t.startsWith('-'));
  if (nonFlags.length === 0) return true;

  for (const t of nonFlags) {
    if (SENSITIVE_VAR_REGEX.test(t)) {
      return true;
    }
  }
  return false;
}

/** Helper to check env command for broad dump or sensitive targets. */
function checkEnvSegment(segment: string): boolean {
  const m = segment.trim().match(/^(?:(?:\/usr)?\/bin\/)?env(?:\s+(.*))?$/i);
  if (!m) return false;
  const rawArgs = m[1]?.trim();
  if (!rawArgs) {
    // Bare env dumps entire environment
    return true;
  }

  // Strip redirection e.g. env > out.txt
  const withoutRedirect = rawArgs.replace(/[><].*$/, '').trim();
  if (!withoutRedirect) {
    return true;
  }

  const tokens = extractCommandArgs(withoutRedirect);
  if (tokens.length === 0) return true;

  // If there are no commands to execute (only flags and/or VAR=VAL assignments),
  // env prints the environment.
  let hasCommand = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      if (t === '-u' || t === '--unset') {
        i++; // skip variable name following -u
      }
      continue;
    }
    if (t.includes('=')) {
      // Check if assignment variable name is sensitive
      const varName = t.split('=')[0];
      if (SENSITIVE_VAR_REGEX.test(varName)) {
        return true;
      }
      continue;
    }
    hasCommand = true;
    break;
  }

  return !hasCommand;
}

/**
 * Detects if a shell command in exec attempts to dump environment variables
 * broadly or target sensitive environment variables specifically.
 */
export function isSensitiveEnvCommand(command: string): boolean {
  if (!command || typeof command !== 'string') return false;

  // 1. Check for sensitive variable expansion anywhere in command:
  // e.g. $NAME or ${NAME} where NAME matches SENSITIVE_VAR_REGEX
  const varMatches = command.matchAll(/\$([a-zA-Z_][a-zA-Z0-9_]*|\{([a-zA-Z_][a-zA-Z0-9_]*)\})/g);
  for (const m of varMatches) {
    const varName = m[2] ?? m[1];
    if (varName && SENSITIVE_VAR_REGEX.test(varName)) {
      return true;
    }
  }

  // 2. Check each chained segment
  const segments = chainedSegments(command);
  for (const seg of segments) {
    const s = seg.trim().replace(/^sudo\s+/, '');
    if (!s) continue;

    if (checkPrintenvSegment(s)) {
      return true;
    }

    if (checkEnvSegment(s)) {
      return true;
    }

    // Bare export or export -p dumps environment in bash
    if (/^(?:export)(?:\s+-p)?$/i.test(s)) {
      return true;
    }
  }

  return false;
}

/**
 * Detects if an exec command explicitly targets sensitive files
 * (e.g. 'cat .ruko/config.json', 'grep key .env', etc.).
 */
export function detectSensitiveFileAccessInExec(
  command: string,
  workspaceRoot: string = getWorkspaceRoot(),
): { blocked: boolean; message?: string; target?: string } {
  const segments = chainedSegments(command);

  for (const seg of segments) {
    const s = seg.trim().replace(/^sudo\s+/, '');

    const tokenRegex = /[^\s"';&|<>]+|"([^"]*)"|'([^']*)'/g;
    let match: RegExpExecArray | null;

    while ((match = tokenRegex.exec(s)) !== null) {
      const rawToken = match[1] ?? match[2] ?? match[0];
      if (!rawToken) continue;

      const candidateTokens = rawToken.includes(' ')
        ? [rawToken, ...rawToken.split(/\s+/).filter(Boolean)]
        : [rawToken];

      for (const t of candidateTokens) {
        let candidate = t.trim();

        if (candidate.startsWith('-')) {
          if (candidate.includes('=')) {
            candidate = candidate.split('=', 2)[1];
          } else {
            continue;
          }
        }

        candidate = candidate.replace(/^[@<>]+/, '');
        if (!candidate) continue;

        if (isSensitivePath(candidate, workspaceRoot)) {
          return {
            blocked: true,
            target: candidate,
            message: `exec ditolak: akses ke file sensitif ("${candidate}") diblokir demi keamanan kredensial/data sensitif.`,
          };
        }
      }
    }
  }

  return { blocked: false };
}

/**
 * Resolves the effective execution timeout in ms for an exec tool call.
 * Supports timeoutMs, timeout_ms, and timeout (number or numeric string).
 * Values <= 600 without 'Ms' suffix are interpreted as seconds.
 */
export function resolveExecTimeout(call: Record<string, any>, fallbackMs: number = DEFAULT_TIMEOUT_MS): number {
  const raw = call.timeoutMs ?? call.timeout_ms ?? call.timeout;
  if (raw != null) {
    const num = typeof raw === 'number' ? raw : parseFloat(String(raw));
    if (Number.isFinite(num) && num > 0) {
      const isSecondsParam = !('timeoutMs' in call) && !('timeout_ms' in call) && num <= 600;
      const ms = Math.round(isSecondsParam ? num * 1000 : num);
      return Math.min(Math.max(ms, 100), 3_600_000);
    }
  }
  return fallbackMs;
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

      if (isSensitiveEnvCommand(command)) {
        const msg = 'exec ditolak: command berpotensi membocorkan environment variable sensitif. Kredensial tidak dapat diakses lewat tool ini.';
        deps.onLog?.(yellow(`⚠ ${msg}`));
        return JSON.stringify({ error: msg });
      }

      const fileCheck = detectSensitiveFileAccessInExec(command, ws);
      if (fileCheck.blocked) {
        deps.onLog?.(yellow(`⚠ ${fileCheck.message}`));
        return JSON.stringify({ error: fileCheck.message });
      }

      const mutationCheck = detectWorkspaceMutationInExec(command, ws);
      if (mutationCheck.blocked) {
        deps.onLog?.(yellow(`⚠ Exec ditolak: gunakan tool resmi ${mutationCheck.toolAdvice}`));
        return JSON.stringify({
          error: mutationCheck.message,
        });
      }

      const config = deps.config ?? DEFAULT_CONFIG;
      const defaultTimeout = config.execTimeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timeoutMs = resolveExecTimeout(call, defaultTimeout);
      const isCustomTimeout = timeoutMs !== defaultTimeout;
      const short = command.length > 60 ? `${command.slice(0, 57)}…` : command;
      const timeoutBadge = isCustomTimeout ? dim(` [${Math.round(timeoutMs / 1000)}s]`) : '';
      deps.onLog?.(green(`🟢 Bash(${short})${timeoutBadge}`));
      const result = await guardedExecute(
        command,
        {
          timeoutMs,
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
      try {
        assertNotSensitivePath(file, ws);
      } catch (err) {
        return JSON.stringify({ error: `read_file: ${err instanceof Error ? err.message : String(err)}` });
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
    case 'list_dir':
    case 'list_directory': {
      const targetPath = typeof call.path === 'string'
        ? call.path
        : (typeof call.dir === 'string' ? call.dir : (typeof call.directory === 'string' ? call.directory : '.'));
      try {
        assertNotSensitivePath(targetPath, ws);
      } catch (err) {
        return JSON.stringify({ error: `list_dir: ${err instanceof Error ? err.message : String(err)}` });
      }
      deps.onLog?.(green(`🟢 ListDir(${targetPath})`));
      const result = await listDirTool(targetPath, {
        limit: typeof call.limit === 'number' ? call.limit : undefined,
        showHidden: typeof call.showHidden === 'boolean' ? call.showHidden : undefined,
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
      const rawExt = call.extension ?? call.extensions ?? call.ext;
      const ext = (typeof rawExt === 'string' || Array.isArray(rawExt))
        ? (rawExt as string | string[])
        : undefined;
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
    case 'revert_file': {
      const file = String(call.path ?? call.file ?? call.target ?? '');
      if (!file) {
        return JSON.stringify({ error: 'revert_file: missing "path" field' });
      }
      let abs: string;
      let rel: string;
      try {
        abs = resolveToolPath(file, ws);
        rel = path.relative(ws, abs) || file;
      } catch (err) {
        return JSON.stringify({
          error: `revert_file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const config = deps.config ?? DEFAULT_CONFIG;
      if (config.approvalEnabled && !isYoloMode()) {
        if (!deps.confirm) {
          return JSON.stringify({
            error: `[Persetujuan ditolak: konfirmasi pengguna diperlukan untuk mengembalikan file "${rel}"]`,
          });
        }
        const ok = await deps.confirm(
          `revert_file ${rel}`,
          `mengembalikan file "${rel}" ke kondisi sebelumnya (undo/git rollback)`,
        );
        if (!ok) {
          return JSON.stringify({
            error: `[Persetujuan ditolak: revert file "${rel}"]`,
          });
        }
      }

      const modeArg = call.mode === 'git' || call.mode === 'snapshot' ? call.mode : 'auto';
      const result = revertFile(abs, {
        workspaceRoot: ws,
        mode: modeArg,
      });

      if (!result.ok) {
        return JSON.stringify({
          error: `revert_file: ${result.error}`,
        });
      }

      deps.onLog?.(yellow(`↩ Revert(${rel})`));
      return JSON.stringify(
        {
          ok: true,
          path: rel,
          action: result.action,
          source: result.source,
          message: result.message,
        },
        null,
        2,
      );
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
      const instructions = String(call.instructions ?? call.content ?? '');
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
    case 'delete_skill': {
      const name = String(call.name ?? '');
      if (!name.trim()) {
        return JSON.stringify({ error: 'delete_skill: missing "name" field' });
      }
      const skill = readSkill(name, ws);
      if (!skill) {
        return JSON.stringify({ error: `delete_skill: skill "${name}" tidak ditemukan` });
      }

      const config = deps.config ?? DEFAULT_CONFIG;
      if (config.approvalEnabled && !isYoloMode()) {
        if (!deps.confirm) {
          return JSON.stringify({
            error: `[Persetujuan ditolak: konfirmasi pengguna diperlukan untuk menghapus skill "${name}"]`,
          });
        }
        const preview = skill.instructions.slice(0, 200) + (skill.instructions.length > 200 ? '…' : '');
        const ok = await deps.confirm(
          `delete_skill ${name}`,
          `menghapus skill "${name}" secara permanen:\n---\n${preview}\n---`,
        );
        if (!ok) {
          return JSON.stringify({
            error: `[Persetujuan ditolak: menghapus skill "${name}"]`,
          });
        }
      }

      const deleted = deleteSkill(name, ws);
      if (!deleted) {
        return JSON.stringify({ error: `delete_skill: gagal menghapus skill "${name}"` });
      }
      deps.onLog?.(red(`🔴 DeleteSkill(${name})`));
      return JSON.stringify(
        {
          ok: true,
          message: `Skill "${name}" berhasil dihapus.`,
          name,
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
      const rawLimit = Number(call.limit);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 5;
      deps.onLog?.(green(`🟢 SearchSessions(${query}${limit !== 5 ? `, limit: ${limit}` : ''})`));
      const sessionsDir = path.join(ws, '.ruko', 'sessions');
      const results = searchSessions(query, sessionsDir, limit);
      return JSON.stringify(
        {
          ok: true,
          query,
          count: results.length,
          results: results.map((r) => ({
            session_id: r.sessionId,
            timestamp: r.timestamp,
            message_count: r.messageCount,
            title: r.title,
            role: r.role,
            snippet: r.snippet,
          })),
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