/**
 * External Tool Runner — loads JSON manifests and executes tools as isolated subprocesses.
 * Implements process-boundary isolation for security (credentials stripped from env).
 *
 * Manifest format (tool.json):
 * {
 *   "name": "tool_name",
 *   "description": "What the tool does",
 *   "command": "executable",
 *   "args": ["arg1", "{{param1}}", "--flag", "{{param2}}"],
 *   "parameters": { "type": "object", "properties": {...}, "required": [...] }
 * }
 */
import { spawn } from 'node:child_process';
import { readFile, readdir, access } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { constants } from 'node:fs';

/** Shape of a tool.json manifest file. */
export interface ToolManifest {
  name: string;
  description: string;
  command: string;
  args?: string[];
  parameters?: {
    type: 'object';
    properties?: Record<string, { type: string; description?: string; enum?: string[] }>;
    required?: string[];
  };
  /** Optional timeout in milliseconds (default 30_000). */
  timeoutMs?: number;
  /** Optional working directory for the command. */
  cwd?: string;
}

/** Sensitive env var patterns to strip from child process environment. */
const SENSITIVE_ENV_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /openai/i,
  /anthropic/i,
  /gemini/i,
  /ssh[_-]auth/i,
];

/** Build a sanitized environment object with sensitive vars removed. */
export function sanitizeEnv(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const isSensitive = SENSITIVE_ENV_PATTERNS.some(re => re.test(key));
    if (!isSensitive) {
      clean[key] = value;
    }
  }
  return clean;
}

/** Validate a tool manifest object. Returns error message or null if valid. */
export function validateManifest(manifest: unknown): string | null {
  if (!manifest || typeof manifest !== 'object') {
    return 'Manifest harus berupa objek JSON.';
  }
  const m = manifest as Record<string, unknown>;
  if (typeof m.name !== 'string' || !m.name.trim()) {
    return 'Manifest harus memiliki field "name" bertipe string.';
  }
  if (typeof m.description !== 'string' || !m.description.trim()) {
    return 'Manifest harus memiliki field "description" bertipe string.';
  }
  if (typeof m.command !== 'string' || !m.command.trim()) {
    return 'Manifest harus memiliki field "command" bertipe string.';
  }
  if (m.args !== undefined && !Array.isArray(m.args)) {
    return 'Field "args" harus berupa array string.';
  }
  if (m.parameters !== undefined) {
    if (typeof m.parameters !== 'object') {
      return 'Field "parameters" harus berupa objek JSON Schema.';
    }
  }
  return null;
}

/** Load and validate a tool manifest from a JSON file. */
export async function loadManifest(filePath: string): Promise<ToolManifest> {
  const raw = await readFile(resolve(filePath), 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  const error = validateManifest(parsed);
  if (error) {
    throw new Error(`Manifest tidak valid (${basename(filePath)}): ${error}`);
  }
  return parsed as ToolManifest;
}

/** Scan a directory for tool manifest files (tool.json or *.tool.json). */
export async function scanManifests(dir: string): Promise<ToolManifest[]> {
  const resolvedDir = resolve(dir);
  try {
    await access(resolvedDir, constants.R_OK);
  } catch {
    return [];
  }
  const entries = await readdir(resolvedDir, { withFileTypes: true });
  const manifests: ToolManifest[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === 'tool.json' || entry.name.endsWith('.tool.json')) {
      try {
        const manifest = await loadManifest(join(resolvedDir, entry.name));
        manifests.push(manifest);
      } catch {
        // Skip invalid manifests
      }
    }
  }
  return manifests;
}

/** Interpolate template parameters in args array. */
export function interpolateArgs(args: string[], params: Record<string, unknown>): string[] {
  return args.map(arg => {
    return arg.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      const val = params[key];
      return val !== undefined ? String(val) : '';
    });
  });
}

/** Result of an external tool execution. */
export interface ExternalToolResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Execute an external tool manifest with given parameters. */
export async function executeExternalTool(
  manifest: ToolManifest,
  params: Record<string, unknown>,
  options?: { timeoutMs?: number; cwd?: string; signal?: AbortSignal },
): Promise<ExternalToolResult> {
  const timeout = options?.timeoutMs ?? manifest.timeoutMs ?? 30_000;
  const cwd = options?.cwd ?? manifest.cwd ?? process.cwd();
  const args = manifest.args ? interpolateArgs(manifest.args, params) : [];
  const cleanEnv = sanitizeEnv();

  return new Promise<ExternalToolResult>((resolve) => {
    const child = spawn(manifest.command, args, {
      cwd,
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeout);

    if (options?.signal) {
      options.signal.addEventListener('abort', () => {
        child.kill('SIGTERM');
      }, { once: true });
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + '\n' + String(err), exitCode: 1, timedOut: false });
    });

    // Prevent unhandled EPIPE if child process exits before/without reading stdin
    child.stdin?.on('error', () => {
      // Child process closed stdin or exited early — ignore EPIPE
    });

    // Send params as JSON to stdin for JSON-RPC style tools
    if (child.stdin && child.stdin.writable) {
      try {
        child.stdin.write(JSON.stringify(params), () => {
          try {
            child.stdin?.end();
          } catch {
            // ignore
          }
        });
      } catch {
        // stdin may be closed already
      }
    }
  });
}

/** Convert a ToolManifest to an OpenAI function tool definition. */
export function manifestToToolDefinition(manifest: ToolManifest): {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
} {
  return {
    type: 'function' as const,
    function: {
      name: manifest.name,
      description: manifest.description,
      parameters: manifest.parameters ?? { type: 'object', properties: {} },
    },
  };
}
