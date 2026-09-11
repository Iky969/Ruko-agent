# Ruko — AI Coding Agent CLI

Ruko adalah CLI agent untuk pekerjaan coding berbasis **Node.js / TypeScript** (zero runtime dependency). Ia menjalankan *system loop* interaktif yang menerima instruksi, memotong log terminal yang panjang agar tidak memenuhi konteks, dan mengeksekusi perintah shell dengan pengamanan persetujuan (approval gate).

Mulai cepat: lihat **Instalasi & Menjalankan** di bawah — detail cara kerja ada di bagian *Cara Kerja*.

**v0.6.0**: Menu slash **live** di terminal (editor raw-mode sendiri: filter per keystroke, ↑/↓, Tab, Esc) dengan overlay yang **terhapus bersih saat ditutup** — tidak ada lagi blok menu duplikat nyangkut di scrollback; daftar bantuan hanya-Enter tidak pernah ikut menetap. (v0.4.0: wizard `/login` dengan tes koneksi live + penerjemah error, multi-profil provider + auto-fetch model, role AI berlapis, plan mode & deteksi loop di kode, `patch_file`, `/undo`, `/compact`, baris usage. v0.3.0: setup wizard, streaming SSE, status bar, diff visual, distribusi global.)

---

## Instalasi & Menjalankan

**Syarat:** Node.js ≥ 18 — tanpa dependency runtime lain (TypeScript hanya untuk build).

### Dari repository ini

```bash
git clone https://github.com/Iky969/Ruko-agent.git && cd Ruko-agent
npm install          # devDependencies saja (TypeScript)
npm run build        # compile src/ → dist/
npm start            # = node dist/index.js — mulai REPL Ruko
```

Jalankan pertama kali tanpa API key → **wizard setup** otomatis muncul: isi `API Key` → `Base URL` → `Model` → dites koneksi live (`✓ Terhubung ke <model>`) → tersimpan ke `.ruko/config.json` (di folder proyek, izin 600). Provider mana pun yang kompatibel OpenAI cukup dengan Base URL + key: OpenAI, OpenRouter, DeepSeek, Qwen, Groq, Together, vLLM, LM Studio, atau Ollama lokal (`http://localhost:11434/v1`).

### Install global — perintah `ruko` dari folder mana pun

```bash
npm install -g .     # atau: npm link
cd /projek-ku && ruko
```

Semua data (config, sesi, snapshot undo) mengikuti **current working directory** → `./.ruko/`.

### Satu perintah tanpa REPL

```bash
node dist/index.js --exec "ls -la"          # eksekusi shell (lewat approval gate + summarizer)
node dist/index.js --exec "rm -rf x" --yes  # tanpa konfirmasi
node dist/index.js --summarize "<log panjang>"
node dist/index.js --help
```

### Setelah install, coba ini di REPL

```text
› halo                            → percakapan normal (LLM mode)
› /model                          → daftar model auto-fetch dari endpoint
› /help                           → semua slash command
› run ls -la                      → manual mode: eksekusi langsung
```

### Verifikasi build

```bash
npm test             # 93 unit test (node:test) harus hijau
npm run typecheck    # tsc --noEmit bersih
```

### Environment variables (opsional — config file lebih prioritas)

| Variabel | Fungsi |
| --- | --- |
| `OPENAI_API_KEY` | API key backend OpenAI-compatible |
| `OPENAI_BASE_URL` | Ganti base URL (mis. `http://localhost:11434/v1` untuk Ollama) |
| `AGENT_MODEL` / `OPENAI_MODEL` | Model default |
| `RUKO_CONFIG` | Path config lain (default `./.ruko/config.json`) |
| `RUKO_UNDO_DIR` | Lokasi jurnal undo (default `./.ruko/undo`) |
| `RUKO_YOLO_MODE=1` | Bypass approval — hati-hati |
| `NO_COLOR` | Matikan warna ANSI |


---

## Fitur

