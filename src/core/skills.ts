import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Skills System for Ruko Agent.
 *
 * Provides reusable skill packages and operational workflows
 * stored under `<workspace>/.ruko/skills/` (local) and `~/.ruko/skills/` (global).
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

export const DEFAULT_ANTI_SLOP_CONTENT = `---
name: anti-slop
description: Guardrail anti-slop: larangan basa-basi robotik, over-commenting, dan boilerplate kosong.
---
# Anti-Slop Guardrail
- Aturan ketat: Dilarang menggunakan basa-basi pembuka/penutup robotik (seperti "Tentu, saya akan membantu Anda", "Berikut adalah kodenya", dsb).
- Langsung eksekusi tool atau berikan jawaban to-the-point tanpa intro bertele-tele.
- Hindari menambahkan komentar penjelasan berlebihan (over-commenting) pada kode yang tidak diminta.
- Jangan generate boilerplate kosong yang tidak berguna.
`;

export const DEFAULT_ANTI_HALLUCINATION_CONTENT = `---
name: anti-hallucination
description: Guardrail anti-halusinasi: verifikasi berkas, baca sebelum edit, akui error tool secara faktual.
---
# Anti-Hallucination Guardrail
- Aturan ketat: Jangan pernah berasumsi berkas atau path itu ada sebelum memeriksa dengan list_dir atau file_search / glob.
- Selalu baca isi berkas dengan read_file sebelum membuat patch/edit, jangan menebak isi baris kode.
- Jika output tool menghasilkan error, akui error tersebut secara faktual dan jangan pura-pura prosesnya berhasil.
- Jangan mengarang nama library, fungsi, atau parameter API yang tidak valid.
`;

export function defaultSkillsDir(workspaceRoot: string = process.cwd()): string {
  return join(resolve(workspaceRoot), '.ruko', 'skills');
}

export function globalSkillsDir(): string {
  return join(homedir(), '.ruko', 'skills');
}

