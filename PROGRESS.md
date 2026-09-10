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
1. **Tool tambahan** — `read_file` sudah selesai (lihat Fitur Selesai). Lanjutkan pola yang sama untuk `write_file`, `patch`/`apply_diff`, `code_search`/`glob`: (1) fungsi murni di `src/agent/filetools.ts`, (2) case baru di `runToolCall()` `src/agent/tools.ts`, (3) contoh blok di `SYSTEM_PROMPT` `src/agent/agent.ts`, (4) unit test. Pertimbangkan approval gate untuk tool yang menulis (`write_file`/`patch`) — tool non-shell saat ini bypass `guardedExecute` karena tidak melewati executor.
2. **Provider LLM lain + streaming** — interface `LLMProvider` (`src/agent/llm.ts`) hanya punya implementasi OpenAI-compatible. Tambah: Anthropic (`ANTHROPIC_API_KEY`), Google Gemini, OpenRouter; dan streaming respons ke terminal (`/model` berguna untuk beralih antar provider).
3. **Subagent / delegation** — spawn subagent terisolasi untuk pekerjaan paralel, hasilnya dikembalikan sebagai satu turn (hemat konteks). Pola: `Agent` baru dengan Context sendiri + channel komunikasi.
4. **Skills system** — folder skill yang bisa dimuat agent saat tugas cocok (deklarasi di YAML/JSON + instruksi). Referensi: standar open `agentskills.io`. Mulai dari mekanisme load-by-name, lalu "belajar dari pengalaman" (simpan langkah sukses sebagai skill).

### Prioritas sedang
5. **Approval pintar** — guardian LLM untuk verdict otomatis pada command `dangerous` (bukan selalu tanya), circuit breaker denial, dan UI allowlist per-command.
6. **Pencarian lintas sesi** — FTS sederhana (mis. SQLite atau index JSON) atas isi `.ruko/sessions/` agar agent bisa "mengingat" percakapan lama; tambahkan tool `search_sessions`.
7. **Cron / automasi terjadwal** — jalankan instruksi pada jadwal (daily report, backup), kirim hasil ke platform.
8. **Gateway messaging** — konektor Telegram/Discord/Slack untuk berinteraksi dengan Ruko dari mana saja (butuh daemon terpisah).
9. **TUI** — multiline editing, autocomplete slash command, streaming tool output (pakai `blessed`/`ink` — ingat prinsip "verify library already used"; saat ini belum ada dependency UI).

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

- [ ] Tool tambahan lanjutan (write/patch/search) — lihat Roadmap #1; `read_file` sudah selesai.
- [ ] Provider Anthropic/Gemini + streaming — Roadmap #2.
- [ ] Subagent/delegation — Roadmap #3.
- [ ] Skills system — Roadmap #4.
- [ ] Approval pintar (guardian LLM) — Roadmap #5.
- [ ] Pencarian lintas sesi — Roadmap #6.
- [ ] Cron & gateway messaging — Roadmap #7–8.
- [ ] TUI — Roadmap #9.
- [ ] Trajectory export, packaging, E2E test — Roadmap #10–13.

---

## 🐞 Known Bugs / Issues

- **Belum ada bug terkonfirmasi pada fitur aktif.** Catatan batasan yang disadari:
  1. **Compression menyerah bila budget tak terjangkau** — jika turn yang dilindungi + ekscerpt minimum melebihi `maxContextChars`, history dibiarkan utuh (over budget). Aman, tapi konteks bisa tetap besar; solusi jangka panjang: summarization via LLM.
  2. **`--exec` timeout mencatat exit code `null`** (bukan 124) — perilaku `child_process.exec` bawaan; migrasi ke `spawn` memungkinkan exit code akurat + streaming.
  3. **Urutan stdout vs stderr** di field `output` tidak dijamin (limitasi callback `exec`).
  4. **`rm -rf /etc` terdeteksi `dangerous` (bukan `blocked`)** — hanya `rm -rf /` persis yang diblokir; pola lain yang menghapus path sistem bisa lolos ke level "tanya". Perlu audit pola regex.
  5. **Approval non-TTY selalu menolak** — di skenario CI yang memang ingin menjalankan perintah berisiko harus pakai `--yes` atau `RUKO_YOLO_MODE` (by design, tapi bisa mengejutkan).
  6. **Digest header estimate (60 char)** — proyeksi budget konservatif; aman, hanya sedikit membuang ruang.

---

## 🤖 Context Handoff untuk AI Berikutnya

1. **Verifikasi baseline dulu:** `npm install && npm run build && npm test` → 26 test harus hijau. Smoke test: `printf 'run echo hi\n/context\n/exit\n' | node dist/index.js`.
2. **Mulai dari Roadmap #1** (tool read/write/patch/search) — dampak terbesar dengan usaha terkecil. Pola menambah tool: (1) case baru di `runToolCall()` `src/agent/tools.ts`, (2) sebut di `SYSTEM_PROMPT` `src/agent/agent.ts`, (3) unit test.
3. **Struktur kode:** `src/core/` = infrastruktur (loop, executor, summarizer, approval, compressor, context, session, config); `src/agent/` = logika agen (agent, llm, tools, commands). Entry point `src/index.ts`. Semua ESM, import pakai ekstensi `.js`, TypeScript strict, JSDoc singkat.
4. **Fitur wajib dari spesifikasi awal (jangan dihapus):** Log Summarizer >1000 char terpasang di `executor.ts` (param `summarize`, default `true`); System Loop menerima instruksi; eksekusi shell bawaan.
5. **Dokumentasi:** `README.md` = fitur + cara kerja saja (sesuai permintaan user). Semua detail status/tugas/bug ada di file ini (`PROGRESS.md`).
6. **Konvensi:** Bahasa Indonesia untuk output UI & docs; brand **Ruko** (jangan reintroduksi nama/unsur brand proyek referensi — referensi cukup disebut di catatan ini sebagai sumber ide).
7. **Setelah selesai sesi:** perbarui file ini — centang fitur selesai, pindahkan item Roadmap ke Tertunda, catat bug/handoff baru.
8. **Batasan waktu kerja:** spesifikasi asli membatasi eksekusi ~50 menit; prioritaskan eksekusi cepat dan self-documenting.
9. **Catatan teknis:** `AgentConfig` ada di `src/types.ts` (default di `DEFAULT_CONFIG`); menambah opsi config = tambah field di interface + loader `src/core/config.ts` + `/config` di `src/agent/commands.ts`.