### Interactive Setup Wizard
Jalankan `ruko` pertama kali tanpa kredensial → wizard interaktif muncul berturut-turut: banner *Welcome* berlatar biru, lalu prompt `API Key:` (**ter-mask `*`**) → `Base URL:` → `Model Name:`. Ruko **tidak punya default provider**: Base URL dan model wajib Anda isi sendiri, tanpa contoh merek apa pun. Sebelum disimpan, CLI **menguji koneksi live** dan menampilkan `✓ Terhubung ke <model>` — atau pesan error yang membedakan jenis kegagalan (400 request invalid, 401 key salah, 403 tanpa izin, 404 model/endpoint, 429 rate limit dengan retry otomatis, 5xx server, atau error jaringan/timeout) lengkap dengan perintah perbaikan + opsi coba ulang/simpan paksa/batal. Semuanya tersimpan permanen ke `.ruko/config.json` dengan izin **600** — tanpa export manual. Kapan pun bisa diulang dari REPL dengan `/login` (atau `/config setup`).

### Multi-Profil Provider
`profiles` di `.ruko/config.json` menyimpan beberapa provider ber-alias (`hemat`, `kuat`, `lokal`), masing-masing `{ baseUrl, model, apiKeyEnv | apiKey }`. `/profile` menampilkan daftar + mana aktif; `/profile <alias>` langsung mengganti kredensial dan model. `/model` tanpa argumen **meng-auto-fetch daftar model** dari endpoint `/v1/models` — tidak perlu mengetik nama model dari ingatan.

```json
{
  "mode": "beginner",
  "defaultProfile": "hemat",
  "profiles": {
    "hemat": { "baseUrl": "https://api.example.com/v1", "model": "qwen3-flash", "apiKeyEnv": "QWEN_API_KEY" },
    "lokal": { "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5-coder" }
  },
  "role": "teacher"
}
```

### System Loop + Status Bar
REPL interaktif dengan status bar berlatar hijau gelap — `⚡ [model · role] | ctx 41% (12.3k/30k) | / perintah · Ctrl+C batal` (indikator `⏸ PLAN` muncul saat plan mode aktif) — dan prompt `› Ask anything...`. Mengetik `/` lalu Enter memunculkan daftar slash command + deskripsi + hint argumennya. Setelah tiap respons LLM ada **baris usage**: `↑ 3.2k ↓ 800 · ctx 41%`. Instruksi diproses serial: setiap baris tuntas (termasuk eksekusi shell atau round-trip LLM) sebelum baris berikutnya.

### Role AI (System Prompt Berlapis)
System prompt disusun berlapis dengan urutan tetap (ramah prompt-caching): (a) identitas inti + kontrak output → (b) aturan tool → (c) **role aktif** → (d) `AGENT.md`/`AGENTS.md` proyek (kalau ada) → (e) tambahan mode (plan/beginner). Role bawaan: `default`, `reviewer` (read-only), `teacher` (menjelaskan tiap langkah), `minimal` (hemat token) — ganti lewat `/role <nama>`. Role kustom: taruh file `.md` ber-frontmatter (`name`, `description`) di `~/.ruko/roles/` atau `.ruko/roles/` proyek. `/mode beginner|pro` menukar paket default (teacher + tips vs minimal + ringkas) dengan engine yang sama.