/** Inisialisasi berkas guardrail default (anti-slop & anti-hallucination) jika belum ada. */
export function initDefaultSkills(workspaceRoot: string = process.cwd()): void {
  const dir = defaultSkillsDir(workspaceRoot);
  mkdirSync(dir, { recursive: true });

  const antiSlopPath = join(dir, 'anti-slop.md');
  try {
    writeFileSync(antiSlopPath, DEFAULT_ANTI_SLOP_CONTENT, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
  }

  const antiHallucinationPath = join(dir, 'anti-hallucination.md');
  try {
    writeFileSync(antiHallucinationPath, DEFAULT_ANTI_HALLUCINATION_CONTENT, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
  } catch (e: any) {
    if (e?.code !== 'EEXIST') throw e;
  }
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

/** Internal directory scanner for `.md` files or `<name>/SKILL.md`. */
export function scanDirectory(dir: string): SkillDef[] {
  if (!existsSync(dir)) return [];

  const skills: SkillDef[] = [];
  try {
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
  } catch {
    // ignore unreadable directory
  }

  return skills;
}

/** Lists all available skills in local .ruko/skills. */
export function listSkills(workspaceRoot: string = process.cwd()): SkillDef[] {
  const dir = defaultSkillsDir(workspaceRoot);
  const skills = scanDirectory(dir);
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export interface ScanSkillsOptions {
  includeGlobal?: boolean;
  globalDir?: string;
}

/**
 * Scans `.md` files from local `.ruko/skills/` and global `~/.ruko/skills/`.
 * Local skills override global skills with the same name.
 */
export function scanSkills(
  workspaceRoot: string = process.cwd(),
  options: ScanSkillsOptions = { includeGlobal: true },
): SkillDef[] {
  const localDir = defaultSkillsDir(workspaceRoot);
  const localSkills = scanDirectory(localDir);

  if (options.includeGlobal === false) {
    return localSkills.sort((a, b) => a.name.localeCompare(b.name));
  }

  const gDir = options.globalDir ?? globalSkillsDir();
  const globalSkills = resolve(localDir) !== resolve(gDir) ? scanDirectory(gDir) : [];

  const skillMap = new Map<string, SkillDef>();
  // Global skills first
  for (const s of globalSkills) {
    skillMap.set(s.name.toLowerCase(), s);
  }
  // Local skills override global skills
  for (const s of localSkills) {
    skillMap.set(s.name.toLowerCase(), s);
  }

  return Array.from(skillMap.values()).sort((a, b) => a.name.localeCompare(b.name));
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

  // Check global directory if not found locally
  const gDir = globalSkillsDir();
  if (existsSync(gDir)) {
    const canonicalGDir = resolve(gDir);
    const gPrefix = canonicalGDir.endsWith(sep) ? canonicalGDir : canonicalGDir + sep;

    const globalDirect = join(gDir, `${safeName}.md`);
    const canonicalGlobalDirect = resolve(globalDirect);
    if (canonicalGlobalDirect.startsWith(gPrefix) || canonicalGlobalDirect === canonicalGDir) {
      if (existsSync(globalDirect)) {
        try {
          const raw = readFileSync(globalDirect, 'utf8');
          const parsed = parseSkillContent(raw, safeName);
          parsed.filePath = globalDirect;
          return parsed;
        } catch {
          // continue
        }
      }
    }

    const globalNested = join(gDir, safeName, 'SKILL.md');
    const canonicalGlobalNested = resolve(globalNested);
    if (canonicalGlobalNested.startsWith(gPrefix) || canonicalGlobalNested === canonicalGDir) {
      if (existsSync(globalNested)) {
        try {
          const raw = readFileSync(globalNested, 'utf8');
          const parsed = parseSkillContent(raw, safeName);
          parsed.filePath = globalNested;
          return parsed;
        } catch {
          // continue
        }
      }
    }
  }

  // Case-insensitive search across listed skills
  const all = scanSkills(workspaceRoot, { includeGlobal: true });
  return all.find((s) => s.name.toLowerCase() === safeName) ?? null;
}

/**
 * Parses skill names and instruction contents, merges them into a single
 * context string for the LLM, keeping context token efficiency in mind.
 */
export function loadSkillsContext(
  skillsOrWorkspace?: SkillDef[] | string,
  maxChars = 8000,
): string {
  let skills: SkillDef[];
  if (Array.isArray(skillsOrWorkspace)) {
    skills = skillsOrWorkspace;
  } else {
    skills = scanSkills(skillsOrWorkspace, { includeGlobal: true });
  }

  if (skills.length === 0) return '';

  const blocks: string[] = [];
  let currentChars = 0;

  for (const skill of skills) {
    let cleanInstructions = skill.instructions
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const header = `### Skill: ${skill.name}\n`;
    if (currentChars + header.length >= maxChars) {
      blocks.push(`<!-- Skill ${skill.name} omitted: context budget limit reached -->`);
      break;
    }

    const remainingBudget = maxChars - (currentChars + header.length);
    if (cleanInstructions.length > remainingBudget) {
      const truncateNotice = '\n[...dipotong demi efisiensi context]';
      const sliceLen = Math.max(0, remainingBudget - truncateNotice.length);
      if (sliceLen >= 10) {
        cleanInstructions = cleanInstructions.slice(0, sliceLen) + truncateNotice;
      } else {
        blocks.push(`<!-- Skill ${skill.name} omitted: context budget limit reached -->`);
        break;
      }
    }

    const block = `${header}${cleanInstructions}`;
    blocks.push(block);
    currentChars += block.length;
  }

  return (
    '<active_skills_instructions>\n' +
    'The following skill instructions and guardrails are actively loaded and must be strictly followed:\n\n' +
    blocks.join('\n\n') +
    '\n</active_skills_instructions>'
  );
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
