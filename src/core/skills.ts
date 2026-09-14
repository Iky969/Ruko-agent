import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Skills System for Ruko Agent.
 *
 * Provides reusable skill packages and operational workflows
 * stored under `<workspace>/.ruko/skills/`.
 *
 * Each skill can be:
 *   - `<name>.md`
 *   - `<name>/SKILL.md`
 */

export interface SkillDef {
  name: string;
  description: string;
  instructions: string;
  filePath?: string;
}

export function defaultSkillsDir(workspaceRoot: string = process.cwd()): string {
  return join(resolve(workspaceRoot), '.ruko', 'skills');
}

/** Parses frontmatter and body from a markdown skill file. */
export function parseSkillContent(raw: string, fallbackName: string): SkillDef {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) {
    // Extract first line as description if possible
    const lines = raw.trim().split('\n');
    const firstLine = lines[0].replace(/^#+\s*/, '').trim();
    return {
      name: fallbackName,
      description: firstLine || fallbackName,
      instructions: raw.trim(),
    };
  }

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (kv) {
      meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }

  return {
    name: meta.name || fallbackName,
    description: meta.description || 'Skill kustom.',
    instructions: raw.slice(match[0].length).trim(),
  };
}

/** Lists all available skills in .ruko/skills. */
export function listSkills(workspaceRoot: string = process.cwd()): SkillDef[] {
  const dir = defaultSkillsDir(workspaceRoot);
  if (!existsSync(dir)) return [];

  const skills: SkillDef[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    try {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const name = entry.name.replace(/\.md$/, '');
        const fullPath = join(dir, entry.name);
        const raw = readFileSync(fullPath, 'utf8');
        const parsed = parseSkillContent(raw, name);
        parsed.filePath = fullPath;
        skills.push(parsed);
      } else if (entry.isDirectory()) {
        const skillMd = join(dir, entry.name, 'SKILL.md');
        if (existsSync(skillMd)) {
          const raw = readFileSync(skillMd, 'utf8');
          const parsed = parseSkillContent(raw, entry.name);
          parsed.filePath = skillMd;
          skills.push(parsed);
        }
      }
    } catch {
      // ignore unreadable file
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function sanitizeSkillName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-');
}

/** Reads a specific skill by name. */
export function readSkill(name: string, workspaceRoot: string = process.cwd()): SkillDef | null {
  const safeName = sanitizeSkillName(name);
  if (!safeName) return null;
  const dir = defaultSkillsDir(workspaceRoot);
  const canonicalDir = resolve(dir);
  const prefix = canonicalDir.endsWith(sep) ? canonicalDir : canonicalDir + sep;

  const directFile = join(dir, `${safeName}.md`);
  const canonicalDirect = resolve(directFile);
  if (!canonicalDirect.startsWith(prefix) && canonicalDirect !== canonicalDir) {
    return null;
  }
  if (existsSync(directFile)) {
    try {
      const raw = readFileSync(directFile, 'utf8');
      const parsed = parseSkillContent(raw, safeName);
      parsed.filePath = directFile;
      return parsed;
    } catch {
      return null;
    }
  }

  const nestedFile = join(dir, safeName, 'SKILL.md');
  const canonicalNested = resolve(nestedFile);
  if (!canonicalNested.startsWith(prefix) && canonicalNested !== canonicalDir) {
    return null;
  }
  if (existsSync(nestedFile)) {
    try {
      const raw = readFileSync(nestedFile, 'utf8');
      const parsed = parseSkillContent(raw, safeName);
      parsed.filePath = nestedFile;
      return parsed;
    } catch {
      return null;
    }
  }

  // Case-insensitive search across listed skills
  const all = listSkills(workspaceRoot);
  return all.find((s) => s.name.toLowerCase() === safeName) ?? null;
}

/** Saves or updates a skill in `.ruko/skills/<name>.md`. */
export function saveSkill(
  name: string,
  description: string,
  instructions: string,
  workspaceRoot: string = process.cwd(),
): SkillDef {
  const dir = defaultSkillsDir(workspaceRoot);
  mkdirSync(dir, { recursive: true });

  const safeName = sanitizeSkillName(name);
  const filePath = join(dir, `${safeName}.md`);

  const content = [
    '---',
    `name: ${safeName}`,
    `description: ${description.trim().replace(/\n/g, ' ')}`,
    '---',
    '',
    instructions.trim(),
    '',
  ].join('\n');

  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });

  return {
    name: safeName,
    description: description.trim(),
    instructions: instructions.trim(),
    filePath,
  };
}

/**
 * Deletes a skill by name from `.ruko/skills/`.
 * Removes the .md file or nested directory containing SKILL.md.
 * Returns true if successfully deleted, or false if not found.
 */
export function deleteSkill(name: string, workspaceRoot: string = process.cwd()): boolean {
  const skill = readSkill(name, workspaceRoot);
  if (!skill || !skill.filePath) return false;

  const dir = defaultSkillsDir(workspaceRoot);
  const canonicalDir = resolve(dir);
  const prefix = canonicalDir.endsWith(sep) ? canonicalDir : canonicalDir + sep;
  const canonicalFile = resolve(skill.filePath);
  if (!canonicalFile.startsWith(prefix) && canonicalFile !== canonicalDir) {
    return false;
  }

  try {
    rmSync(skill.filePath, { force: true });
    const parent = dirname(skill.filePath);
    const canonicalParent = resolve(parent);
    if (parent !== dir && existsSync(parent) && (canonicalParent.startsWith(prefix) || canonicalParent === canonicalDir)) {
      try {
        rmSync(parent, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Formats available skills for inclusion in the system prompt. */
export function formatSkillsForPrompt(skills: SkillDef[]): string {
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- **${s.name}**: ${s.description}`);
  return (
    '<available_skills>\n' +
    'The following skills are available in the project. When a user task matches one of these skills, ' +
    'you may load its full detailed instructions using the `load_skill` tool:\n' +
    lines.join('\n') +
    '\n</available_skills>'
  );
}