### Streaming Respons LLM
Permintaan ke backend memakai `stream: true` (SSE); token teks di-pipe ke terminal secara real-time. Blok tool internal (` ```tool `) tidak ditampilkan ke user (difilter sambil jalan), dan spinner `▸ Thinking...` muncul saat LLM berpikir.

### Visual Action Logs & File Diff
Setiap pemanggilan tool dicetak dengan indikator visual: `🟢 Bash(<cmd>)`, `🟢 Read(<file>)`, `🟢 Edit(<file>)`. Perubahan file lewat `edit_file`/`write_file`/`patch_file` langsung ditampilkan bergaya `git diff` — baris dihapus **merah** (`-`), baris ditambahkan **hijau** (`+`), region tak berubah dilipat.

### Log Summarizer
Output perintah yang panjang otomatis dipotong saat melebihi ambang (default **1000 karakter**):

- Kepala (head) ~40% + ekor (tail) ~60%, dibulatkan ke batas baris agar tidak ada baris terpotong di tengah.
- Marker `[... TRUNCATED ...]` berisi jumlah karakter/baris yang dibuang.
- Baris-baris penting (error, warning, exception, exit code, build result) dikumpulkan sebagai *Highlights*.

### Eksekusi Shell Bawaan
Menjalankan perintah apa pun lewat shell dengan timeout default 30 detik, capture stdout/stderr, exit code, dan durasi. Semua output lewat Log Summarizer secara default.

### Tool `read_file`
Agen bisa membaca berkas teks langsung (tanpa `cat`/`head`), dengan hasil bernomor baris dan berhalaman:

```tool
{"tool": "read_file", "path": "src/index.ts", "offset": 1, "limit": 200}
```

- Default 200 baris per panggilan, hard cap 2.000 baris — satu bacaan tidak bisa membanjiri konteks.
- Header hasil melaporkan total baris + rentang yang ditampilkan; ada `nextOffset` saat file terpotong sehingga agen tinggal melanjutkan dengan `offset`.
- Aman: menolak direktori, file non-reguler, dan konten biner (deteksi NUL/control-char); baris super panjang dipotong ke 2.000 char.

### Tool `edit_file` / `write_file` (Diff Visual)
Agen bisa membuat dan mengubah berkas teks langsung; setiap perubahan dicetak terbuka sebagai diff berwarna:

```tool
{"tool": "edit_file", "path": "src/util.ts", "content": "<isi lengkap terbaru>"}
```

- `write_file` hanya untuk berkas baru; menimpa berkas existing wajib lewat `edit_file` (agar ada diff).
- Diff LCS-style ala `git diff`: `-` merah untuk baris dihapus, `+` hijau untuk ditambahkan, region tak berubah dilipat jadi `… N baris tidak berubah …`.
- Konten identik = no-op (`🟡`), tidak ada file yang ditulis.

### Tool `patch_file` (Search-Replace Hemat Token)
Ubah sebagian berkas tanpa mengirim ulang seluruh isinya:

```tool
{"tool": "patch_file", "path": "src/util.ts", "oldText": "<snippet persis>", "newText": "<pengganti>"}
```

- `oldText` harus cocok **persis dan unik**; error informatif bila tidak ketemu / ambigu (`replaceAll: true` untuk multi-match).
- Sebelum setiap `patch_file`/`edit_file`/`write_file`, kondisi lama berkas di-snapshot ke `.ruko/undo/` → **`/undo`** mengembalikannya (file baru dihapus; 25 snapshot terakhir disimpan). Jalan tanpa git.

### Pengaman Berbasis Kode
Disiplin yang penting tidak digantungkan pada kepatuhan model — ditegakkan di CLI: **plan mode** (`/plan on`) memblokir tool `exec`/`write_file`/`edit_file`/`patch_file` di level kode; **deteksi loop** menghentikan eksekusi saat tool + argumen yang sama dipanggil >2×; **cap hasil tool** 8.000 char (head+tail, tengah dilipat) sebelum masuk konteks; approval gate tetap di depan semua `exec`.

### Distribusi Global
Paket punya `bin: { "ruko": "./dist/index.js" }` — setelah `npm link` atau `npm install -g .`, perintah `ruko` tersedia dari folder mana pun dan selalu beroperasi pada **current working directory** user (config & sesi di `./.ruko/`).

### Approval Gate
Perintah berisiko diklasifikasikan sebelum dijalankan:

| Level | Contoh | Tindakan |
| --- | --- | --- |
| `dangerous` | `rm -rf`, `sudo`, `git push`, `git reset --hard`, `curl \| sh`, `kill -9` | Minta konfirmasi `y/N` ke user |
| `blocked` | `rm -rf /`, `mkfs`, `dd of=/dev/...`, fork bomb | Selalu ditolak, tidak bisa di-bypass |

Bypass sah: `--yes` (untuk `--exec`), `RUKO_YOLO_MODE=1`, atau allowlist di config. Tanpa terminal interaktif (non-TTY), perintah `dangerous` otomatis ditolak demi keamanan.

### Context Compression
Saat konteks melebihi budget (default 30.000 karakter), turn-turn tertua **dikompres** menjadi satu pesan ringkas (`[compressed history ...]`) — bukan dibuang mentah. N turn terakhir selalu dilindungi utuh. Jika budget belum tercapai, ukuran ekscerpt diperkecil bertahap (200 → 100 → 50 → 25 → 12 karakter) sampai muat. Bisa dipaksa kapan pun lewat `/compact` (target 65% budget).

### Session Persistence
Setiap percakapan tersimpan otomatis ke `.ruko/sessions/<id>.json` (setelah tiap instruksi dan saat keluar). Sesi bisa dilanjutkan kapan pun: `/sessions` untuk daftar, `/resume <id>` untuk melanjutkan, `/new` untuk memulai baru.

### Konfigurasi Berkas
Pengaturan tersimpan di `.ruko/config.json` (atau path dari env `RUKO_CONFIG`) dengan izin **600**: kredensial API (`apiKey`, `baseUrl`, `model` — diisi oleh wizard), **profil** (`profiles` + `defaultProfile`/`activeProfile`, tiap profil `{ baseUrl, model, apiKeyEnv | apiKey }`), **mode** (`beginner`/`pro`), **role** aktif, budget konteks, ambang summarizer, timeout eksekusi, dan approval (aktif/allowlist). Lihat/ubah lewat `/config` (mis. `/config set maxLogChars 2500`) atau ulang wizard lewat `/login`. Prioritas kredensial: `activeProfile` > `defaultProfile` > top-level; di dalam profil `apiKeyEnv` (env var) > `apiKey` literal; config file > env var (`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `AGENT_MODEL`) — tanpa default provider, jadi `apiKey` + `baseUrl` + `model` harus terisi (wizard memandu).

