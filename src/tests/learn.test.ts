import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildLearnAskPrompt,
  buildLearnCategorizePrompt,
  categorizeWithLlm,
  createLearnSession,
  installLearnSkills,
  LEARN_SESSION_JSON_SCHEMA,
  MAX_LEARN_SKILL_CHARS,
  parseLearnCategorizeResponse,
  parseLearnSelection,
  renderLearnAskText,
  saveLearnSession,
  splitLearnContent,
} from '../core/learn.js';
import { readSkill } from '../core/skills.js';

const BIG_DOC = `# Panduan Besar

## Git Branching
Branch adalah penanda bergerak. Buat branch baru untuk tiap fitur.
Gunakan nama yang jelas: feat/login, fix/crash-startup.

## Code Review
Periksa diff sebelum approve. Cari bug keamanan dulu, lalu gaya.
Jangan approve kalau test merah.

## Testing
Tulis test untuk perilaku baru. Jalankan npm test sebelum push.
`;

function sessionFromDoc(doc: string = BIG_DOC) {
  return createLearnSession({ kind: 'file', label: 'docs/panduan.md' }, splitLearnContent(doc));
}

// ---------------------------------------------------------------------------
// Pemecahan struktural
// ---------------------------------------------------------------------------

test('splitLearnContent: tiap heading H2 jadi satu kategori', () => {
  const cats = splitLearnContent(BIG_DOC);
  assert.equal(cats.length, 3);
  assert.deepEqual(
    cats.map((c) => c.name),
    ['git-branching', 'code-review', 'testing'],
  );
  assert.ok(cats[0].content.includes('Branch adalah penanda bergerak'));
  assert.ok(cats[0].summary.length > 0);
  assert.ok(cats.every((c) => c.chars === c.content.length));
});

test('splitLearnContent: konten kosong → tidak ada kategori', () => {
  assert.deepEqual(splitLearnContent(''), []);
  assert.deepEqual(splitLearnContent('   \n\n  '), []);
});

test('splitLearnContent: dokumen tanpa heading dipecah per paragraf sampai muat', () => {
  const para = 'Kalimat penting tentang topik A. '.repeat(40);
  const doc = [para, para, para, para, para, para].join('\n\n');
  const cats = splitLearnContent(doc);
  assert.ok(cats.length >= 2);
  assert.ok(cats.every((c) => c.chars <= MAX_LEARN_SKILL_CHARS));
  assert.ok(cats.every((c) => c.content.length > 0));
});

test('splitLearnContent: bagian raksasa dipecah lewat H3 lalu paragraf', () => {
  const bigSection = ['## Topik Besar', ...Array.from({ length: 30 }, (_, i) => `### Sub ${i + 1}\nIsi sub bagian ${i + 1}. `.repeat(20))].join('\n\n');
  const cats = splitLearnContent(bigSection);
  assert.ok(cats.length > 1);
  assert.ok(cats.every((c) => c.chars <= MAX_LEARN_SKILL_CHARS));
});

test('splitLearnContent: nama kategori bentrok diberi suffix -2', () => {
  const doc = '## Sama\nIsi satu.\n\n## Sama\nIsi dua.\n';
  const cats = splitLearnContent(doc);
  assert.deepEqual(
    cats.map((c) => c.id),
    ['sama', 'sama-2'],
  );
});

// ---------------------------------------------------------------------------
// Prompt JSON kategorisasi
// ---------------------------------------------------------------------------

test('buildLearnCategorizePrompt: JSON valid dengan output_schema dan isi sumber', () => {
  const prompt = JSON.parse(buildLearnCategorizePrompt(BIG_DOC)) as {
    task: string;
    input: { content: string };
    output_schema: unknown;
  };
  assert.equal(prompt.task, 'learn-categorize');
  assert.ok(prompt.input.content.includes('Git Branching'));
  assert.ok(prompt.output_schema);
});

test('parseLearnCategorizeResponse: JSON polos dan ber-fence diterima', () => {
  const raw = JSON.stringify({
    categories: [
      { name: 'git-branching', title: 'Git Branching', summary: 'Cara memakai branch.', content: 'Branch adalah penanda bergerak.' },
      { name: 'testing', title: 'Testing', summary: 'Tulis test.', content: 'Jalankan npm test.' },
    ],
  });
  const plain = parseLearnCategorizeResponse(raw);
  assert.equal(plain.length, 2);
  assert.equal(plain[0].id, 'git-branching');
  assert.equal(plain[0].summary, 'Cara memakai branch.');

  const fenced = parseLearnCategorizeResponse(`Berikut hasilnya:\n\`\`\`json\n${raw}\n\`\`\``);
  assert.equal(fenced.length, 2);
});

