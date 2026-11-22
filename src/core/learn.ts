/**
 * `/learn` — pelajari satu dokumen/skill yang besar, pecah jadi kategori,
 * lalu pasang hanya kategori yang dipilih user sebagai skill-skill kecil.
 *
 * Kenapa memecah itu penting: `loadSkillsContext` di `src/agent/agent.ts`
 * menyuntikkan SEMUA skill ke system prompt dengan batas 8000 karakter.
 * Satu skill raksasa akan terpotong (atau memakan jatah skill lain), sementara
 * skill kecil muat dan gampang dipakai harian.
 *
 * Alur:
 *   1. Sumber dibaca (file di workspace, teks langsung via `--text`, atau
 *      URL GitHub — lihat `learnGithubSource`).
 *   2. `splitLearnContent` memecah berdasarkan struktur dokumen (heading).
 *      Bila dokumen tidak terstruktur, `categorizeWithLlm` memakai LLM dengan
 *      prompt JSON (`buildLearnCategorizePrompt`) untuk mengkategorikan.
 *   3. User ditanya apa yang mau dipasang — semua, atau kategori tertentu —
 *      lewat prompt JSON (`buildLearnAskPrompt`) + jawaban teks bebas
 *      (`parseLearnSelection`). Flag `--all` / `--only` untuk non-interaktif.
 *   4. Kategori terpilih disimpan sebagai skill kecil via `saveSkill`
 *      dari `src/core/skills.ts`; sesi learn disimpan sebagai JSON di
 *      `.ruko/learn/` supaya bisa diaudit / diulang.
 *
 * Modul ini murni (pure) kecuali `categorizeWithLlm`, `installLearnSkills`,
 * dan `learnGithubSource`: LLM di-inject lewat interface minimal `LearnLlm`
 * supaya test unit tidak pernah memanggil LLM beneran; network/git untuk
 * sumber GitHub di-inject lewat `GithubLearnDeps` supaya test tidak pernah
 * menyentuh network beneran.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { checkSsrfSafety, pinnedHttpFetch } from '../agent/webtools.js';
import { readSkill, sanitizeSkillName, saveSkill } from './skills.js';

/** Satu sumber learn: file di workspace, teks langsung, atau URL GitHub. */
export interface LearnSource {
  kind: 'file' | 'text' | 'github';
  /** Label sumber untuk ditampilkan & disimpan (path relatif, 'teks langsung', atau 'github:owner/repo@branch/path'). */
  label: string;
}

/** Satu kategori hasil pemecahan — calon satu skill kecil. */
export interface LearnCategory {
  /** Id slug, aman dipakai sebagai nama skill (`sanitizeSkillName`). */
  id: string;
  /** Nama skill yang akan disimpan. Sama dengan id (slug). */
  name: string;
  /** Judul kategori untuk ditampilkan ke user. */
  title: string;
  /** Ringkasan satu baris — dipakai sebagai deskripsi skill. */
  summary: string;
  /** Isi penuh kategori (markdown) — dipakai sebagai instruksi skill. */
  content: string;
  /** Panjang isi dalam karakter. */
  chars: number;
}

/** Sesi `/learn` — skema JSON yang disimpan di `.ruko/learn/*.json`. */
export interface LearnSession {
  version: 1;
  createdAt: string;
  source: LearnSource;
  categories: LearnCategory[];
  /** Id kategori yang dipilih user (kosong sebelum user memilih). */
  selectedIds: string[];
  /** Skill yang sudah terpasang dari sesi ini. */
  installed: Array<{ name: string; filePath: string; overwrote: boolean }>;
}

/** Hasil pemasangan kategori terpilih. */
export interface LearnInstallResult {
  installed: Array<{ name: string; filePath: string; overwrote: boolean }>;
}

/** Interface LLM minimal untuk kategorisasi — di-inject, bukan di-import. */
export interface LearnLlm {
  chat(
    messages: Array<{ role: 'user' | 'system'; content: string; timestamp: string }>,
    options?: { maxTokens?: number },
  ): Promise<string>;
}

/** Batas ukuran sumber learn (karakter). Di atas ini, tolak dengan pesan jelas. */
export const MAX_LEARN_SOURCE_CHARS = 200_000;
/** Target ukuran maksimal satu skill kecil (karakter) — muat di budget 8000. */
export const MAX_LEARN_SKILL_CHARS = 6_000;
/** Batas jumlah kategori per sesi learn (supaya daftar pilihan tetap readable). */
export const MAX_LEARN_CATEGORIES = 12;
/** Versi skema sesi learn. */
export const LEARN_SESSION_VERSION = 1 as const;

