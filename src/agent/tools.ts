import { chainedSegments, Confirmer, decodePathSafely, detectRisk, extractAndResolveShellVariables, guardedExecute, isYoloMode } from '../core/approval.js';
import { AgentConfig, DEFAULT_CONFIG } from '../types.js';
import { DEFAULT_TIMEOUT_MS } from '../core/executor.js';
import { renderFileDiff, splitLines } from '../core/diff.js';
import { revertFile, takeSnapshot } from '../core/undo.js';
import type { ActivityTray } from '../core/activity.js';
import { cyan, dim, green, magenta, red, yellow } from '../core/ui.js';
import { codeSearchTool, globTool, listDirTool, readFileTool } from './filetools.js';
import { appendMemory } from '../core/memory.js';
import { deleteSkill, listSkills, readSkill, saveSkill } from '../core/skills.js';
import { searchSessions } from '../core/session.js';
import { runSubagent } from './subagent.js';
import { webFetchTool } from './webtools.js';
import { defaultProcessManager } from './processManager.js';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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
/**
 * DSML prefix, e.g. `<|DSML|`, `<||DSML||`, `<｜DSML｜`, `<｜｜DSML｜｜`.
 * Kept as a source fragment so the invoke/parameter patterns below can accept
 * the prefix as OPTIONAL on the CLOSING tag: real DeepSeek output frequently
 * opens with `<|DSML|invoke ...>` but closes with a bare `</invoke>` (or the
 * other way around), and requiring the prefix on both ends made the parser
 * execute only the first call and leak the rest of the block as plain text.
 */
const DSML_PREFIX_SRC = '(?:\\|\\|?|｜｜?)\\s*DSML\\s*(?:\\|\\|?|｜｜?)\\s*';
const DSML_INVOKE_RE = new RegExp(
  `<\\s*${DSML_PREFIX_SRC}invoke\\s+name=["']?([^"'>\\s]+)["']?[^>]*>([\\s\\S]*?)<\\/\\s*(?:${DSML_PREFIX_SRC})?invoke\\s*>`,
  'gi',
);
const DSML_INVOKE_SELF_RE = new RegExp(
  `<\\s*${DSML_PREFIX_SRC}invoke\\s+name=["']?([^"'>\\s]+)["']?[^>]*\\/>`,
  'gi',
);
const DSML_PARAM_RE = new RegExp(
  `<\\s*${DSML_PREFIX_SRC}parameter\\s+name=["']?([^"'>\\s]+)["']?(?:\\s+string=["']?(true|false)["']?)?[^>]*>([\\s\\S]*?)<\\/\\s*(?:${DSML_PREFIX_SRC})?parameter\\s*>`,
  'gi',
);
/**
 * Bare XML invoke blocks (Anthropic / DeepSeek "native" XML tool calls):
 *   <invoke name="write_file"><parameter name="path">a.txt</parameter></invoke>
 * No DSML pipes at all — these were previously classified as MALFORMED and
 * never executed (only the first DSML-prefixed call in a batch ran).
 */
const XML_INVOKE_RE = new RegExp(
  `<invoke\\s+name=["']?([^"'>\\s]+)["']?[^>]*>([\\s\\S]*?)<\\/\\s*(?:${DSML_PREFIX_SRC})?invoke\\s*>`,
  'gi',
);
const XML_INVOKE_SELF_RE = /<invoke\s+name=["']?([^"'>\s]+)["']?[^>]*\/>/gi;
const XML_PARAM_RE = new RegExp(
  `<parameter\\s+name=["']?([^"'>\\s]+)["']?(?:\\s+string=["']?(true|false)["']?)?[^>]*>([\\s\\S]*?)<\\/\\s*(?:${DSML_PREFIX_SRC})?parameter\\s*>`,
  'gi',
);
/** Closing tags left behind by a partially parsed invoke block (any prefix). */
const STRAY_TOOL_TAG_RE =
  /<\/?\s*(?:(?:\|\|?|｜｜?)\s*DSML\s*(?:\|\|?|｜｜?)\s*)?(?:invoke|parameter|function_calls|tool_calls)\b[^>]*>/gi;
const XML_TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
export const MALFORMED_TOOL_TAG_RE = /[<＜]\s*([^\s>]+)\s+([^>]*?\b(?:name|tool|query|path|command|action)\s*=\s*(?:["'][^"']*["']|[^\s>]+)[^>]*?)(?:\/>|>([\s\S]*?)<\/\s*\1\s*>|>|$)/gi;

export interface ParseToolCallsResult {
  calls: ToolCall[];
  malformedBlocks: string[];
}

/**
 * Extracts `<parameter name="..." string="true|false">value</parameter>` pairs
 * from the body of a DSML or bare-XML invoke block. `string="true"` keeps the
 * raw text; otherwise the value is parsed as JSON when possible (numbers,
 * booleans, arrays), falling back to the raw string.
 */
function extractInvokeParameters(body: string): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const paramRe of [DSML_PARAM_RE, XML_PARAM_RE]) {
    for (const pMatch of body.matchAll(paramRe)) {
      const pName = pMatch[1].trim();
      const isString = pMatch[2]?.toLowerCase() === 'true';
      const pValRaw = pMatch[3].trim();
      if (isString) {
        params[pName] = pValRaw;
      } else {
        try {
          params[pName] = JSON.parse(pValRaw);
        } catch {
          params[pName] = pValRaw;
        }
      }
    }
  }
  return params;
}