test('parseLearnCategorizeResponse: menolak JSON tak valid dan field hilang', () => {
  assert.throws(() => parseLearnCategorizeResponse('bukan json'), /JSON/);
  assert.throws(() => parseLearnCategorizeResponse('{"categories": []}'), /tidak berisi kategori/);
  assert.throws(
    () => parseLearnCategorizeResponse('{"categories": [{"name": "x", "title": "X"}]}'),
    /tidak punya "content"/,
  );
  assert.throws(
    () => parseLearnCategorizeResponse('{"categories": [{"name": "", "title": "T", "content": "isi"}]}'),
    /tidak punya "name" yang valid/,
  );
});

test('categorizeWithLlm: memakai stub LLM, tanpa memanggil LLM beneran', async () => {
  const stub = {
    chat: async () => JSON.stringify({
      categories: [
        { name: 'a-topik', title: 'Topik A', summary: 'Tentang A.', content: 'Isi A asli.' },
        { name: 'b-topik', title: 'Topik B', summary: 'Tentang B.', content: 'Isi B asli.' },
      ],
    }),
  };
  const cats = await categorizeWithLlm(stub, 'dokumen tanpa struktur apa pun '.repeat(50));
  assert.deepEqual(
    cats.map((c) => c.id),
    ['a-topik', 'b-topik'],
  );
  assert.equal(cats[0].content, 'Isi A asli.');
});

// ---------------------------------------------------------------------------
// Prompt JSON tanya-pilih + parsing jawaban
// ---------------------------------------------------------------------------

test('buildLearnAskPrompt: JSON valid berisi opsi semua + tiap kategori', () => {
  const session = sessionFromDoc();
  const prompt = JSON.parse(buildLearnAskPrompt(session)) as {
    task: string;
    options: Array<{ id: string }>;
  };
  assert.equal(prompt.task, 'learn-ask');
  assert.equal(prompt.options[0].id, 'all');
  assert.deepEqual(
    prompt.options.slice(1).map((o) => o.id),
    ['git-branching', 'code-review', 'testing'],
  );
});

test('renderLearnAskText: daftar bernomor dengan nama dan ringkasan', () => {
  const text = renderLearnAskText(sessionFromDoc());
  assert.match(text, /1\. Git Branching/);
  assert.match(text, /3\. Testing/);
  assert.match(text, /semua/);
});

test('parseLearnSelection: "semua" memasang semua kategori', () => {
  const session = sessionFromDoc();
  assert.equal(parseLearnSelection('semua', session).length, 3);
  assert.equal(parseLearnSelection('ALL', session).length, 3);
  assert.equal(parseLearnSelection('*', session).length, 3);
});

test('parseLearnSelection: nomor, nama, dan campuran', () => {
  const session = sessionFromDoc();
  assert.deepEqual(
    parseLearnSelection('1,3', session).map((c) => c.id),
    ['git-branching', 'testing'],
  );
  assert.deepEqual(
    parseLearnSelection('code-review', session).map((c) => c.id),
    ['code-review'],
  );
  assert.deepEqual(
    parseLearnSelection('1, code-review', session).map((c) => c.id),
    ['git-branching', 'code-review'],
  );
  // Duplikat dihitung sekali
  assert.equal(parseLearnSelection('1, 1, git-branching', session).length, 1);
});

test('parseLearnSelection: menolak jawaban kosong dan pilihan tak dikenal', () => {
  const session = sessionFromDoc();
  assert.throws(() => parseLearnSelection('', session), /kosong/);
  assert.throws(() => parseLearnSelection('9', session), /tidak dikenal/);
  assert.throws(() => parseLearnSelection('tidak-ada', session), /tidak dikenal/);
  assert.throws(() => parseLearnSelection('1, tidak-ada', session), /tidak dikenal/);
});

// ---------------------------------------------------------------------------
// Sesi JSON + pemasangan skill
// ---------------------------------------------------------------------------

test('LEARN_SESSION_JSON_SCHEMA: skema sesi valid dan konsisten dengan tipe', () => {
  assert.equal(LEARN_SESSION_JSON_SCHEMA.title, 'LearnSession');
  assert.equal((LEARN_SESSION_JSON_SCHEMA.properties.version as { const: number }).const, 1);
  const required = LEARN_SESSION_JSON_SCHEMA.required as unknown as string[];
  for (const key of ['version', 'createdAt', 'source', 'categories', 'selectedIds', 'installed']) {
    assert.ok(required.includes(key), `skema harus mewajibkan ${key}`);
  }
});