/**
 * JSON Schema (draft 2020-12) untuk `LearnSession` — sesi learn yang disimpan
 * di `.ruko/learn/*.json`. Dipakai untuk validasi & dokumentasi, bukan untuk
 * validasi runtime yang ketat di setiap baca (file sesi ditulis oleh Ruko sendiri).
 */
export const LEARN_SESSION_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://ruko.local/schemas/learn-session.json',
  title: 'LearnSession',
  description: 'Sesi /learn: sumber, kategori hasil pemecahan, pilihan user, dan skill terpasang.',
  type: 'object',
  required: ['version', 'createdAt', 'source', 'categories', 'selectedIds', 'installed'],
  properties: {
    version: { type: 'integer', const: 1 },
    createdAt: { type: 'string', format: 'date-time' },
    source: {
      type: 'object',
      required: ['kind', 'label'],
      properties: {
        kind: { type: 'string', enum: ['file', 'text', 'github'] },
        label: { type: 'string', minLength: 1 },
      },
    },
    categories: {
      type: 'array',
      maxItems: MAX_LEARN_CATEGORIES,
      items: {
        type: 'object',
        required: ['id', 'name', 'title', 'summary', 'content', 'chars'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]*$' },
          name: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]*$' },
          title: { type: 'string', minLength: 1 },
          summary: { type: 'string', minLength: 1 },
          content: { type: 'string', minLength: 1 },
          chars: { type: 'integer', minimum: 1 },
        },
      },
    },
    selectedIds: { type: 'array', items: { type: 'string' } },
    installed: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'filePath', 'overwrote'],
        properties: {
          name: { type: 'string' },
          filePath: { type: 'string' },
          overwrote: { type: 'boolean' },
        },
      },
    },
  },
} as const;

/**
 * Output schema yang diminta dari LLM saat mengkategorikan konten tak
 * terstruktur. Disisipkan apa adanya ke dalam prompt JSON kategorisasi.
 */