/** Extracts all tool-call blocks from a model reply (markdown fence, DeepSeek DSML, or XML). */
export function parseToolCalls(text: string): ParseToolCallsResult {
  const calls: ToolCall[] = [];
  const malformedBlocks: string[] = [];

  // 1. Standard markdown ```tool ... ``` fences
  for (const match of text.matchAll(TOOL_BLOCK_RE)) {
    try {
      const parsed = JSON.parse(match[1].trim()) as ToolCall;
      if (parsed && typeof parsed.tool === 'string' && parsed.tool.length > 0) {
        parsed.tool = normalizeToolName(parsed.tool);
        calls.push(parsed);
      }
    } catch {
      malformedBlocks.push(match[1].trim());
    }
  }

  // 1b. Markdown ```json ... ``` fences (when containing tool/name field)
  const JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)\n\s*```/gi;
  for (const match of text.matchAll(JSON_BLOCK_RE)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.tool === 'string' && parsed.tool.length > 0) {
          parsed.tool = normalizeToolName(parsed.tool);
          calls.push(parsed as ToolCall);
        } else if (typeof parsed.name === 'string' && parsed.name.length > 0) {
          const toolName = normalizeToolName(parsed.name);
          let args = parsed.arguments ?? parsed.parameters ?? {};
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { /* keep raw */ }
          }
          const { name: _n, arguments: _a, parameters: _p, ...rest } = parsed;
          calls.push({ tool: toolName, ...rest, ...(typeof args === 'object' && args ? args : {}) });
        }
      }
    } catch {
      // Not a tool call JSON, just regular code — ignore
    }
  }

  // 2. DeepSeek DSML (<|DSML|invoke name="...">... or full-width <｜DSML｜invoke...>)
  //    and the bare-XML variant (<invoke name="...">...<parameter .../invoke>).
  //    The closing tag may or may not carry the DSML prefix in both cases —
  //    a real DeepSeek batch mixes them, and requiring the prefix on both ends
  //    is what made only the first call execute (feedback.txt item 1a).
  const invokePatterns: ReadonlyArray<RegExp> = [DSML_INVOKE_RE, XML_INVOKE_RE];
  for (const invokeRe of invokePatterns) {
    for (const match of text.matchAll(invokeRe)) {
      const tool = normalizeToolName(match[1].trim());
      const body = match[2];
      if (tool) {
        calls.push({ tool, ...extractInvokeParameters(body) });
      }
    }
  }

  for (const selfRe of [DSML_INVOKE_SELF_RE, XML_INVOKE_SELF_RE]) {
    for (const match of text.matchAll(selfRe)) {
      const tool = normalizeToolName(match[1].trim());
      if (tool) {
        calls.push({ tool });
      }
    }
  }

  // 3. Generic XML <tool_call>...</tool_call> (Qwen / GLM / OpenAI-in-XML)
  for (const match of text.matchAll(XML_TOOL_CALL_RE)) {
    try {
      const rawJson = match[1].trim();
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.name === 'string' && parsed.name.length > 0) {
          let args = parsed.arguments ?? {};
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch {
              // fallback raw string
            }
          }
          calls.push({ tool: normalizeToolName(parsed.name), ...(typeof args === 'object' && args ? args : {}) });
        } else if (typeof parsed.tool === 'string' && parsed.tool.length > 0) {
          parsed.tool = normalizeToolName(parsed.tool);
          calls.push(parsed as ToolCall);
        }
      }
    } catch {
      malformedBlocks.push(match[1].trim());
    }
  }

  // 4. Generic XML <tool>JSON</tool> (Nemotron / generic style) or self-closing <tool name="..." ... />
  const XML_TOOL_SIMPLE_RE = /<tool(?:[^>]*)>\s*([\s\S]*?)\s*(?:<\/tool>|$)/gi;
  for (const match of text.matchAll(XML_TOOL_SIMPLE_RE)) {
    const rawTag = match[0].trim();
    const body = match[1]?.trim() ?? '';

    // try extract name attribute
    const attrMatch = match[0].match(/name=["']?([^"'>\s]+)["']?/i);
    let nameAttr = attrMatch ? attrMatch[1] : null;

    if (!body && (match[0].includes('/>') || nameAttr)) {
      // Self-closing or attribute-only tag: extract parameters from XML attributes
      const attrRegex = /([a-zA-Z0-9_-]+)=["']([^"']*)["']|([a-zA-Z0-9_-]+)=([^\s>]+)/g;
      const attrs: Record<string, string> = {};
      for (const m of match[0].matchAll(attrRegex)) {
        const k = (m[1] ?? m[3]).toLowerCase();
        const v = m[2] ?? m[4] ?? '';
        attrs[k] = v;
      }
      let tName = attrs.tool ?? attrs.name ?? nameAttr;
      if (typeof tName === 'string' && tName.length > 0) {
        tName = normalizeToolName(tName);
        delete attrs.tool;
        delete attrs.name;
        calls.push({ tool: tName, ...attrs });
        continue;
      }
    }

    if (!body) {
      if (rawTag) malformedBlocks.push(rawTag);
      continue;
    }

    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') {
        let tName = parsed.tool ?? parsed.name ?? nameAttr;
        if (typeof tName === 'string' && tName.length > 0) {
          tName = normalizeToolName(tName);
          let args = parsed.arguments ?? parsed.parameters ?? {};
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { /* keep raw */ }
          }
          const { tool: _t, name: _n, arguments: _a, parameters: _p, ...rest } = parsed;
          calls.push({ tool: tName, ...rest, ...(typeof args === 'object' && args ? args : {}) });
        } else {
          malformedBlocks.push(body || rawTag);
        }
      } else {
        malformedBlocks.push(body || rawTag);
      }
    } catch {
      malformedBlocks.push(body || rawTag);
    }
  }

  // 5. Corrupted or malformed tool-call tags (e.g. non-ASCII/Kanji in tag name: <認 name=code_search tool="code_search" .../>)
  for (const match of text.matchAll(MALFORMED_TOOL_TAG_RE)) {
    const rawTag = match[0].trim();
    if (!rawTag) continue;
    const tagName = match[1].trim().toLowerCase();
    // Skip if it was already parsed as standard DSML or XML call
    if (
      tagName.includes('dsml') ||
      tagName === 'tool_call' ||
      tagName === 'tool' ||
      tagName === 'invoke' ||
      tagName === 'parameter'
    ) {
      continue;
    }
    malformedBlocks.push(rawTag);
  }

  // Normalize parameters in all standard calls before returning
  const normalizedCalls = calls.map(c => {
    const norm = normalizeToolParams(c);
    return { tool: c.tool, ...norm };
  }) as ToolCall[];

  return { calls: normalizedCalls, malformedBlocks };
}

/** Removes all tool-call blocks (markdown, DSML, XML) from a model reply, keeping surrounding text. */
export function stripToolBlocks(text: string): string {
  if (!text) return '';
  return text
    .replace(TOOL_BLOCK_RE, '')
    .replace(DSML_INVOKE_RE, '')
    .replace(DSML_INVOKE_SELF_RE, '')
    .replace(XML_INVOKE_RE, '')
    .replace(XML_INVOKE_SELF_RE, '')
    .replace(/<\/?(?:\|\|?|｜｜?)DSML(?:\|\|?|｜｜?)[^>]*>/gi, '')
    // feedback.txt item 1: closing tags of a partially recognised invoke block
    // (`</parameter></invoke>`, `</|DSML|invoke>`, stray `<function_calls>`) must
    // never survive into the visible reply.
    .replace(STRAY_TOOL_TAG_RE, '')
    .replace(XML_TOOL_CALL_RE, '')
    .replace(/<tool(?:[^>]*)>[\s\S]*?<\/tool>/gi, '')
    .replace(/<tool(?:[^>]*)\/>/gi, '')
    .replace(/<tool(?:[^>]*)>[\s\S]*$/gi, '')
    .replace(MALFORMED_TOOL_TAG_RE, '')
    .trim();
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
  /**
   * Delegation nesting depth to prevent infinite recursion / subagent bomb.
   */
  subagentDepth?: number;
  /**
   * Live bottom activity tray (feedback §4). Passed down so a delegated
   * subagent reports its own running tools into the SAME tray instead of
   * spawning a second, invisible one.
   */
  activityTray?: ActivityTray;
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
  let canonicalCwd = cwd;
  try {
    if (existsSync(cwd)) canonicalCwd = realpathSync(cwd);
  } catch {
    // ignore
  }
  const canonicalCwdPrefix = canonicalCwd.endsWith(path.sep) ? canonicalCwd : canonicalCwd + path.sep;

  const isLexicalInside =
    abs === cwd || abs.startsWith(cwdPrefix) || abs === canonicalCwd || abs.startsWith(canonicalCwdPrefix);
  if (!isLexicalInside) {
    throw new Error(
      `Path "${abs}" di luar working directory — akses file di luar project tidak diizinkan. ` +
      `Workspace: ${cwd}`,
    );
  }

  // Canonical symlink check: verify the real target does not escape the workspace
  try {
    let isSymlink = false;
    try {
      const lst = lstatSync(abs);
      isSymlink = lst.isSymbolicLink();
    } catch {}

    if (isSymlink || existsSync(abs)) {
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        const target = readlinkSync(abs);
        real = path.isAbsolute(target) ? path.resolve(target) : path.resolve(path.dirname(abs), target);
      }
      const isRealInside =
        real === cwd || real.startsWith(cwdPrefix) || real === canonicalCwd || real.startsWith(canonicalCwdPrefix);
      if (!isRealInside) {
        throw new Error(
          `Path "${abs}" mengarah ke symlink di luar working directory / workspace ("${real}"). Akses ditolak demi keamanan sandbox. ` +
          `Workspace: ${cwd}`,
        );
      }
    } else {
      // If path does not exist yet, verify nearest existing ancestor directory doesn't escape
      let cur = path.dirname(abs);
      while (cur && cur !== path.dirname(cur)) {
        if (existsSync(cur)) {
          const realCur = realpathSync(cur);
          const isCurInside =
            realCur === cwd || realCur.startsWith(cwdPrefix) || realCur === canonicalCwd || realCur.startsWith(canonicalCwdPrefix);
          if (!isCurInside) {
            throw new Error(
              `Direktori induk "${cur}" mengarah ke symlink di luar working directory / workspace ("${realCur}"). Akses ditolak demi keamanan sandbox. ` +
              `Workspace: ${cwd}`,
            );
          }
          break;
        }
        cur = path.dirname(cur);
      }
    }
  } catch (err) {
    if (err instanceof Error && (err.message.includes('di luar working directory') || err.message.includes('luar workspace'))) {
      throw err;
    }
  }
}

/**
 * Immutable security core files of Ruko Agent.
 * Modifying or deleting these files through agent tools is forbidden.
 */
export const SECURITY_CORE_FILES = [
  'src/core/approval.ts',
  'src/core/executor.ts',
  'src/agent/tools.ts',
  'src/agent/filetools.ts',
  'src/agent/subagent.ts',
  'src/agent/webtools.ts',
] as const;

export const SECURITY_CORE_FILES_SET = new Set<string>(
  SECURITY_CORE_FILES.map((f) => f.toLowerCase()),
);

/**
 * Maximum payload size allowed for file writing and editing (5 MB).
 * Protects against memory exhaustion and runaway output.
 */
export const MAX_FILE_WRITE_BYTES = 5 * 1024 * 1024;

/**
 * Checks if a target path matches any of Ruko's immutable security core files.
 */
export function isSecurityCoreFile(targetPath: string, workspaceRoot: string = getWorkspaceRoot()): boolean {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const decoded = decodePathSafely(targetPath).trim().replace(/^['"]|['"]$/g, '');
  if (!decoded) return false;

  const cwd = path.resolve(workspaceRoot);
  const candidates = [
    decoded,
    decoded.replace(/\\(.)/g, '$1'),
    decoded.replace(/\\/g, '/'),
  ];

  for (const cand of candidates) {
    const abs = path.isAbsolute(cand) ? path.resolve(cand) : path.resolve(cwd, cand);
    const rel = path.relative(cwd, abs).replace(/\\/g, '/').toLowerCase();
    const cleanRel = rel.startsWith('./') ? rel.slice(2) : rel;

    if (SECURITY_CORE_FILES_SET.has(cleanRel)) {
      return true;
    }

    try {
      if (existsSync(abs)) {
        const real = realpathSync(abs);
        const realRel = path.relative(cwd, real).replace(/\\/g, '/').toLowerCase();
        const cleanRealRel = realRel.startsWith('./') ? realRel.slice(2) : realRel;
        if (SECURITY_CORE_FILES_SET.has(cleanRealRel)) {
          return true;
        }
      }
    } catch {}
  }

  return false;
}

/**
 * Asserts that a target path is not one of Ruko's immutable security core files.
 */
export function assertNotSecurityCore(targetPath: string, workspaceRoot: string = getWorkspaceRoot()): void {
  if (isSecurityCoreFile(targetPath, workspaceRoot)) {
    throw new Error(
      `Akses modifikasi ditolak: "${targetPath}" adalah berkas keamanan inti Ruko (Immutable Security Core file). Berkas ini dilindungi dari modifikasi atau penghapusan demi menjaga integritas sistem proteksi.`,
    );
  }
}

/**
 * Checks if a target path points to a sensitive file or directory:
 * - .ruko/config.json (relative, in workspace, or absolute in home / termux home / system)
 * - .ruko/trusted
 * - .ruko/undo/**
 * - .env, .env.*
 * - .git-credentials, .git-credentials.*
 * - id_rsa, id_ed25519, *.pem, *.key
 * - .git/config
 *
 * Case-insensitive, handles URL-encoding (%2e%2e%2f) and escape characters (\).
 */
export function isSensitivePath(targetPath: string, workspaceRoot: string = getWorkspaceRoot()): boolean {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const rawClean = targetPath.trim().replace(/^['"]|['"]$/g, '');
  if (!rawClean) return false;

  const cwd = path.resolve(workspaceRoot);
  const home = os.homedir();

  // Test both unescaped and normalized candidates to handle %-encoding and \-escaping
  const candidateForms = new Set<string>();
  candidateForms.add(rawClean);

  const decoded = decodePathSafely(rawClean);
  candidateForms.add(decoded);

  const unescaped = decoded.replace(/\\(.)/g, '$1');
  candidateForms.add(unescaped);

  const slashNorm = unescaped.replace(/\\/g, '/');
  candidateForms.add(slashNorm);

  for (let cand of candidateForms) {
    cand = cand.trim().replace(/^['"]|['"]$/g, '');
    if (!cand) continue;

    // Expand ~ or ~/ to home directory
    if (cand === '~' || cand.startsWith('~/') || cand.startsWith('~\\')) {
      cand = home + cand.slice(1);
    }

    const candLower = cand.toLowerCase().replace(/\\/g, '/');

    // 1. .ruko/config.json, .ruko/trusted (relative, in workspace, or absolute in home / termux home / system)
    if (
      candLower === '.ruko/config.json' ||
      candLower.endsWith('/.ruko/config.json') ||
      candLower.includes('/.ruko/config.json') ||
      candLower.includes('.ruko/config.json') ||
      candLower === '.ruko/trusted' ||
      candLower.endsWith('/.ruko/trusted') ||
      candLower.includes('/.ruko/trusted') ||
      candLower.includes('.ruko/trusted')
    ) {
      return true;
    }

    const abs = path.isAbsolute(cand) ? path.resolve(cand) : path.resolve(cwd, cand);
    const absLower = abs.toLowerCase().replace(/\\/g, '/');
    const rel = path.relative(cwd, abs).replace(/\\/g, '/');
    const relLower = rel.toLowerCase();
    const baseLower = path.basename(abs).toLowerCase();
    const extLower = path.extname(abs).toLowerCase();

    // 1b. Absolute or relative .ruko/config.json, .ruko/trusted
    if (
      absLower.endsWith('/.ruko/config.json') ||
      relLower === '.ruko/config.json' ||
      relLower.endsWith('/.ruko/config.json') ||
      absLower.endsWith('/.ruko/trusted') ||
      relLower === '.ruko/trusted' ||
      relLower.endsWith('/.ruko/trusted')
    ) {
      return true;
    }

    // 2. .ruko/undo/**
    if (
      relLower === '.ruko/undo' ||
      relLower.startsWith('.ruko/undo/') ||
      relLower.includes('/.ruko/undo/') ||
      relLower.endsWith('/.ruko/undo') ||
      absLower.includes('/.ruko/undo/') ||
      absLower.endsWith('/.ruko/undo')
    ) {
      return true;
    }

    // 3. .env, .env.*
    if (baseLower === '.env' || baseLower.startsWith('.env.')) {
      return true;
    }

    // 4. .git-credentials
    if (baseLower === '.git-credentials' || baseLower.startsWith('.git-credentials.')) {
      return true;
    }

    // 5. id_rsa, id_ed25519, *.pem, *.key
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

    // 6. .git/config
    if (
      relLower === '.git/config' ||
      relLower.endsWith('/.git/config') ||
      absLower.endsWith('/.git/config')
    ) {
      return true;
    }

    // 7. Shell startup/profile configurations (.bashrc, .bash_profile, .zshrc, .profile, etc.)
    if (
      baseLower === '.bashrc' ||
      baseLower.startsWith('.bashrc.') ||
      baseLower === '.bash_profile' ||
      baseLower.startsWith('.bash_profile.') ||
      baseLower === '.bash_login' ||
      baseLower.startsWith('.bash_login.') ||
      baseLower === '.bash_logout' ||
      baseLower.startsWith('.bash_logout.') ||
      baseLower === '.zshrc' ||
      baseLower.startsWith('.zshrc.') ||
      baseLower === '.zprofile' ||
      baseLower.startsWith('.zprofile.') ||
      baseLower === '.zshenv' ||
      baseLower.startsWith('.zshenv.') ||
      baseLower === '.zlogin' ||
      baseLower.startsWith('.zlogin.') ||
      baseLower === '.zlogout' ||
      baseLower.startsWith('.zlogout.') ||
      baseLower === '.profile' ||
      baseLower.startsWith('.profile.')
    ) {
      return true;
    }

    // 8. /proc/*/environ (Linux process environment pseudofiles)
    if (
      /(?:^|\/)proc\/(?:self|\$\$|\$ppid|[0-9]+|\*|[a-z0-9_$]+)\/environ\b/i.test(candLower) ||
      /(?:^|\/)proc\/(?:self|\$\$|\$ppid|[0-9]+|\*|[a-z0-9_$]+)\/environ\b/i.test(relLower) ||
      /(?:^|\/)proc\/(?:self|\$\$|\$ppid|[0-9]+|\*|[a-z0-9_$]+)\/environ\b/i.test(absLower)
    ) {
      return true;
    }
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
  // Also check canonical destination if file exists (guards against symlinks pointing to sensitive files)
  try {
    const cwd = path.resolve(workspaceRoot);
    const abs = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(cwd, targetPath);
    let real: string | null = null;
    try {
      const lst = lstatSync(abs);
      if (lst.isSymbolicLink()) {
        try {
          real = realpathSync(abs);
        } catch {
          const target = readlinkSync(abs);
          real = path.isAbsolute(target) ? path.resolve(target) : path.resolve(path.dirname(abs), target);
        }
      } else if (existsSync(abs)) {
        real = realpathSync(abs);
      }
    } catch {
      if (existsSync(abs)) {
        real = realpathSync(abs);
      }
    }
    if (real && isSensitivePath(real, workspaceRoot)) {
      throw new Error(
        `Akses ke file sensitif "${targetPath}" (mengarah ke "${real}") ditolak demi keamanan kredensial/data sensitif.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('file sensitif')) {
      throw err;
    }
  }
}