### Dua Mode Agen
- **Manual mode** — tanpa API key: prefix `run <cmd>` langsung dieksekusi; input lain dicatat sebagai konteks.
- **LLM mode** — dengan API key (wizard saat first-run, `/login`, atau env `OPENAI_API_KEY`; backend OpenAI-compatible bisa diarahkan ke Ollama/LM Studio lewat Base URL, atau lewat profil `/profile`): instruksi dikirim ke model beserta riwayat + prompt berlapis sesuai role aktif, agen menjalankan *tool loop* sampai jawaban final — respons di-stream real-time. Model bisa diganti runtime dengan `/model <nama>`.

### Slash Commands
Registry tunggal di `src/agent/commands.ts` — setiap command mendeklarasikan `name`, `aliases`, `help`, `hint`; `/help`, menu `/`, dan tabel README dibangkitkan dari sumber yang sama (`scripts/gen-commands-doc.mjs`) sehingga tidak pernah tidak sinkron.

| Perintah | Fungsi |
| --- | --- |
| `/help` | Show this help. |
| `/exit` | Keluar (sesi disimpan otomatis). |
| `/login` | Wizard provider: kredensial + tes koneksi langsung. |
| `/new` | Simpan sesi saat ini lalu mulai percakapan baru. |
| `/sessions` | Daftar sesi tersimpan. |
| `/resume <id>  (lihat /sessions)` | Lanjutkan sesi tersimpan. |
| `/clear` | Hapus konteks percakapan saat ini. |
| `/compact` | Paksa ringkas history lama sekarang (tanpa tunggu budget). |
| `/plan on \| off` | Mode rencana: hanya baca & usulkan, eksekusi diblokir di kode. |
| `/undo` | Batalkan perubahan file terakhir (snapshot .ruko/undo). |
| `/role [nama role]` | Lihat/ganti role AI (default, reviewer, teacher, minimal, kustom). |
| `/mode beginner \| pro` | Mode pengguna: beginner (guide penuh) atau pro (ringkas). |
| `/profile [alias]` | Provider multi-profil: ganti cepat alias (hemat, kuat, lokal). |
| `/exec <command>` | Jalankan perintah shell (output di-summarize otomatis). |
| `/history [n]` | Tampilkan n pesan konteks terakhir (default 5). |
| `/context` | Statistik konteks (pesan, karakter, budget). |
| `/usage` | Statistik pemakaian sesi (context, model, budget). |
| `/config [set <k> <v> \| setup]` | Tampilkan / ubah konfigurasi (.ruko/config.json). |
| `/model [nama]` | Lihat model aktif + daftar model, atau ganti. |