export const LEARN_CATEGORIZE_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['categories'],
  properties: {
    categories: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_LEARN_CATEGORIES,
      items: {
        type: 'object',
        required: ['name', 'title', 'summary', 'content'],
        properties: {
          name: {
            type: 'string',
            description: 'Slug kecil, huruf/kecil, angka, strip, underscore. Contoh: "git-branching".',
          },
          title: { type: 'string', description: 'Judul kategori yang enak dibaca manusia.' },
          summary: { type: 'string', description: 'Ringkasan satu kalimat: apa yang dilakukan kategori ini.' },
          content: {
            type: 'string',
            description: 'Isi kategori — potongan ASLI dari dokumen sumber, jangan diringkas atau ditulis ulang.',
          },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Pemecahan struktural (deterministik, tanpa LLM)
// ---------------------------------------------------------------------------

function firstSummaryLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').replace(/[*_`>|]/g, '').trim())
    .filter(Boolean);
  const first = lines[0] ?? '';
  return first.length > 140 ? first.slice(0, 137) + '…' : first;
}

function slugify(title: string, fallback: string): string {
  const slug = sanitizeSkillName(title);
  return slug || fallback;
}

function makeCategory(title: string, content: string, usedIds: Set<string>, fallback: string): LearnCategory {
  const base = slugify(title, fallback);
  let id = base;
  let n = 2;
  while (usedIds.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  usedIds.add(id);
  const body = content.trim();
  return {
    id,
    name: id,
    title: title.trim() || id,
    summary: firstSummaryLine(body) || title.trim() || id,
    content: body,
    chars: body.length,
  };
}

/** Pecah satu bagian besar berdasarkan sub-heading `###`, lalu paragraf. */
function splitOversize(title: string, body: string, usedIds: Set<string>, out: LearnCategory[]): void {
  const subSections = splitByHeadings(body, 3);
  if (subSections.length > 1) {
    for (const sub of subSections) {
      if (sub.body.trim().length > MAX_LEARN_SKILL_CHARS) {
        splitByParagraphs(`${title} — ${sub.title}`, sub.body, usedIds, out);
      } else if (sub.body.trim()) {
        out.push(makeCategory(`${title} — ${sub.title}`, sub.body, usedIds, 'bagian'));
      }
    }
    return;
  }
  splitByParagraphs(title, body, usedIds, out);
}

/** Pecah berdasarkan paragraf (blok dipisah baris kosong) sampai muat. */
function splitByParagraphs(title: string, body: string, usedIds: Set<string>, out: LearnCategory[]): void {
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let chunk = '';
  let part = 1;
  const flush = () => {
    if (!chunk.trim()) return;
    const label = part === 1 && paras.length <= 1 ? title : `${title} (bagian ${part})`;
    out.push(makeCategory(label, chunk, usedIds, 'bagian'));
    part += 1;
    chunk = '';
  };
  for (const p of paras) {
    if (chunk && chunk.length + p.length + 2 > MAX_LEARN_SKILL_CHARS) flush();
    chunk = chunk ? `${chunk}\n\n${p}` : p;
  }
  flush();
  if (out.length === 0 && body.trim()) {
    out.push(makeCategory(title, body, usedIds, 'bagian'));
  }
}

interface HeadingSection {
  title: string;
  body: string;
}

/** Pecah teks berdasarkan heading markdown level `level` (`#` diulang `level` kali). */
function splitByHeadings(text: string, level: number): HeadingSection[] {
  const re = new RegExp(`^#{${level}}\\s+(.+)$`, 'm');
  const lines = text.split('\n');
  const sections: HeadingSection[] = [];
  let current: HeadingSection | null = null;
  const push = () => {
    if (current) sections.push(current);
  };
  for (const line of lines) {
    const m = line.match(re);
    if (m) {
      push();
      current = { title: m[1].trim(), body: '' };
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  push();
  return sections;
}

/**
 * Pecah konten jadi kategori secara struktural (tanpa LLM).
 *
 * - Dokumen ber-heading: tiap `##` jadi satu kategori (judul dokumen `#`
 *   dipakai sebagai konteks, bukan kategori sendiri).
 * - Bagian yang masih lebih besar dari `MAX_LEARN_SKILL_CHARS` dipecah lagi
 *   lewat `###`, lalu lewat paragraf.
 * - Dokumen tanpa heading: dipecah per paragraf sampai muat.
 * - Tidak pernah mengembalikan 0 kategori untuk konten tak-kosong.
 */
export function splitLearnContent(content: string): LearnCategory[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const usedIds = new Set<string>();
  const out: LearnCategory[] = [];

  const h2Sections = splitByHeadings(normalized, 2);
  if (h2Sections.length > 0) {
    for (const section of h2Sections) {
      if (!section.body.trim()) continue;
      if (section.body.trim().length > MAX_LEARN_SKILL_CHARS) {
        splitOversize(section.title, section.body, usedIds, out);
      } else {
        out.push(makeCategory(section.title, section.body, usedIds, 'bagian'));
      }
    }
    if (out.length > 0) return out.slice(0, MAX_LEARN_CATEGORIES);
  }

  // Tanpa heading H2 yang berguna — pecah per paragraf.
  splitByParagraphs('Materi', normalized, usedIds, out);
  return out.slice(0, MAX_LEARN_CATEGORIES);
}

// ---------------------------------------------------------------------------
// Prompt JSON: kategorisasi oleh LLM (konten tak terstruktur)
// ---------------------------------------------------------------------------

/**
 * Bangun prompt kategorisasi sebagai DOKUMEN JSON (bukan teks bebas).
 * LLM diminta mengembalikan JSON yang mengikuti
 * `LEARN_CATEGORIZE_OUTPUT_SCHEMA`. Konten sumber disisipkan apa adanya
 * sebagai `input.content` — LLM hanya memotong, bukan menulis ulang.
 */
export function buildLearnCategorizePrompt(content: string): string {
  const maxInputChars = 120_000;
  const input =
    content.length > maxInputChars
      ? content.slice(0, maxInputChars) + '\n\n[...dipotong: sumber melebihi batas prompt kategorisasi...]'
      : content;
  const prompt = {
    task: 'learn-categorize',
    version: 1,
    goal: 'Pecah dokumen sumber menjadi kategori-kategori kecil, masing-masing akan disimpan sebagai satu skill Ruko yang terpisah.',
    instructions: [
      'Baca input.content secara menyeluruh, lalu kelompokkan isinya berdasarkan topik/fungsi, bukan berdasarkan urutan kemunculan.',
      'Setiap kategori HARUS berisi potongan ASLI dari dokumen sumber (copy-paste, jangan diringkas, jangan ditulis ulang, jangan ditambah-tambahi).',
      'Satu kategori = satu topik yang utuh dan bisa dipakai sendiri. Jangan buat kategori yang isinya cuma satu kalimat.',
      'Jangan buat lebih dari 12 kategori. Bila topik terlalu banyak, gabungkan yang paling berdekatan.',
      'Nama kategori (name) harus slug kecil: huruf kecil, angka, strip, underscore — tanpa spasi.',
    ],
    input: { content: input },
    output_schema: LEARN_CATEGORIZE_OUTPUT_SCHEMA,
    output_format:
      'Kembalikan HANYA satu objek JSON yang mengikuti output_schema. Tanpa teks pembuka/penutup, tanpa markdown fence di luar JSON.',
  };
  return JSON.stringify(prompt, null, 2);
}

/** Ambil objek JSON dari jawaban LLM (tahan terhadap ```json fence & teks di sekitarnya). */
export function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Jawaban LLM tidak mengandung objek JSON.');
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new Error('Jawaban LLM bukan JSON yang valid.');
  }
}

/**
 * Validasi & normalisasi jawaban LLM kategorisasi menjadi `LearnCategory[]`.
 * Menolak: bukan objek, tanpa `categories`, kategori tanpa name/title/content,
 * atau nama yang tidak bisa dijadikan slug skill.
 */
export function parseLearnCategorizeResponse(text: string): LearnCategory[] {
  const parsed = extractJsonObject(text) as { categories?: unknown };
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.categories)) {
    throw new Error('Jawaban LLM harus berupa objek JSON dengan field "categories" (array).');
  }
  if (parsed.categories.length === 0) {
    throw new Error('Jawaban LLM tidak berisi kategori apa pun.');
  }
  const usedIds = new Set<string>();
  const out: LearnCategory[] = [];
  for (const [i, raw] of parsed.categories.entries()) {
    const cat = raw as { name?: unknown; title?: unknown; summary?: unknown; content?: unknown };
    if (!cat || typeof cat !== 'object') {
      throw new Error(`Kategori ke-${i + 1} bukan objek.`);
    }
    const name = typeof cat.name === 'string' ? sanitizeSkillName(cat.name) : '';
    const title = typeof cat.title === 'string' ? cat.title.trim() : '';
    const summary = typeof cat.summary === 'string' ? cat.summary.trim() : '';
    const content = typeof cat.content === 'string' ? cat.content.trim() : '';
    if (!name) throw new Error(`Kategori ke-${i + 1} tidak punya "name" yang valid (slug).`);
    if (!title) throw new Error(`Kategori "${name}" tidak punya "title".`);
    if (!content) throw new Error(`Kategori "${name}" tidak punya "content".`);
    // Id diambil dari slug "name" LLM (bukan dari judul) — dedupe bila bentrok.
    let id = name;
    let n = 2;
    while (usedIds.has(id)) {
      id = `${name}-${n}`;
      n += 1;
    }
    usedIds.add(id);
    out.push({
      id,
      name: id,
      title,
      summary: summary || firstSummaryLine(content) || title,
      content,
      chars: content.length,
    });
  }
  return out.slice(0, MAX_LEARN_CATEGORIES);
}

/**
 * Kategorikan konten tak terstruktur lewat LLM. Dipakai command `/learn` hanya
 * bila pemecahan struktural menghasilkan 0–1 kategori. Gagal (LLM error /
 * jawaban tak valid) → lempar Error, pemanggil yang memutuskan fallback.
 */
export async function categorizeWithLlm(llm: LearnLlm, content: string): Promise<LearnCategory[]> {
  const promptJson = buildLearnCategorizePrompt(content);
  const answer = await llm.chat(
    [
      {
        role: 'user',
        content: promptJson,
        timestamp: new Date().toISOString(),
      },
    ],
    { maxTokens: 4096 },
  );
  return parseLearnCategorizeResponse(answer);
}

// ---------------------------------------------------------------------------
// Sumber GitHub (URL) — file tunggal via fetch raw, repo via shallow clone
// ---------------------------------------------------------------------------
//
// Keamanan (ditulis juga di deskripsi PR #47):
//   - Hanya host github.com (dan www.github.com) serta raw.githubusercontent.com
//     yang diterima; host lain ditolak sebelum ada request apa pun.
//   - Fetch memakai `checkSsrfSafety` + `pinnedHttpFetch` yang sama dengan
//     web_fetch (IP pinning per hop, redirect maks 5, SSRF guard diulang
//     tiap hop) — tidak ada fetch polos tanpa validasi.
//   - Clone memakai `git` CLI dengan argumen terpisah (execFileSync, tanpa
//     shell) ke direktori sementara; isi clone HANYA dibaca sebagai teks,
//     TIDAK PERNAH dieksekusi; direktori sementara selalu dibersihkan
//     (finally), berhasil maupun gagal.
//   - Batas ukuran tetap berlaku: satu sumber maks MAX_LEARN_SOURCE_CHARS,
//     satu repo maks MAX_LEARN_REPO_FILES file dan MAX_LEARN_REPO_TOTAL_CHARS
//     karakter — repo raksasa dipotong, bukan diunduh utuh tanpa batas.

/** Host yang diizinkan untuk sumber GitHub. Host lain ditolak. */
export const LEARN_GITHUB_HOSTS = ['github.com', 'www.github.com', 'raw.githubusercontent.com'] as const;
/** Batas jumlah file dokumen yang dipelajari dari satu repo/direktori. */
export const MAX_LEARN_REPO_FILES = 20;
/** Batas total karakter yang dipelajari dari satu repo/direktori. */
export const MAX_LEARN_REPO_TOTAL_CHARS = 200_000;
/** Timeout fetch file raw dari GitHub. */
export const LEARN_GITHUB_FETCH_TIMEOUT_MS = 30_000;
/** Timeout shallow clone repo. */
export const LEARN_GITHUB_CLONE_TIMEOUT_MS = 120_000;
/** Ekstensi file yang dianggap dokumen dan dibaca dari hasil clone. */
const LEARN_REPO_DOC_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt']);

/** Target learn dari sebuah URL GitHub. */
export type GithubLearnTarget =
  | { kind: 'file'; owner: string; repo: string; branch: string; path: string; rawUrl: string }
  | { kind: 'repo'; owner: string; repo: string; branch: string | null; path: string };

const GITHUB_NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeGithubSegment(seg: string): boolean {
  return seg.length > 0 && seg !== '.' && seg !== '..' && GITHUB_NAME_SEGMENT.test(seg);
}

function encodeGithubPath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * Parse URL GitHub menjadi target learn, atau `null` bila bukan URL GitHub
 * yang didukung. Bentuk yang dikenali:
 *   - File:  github.com/<owner>/<repo>/blob/<branch>/<path>
 *            github.com/<owner>/<repo>/raw/<branch>/<path>
 *            raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>
 *   - Repo:  github.com/<owner>/<repo>[/.git]
 *            github.com/<owner>/<repo>/tree/<branch>[/<path>]
 * Bentuk lain (issues, pulls, actions, gist, …) ditolak. Catatan: branch
 * yang mengandung `/` tidak bisa dibedakan dari path — segmen pertama
 * setelah blob/raw/tree selalu dianggap nama branch.
 */
export function parseGithubUrl(raw: string): GithubLearnTarget | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (!(LEARN_GITHUB_HOSTS as readonly string[]).includes(host)) return null;

  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

  if (host === 'raw.githubusercontent.com') {
    if (segments.length < 4) return null;
    const [owner, repoRaw, branch, ...rest] = segments;
    const repo = repoRaw.replace(/\.git$/, '');
    if (!isSafeGithubSegment(owner) || !isSafeGithubSegment(repo) || !isSafeGithubSegment(branch)) return null;
    if (rest.length === 0 || rest.some((s) => !isSafeGithubSegment(s))) return null;
    const path = rest.join('/');
    return {
      kind: 'file',
      owner,
      repo,
      branch,
      path,
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${encodeGithubPath(path)}`,
    };
  }

  // github.com / www.github.com
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, '');
  if (!isSafeGithubSegment(owner) || !isSafeGithubSegment(repo)) return null;
  const rest = segments.slice(2);
  if (rest.length === 0) {
    return { kind: 'repo', owner, repo, branch: null, path: '' };
  }
  if (rest[0] === 'blob' || rest[0] === 'raw') {
    if (rest.length < 3) return null;
    const branch = rest[1];
    const pathSegs = rest.slice(2);
    if (!isSafeGithubSegment(branch) || pathSegs.some((s) => !isSafeGithubSegment(s))) return null;
    const path = pathSegs.join('/');
    return {
      kind: 'file',
      owner,
      repo,
      branch,
      path,
      rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${encodeGithubPath(path)}`,
    };
  }
  if (rest[0] === 'tree') {
    if (rest.length < 2) return null;
    const branch = rest[1];
    const pathSegs = rest.slice(2);
    if (!isSafeGithubSegment(branch) || pathSegs.some((s) => !isSafeGithubSegment(s))) return null;
    return { kind: 'repo', owner, repo, branch, path: pathSegs.join('/') };
  }
  return null;
}

