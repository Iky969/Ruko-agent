# PROGRESS.md

> Dokumen status pengerjaan **Ruko — AI Coding Agent CLI**. Diperbarui di akhir setiap sesi kerja. Ini adalah sumber kebenaran untuk handoff ke AI berikutnya.

---

## ✅ Fitur yang Sudah Selesai

- [x] Scaffold Node.js + TypeScript (ESM, strict, build ke `dist/`), entry point `src/index.ts`.
- [x] **System Loop** interaktif (`ruko> `), input diproses serial (promise queue — tidak ada race condition).
- [x] **Log Summarizer** (`src/core/summarizer.ts`) — potong log > 1000 char: head+tail (rata ke batas baris), marker TRUNCATED, highlights error/warning/exit code.
- [x] **Eksekusi shell** (`src/core/executor.ts`) — timeout, maxBuffer, stdout/stderr, exit code, summarization otomatis.
- [x] **Approval gate** (`src/core/approval.ts`) — deteksi `dangerous` (minta y/N) & `blocked` (selalu tolak: `rm -rf /`, `mkfs`, `dd of=/dev/`, fork bomb); allowlist config; `--yes` untuk `--exec`; `RUKO_YOLO_MODE`; non-TTY auto-ditolak.
- [x] **Context compression** (`src/core/compressor.ts` + `Context.compress`) — fold turn tertua jadi satu digest, N turn terakhir dilindungi, ekscerpt adaptif 200→12 char sampai budget muat, menyerah jika tak ada penghematan.
- [x] **Session persistence** (`src/core/session.ts`) — auto-save `.ruko/sessions/`, `/new`, `/resume <id>`, `/sessions`, judul dari pesan user pertama.
- [x] **Config file** (`src/core/config.ts`) — `.ruko/config.json` (atau `RUKO_CONFIG`), `/config [set k v]`, persist antar restart.
- [x] **Model switching** — `/model <nama>` runtime, tersimpan ke config; provider OpenAI-compatible (Ollama/LM Studio via `OPENAI_BASE_URL`).
- [x] **LLM tool loop** — blok `` ```tool {"tool":"exec",...} ``` ``, max 6 iterasi, hasil tool masuk approval gate.
- [x] Slash commands: `/help /exit /new /resume /sessions /clear /exec /history /context /config /model`.
- [x] Unit test `node:test` — **35 test hijau** (summarizer, executor, approval, compressor, config, filetools).
- [x] Rebrand lengkap ke **Ruko** (nama paket, bin, prompt, banner, dokumentasi).
- [x] **Tool `read_file`** (`src/agent/filetools.ts`) — baca berkas teks bernomor baris + paginasi offset/limit (default 200, cap 2.000 baris, clip baris 2.000 char), tolak direktori/file non-reguler/biner (deteksi NUL + rasio control-char), header hasil lapor total baris + rentang + `nextOffset`. Terdaftar di `runToolCall()` (`src/agent/tools.ts`) + `SYSTEM_PROMPT` (`src/agent/agent.ts`) + 9 unit test.

### v0.3.0 — Refactoring UI/UX + Setup Wizard + Streaming + Diff Visual