---

## Cara Kerja

### 1. Alur input

```
User input
   │
   ▼
First-run? → Setup Wizard (src/core/wizard.ts)  ← API Key/Base URL/Model
   │                                             → tes koneksi live (✓ Terhubung / error + fix)
   ▼                                             → .ruko/config.json (mode 600)
SystemLoop (src/core/loop.ts)            ← REPL + status bar `ctx% ⏸PLAN`, prompt `›`, menu `/`
   │
   ├─ slash command?  →  commands.ts      ← registry tunggal: /login /profile /role /mode
   │                                        /plan /undo /compact /model (auto-fetch) /exec...
   │
   └─ instruksi biasa →  Context.add() → Agent
                            │
   Agent (src/agent/agent.ts)            ← manual mode ATAU LLM tool loop
                            │              prompt berlapis (roles.ts: core+tools+role+AGENT.md+mode)
                            ▼              spinner ▸ Thinking... → stream token via
   LLM (src/agent/llm.ts)                ← fetch SSE stream:true, onToken per chunk
   │                                        (+ testConnection / listModels / penerjemah error)
   ├─ plan mode aktif? → exec/write/edit/patch DIBLOK di runToolCall (bukan cuma prompt)
   ├─ tool + argumen sama >2×? → loop breaker berhenti & lapor user
   ├─ tool exec/read → action log 🟢 Bash(...)/🟢 Read(...) — hasil di-cap 8k char
   ├─ tool edit/write/patch → snapshot .ruko/undo/ → log 🟢 Edit(...) + diff merah/hijau
   ▼
Executor (src/core/executor.ts) → Log Summarizer (> ambang dipotong)
   │
   ▼
Hasil → baris usage `↑ ↓ · ctx%` (+ peringatan >50%)
      → Context.compress() (jika over budget; /compact untuk paksa)
      → saveSession() ke .ruko/sessions/ → prompt berikutnya
```

### 2. Approval flow

```
Perintah mau dieksekusi
   │
   ▼
detectRisk(command, config)   ← regex dangerous/blocked + allowlist + yolo
   │
   ├─ none      → eksekusi langsung
   ├─ dangerous → prompt user y/N (non-TTY = otomatis tolak)
   │               ├─ ya  → eksekusi
   │               └─ tidak → hasil sintetis [Persetujuan ditolak: <alasan>]
   └─ blocked   → selalu tolak [BLOCKED oleh Ruko: <alasan>]
```

### 3. LLM tool loop (mode LLM)

1. Instruksi + riwayat konteks dikirim ke model dengan `stream: true`; **system prompt dirakit berlapis** oleh `roles.ts` (identitas inti → aturan tool → role aktif → AGENT.md proyek → tambahan mode/plan) dengan urutan tetap agar ramah prompt-caching. Token jawaban di-stream ke terminal, blok ` ```tool ` disaring keluar.
2. Jika ingin memakai tool, model membalas blok (pilihan: `exec`, `read_file`, `write_file`, `edit_file`, `patch_file`):

   ````text
   ```tool
   {"tool": "exec", "command": "ls -la", "cwd": null, "timeoutMs": 30000}
   ```
   ````

   ````text
   ```tool
   {"tool": "patch_file", "path": "src/util.ts", "oldText": "<snippet persis>", "newText": "<pengganti>"}
   ```
   ````

3. Sebelum dieksekusi, lapisan pengaman CLI bekerja: plan mode memblokir tool mutatif, penghitung loop menghentikan panggilan identik >2×, approval gate menyaring `exec` berisiko. Blok dieksekusi (`read_file` berhalaman; `edit_file`/`write_file`/`patch_file` snapshot dulu ke `.ruko/undo/` lalu menulis dan mencetak diff berwarna), hasilnya **di-cap 8.000 char** dan dikirim balik sebagai pesan `tool`.
4. Diulang sampai model menjawab tanpa blok tool (maksimal 6 iterasi per instruksi), lalu baris usage `↑ ↓ · ctx%` dicetak.

### 4. Compression flow

```
Konteks > budget (default 30.000 char)?
   │
   ▼