test('saveLearnSession + installLearnSkills: sesi JSON tersimpan, skill kecil terpasang', () => {
  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-learn-test-'));
  try {
    const session = sessionFromDoc();
    const sessionPath = saveLearnSession(session, tmpWs);
    assert.ok(existsSync(sessionPath));
    const saved = JSON.parse(readFileSync(sessionPath, 'utf8')) as { version: number; categories: unknown[] };
    assert.equal(saved.version, 1);
    assert.equal(saved.categories.length, 3);

    const selected = parseLearnSelection('1,3', session);
    const { installed } = installLearnSkills(session, selected, tmpWs);
    assert.equal(installed.length, 2);
    assert.ok(installed.every((s) => !s.overwrote));
    assert.ok(existsSync(join(tmpWs, '.ruko', 'skills', 'git-branching.md')));
    assert.ok(existsSync(join(tmpWs, '.ruko', 'skills', 'testing.md')));
    assert.equal(readSkill('git-branching', tmpWs)?.description, 'Branch adalah penanda bergerak. Buat branch baru untuk tiap fitur.');
    assert.ok(!existsSync(join(tmpWs, '.ruko', 'skills', 'code-review.md')));

    // Pasang ulang nama yang sama → menimpa, dilaporkan sebagai overwrote.
    const again = installLearnSkills(session, parseLearnSelection('git-branching', session), tmpWs);
    assert.equal(again.installed[0].overwrote, true);
  } finally {
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Command /learn terdaftar + alur end-to-end --all
// ---------------------------------------------------------------------------

test('/learn terdaftar di registry dan muncul di /help', async () => {
  const { buildHelpText, listCommands } = await import('../agent/commands.js');
  const names = new Set(listCommands().map((c) => c.name));
  assert.ok(names.has('learn'), 'missing /learn');
  const help = buildHelpText();
  assert.ok(help.includes('/learn'));
  assert.ok(help.includes('Pelajari skill/doc besar'));
});

test('/learn <file> --all: file dibaca, dipecah, semua kategori terpasang', async () => {
  const { handleCommand } = await import('../agent/commands.js');
  const { Context } = await import('../core/context.js');
  const { DEFAULT_CONFIG } = await import('../types.js');
  const { setWorkspaceRoot } = await import('../agent/tools.js');
  const { listSkills } = await import('../core/skills.js');

  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-learn-cmd-'));
  try {
    setWorkspaceRoot(tmpWs);
    mkdirSync(join(tmpWs, 'docs'), { recursive: true });
    writeFileSync(join(tmpWs, 'docs', 'panduan.md'), BIG_DOC, 'utf8');

    const config = { ...DEFAULT_CONFIG };
    const ctx = new Context(config);
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logged.push(String(msg));
    const env: any = {
      ctx,
      config,
      llm: { model: 'test-model', isConfigured: false },
      confirm: async () => true,
      updateConfig: () => {},
      handle: { stop: () => {}, getSessionId: () => null, setSessionId: () => {} },
    };
    try {
      await handleCommand('/learn docs/panduan.md --all', env);
    } finally {
      console.log = origLog;
    }

    assert.deepEqual(
      listSkills(tmpWs).map((s) => s.name),
      ['code-review', 'git-branching', 'testing'],
    );
    assert.ok(logged.some((l) => l.includes('3 skill terpasang')));
    assert.ok(existsSync(join(tmpWs, '.ruko', 'learn')));
  } finally {
    setWorkspaceRoot(null);
    rmSync(tmpWs, { recursive: true, force: true });
  }
});

test('/learn: URL ditolak, file hilang dilaporkan, tanpa argumen menampilkan usage', async () => {
  const { handleCommand } = await import('../agent/commands.js');
  const { Context } = await import('../core/context.js');
  const { DEFAULT_CONFIG } = await import('../types.js');
  const { setWorkspaceRoot } = await import('../agent/tools.js');

  const tmpWs = mkdtempSync(join(tmpdir(), 'ruko-learn-cmd2-'));
  try {
    setWorkspaceRoot(tmpWs);
    const config = { ...DEFAULT_CONFIG };
    const ctx = new Context(config);
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logged.push(String(msg));
    const env: any = {
      ctx,
      config,
      llm: { model: 'test-model', isConfigured: false },
      confirm: async () => true,
      updateConfig: () => {},
      handle: { stop: () => {}, getSessionId: () => null, setSessionId: () => {} },
    };
    try {
      await handleCommand('/learn https://example.com/skill.md', env);
      await handleCommand('/learn tidak-ada.md', env);
      await handleCommand('/learn', env);
    } finally {
      console.log = origLog;
    }
    const all = logged.join('\n');
    assert.match(all, /URL belum didukung/);
    assert.match(all, /tidak ditemukan/);
    assert.match(all, /Penggunaan: \/learn/);
  } finally {
    setWorkspaceRoot(null);
    rmSync(tmpWs, { recursive: true, force: true });
  }
});