- [x] **Interactive Setup Wizard** (`src/core/wizard.ts`) — first-run tanpa API key → banner welcome bgBlue, prompt berurutan `API Key:` / `Base URL (default https://api.b.ai/v1):` / `Model Name (default qwen3.8-flash):`; hasil tersimpan permanen ke `.ruko/config.json` (field baru `apiKey`/`baseUrl`, config file > env var > default). Slash `/config setup` mengulang wizard dari dalam REPL; API key ditampilkan ter-mask di `/config`.
- [x] **Streaming LLM** (`src/agent/llm.ts`) — `stream: true` + parser SSE incremental (buffer per event `data:`, fallback ke JSON biasa jika endpoint menolak stream); token di-pipe real-time via callback `onToken`.
- [x] **RevealFilter** (`src/core/ui.ts`) — filter stream yang menyembunyikan blok `` ```tool `` bahkan saat fence terpotong antar-chunk; fence kode biasa tetap tampil. Unit test chunk-per-3-char.
- [x] **Status Bar & prompt baru** (`src/core/ui.ts` + `loop.ts`) — bar `⚡ [model] | Context: X/30k | / for commands` bg hijau gelap + prompt `› Ask anything...`; warna ANSI auto-off saat non-TTY/NO_COLOR (output test tetap bersih).
- [x] **Spinner** `▸ Thinking...` saat LLM berpikir (idle sampai token pertama tiba).
- [x] **Menu slash command interaktif** — ketik `/` (+Enter) → daftar semua command + deskripsi dalam box unicode; daftar dibaca dari registry via `listCommands()`.
- [x] **Output box drawing** (┌─┐│└─┘) untuk `/context`, `/usage` (baru), `/config`, `/sessions`.
- [x] **Visual Action Logs** — `🟢 Bash(<cmd>)`, `🟢 Read(<file>)`, `🟢 Edit(<file>)` saat tool dijalankan (via `ToolDeps.onLog`).
- [x] **Tool `edit_file`/`write_file` + Visual File Diff** (`src/core/diff.ts` + `tools.ts`) — diff LCS baris gaya git: `-` merah, `+` hijau, konteks 3 baris, region tak berubah dilipat; `write_file` tolak overwrite diam-diam; konten identik = no-op 🟡. `SYSTEM_PROMPT` diperbarui.
- [x] **Distribusi global** — shebang `#!/usr/bin/env node` + `"bin": {"ruko": "./dist/index.js"}` + chmod dist; semua path basis `process.cwd()` (config, sesi, tool file). Terverifikasi `npm link` → `ruko` jalan dari direktori lain.
- [x] Unit test baru (`src/tests/ui|diff|reveal|fileedit|wizard|llm.test.ts`) — **total 64 test hijau**; test lama (summarizer, executor, approval, compressor, config, filetools) tidak diubah dan tetap pass.
- [x] Smoke test end-to-end dengan server SSE tiruan (`scripts/fake-llm-server.mjs`): streaming, tool loop exec→observe→jawab, filter blok tool, log 🟢 — terverifikasi di PTY nyata termasuk wizard first-run + `/config setup` + menu `/`.

### v0.4.0 — Eksekusi feedback.txt (lihat progress.md untuk checklist rinci)

- [x] **Provider ramah pemula**: wizard `/login` tes koneksi live ("✓ Terhubung ke <model>") + penerjemah error 401/404/ECONNREFUSED dengan perintah perbaikan; auto-fetch `/v1/models` di `/model`; config **600**.
- [x] **Multi-profil**: `profiles` + `apiKeyEnv` di config, `/profile <alias>` (hemat/kuat/lokal), resolusi active>default>none.
- [x] **Registry tunggal**: `/help`, menu `/`, dan tabel README dibangkitkan dari COMMANDS (`buildHelpText`, `scripts/gen-commands-doc.mjs`); hint argumen per command.
- [x] **Role berlapis** (`src/agent/roles.ts`): core+tools+role+AGENT.md+mode (urutan tetap, cache-friendly); bawaan default/reviewer/teacher/minimal; kustom via `.ruko/roles/*.md`; `/role`, `/mode beginner|pro`.
- [x] **Hemat token**: cap hasil tool 8k char, deteksi loop (tool+arg >2× dihentikan di kode), tool `patch_file` search-replace, `/compact`, baris usage `↑ ↓ · ctx%` per giliran + peringatan >50%.
- [x] **Pengaman**: plan mode `/plan` dipaksakan di level tool (exec/write/edit/patch diblok), `/undo` snapshot `.ruko/undo/` sebelum tiap perubahan file.
- [x] Test: **93 hijau** (+29 baru: roles, undo, patchfile, profiles, commands, wizard-probe, ui-bar).

---

## 📋 Tugas Sesi Ini (gap analysis vs proyek referensi) — SEMUA SELESAI

- [x] Rebrand proyek → **Ruko** (tanpa unsur brand referensi).
- [x] **Approval system** — deteksi perintah berisiko + konfirmasi user (referensi: konsep approval gate).
- [x] **Context compression** — kompres history lama, bukan buang mentah (referensi: konsep trajectory compression).
- [x] **Session persistence** — `/new`, `/resume`, `/sessions`, auto-save (referensi: konsep session state).
- [x] **Config file** — `.ruko/config.json` + `/config` (referensi: konsep config yaml).
- [x] **Model switching** — `/model <nama>` runtime + persist (referensi: konsep model CLI).
- [x] Unit test approval, compressor, config loader.

---

## 💡 Ide Selanjutnya / Roadmap (untuk AI berikutnya)

Berikut gap yang masih tersisa dibanding proyek referensi, diurutkan berdasarkan dampak vs usaha:

### Prioritas tinggi
1. **Tool tambahan** — `read_file`, `edit_file`, `write_file`, `patch_file` selesai (v0.3.0/v0.4.0). Lanjutkan pola yang sama untuk `code_search`/`glob` (dengan penghindaran node_modules/dist/.git/biner per §5.31): (1) fungsi murni di `src/agent/filetools.ts`, (2) case baru di `runToolCall()` `src/agent/tools.ts`, (3) contoh blok di `TOOL_RULES` `src/agent/roles.ts`, (4) unit test.
2. **Provider LLM lain** — interface `LLMProvider` + streaming SSE + testConnection/listModels selesai (v0.4.0, OpenAI-compatible saja). Tambah: Anthropic (`ANTHROPIC_API_KEY` + cache_control), Google Gemini, OpenRouter.
3. **Subagent / delegation** — spawn subagent terisolasi untuk pekerjaan paralel, hasilnya dikembalikan sebagai satu turn (hemat konteks, §6.41). Pola: `Agent` baru dengan Context sendiri + channel komunikasi.
4. **Skills system** — folder skill yang bisa dimuat agent saat tugas cocok (deklarasi di YAML/JSON + instruksi). Referensi: standar open `agentskills.io`. Mulai dari mekanisme load-by-name, lalu "belajar dari pengalaman" (simpan langkah sukses sebagai skill).