Lindungi N turn terakhir (default 6, utuh)
   │
   ▼
Fold turn tertua → ekscerpt satu baris [role] teks
   │
   ▼
Hitung proyeksi: digest + sisa verbatim + tail ≤ budget?
   ├─ ya  → stop fold, sisipkan pesan [compressed history ...]
   └─ tidak → perkecil ekscerpt (200→100→50→25→12) lalu ulangi
        └─ tetap tidak muat / tidak ada penghematan → serah (history dibiarkan)
```

### 5. Persistensi

- **Sesi**: JSON di `.ruko/sessions/` — `{id, title (dari pesan user pertama), createdAt, updatedAt, messages[]}`. Auto-save setelah tiap instruksi & saat `/exit`.
- **Config**: `.ruko/config.json` (izin 600) dimuat saat start + resolusi profil (`activeProfile` > `defaultProfile`); `/model`, `/profile`, `/role`, `/mode` dan `/config set` menulis ulang berkasnya.
- **Undo**: jurnal snapshot `{<id>.content, <id>.meta.json}` di `.ruko/undo/` (maks 25) — `/undo` memakainya dari yang terbaru; lokasi bisa dialihkan via env `RUKO_UNDO_DIR`.

### 6. Modul & tanggung jawab

| Modul | Peran |
| --- | --- |
| `src/core/loop.ts` | System loop, status bar + prompt `›`, menu `/`, diff-aware output, confirmer approval, auto-save, kompresi |
| `src/core/ui.ts` | ANSI colors (auto-off non-TTY), box drawing, status bar, spinner, `RevealFilter` (stream filter) |
| `src/core/diff.ts` | Line diff LCS + render git-style merah/hijau |
| `src/core/wizard.ts` | Setup wizard interaktif (banner biru, 3 prompt, tes koneksi live → config 600) |
| `src/core/executor.ts` | Eksekusi shell (`child_process`) |
| `src/core/summarizer.ts` | Log Summarizer (>1000 char) |
| `src/core/approval.ts` | Deteksi risiko + guarded execute |
| `src/core/compressor.ts` | Kompresi history (adaptif) |
| `src/core/context.ts` | Memori percakapan (window, compress, compressNow) |
| `src/core/session.ts` | Simpan/list/load sesi |
| `src/core/config.ts` | Load/save `.ruko/config.json` mode 600 (+ resolusi profil) |
| `src/core/undo.ts` | Snapshot-before-write + `/undo` (restore/delete, jurnal .ruko/undo) |
| `src/agent/agent.ts` | Orkestrasi manual/LLM, streaming + spinner + action log, prompt berlapis, usage, deteksi loop |
| `src/agent/llm.ts` | Provider OpenAI-compatible (SSE stream, testConnection, listModels, penerjemah error) |
| `src/agent/roles.ts` | Registry role + parser frontmatter + assembler prompt berlapis |
| `src/agent/tools.ts` | Protocol tool-call (`exec`, `read_file`, `edit_file`, `write_file`, `patch_file`) + cap 8k + blokir plan mode + log 🟢 |
| `src/agent/filetools.ts` | Tool `read_file` (bernomor, berhalaman, deteksi biner) |
| `src/agent/commands.ts` | Registry slash commands (sumber tunggal /help + menu / + docs) |
| `src/index.ts` | Entry point (wizard first-run + tes koneksi, --exec, --summarize, --help, --version) |
| `scripts/gen-commands-doc.mjs` | Pembangkit tabel command README dari registry |
| `src/tests/` | Unit test (`node:test`, 93 test) |

---

Status pengerjaan, daftar tugas, ide selanjutnya, dan catatan handoff untuk AI berikutnya ada di **`PROGRESS.md`**.