/** Label sumber yang disimpan di sesi learn untuk target GitHub. */
export function githubLearnLabel(target: GithubLearnTarget): string {
  if (target.kind === 'file') {
    return `github:${target.owner}/${target.repo}@${target.branch}/${target.path}`;
  }
  const at = target.branch ? `@${target.branch}` : '';
  const sub = target.path ? `/${target.path}` : '';
  return `github:${target.owner}/${target.repo}${at}${sub}`;
}

/** Dependensi network/git untuk sumber GitHub — di-inject supaya test tidak menyentuh network. */
export interface GithubLearnDeps {
  /** Ambil isi teks dari satu URL raw. Default: fetch dengan SSRF guard + IP pinning (lihat bawah). */
  fetchText?: (url: string) => Promise<string>;
  /** Clone satu repo ke direktori tujuan (sudah dibuatkan). Default: `git clone --depth 1` via execFileSync. */
  cloneRepo?: (cloneUrl: string, branch: string | null, destDir: string) => void | Promise<void>;
}

/**
 * Fetch isi file raw dari GitHub dengan perlindungan yang sama seperti
 * web_fetch: SSRF guard + IP pinning diulang tiap hop redirect (maks 5),
 * timeout 30 detik, tolak content-type non-teks, dan batas byte
 * (MAX_LEARN_SOURCE_CHARS * 4 — pemanggil tetap memotong ke batas karakter).
 */