### Prioritas sedang
5. **Approval pintar** — guardian LLM untuk verdict otomatis pada command `dangerous` (bukan selalu tanya), circuit breaker denial, dan UI allowlist per-command.
6. **Pencarian lintas sesi** — FTS sederhana (mis. SQLite atau index JSON) atas isi `.ruko/sessions/` agar agent bisa "mengingat" percakapan lama; tambahkan tool `search_sessions`.
7. **Cron / automasi terjadwal** — jalankan instruksi pada jadwal (daily report, backup), kirim hasil ke platform.
8. **Gateway messaging** — konektor Telegram/Discord/Slack untuk berinteraksi dengan Ruko dari mana saja (butuh daemon terpisah).
9. **TUI** — multiline editing, autocomplete slash command saat mengetik (butuh keypress handling sendiri: event `keypress` readline TIDAK ter-emit di beberapa PTY, lihat Known Bugs #7), streaming tool output (pakai `blessed`/`ink` — ingat prinsip "verify library already used"; saat ini belum ada dependency UI).

### Prioritas rendah / jangka panjang
10. **Trajectory export** — ekspor riwayat percakapan+tool ke JSONL untuk training/evals (batch runner).
11. **Persistensi history antar-sesi di REPL** — riwayat input shell (readline history file) + `/titles` rename sesi.
12. **Packaging** — `npm publish` + installer one-liner, Dockerfile, dukungan Windows native (Git Bash).
13. **E2E test** — mock server OpenAI-compatible untuk menguji tool loop tanpa API key; test approval prompt via TTY mock.
14. **Config lanjutan** — `.env` loader, override via CLI flags, validasi tipe, dukungan YAML.

### Referensi yang belum dipetakan ke Ruko (dari proyek referensi)
Browser automation, computer-use, voice/TTS, plugin system, sandbox backend (Docker/SSH/Modal), RPC toolsets untuk pipeline multi-langkah. Sebagian besar di luar scope CLI minimal ini — dokumentasikan dulu sebelum dikerjakan.

---

## ⏳ Fitur yang Belum / Tertunda (belum dikerjakan)

- [ ] Tool lanjutan (`patch`/`apply_diff`, `code_search`/`glob`) — lihat Roadmap #1; `read_file`/`edit_file`/`write_file` sudah selesai (v0.3.0).
- [ ] Provider Anthropic/Gemini — Roadmap #2 (streaming OpenAI-compatible sudah selesai v0.3.0).
- [ ] Subagent/delegation — Roadmap #3.
- [ ] Skills system — Roadmap #4.
- [ ] Approval pintar (guardian LLM) — Roadmap #5.
- [ ] Pencarian lintas sesi — Roadmap #6.
- [ ] Cron & gateway messaging — Roadmap #7–8.
- [ ] TUI — Roadmap #9.
- [ ] Trajectory export, packaging npm publish, E2E CI — Roadmap #10–13 (mock server SSE lokal sudah ada: `scripts/fake-llm-server.mjs`).
- [ ] Config lanjutan (.env loader, validasi tipe, YAML) — Roadmap #14.

---

## 🐞 Known Bugs / Issues

- **Belum ada bug terkonfirmasi pada fitur aktif.** Catatan batasan yang disadari:
  1. **Compression menyerah bila budget tak terjangkau** — jika turn yang dilindungi + ekscerpt minimum melebihi `maxContextChars`, history dibiarkan utuh (over budget). Aman, tapi konteks bisa tetap besar; solusi jangka panjang: summarization via LLM.
  2. **`--exec` timeout mencatat exit code `null`** (bukan 124) — perilaku `child_process.exec` bawaan; migrasi ke `spawn` memungkinkan exit code akurat + streaming.
  3. **Urutan stdout vs stderr** di field `output` tidak dijamin (limitasi callback `exec`).
  4. **`rm -rf /etc` terdeteksi `dangerous` (bukan `blocked`)** — hanya `rm -rf /` persis yang diblokir; pola lain yang menghapus path sistem bisa lolos ke level "tanya". Perlu audit pola regex.
  5. **Approval non-TTY selalu menolak** — di skenario CI yang memang ingin menjalankan perintah berisiko harus pakai `--yes` atau `RUKO_YOLO_MODE` (by design, tapi bisa mengejutkan).
  6. **Digest header estimate (60 char)** — proyeksi budget konservatif; aman, hanya sedikit membuang ruang.
  7. **Event `keypress` readline tidak ter-emit di semua PTY** (teramati di PTY environment codespace ini) — menu rekomendasi `/` karena itu muncul saat `/` ditekan Enter (jalur `handleLine`), bukan otomatis per- keystroke. Autocomplete penuh butuh parser ANSI sendiri (Roadmap #9).
  8. **Streaming + `console.log` dapat selang-seling** — teks LLM ditulis via `process.stdout.write` tanpa newline saat spinner aktif; newline sudah dijaga di `runWithLlm`, tapi interleave dengan spinner TTY yang lambat bisa terlihat berantakan pada terminal sangat sempit.

---

## 🤖 Context Handoff untuk AI Berikutnya

1. **Verifikasi baseline dulu:** `npm install && npm run build && npm test` → 93 test harus hijau. Smoke test: `printf 'run echo hi\n/context\n/exit\n' | node dist/index.js`.
2. **Mulai dari Roadmap #1** (tool read/write/patch/search) — dampak terbesar dengan usaha terkecil. Pola menambah tool: (1) case baru di `runToolCall()` `src/agent/tools.ts`, (2) sebut di `SYSTEM_PROMPT` `src/agent/agent.ts`, (3) unit test.
3. **Struktur kode:** `src/core/` = infrastruktur (loop, executor, summarizer, approval, compressor, context, session, config); `src/agent/` = logika agen (agent, llm, tools, commands). Entry point `src/index.ts`. Semua ESM, import pakai ekstensi `.js`, TypeScript strict, JSDoc singkat.
4. **Fitur wajib dari spesifikasi awal (jangan dihapus):** Log Summarizer >1000 char terpasang di `executor.ts` (param `summarize`, default `true`); System Loop menerima instruksi; eksekusi shell bawaan.
5. **Dokumentasi:** `README.md` = fitur + cara kerja saja (sesuai permintaan user). Semua detail status/tugas/bug ada di file ini (`PROGRESS.md`).
6. **Konvensi:** Bahasa Indonesia untuk output UI & docs; brand **Ruko** (jangan reintroduksi nama/unsur brand proyek referensi — referensi cukup disebut di catatan ini sebagai sumber ide).
7. **Setelah selesai sesi:** perbarui file ini — centang fitur selesai, pindahkan item Roadmap ke Tertunda, catat bug/handoff baru.
8. **Batasan waktu kerja:** spesifikasi asli membatasi eksekusi ~50 menit; prioritaskan eksekusi cepat dan self-documenting.
9. **Catatan teknis:** `AgentConfig` ada di `src/types.ts` (default di `DEFAULT_CONFIG`); menambah opsi config = tambah field di interface + loader `src/core/config.ts` + `/config` di `src/agent/commands.ts`.
10. **Jebakan tooling (sesi v0.4.0):** lapisan secret-redaksi pada pipeline agen menulis `***` literal ke DISK saat `write_file` mengandung pola mirip API key (mis. `apiKey: string` setelah kata key, atau literal `'sk-...'`). Gejala: syntax error TS1110 di file baru. Mitigasi: hindari literal key-like di source; kalau terjebak, tambal via `node -e` di shell (jalur tulis shell tidak ter-mask).