/**
 * Checks if a string contains references to sensitive files (.ruko/config.json, .env, .git-credentials, SSH keys).
 */
export function containsSensitiveFilePattern(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const decoded = decodePathSafely(text).toLowerCase();
  const unescaped = decoded.replace(/\\([^\s])/g, '$1');
  const candidates = [decoded, unescaped];

  for (const c of candidates) {
    if (/\.ruko[/\\]config\.json\b/i.test(c)) return true;
    if (/\.git-credentials\b/i.test(c)) return true;
    if (/(?:^|\s|["'/\\])\.env(?:\.[a-zA-Z0-9_-]+)?\b/i.test(c)) return true;
    if (/\b(?:id_rsa|id_ed25519)\b/i.test(c)) return true;
    if (/\.git[/\\]config\b/i.test(c)) return true;
  }
  return false;
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
  workspaceRoot: string = getWorkspaceRoot(),
): Promise<string> {
  // Reject mutating immutable security core files
  assertNotSecurityCore(fileLabel, workspaceRoot);
  assertNotSecurityCore(abs, workspaceRoot);

  // Payload size limit protection (Finding 2)
  const byteLen = Buffer.byteLength(newContent, 'utf8');
  if (byteLen > MAX_FILE_WRITE_BYTES) {
    throw new Error(
      `Payload terlalu besar: ukuran berkas (${byteLen} bytes) melebihi batas maksimum 5MB.`,
    );
  }

  let oldContent = '';
  let existed = false;
  let readHandle;
  try {
    readHandle = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    oldContent = await readHandle.readFile('utf8');
    existed = true;
  } catch (err: any) {
    if (err?.code === 'ELOOP' || (err instanceof Error && err.message.includes('symbolic link'))) {
      throw new Error(
        `Akses ditolak: "${fileLabel}" adalah symbolic link. Menulis atau mengubah file melalui symbolic link dilarang demi keamanan sandbox.`,
      );
    }
    if (err?.code !== 'ENOENT') throw err;
  } finally {
    await readHandle?.close();
  }

  if (existed && oldContent === newContent) {
    onLog?.(yellow(`🟡 Edit(${fileLabel}) — tidak ada perubahan`));
    return JSON.stringify({ ok: true, note: 'File sudah berisi konten yang sama; tidak ada perubahan.' });
  }
  // Undo safety net (§6): snapshot the old state before any mutation.
  takeSnapshot(abs);

  // Eliminate TOCTOU swap window: atomic open with O_NOFOLLOW
  const openFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0);
  let writeHandle;
  try {
    writeHandle = await open(abs, openFlags, 0o644);
    await writeHandle.writeFile(newContent, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ELOOP' || (err instanceof Error && err.message.includes('symbolic link'))) {
      throw new Error(`Akses ditolak: "${fileLabel}" terdeteksi sebagai symbolic link sebelum penulisan.`);
    }
    throw err;
  } finally {
    await writeHandle?.close();
  }
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
    let canonicalCwd = cwd;
    try {
      if (existsSync(cwd)) canonicalCwd = realpathSync(cwd);
    } catch {}
    const canonicalCwdPrefix = canonicalCwd.endsWith(path.sep) ? canonicalCwd : canonicalCwd + path.sep;

    const isLexical =
      abs === cwd || abs.startsWith(cwdPrefix) || abs === canonicalCwd || abs.startsWith(canonicalCwdPrefix);
    if (!isLexical) return false;

    if (existsSync(abs)) {
      const real = realpathSync(abs);
      return real === cwd || real.startsWith(cwdPrefix) || real === canonicalCwd || real.startsWith(canonicalCwdPrefix);
    }
    return true;
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

/** Helper to detect runtime scripting inline commands attempting to dump or access environment variables. */
function checkRuntimeInlineEnv(segment: string): boolean {
  const trimmed = segment.trim();

  // Node / Bun / Deno: node -e / --eval "..."
  if (/\b(?:node|nodejs|bun|deno)\s+(?:-[a-z]*e\b|--eval\b)/i.test(trimmed)) {
    if (/\b(?:process\.env|Deno\.env)\b/.test(trimmed)) {
      return true;
    }
  }

  // Python: python -c "..."
  if (/\bpython[23]?\s+(?:-[a-z]*c\b)/i.test(trimmed)) {
    if (/\b(?:os\.)?(?:environ|getenv)\b/.test(trimmed)) {
      return true;
    }
  }

  // Ruby: ruby -e "..."
  if (/\bruby\s+(?:-[a-z]*e\b)/i.test(trimmed)) {
    if (/\bENV\b/.test(trimmed)) {
      return true;
    }
  }

  // Perl: perl -e "..."
  if (/\bperl\s+(?:-[a-z]*e\b)/i.test(trimmed)) {
    if (/%ENV|\$ENV\{/.test(trimmed)) {
      return true;
    }
  }

  // PHP: php -r "..."
  if (/\bphp\s+(?:-[a-z]*r\b)/i.test(trimmed)) {
    if (/\$(?:_ENV|_SERVER)\b|\bgetenv\b/.test(trimmed)) {
      return true;
    }
  }

  // PowerShell: pwsh -c / powershell -Command "..."
  if (/\b(?:pwsh|powershell)\s+(?:-[a-z]*(?:c|command)\b)/i.test(trimmed)) {
    if (/\$env:|Get-ChildItem\s+env:/i.test(trimmed)) {
      return true;
    }
  }

  return false;
}

/**
 * Helper to extract subshell substitutions: $(cmd), `cmd`, <(cmd),
 * and dynamic evaluation targets: eval "cmd", sh -c "cmd", bash -c "cmd"
 */
function extractSubshellAndEvalCommands(cmd: string): string[] {
  const extracted: string[] = [];

  // $(cmd)
  const dollarParen = /\$\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = dollarParen.exec(cmd)) !== null) {
    if (m[1]?.trim()) extracted.push(m[1].trim());
  }

  // `cmd`
  const backtick = /`([^`]+)`/g;
  while ((m = backtick.exec(cmd)) !== null) {
    if (m[1]?.trim()) extracted.push(m[1].trim());
  }

  // <(cmd)
  const procSub = /<\(([^)]+)\)/g;
  while ((m = procSub.exec(cmd)) !== null) {
    if (m[1]?.trim()) extracted.push(m[1].trim());
  }

  // eval "cmd" or eval 'cmd' or eval cmd
  const evalPattern = /\beval\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi;
  while ((m = evalPattern.exec(cmd)) !== null) {
    const target = m[1] ?? m[2] ?? m[3];
    if (target?.trim()) extracted.push(target.trim());
  }

  return extracted;
}

/**
 * Detects if a shell command in exec attempts to dump environment variables
 * broadly or target sensitive environment variables specifically.
 */
export function isSensitiveEnvCommand(command: string): boolean {
  if (!command || typeof command !== 'string') return false;

  // 1. Direct or indirect access to /proc/*/environ pseudofiles
  if (/(?:^|[\s"'`|&;<>()])\/?proc\/(?:self|\$\$|\$ppid|[0-9]+|\*|[a-z0-9_$]+)\/environ\b/i.test(command)) {
    return true;
  }

  const resolved = extractAndResolveShellVariables(command);
  const allVariants = new Set<string>();
  allVariants.add(command);
  if (resolved) {
    allVariants.add(resolved);
    const unescaped = resolved.replace(/\\([^\s])/g, '$1');
    if (unescaped) allVariants.add(unescaped);
  }
  const unescapedCmd = command.replace(/\\([^\s])/g, '$1');
  if (unescapedCmd) allVariants.add(unescapedCmd);

  const subCommands = extractSubshellAndEvalCommands(command);
  for (const sc of subCommands) {
    allVariants.add(sc);
    const unescSub = sc.replace(/\\([^\s])/g, '$1');
    if (unescSub) allVariants.add(unescSub);
  }
  if (resolved && resolved !== command) {
    const subResolved = extractSubshellAndEvalCommands(resolved);
    for (const sc of subResolved) {
      allVariants.add(sc);
      const unescSub = sc.replace(/\\([^\s])/g, '$1');
      if (unescSub) allVariants.add(unescSub);
    }
  }

  for (const variant of allVariants) {
    // 1. Direct variable expansion $VAR, ${VAR}, ${!VAR}
    const varMatches = variant.matchAll(/\$\{?!?([a-zA-Z_][a-zA-Z0-9_]*)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g);
    for (const m of varMatches) {
      const varName = m[1] ?? m[2];
      if (varName && SENSITIVE_VAR_REGEX.test(varName)) {
        return true;
      }
    }

    // 2. Variable assignments with sensitive values (e.g. V=RUKO_API_KEY; echo ${!V} or echo $V)
    const assignRe = /(?:^|[;&|\s])([a-zA-Z_][a-zA-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))/g;
    let am: RegExpExecArray | null;
    while ((am = assignRe.exec(variant)) !== null) {
      const val = am[2] ?? am[3] ?? am[4] ?? '';
      if (SENSITIVE_VAR_REGEX.test(val)) {
        const name = am[1];
        if (new RegExp(`\\$(?:\\{!?\\s*${name}\\s*\\}|${name}\\b)`).test(variant)) {
          return true;
        }
      }
    }

    // 3. Chained segments (including subshells)
    const segments = chainedSegments(variant);
    for (const seg of segments) {
      const s = seg.trim().replace(/^sudo\s+/, '');
      if (!s) continue;

      const unescSeg = s.replace(/\\([^\s])/g, '$1');
      const testSegs = [s, unescSeg];

      for (const ts of testSegs) {
        if (checkPrintenvSegment(ts)) {
          return true;
        }

        if (checkEnvSegment(ts)) {
          return true;
        }

        // Bare export or export -p dumps environment in bash
        if (/^(?:export)(?:\s+-p)?$/i.test(ts)) {
          return true;
        }

        // declare -p or typeset -p (bare or with sensitive variable name)
        const declMatch = ts.match(/^(?:declare|typeset)\s+-p(?:\s+(.*))?$/i);
        if (declMatch) {
          const declArgs = declMatch[1]?.trim();
          if (!declArgs || SENSITIVE_VAR_REGEX.test(declArgs)) {
            return true;
          }
        }

        // declare or declare -p
        if (/^(?:declare)(?:\s+-[a-zA-Z]*p[a-zA-Z]*)?$/i.test(ts)) {
          return true;
        }

        // Bare set (without flags) dumps all shell variables in bash
        if (/^set(?:\s*[><|].*)?$/i.test(ts) || /^(?:set)(?:\s+[><].*)?$/i.test(ts)) {
          return true;
        }

        // awk / gawk / mawk / nawk ENVIRON access
        if (/\b(?:g|m|n)?awk\b/i.test(ts) && /\bENVIRON\b/.test(ts)) {
          return true;
        }

        // Runtime scripting inline execution accessing environment variables (VULN-03)
        if (checkRuntimeInlineEnv(ts)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * VULN-02: Detects if a token contains wildcard/glob characters (*, ?, [...])
 * that target sensitive paths (.ruko/**, .env*, id_rsa*, *.pem, *.key, etc.)
 */
export function isSensitiveWildcardPattern(candidate: string): boolean {
  if (!candidate || typeof candidate !== 'string') return false;
  if (!/[*?[\]]/.test(candidate)) return false;

  const normalized = candidate.replace(/\\/g, '/');
  const base = path.posix.basename(normalized).toLowerCase();

  // 1. Any wildcard touching .ruko (e.g. .ruko/*, .ruko/conf*, */.ruko/*, .ruko*)
  if (/(?:^|\/)\.ruko(?:\/|[?*]|$)/i.test(normalized)) {
    return true;
  }

  // 2. Wildcard targeting .env files (e.g. .env*, .env.*, *.env, path/to/.env*)
  if (
    /(?:^|\/)\.env[*?.]/i.test(normalized) ||
    base === '.env*' ||
    base.startsWith('.env') ||
    base.endsWith('.env')
  ) {
    return true;
  }

  // 3. Wildcard targeting private keys or certificates (id_rsa*, id_ed25519*, id_*, *.pem, *.key, ~/.ssh/*)
  if (
    /(?:^|\/)id_rsa/i.test(normalized) ||
    /(?:^|\/)id_ed25519/i.test(normalized) ||
    /(?:^|\/)id_[*?]/i.test(normalized) ||
    /(?:^|\/)\.ssh(?:\/|$)/i.test(normalized) ||
    /\.(?:pem|key)[*?]?$/i.test(normalized) ||
    base.endsWith('.pem') ||
    base.endsWith('.key')
  ) {
    return true;
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
  const resolved = extractAndResolveShellVariables(command);
  const variants = new Set<string>();
  variants.add(command);
  if (resolved) {
    variants.add(resolved);
  }
  const subCommands = extractSubshellAndEvalCommands(command);
  for (const sc of subCommands) {
    variants.add(sc);
  }
  if (resolved && resolved !== command) {
    const subResolved = extractSubshellAndEvalCommands(resolved);
    for (const sc of subResolved) {
      variants.add(sc);
    }
  }

  for (const variant of variants) {
    const segments = chainedSegments(variant);

    for (const seg of segments) {
      const s = seg.trim().replace(/^sudo\s+/, '');

    const tokenRegex = /[^\s"';&|()<>\`]+|"([^"]*)"|'([^']*)'/g;
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

        // Candidate testing: raw, unescaped, decoded
        const candidates = new Set<string>();
        candidates.add(candidate);
        const unesc = candidate.replace(/\\(.)/g, '$1');
        candidates.add(unesc);
        const dec = decodePathSafely(candidate);
        candidates.add(dec);
        const decUnesc = decodePathSafely(unesc);
        candidates.add(decUnesc);

        for (const cand of candidates) {
          if (isSensitivePath(cand, workspaceRoot) || isSensitiveWildcardPattern(cand)) {
            return {
              blocked: true,
              target: candidate,
              message: `exec ditolak: akses ke file sensitif ("${candidate}") diblokir demi keamanan kredensial/data sensitif.`,
            };
          }
        }
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
      try {
        assertNotSecurityCore(file, ws);
      } catch (err) {
        return JSON.stringify({
          error: `${call.tool}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      const content = typeof call.content === 'string' ? call.content : null;
      if (content == null) {
        return JSON.stringify({ error: `${call.tool}: missing "content" field (string)` });
      }
      const byteLen = Buffer.byteLength(content, 'utf8');
      if (byteLen > MAX_FILE_WRITE_BYTES) {
        return JSON.stringify({
          error: `${call.tool}: payload terlalu besar (${byteLen} bytes) melebihi batas maksimum 5MB.`,
        });
      }
      let abs: string;
      let rel: string;
      try {
        abs = resolveToolPath(file, ws);
        rel = path.relative(ws, abs) || file;
        assertNotSecurityCore(file, ws);
        assertNotSecurityCore(abs, ws);
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
        return await writeWithDiff(abs, rel, content, deps.onLog, ws);
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
      try {
        assertNotSecurityCore(file, ws);
      } catch (err) {
        return JSON.stringify({
          error: `patch_file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      const rawOld = call.oldText ?? call.old_string ?? call.search;
      const rawNew = call.newText ?? call.new_string ?? call.replace;
      const oldText = typeof rawOld === 'string' ? rawOld : null;
      const newText = typeof rawNew === 'string' ? rawNew : null;
      if (oldText == null || newText == null) {
        return JSON.stringify({ error: 'patch_file: missing "oldText"/"newText" (strings)' });
      }
      let abs: string;
      let rel: string;
      try {
        abs = resolveToolPath(file, ws);
        assertNotSecurityCore(abs, ws);
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
        return await writeWithDiff(abs, rel, after, deps.onLog, ws);
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
        assertNotSecurityCore(file, ws);
        abs = resolveToolPath(file, ws);
        assertNotSecurityCore(abs, ws);
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
        assertNotSecurityCore(source, ws);
        sourceAbs = resolveToolPath(source, ws);
        assertNotSecurityCore(sourceAbs, ws);
        sourceRel = path.relative(ws, sourceAbs) || source;
      } catch (err) {
        return JSON.stringify({
          error: `move_file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      try {
        assertNotSecurityCore(target, ws);
        targetAbs = resolveToolPath(target, ws);
        assertNotSecurityCore(targetAbs, ws);
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
        assertNotSecurityCore(file, ws);
        abs = resolveToolPath(file, ws);
        assertNotSecurityCore(abs, ws);
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
    // ── Tool: delegate ─────────────────────────────────────────────────
    // PENTING — Sifat Eksekusi Sekuensial:
    // Tool delegate mengeksekusi SATU tool call per giliran secara SEKUENSIAL
    // (bukan concurrent/paralel). Setiap delegate berjalan di konteks terisolasi
    // sendiri dengan Context terpisah, namun TIDAK berjalan bersamaan dengan
    // delegate lain maupun tool call lain dalam turn yang sama.
    //
    // Default timeout: 60 detik. Jika subagent timeout:
    // - Sistem otomatis melaporkan file yang sempat termodifikasi
    // - User dapat melakukan rollback via /undo
    //
    // Nesting limit: 1 level (subagent tidak boleh memanggil delegate lagi).
    // ────────────────────────────────────────────────────────────────────
    case 'delegate': {
      if (deps.subagentDepth && deps.subagentDepth >= 1) {
        const msg = 'delegate ditolak: subagent tidak diizinkan memanggil delegate secara bertingkat (delegation recursion limit = 1).';
        deps.onLog?.(yellow(`⚠ ${msg}`));
        return JSON.stringify({ error: msg });
      }
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
        const timeoutMs =
          typeof call.timeout_ms === 'number'
            ? call.timeout_ms
            : (typeof call.timeout === 'number' ? call.timeout : undefined);
        const subResult = await runSubagent(
          task,
          {
            config: deps.config ?? DEFAULT_CONFIG,
            llmProvider: deps.llmProvider,
            confirm: deps.confirm,
            onLog: deps.onLog,
            signal: deps.signal,
            activityTray: deps.activityTray,
          },
          {
            planMode: deps.planMode,
            workspaceRoot: ws,
            depth: (deps.subagentDepth ?? 0) + 1,
            timeoutMs,
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

      if (isSensitiveEnvCommand(command)) {
        const msg = 'start_process ditolak: command berpotensi membocorkan environment variable sensitif. Kredensial tidak dapat diakses lewat tool ini.';
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
        deps.onLog?.(yellow(`⚠ start_process ditolak: gunakan tool resmi ${mutationCheck.toolAdvice}`));
        return JSON.stringify({
          error: mutationCheck.message,
        });
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
      const verdict = detectRisk(command, config);
      if (verdict.risk === 'blocked') {
        const msg = `start_process ditolak: BLOCKED — ${verdict.reason ?? 'perintah dilarang demi keamanan'}`;
        deps.onLog?.(yellow(`⚠ ${msg}`));
        return JSON.stringify({ error: msg });
      }

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
export function normalizeToolName(toolName: string): string {
  const name = toolName.trim();
  const lower = name.toLowerCase();
  
  // Read aliases
  if (lower === 'read' || lower === 'readfile' || lower === 'read_file') return 'read_file';
  
  // Exec / Bash aliases  
  if (lower === 'bash' || lower === 'shell' || lower === 'sh' || lower === 'terminal' || lower === 'execute_command' || lower === 'run_command') return 'exec';
  
  // Edit aliases
  if (lower === 'edit' || lower === 'editfile' || lower === 'edit_file') return 'edit_file';
  
  // Write aliases
  if (lower === 'write' || lower === 'writefile' || lower === 'write_file') return 'write_file';
  
  // Search aliases
  if (lower === 'search' || lower === 'search_files' || lower === 'find_in_files' || lower === 'code_search') return 'code_search';
  
  // Glob aliases
  if (lower === 'glob' || lower === 'glob_files' || lower === 'list_files') return 'glob';
  
  // ListDir aliases
  if (lower === 'listdir' || lower === 'list_dir' || lower === 'ls') return 'list_dir';
  
  // Delete aliases
  if (lower === 'delete' || lower === 'deletefile' || lower === 'delete_file') return 'delete_file';
  
  // Move aliases
  if (lower === 'move' || lower === 'movefile' || lower === 'move_file' || lower === 'rename') return 'move_file';
  
  // Patch aliases
  if (lower === 'patch' || lower === 'patchfile' || lower === 'patch_file') return 'patch_file';
  
  return name;
}

/** Regex for <tool>JSON</tool> or unclosed <tool>JSON (Nemotron/generic style). */
const XML_TOOL_TAG_RE = /<tool>\s*([\s\S]*?)\s*(?:<\/tool>|$)/gi;
/** Regex for <tool name="..." attr="..." /> or <tool name="..." attr="..."></tool> */
const XML_TOOL_ATTR_RE = /<tool\s+([^>]*?)\s*\/?>/gi;
/** Regex for ```json ... ``` blocks */
const JSON_FENCE_RE = /```json\s*\n([\s\S]*?)\n\s*```/gi;

/** Normalize common parameter key aliases. */
function normalizeToolParams(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    const lk = key.toLowerCase();
    if (lk === 'file_path' || lk === 'filepath' || lk === 'file') {
      result.path = value;
    } else if (lk === 'old_text' || lk === 'old_string') {
      result.oldText = value;
    } else if (lk === 'new_text' || lk === 'new_string') {
      result.newText = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Extract a single fallback tool call from model output (handles many formats). */
export function extractFallbackToolCall(content: string): ToolCall | null {
  const calls = extractFallbackToolCalls(content);
  return calls.length > 0 ? calls[0] : null;
}

/** Extract all fallback tool calls from model output (handles many non-standard formats). */
export function extractFallbackToolCalls(content: string): ToolCall[] {
  // First try standard parseToolCalls
  const { calls: standardCalls } = parseToolCalls(content);
  if (standardCalls.length > 0) return standardCalls;
  
  const calls: ToolCall[] = [];
  
  // 1. <tool>{JSON}</tool> format
  for (const match of content.matchAll(XML_TOOL_TAG_RE)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && typeof parsed === 'object') {
        let toolName = parsed.tool ?? parsed.name ?? '';
        if (typeof toolName === 'string' && toolName) {
          toolName = normalizeToolName(toolName);
          const { tool: _t, name: _n, ...rest } = parsed;
          const normalized = normalizeToolParams(rest);
          calls.push({ tool: toolName, ...normalized });
        }
      }
    } catch {
      // ignore malformed
    }
  }
  if (calls.length > 0) return calls;
  
  // 2. <tool name="..." path="..." /> attribute format
  for (const match of content.matchAll(XML_TOOL_ATTR_RE)) {
    const attrStr = match[1];
    const attrs: Record<string, string> = {};
    for (const am of attrStr.matchAll(/(\w+)=["']([^"']*)["']/g)) {
      attrs[am[1]] = am[2];
    }
    const toolName = attrs.name;
    if (toolName) {
      const { name: _n, ...rest } = attrs;
      const normalized = normalizeToolParams(rest as Record<string, unknown>);
      calls.push({ tool: normalizeToolName(toolName), ...normalized });
    }
  }
  if (calls.length > 0) return calls;
  
  // 3. ```json ... ``` blocks
  for (const match of content.matchAll(JSON_FENCE_RE)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed && typeof parsed === 'object') {
        let toolName = parsed.tool ?? parsed.name ?? '';
        if (typeof toolName === 'string' && toolName) {
          toolName = normalizeToolName(toolName);
          let args = parsed.arguments ?? parsed.parameters ?? {};
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch { args = {}; }
          }
          const { tool: _t, name: _n, arguments: _a, parameters: _p, ...directRest } = parsed;
          const merged = { ...directRest, ...(typeof args === 'object' && args ? args : {}) };
          const normalized = normalizeToolParams(merged);
          calls.push({ tool: toolName, ...normalized });
        }
      }
    } catch {
      // ignore
    }
  }
  
  return calls;
}