export async function fetchGithubRawText(rawUrl: string): Promise<string> {
  const maxBytes = MAX_LEARN_SOURCE_CHARS * 4;
  let current = new URL(rawUrl);
  const visited = new Set<string>([current.href]);
  for (let hop = 0; hop <= 5; hop += 1) {
    const ssrf = await checkSsrfSafety(current, {});
    if (!ssrf.safe || !ssrf.pinnedIp) {
      throw new Error(`Fetch GitHub ditolak: ${ssrf.reason ?? 'tidak ada IP aman untuk di-pin'}`);
    }
    const res = await pinnedHttpFetch(current, {
      pinnedIp: ssrf.pinnedIp,
      ipFamily: ssrf.ipFamily ?? 4,
      timeoutMs: LEARN_GITHUB_FETCH_TIMEOUT_MS,
      maxBytes,
      headers: {
        'User-Agent': 'Ruko-Agent/1.7 (learn)',
        Accept: 'text/plain, text/markdown, application/json;q=0.9, */*;q=0.1',
      },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const locRaw = res.headers.location;
      const locationHeader = Array.isArray(locRaw) ? locRaw[0] : locRaw;
      if (!locationHeader) throw new Error(`Fetch GitHub gagal: HTTP ${res.status} redirect tanpa header Location.`);
      const next = new URL(locationHeader, current.href);
      if (visited.has(next.href)) throw new Error(`Fetch GitHub ditolak: siklus redirect ke "${next.href}".`);
      visited.add(next.href);
      current = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Fetch GitHub gagal: HTTP ${res.status} ${res.statusText ?? ''}`.trim());
    }
    const ctRaw = res.headers['content-type'];
    const contentType = (Array.isArray(ctRaw) ? ctRaw[0] : ctRaw) ?? '';
    if (contentType) {
      const ct = contentType.toLowerCase();
      const isText = ct.startsWith('text/') || ct.includes('application/json') || ct.includes('charset=');
      if (!isText) {
        throw new Error(`Fetch GitHub ditolak: content-type "${contentType}" bukan teks.`);
      }
    }
    return res.text;
  }
  throw new Error('Fetch GitHub ditolak: batas maksimal 5 redirect terlampaui.');
}

/** Default clone: shallow, tanpa shell, timeout 120 detik. */
export function cloneGithubRepoDefault(cloneUrl: string, branch: string | null, destDir: string): void {
  const args = ['clone', '--depth', '1'];
  if (branch) args.push('--branch', branch);
  args.push(cloneUrl, destDir);
  execFileSync('git', args, { stdio: 'pipe', timeout: LEARN_GITHUB_CLONE_TIMEOUT_MS });
}

function isBinaryText(sample: string): boolean {
  return sample.includes('\0');
}

function collectRepoFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectRepoFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

export interface RepoLearnContent {
  content: string;
  files: string[];
  truncated: boolean;
}

/**
 * Baca dokumen dari hasil clone (atau satu file di dalamnya) sebagai konten
 * learn. Satu file → dibaca langsung. Direktori → semua file `.md`/`.txt`
 * di bawahnya (README dulu, lalu alfabetis), masing-masing diawali heading
 * `## <path-relatif>` supaya `splitLearnContent` memecahnya per file.
 * File biner dilewati; batas file & total karakter dipatuhi (kelebihan
 * dipotong dengan `truncated: true`). TIDAK mengeksekusi apa pun.
 */
export function collectRepoLearnContent(cloneDir: string, subPath: string): RepoLearnContent {
  const root = resolve(cloneDir);
  const target = subPath ? resolve(root, subPath) : root;
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(prefix)) {
    throw new Error(`Path repo di luar batas clone: "${subPath}".`);
  }
  if (!existsSync(target)) {
    throw new Error(`Path tidak ditemukan di repo: "${subPath || '(root)'}".`);
  }
  const stat = statSync(target);
  let files: string[] = [];
  if (stat.isFile()) {
    files = [target];
  } else if (stat.isDirectory()) {
    const all: string[] = [];
    collectRepoFiles(target, all);
    files = all
      .filter((f) => {
        const lower = f.toLowerCase();
        return [...LEARN_REPO_DOC_EXTENSIONS].some((ext) => lower.endsWith(ext));
      })
      .sort((a, b) => {
        const ra = relative(target, a);
        const rb = relative(target, b);
        const aReadme = /(^|\/)readme\./i.test(ra) ? 0 : 1;
        const bReadme = /(^|\/)readme\./i.test(rb) ? 0 : 1;
        if (aReadme !== bReadme) return aReadme - bReadme;
        return ra.localeCompare(rb);
      });
  } else {
    throw new Error(`Path bukan file/direktori: "${subPath}".`);
  }
  if (files.length === 0) {
    throw new Error('Tidak ada dokumen (.md/.txt) yang bisa dipelajari di path ini.');
  }

  const sections: string[] = [];
  const used: string[] = [];
  let totalChars = 0;
  let truncated = false;
  for (const file of files) {
    if (used.length >= MAX_LEARN_REPO_FILES) {
      truncated = true;
      break;
    }
    let body: string;
    try {
      body = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!body.trim() || isBinaryText(body.slice(0, 8192))) continue;
    const rel = stat.isFile() ? basename(file) : relative(target, file) || basename(file);
    const section = `## ${rel}\n\n${body.trim()}`;
    if (totalChars + section.length > MAX_LEARN_REPO_TOTAL_CHARS && used.length > 0) {
      truncated = true;
      break;
    }
    sections.push(section);
    used.push(rel);
    totalChars += section.length;
  }
  if (sections.length === 0) {
    throw new Error('Tidak ada dokumen teks yang bisa dipelajari di path ini.');
  }
  return { content: sections.join('\n\n'), files: used, truncated };
}

/**
 * Ambil konten learn dari sebuah URL GitHub. File tunggal → fetch raw.
 * Repo/direktori → shallow clone ke direktori sementara (selalu dibersihkan),
 * lalu baca dokumennya. Mengembalikan konten + label sumber untuk sesi learn.
 * Melempar Error yang jelas bila URL bukan GitHub, fetch/clone gagal, atau
 * konten melebihi batas ukuran.
 */
export async function learnGithubSource(
  rawUrl: string,
  deps: GithubLearnDeps = {},
): Promise<{ content: string; label: string; files?: string[]; truncated?: boolean }> {
  const target = parseGithubUrl(rawUrl);
  if (!target) {
    throw new Error(
      'URL GitHub tidak dikenali. Bentuk yang didukung: github.com/<owner>/<repo>[/tree/<branch>/<path>] atau .../blob/<branch>/<path>, dan raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>.',
    );
  }
  const label = githubLearnLabel(target);
  if (target.kind === 'file') {
    const fetchText = deps.fetchText ?? fetchGithubRawText;
    const content = await fetchText(target.rawUrl);
    if (!content.trim()) throw new Error(`File GitHub kosong: ${label}.`);
    if (content.length > MAX_LEARN_SOURCE_CHARS) {
      throw new Error(
        `File GitHub terlalu besar (${content.length.toLocaleString()} karakter, maks ${MAX_LEARN_SOURCE_CHARS.toLocaleString()}). Pelajari per bagian saja.`,
      );
    }
    return { content, label };
  }

  const fetchClone = deps.cloneRepo ?? cloneGithubRepoDefault;
  const tmpDir = mkdtempSync(join(tmpdir(), 'ruko-learn-github-'));
  try {
    const cloneUrl = `https://github.com/${target.owner}/${target.repo}.git`;
    await fetchClone(cloneUrl, target.branch, tmpDir);
    const collected = collectRepoLearnContent(tmpDir, target.path);
    if (collected.content.length > MAX_LEARN_SOURCE_CHARS) {
      throw new Error(
        `Konten repo terlalu besar (${collected.content.length.toLocaleString()} karakter, maks ${MAX_LEARN_SOURCE_CHARS.toLocaleString()}). Pelajari subdirektori yang lebih kecil.`,
      );
    }
    return { content: collected.content, label, files: collected.files, truncated: collected.truncated };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Prompt JSON: menanyakan pilihan ke user
// ---------------------------------------------------------------------------

/**
 * Bangun prompt tanya-pilih sebagai DOKUMEN JSON: pertanyaan, daftar opsi
 * (`semua` + tiap kategori dengan ringkasannya), dan format jawaban yang
 * diterima. Command mencetak versi manusiawinya (`renderLearnAskText`) dan
 * mem-parse jawaban user dengan `parseLearnSelection` mengikuti skema ini.
 */
export function buildLearnAskPrompt(session: LearnSession): string {
  const prompt = {
    task: 'learn-ask',
    version: 1,
    question: 'Kategori mana yang ingin dipasang sebagai skill?',
    source: session.source.label,
    options: [
      {
        id: 'all',
        label: 'Semua',
        description: `Pasang semua ${session.categories.length} kategori sebagai skill terpisah.`,
      },
      ...session.categories.map((c, i) => ({
        id: c.id,
        label: `${i + 1}. ${c.title}`,
        summary: c.summary,
        chars: c.chars,
      })),
    ],
    answer_format: {
      accepted: [
        'semua / all — pasang semua kategori',
        'angka dipisah koma — contoh: "1,3" (kategori nomor 1 dan 3)',
        'nama kategori dipisah koma — contoh: "git-branching, code-review"',
        'campuran angka dan nama — contoh: "1, code-review"',
      ],
      rules: ['Jawaban kosong dibatalkan.', 'Nomor di luar daftar ditolak dengan pesan yang menyebut pilihan valid.'],
    },
  };
  return JSON.stringify(prompt, null, 2);
}

/** Render daftar kategori yang enak dibaca di terminal (versi manusiawi dari ask-prompt JSON). */
export function renderLearnAskText(session: LearnSession): string {
  const lines = [
    `Sumber: ${session.source.label} — ditemukan ${session.categories.length} kategori:`,
    '',
  ];
  session.categories.forEach((c, i) => {
    lines.push(`  ${i + 1}. ${c.title} (${c.name}) — ${c.summary} [${c.chars} karakter]`);
  });
  lines.push('', 'Pilih: semua / nomor (contoh: 1,3) / nama (contoh: git-branching, code-review)');
  return lines.join('\n');
}

/**
 * Parse jawaban user mengikuti `buildLearnAskPrompt.answer_format`.
 * Mengembalikan kategori terpilih (tanpa duplikat, urutan sesuai daftar).
 * Melempar Error yang menyebut pilihan valid bila jawaban kosong/tak dikenal.
 */
export function parseLearnSelection(answer: string, session: LearnSession): LearnCategory[] {
  const raw = answer.trim();
  if (!raw) {
    throw new Error('Pilihan kosong — dibatalkan. Jawab "semua" atau sebutkan nomor/nama kategori.');
  }
  const lowered = raw.toLowerCase();
  if (lowered === 'semua' || lowered === 'all' || lowered === '*' || lowered === 'semuanya') {
    return [...session.categories];
  }
  const tokens = raw
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const chosen = new Map<string, LearnCategory>();
  const validHint = session.categories.map((c, i) => `${i + 1}=${c.id}`).join(', ');
  for (const token of tokens) {
    const asNumber = Number(token);
    if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= session.categories.length) {
      const cat = session.categories[asNumber - 1];
      chosen.set(cat.id, cat);
      continue;
    }
    const byId = session.categories.find(
      (c) => c.id === sanitizeSkillName(token) || c.name.toLowerCase() === token.toLowerCase(),
    );
    if (byId) {
      chosen.set(byId.id, byId);
      continue;
    }
    throw new Error(`Pilihan tidak dikenal: "${token}". Pilihan valid: semua, atau ${validHint}.`);
  }
  if (chosen.size === 0) {
    throw new Error(`Tidak ada kategori terpilih. Pilihan valid: semua, atau ${validHint}.`);
  }
  return session.categories.filter((c) => chosen.has(c.id));
}

// ---------------------------------------------------------------------------
// Sesi & pemasangan
// ---------------------------------------------------------------------------

/** Buat sesi learn baru dari sumber + kategori hasil pemecahan. */
export function createLearnSession(source: LearnSource, categories: LearnCategory[]): LearnSession {
  return {
    version: LEARN_SESSION_VERSION,
    createdAt: new Date().toISOString(),
    source,
    categories,
    selectedIds: [],
    installed: [],
  };
}

/** Nama file sesi: `<slug-sumber>-<timestamp>.json` di `.ruko/learn/`. */
export function learnSessionFileName(session: LearnSession): string {
  const slug = sanitizeSkillName(session.source.label.replace(/\.[^.]+$/, '')) || 'learn';
  const stamp = session.createdAt.replace(/[:.]/g, '-');
  return `${slug}-${stamp}.json`;
}

/** Simpan sesi learn sebagai JSON di `.ruko/learn/` (mode 0600, seperti skill). */
export function saveLearnSession(session: LearnSession, workspaceRoot: string): string {
  const dir = join(workspaceRoot, '.ruko', 'learn');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, learnSessionFileName(session));
  writeFileSync(filePath, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 });
  return filePath;
}

/**
 * Pasang kategori terpilih sebagai skill kecil via `saveSkill`.
 * Nama skill yang sudah ada akan ditimpa — dikembalikan sebagai `overwrote`.
 */
export function installLearnSkills(
  session: LearnSession,
  selected: LearnCategory[],
  workspaceRoot: string,
): LearnInstallResult {
  const installed: LearnInstallResult['installed'] = [];
  for (const cat of selected) {
    const existing = readSkill(cat.name, workspaceRoot);
    const saved = saveSkill(cat.name, cat.summary, cat.content, workspaceRoot);
    installed.push({ name: saved.name, filePath: saved.filePath ?? '', overwrote: Boolean(existing) });
  }
  session.selectedIds = selected.map((c) => c.id);
  session.installed = installed;
  return { installed };
}

/** Direktori sesi learn di workspace (untuk dokumentasi/pesan command). */
export function learnSessionsDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.ruko', 'learn');
}
