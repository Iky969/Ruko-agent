import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContextMessage } from '../types.js';

/**
 * Session persistence — conversations are saved as JSON files under
 * `<cwd>/.ruko/sessions/<id>.json` and can be resumed later.
 */

export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export interface Session extends SessionMeta {
  createdAt: string;
  messages: ContextMessage[];
}

export function defaultSessionDir(): string {
  return join(process.cwd(), '.ruko', 'sessions');
}

/** Saves a session to disk (creates directory if missing). */
export function saveSession(
  messages: ContextMessage[],
  dir = defaultSessionDir(),
  id?: string,
): Session {
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const sessionId = id ?? now.replace(/[:.]/g, '-');
  const session: Session = {
    id: sessionId,
    title: inferTitle(messages),
    createdAt: now,
    updatedAt: now,
    messageCount: messages.length,
    messages,
  };
  const filePath = join(dir, `${sessionId}.json`);
  writeFileSync(filePath, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(filePath, 0o600); // M4: enforce owner-only permissions on session transcripts
  } catch {
    // Best-effort on filesystems without POSIX permissions
  }
  return session;
}

/** Lists saved sessions (newest first), skipping corrupt files. */
export function listSessions(dir = defaultSessionDir()): SessionMeta[] {
  if (!existsSync(dir)) return [];
  const metas: SessionMeta[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const s = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Session;
      metas.push({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      });
    } catch {
      // corrupt session file — skip
    }
  }
  return metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Loads a session by id, or null when missing/corrupt. */
export function loadSession(id: string, dir = defaultSessionDir()): Session | null {
  try {
    const raw = readFileSync(join(dir, `${id}.json`), 'utf8');
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

/** Derives a short title from the first user message. */
export function inferTitle(messages: ContextMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return 'untitled';
  const line = first.content.split('\n')[0].trim();
  if (!line) return 'untitled';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

export interface SessionSearchResult {
  sessionId: string;
  title: string;
  updatedAt: string;
  timestamp: string;
  messageCount: number;
  role: string;
  snippet: string;
}

/**
 * Searches saved sessions for matching keywords across all messages.
 * Reads incrementally (file-by-file) sorted by newest first without loading all sessions into memory.
 */
export function searchSessions(
  query: string,
  dir = defaultSessionDir(),
  maxResults = 20,
): SessionSearchResult[] {
  if (!existsSync(dir) || !query.trim()) return [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const results: SessionSearchResult[] = [];

  // Urutkan file berdasarkan mtime menurun (paling baru duluan) tanpa memuat seluruh konten
  const fileEntries: { file: string; mtimeMs: number }[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const mtimeMs = statSync(join(dir, file)).mtimeMs;
      fileEntries.push({ file, mtimeMs });
    } catch {
      // abaikan file yang tidak dapat di-stat
    }
  }
  fileEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { file } of fileEntries) {
    try {
      const fullPath = join(dir, file);
      const raw = readFileSync(fullPath, 'utf8');
      const s = JSON.parse(raw) as Session;
      if (!s.messages || !Array.isArray(s.messages)) continue;

      const totalMessages = s.messages.length;
      for (let i = 0; i < totalMessages; i++) {
        const msg = s.messages[i];
        if (!msg || typeof msg.content !== 'string') continue;
        const lower = msg.content.toLowerCase();
        const matchesAll = terms.every((t) => lower.includes(t));
        if (matchesAll) {
          const firstTerm = terms[0];
          const pos = lower.indexOf(firstTerm);
          const start = Math.max(0, pos - 50);
          const end = Math.min(msg.content.length, pos + firstTerm.length + 50);
          let snippet = msg.content.slice(start, end).replace(/\r?\n/g, ' ').trim();
          if (start > 0) snippet = '…' + snippet;
          if (end < msg.content.length) snippet = snippet + '…';
          if (snippet.length > 150) {
            snippet = snippet.slice(0, 147) + '…';
          }

          results.push({
            sessionId: s.id,
            title: s.title || 'untitled',
            updatedAt: s.updatedAt,
            timestamp: s.updatedAt,
            messageCount: totalMessages,
            role: msg.role,
            snippet,
          });

          if (results.length >= maxResults) return results;
        }
      }
    } catch {
      // skip corrupt files
    }
  }

  return results;
}

export function defaultExportDir(): string {
  return join(process.cwd(), '.ruko', 'exports');
}

export interface ExportResult {
  filePath: string;
  entryCount: number;
  format: 'jsonl' | 'md';
}

/**
 * Exports conversation trajectory to JSONL or Markdown for evaluation / analysis.
 */
export function exportSessionTrajectory(
  messages: ContextMessage[],
  format: 'jsonl' | 'md' = 'jsonl',
  dir = defaultExportDir(),
  sessionId?: string,
): ExportResult {
  mkdirSync(dir, { recursive: true });
  const id = sessionId ?? new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(dir, `${id}.${format}`);

  let content = '';
  if (format === 'jsonl') {
    const lines = messages.map((m, idx) =>
      JSON.stringify({
        step: idx + 1,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      }),
    );
    content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  } else {
    const parts = [
      `# Trajectory Export: ${id}`,
      `Generated: ${new Date().toISOString()}`,
      `Total steps: ${messages.length}`,
      '---',
      '',
    ];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      parts.push(`### Step ${i + 1} — [${m.role.toUpperCase()}] (${m.timestamp})`);
      parts.push('');
      parts.push(m.content);
      parts.push('');
    }
    content = parts.join('\n');
  }

  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {}

  return {
    filePath,
    entryCount: messages.length,
    format,
  };
}