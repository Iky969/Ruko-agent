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
 *   1. Sumber dibaca (file di workspace, atau teks langsung via `--text`).
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
 * Modul ini murni (pure) kecuali `categorizeWithLlm` dan `installLearnSkills`:
 * LLM di-inject lewat interface minimal `LearnLlm` supaya test unit tidak
 * pernah memanggil LLM beneran.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSkill, sanitizeSkillName, saveSkill } from './skills.js';

/** Satu sumber learn: file di workspace, atau teks yang dikirim langsung. */
export interface LearnSource {
  kind: 'file' | 'text';
  /** Label sumber untuk ditampilkan & disimpan (path relatif, atau 'teks langsung'). */
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
        kind: { type: 'string', enum: ['file', 'text'] },
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
