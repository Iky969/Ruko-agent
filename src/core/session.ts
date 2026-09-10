import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Saves the current messages; reuses `id` when given, else derives a new one. */
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
  writeFileSync(join(dir, `${sessionId}.json`), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
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