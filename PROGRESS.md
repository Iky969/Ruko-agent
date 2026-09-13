# PROGRESS.md

> Dokumen status pengerjaan **Ruko — AI Coding Agent CLI**. Diperbarui di akhir setiap sesi kerja. Ini adalah sumber kebenaran (source of truth) dan checkpoint handoff untuk AI berikutnya.

---

## 📦 Riwayat Rilis & Status Fitur (Changelog)

### v1.4.0 (13 September 2026) — Pencarian Lintas Sesi, Siklus Lengkap Skills System, & In-Flight Cancellation

#### Ditambahkan
- **Tool `search_sessions(query, limit?)` (`src/core/session.ts`, `src/agent/tools.ts`)**:
  * Pencarian teks (case-insensitive substring match) pada seluruh pesan percakapan di `.ruko/sessions/`.
  * Membaca secara inkremental/streaming per berkas (diurutkan berdasarkan `mtime` menurun, newest-first) tanpa memuat seluruh riwayat sesi ke memori.
  * Mengembalikan: `session_id`, `timestamp`, `message_count`, judul, role, dan `snippet` ringkas (maksimal ~150 karakter).
  * Default limit 5 hasil, aman digunakan di seluruh mode (plan mode, reviewer, default).
- **Slash Command `/search <query>` (`src/agent/commands.ts`)**:
  * Antarmuka CLI interaktif untuk pencarian lintas sesi dengan visual rapi (`renderBox`) dan petunjuk langsung `/resume <session_id>`.
- **Tool `delete_skill(name)` (`src/core/skills.ts`, `src/agent/tools.ts`)**:
  * Menghapus berkas skill yang sudah usang atau tidak relevan dari `.ruko/skills/`.
  * Wajib konfirmasi Approval Gate `[Y/N]` dan menampilkan preview isi instruksi skill sebelum dihapus. Terdaftar di `PLAN_MODE_BLOCKED`.
- **Aturan Penyimpanan Skill di System Prompt (`src/agent/roles.ts`)**:
  * `TOOL_RULES` diperbarui: agent HANYA menyimpan skill baru jika (a) user memberi instruksi berulang yang kompleks, atau (b) user secara eksplisit meminta "simpan ini sebagai skill". Dilarang menyimpan skill otomatis/diam-diam. Isi skill wajib berupa pola umum (*generalizable*).
- **In-Flight Cancellation Support via ESC (`src/core/tui.ts`, `src/agent/agent.ts`)**:
  * Menangani tombol ESC tunggal (`\u001b`) saat ambient mode aktif untuk mengirimkan abort signal ke streaming LLM dan eksekusi tool in-flight.
  * Menampilkan umpan balik jelas `"Dibatalkan oleh pengguna"` ke terminal.
- **Installer `install.sh` & Lockfile Sync**:
  * Mengubah default clone ke branch `main` (`TAG="${RUKO_VERSION:-main}"`) agar unduhan via `curl | bash` selalu memperoleh versi terbaru tanpa tertahan di tag lama.

#### Detail Arsitektural
- **Pola Asimetri Keamanan Approval Gate**:
  * `delete_skill` wajib Approval Gate `[Y/N]` karena bersifat destruktif terhadap berkas proyek. Tidak membutuhkan snapshot undo terpisah karena ukuran skill kecil dan pratinjau isi skill sudah ditampilkan secara eksplisit kepada pengguna sebelum konfirmasi.
  * `save_skill` dan `stop_process` tetap non-destruktif / tidak memerlukan gate konfirmasi.
- **Efisiensi Memori Streaming Pencarian Sesi**:
  * Direktori `.ruko/sessions/` diinspeksi dengan `statSync` untuk mengurutkan file secara kronologis menurun sebelum parsing JSON dilakukan. File dibaca dan dievaluasi satu per satu, lalu segera dilepas dari memori jika tidak cocok atau batas `limit` tercapai.
- **Decoupled Lifecycle Background Process vs Turn Cancel**:
  * Child process yang dijalankan via `start_process` berjalan secara *detached* dan *unref*, sehingga saat user menekan ESC untuk membatalkan giliran AI, background server/watcher tetap berjalan aman tanpa terbunuh.
- **Verifikasi & Test Suite**:
  * Total test: **342 passed** (100% lulus, 0 gagal), `npm run typecheck` bersih.

---

### v1.3.0 (13 September 2026) — Process Management Subsystem & Anti-Zombie Lifecycle Hooks
- **Fitur Utama**:
  * Penambahan tool manajemen proses background non-blocking: `start_process(command, cwd?)`, `read_process_logs(process_id)`, `get_status(process_id)`, dan `stop_process(process_id)`.
  * Batas maksimal 3 proses aktif bersamaan dengan validasi ketat `assertInsideWorkspace()`.
  * Buffer log melingkar (*ring buffer*) 100 baris dengan sanitasi kredensial otomatis (*best-effort* regex).
- **Keputusan Keamanan**:
  * Asimetri Approval Gate: `start_process` wajib konfirmasi `[Y/N]` (potensi bahaya tersembunyi), sedangkan `stop_process` bebas konfirmasi.
  * Anti-Zombie Cleanup: Hook terpasang lengkap pada `exit`, `SIGINT`, DAN `SIGTERM` untuk mematikan seluruh child process sebelum Ruko keluar.
- **Verifikasi**: 13 unit test baru (total 335 passed).

---

### v1.2.0 (13 September 2026) — Keamanan Tool Berkas, Guard Anti-Duplikasi, Quick Wins & Approval Expansion
- **Fitur Utama**:
  * Tool resmi `delete_file` dan `move_file` dengan validasi path traversal, persetujuan konfirmasi `[Y/N]`, dan pencadangan snapshot otomatis ke `.ruko/undo/`.
  * Guard mekanis `lastCallSignature` pada loop agent untuk mencegah eksekusi ganda perintah identik secara berulang.
  * Tool `web_fetch` dengan proteksi ketat SSRF (blokir IP lokal, privat RFC 1918, link-local cloud metadata, dan DNS pre-check).
  * Multi-pattern & brace expansion `{a,b}` pada tool `glob`, tool `list_skills`, slash command `/context set <jumlah>`, dan styling box approval ANSI.
- **Verifikasi**: 25 unit test baru (total 322 passed).

---

### v1.1.1 (13 September 2026) — Perbaikan Izin Biner Global & Polish Visual TUI
- **Fitur Utama**:
  * Otomasi izin eksekusi (`chmod +x`) biner global di `install.sh` untuk platform Termux dan Linux standar.
  * Pemisahan baris model dan provider pada splash banner REPL untuk tampilan bersih pada terminal sempit (>= 40 kolom).

---

### v1.1.0 (13 September 2026) — Provider Eksternal, Persistensi REPL & Trajectory Export
- **Fitur Utama**:
  * Dukungan multi-provider: integrasi Anthropic Claude dan Google Gemini via native fetch SSE streaming.
  * Loader `.env` zero-dependency, penyimpanan riwayat masukan REPL (`.ruko/history`), dan ekspor jejak giliran percakapan (`/export [jsonl|md]`).

---

### v1.0.0 (12 September 2026) — Inisiasi Fondasi Ruko AI Coding Agent
- **Fitur Utama**:
  * Mesin agen otonom zero-runtime dependency berbasis Node.js/TypeScript.
  * Filter keamanan dua lapis: Deterministic Regex Gate (Layer 1) + Guardian LLM terisolasi (Layer 2) dengan audit trail `.ruko/guardian-audit.log`.
  * Workspace sandboxing (`assertInsideWorkspace`), kompresi konteks riwayat percakapan, jurnal undo berkas, dan persistensi sesi.

---

## 💡 Ide Selanjutnya / Roadmap (untuk AI berikutnya)

Gap fitur yang tersisa dibanding sistem asisten coding modern:

### Prioritas tinggi
1. ~~**Tool tambahan** — `read_file`, `edit_file`, `write_file`, `patch_file`, `glob`, `code_search`~~ — **SELESAI (v0.9.0)**.
2. ~~**Provider LLM lain** — Anthropic & Google Gemini SSE native~~ — **SELESAI (v1.1.0)**.
3. ~~**Subagent / delegation** — tool `delegate` & subagent runner~~ — **SELESAI (v1.1.0)**.
4. ~~**Skills system lengkap** — load, save, list, delete, & prompt guidelines~~ — **SELESAI (v1.4.0)**.
5. ~~**Pencarian lintas sesi** — `search_sessions` & command `/search`~~ — **SELESAI (v1.4.0)**.
6. ~~**Process management** — `start_process`, `read_process_logs`, `get_status`, `stop_process`~~ — **SELESAI (v1.3.0)**.

### Prioritas sedang / jangka panjang
7. **Cron / automasi terjadwal** — jalankan instruksi berkala (daily healthcheck/build), kirim status ke webhooks.
8. **Gateway messaging** — konektor pesan ringan (Telegram/Discord webhook daemon) untuk remote trigger.
9. **Dukungan Plugin / MCP** — protokol client Model Context Protocol (MCP) untuk menghubungkan tools eksternal secara dinamis.
10. **Packaging & Distribusi** — publikasi npm registry resmi (`npm publish`), Docker container image, dan skrip updater terintegrasi.

---

## ⏳ Status Pengerjaan Roadmap

- [x] Tool manipulasi & inspeksi berkas (`read_file`, `patch_file`, `edit_file`, `write_file`, `delete_file`, `move_file`, `glob`, `code_search`) — SELESAI.
- [x] Provider multi-profil (OpenAI-compatible, Anthropic, Gemini) — SELESAI.
- [x] Subagent / task delegation (`delegate`) — SELESAI.
- [x] Skills system siklus penuh (`load_skill`, `save_skill`, `list_skills`, `delete_skill`) — SELESAI.
- [x] Approval pintar (Guardian LLM + Audit Trail) — SELESAI.
- [x] Pencarian percakapan lintas sesi (`search_sessions` & `/search`) — SELESAI.
- [x] Process management subsystem background services — SELESAI.
- [x] TUI & Visual Polish (raw-mode editor, in-place redraw, ambient mode, ESC cancel, responsive divider) — SELESAI.
- [x] Trajectory export, REPL history persistence, dan E2E test runner — SELESAI.
- [ ] Cron & gateway messaging (DITUNDA / OUT OF SCOPE).

---

## 🐞 Known Bugs / Issues

Catatan batasan arsitektural yang disadari:
1. **Compression menyerah bila budget tak terjangkau** — jika turn yang dilindungi + ringkasan minimum melebihi `maxContextChars`, riwayat dibiarkan utuh (*over budget*).
2. **`--exec` timeout mencatat exit code `null`** (bukan 124) — perilaku bawaan `child_process.exec`; proses latar belakang dialihkan menggunakan `start_process` (`spawn`).
3. **Urutan stdout vs stderr** pada field `output` tool `exec` tidak terjamin sekuensial mutlak (limitasi callback buffering).
4. **Known limitation deteksi obfusikasi perintah regex**: Obfuscation eval/base64 kompleks (`echo <b64> | base64 -d | sh`) tidak dapat ditutup sempurna dengan regex statis tanpa false-positive masif; ditangani via pertahanan lapis kedua (Guardian LLM).
5. **Approval non-TTY otomatis menolak**: Di lingkungan CI headless yang ingin mengeksekusi aksi berisiko, wajib menyetel flag non-interaktif atau `RUKO_YOLO_MODE`.
6. **Known limitation redaksi kredensial**: Redaksi token/kredensial pada `read_process_logs` berbasis ekspresi reguler adalah pertahanan berlapis (*best-effort*), bukan jaminan 100% terhadap token arbitrer tanpa kata kunci penanda.
7. **Streaming interleaving pada terminal sangat sempit**: Teks streaming LLM dapat mengalami pergeseran baris kecil jika terminal berukuran <40 kolom saat indikator thinking aktif.
8. **TOCTOU pada web_fetch**: Terdapat jeda mikro antara resolusi pra-pemeriksaan DNS SSRF guard dan eksekusi `fetch()` native Node.js (didokumentasikan secara transparan pada kode).

---

## 🤖 Context Handoff untuk AI Berikutnya

1. **Verifikasi Baseline**:
   - Jalankan `npm run typecheck` (harus 0 error).
   - Jalankan `npm test` (harus **342 passed**, 0 fail).
   - E2E test: `npm run test:e2e` (1 passed).
2. **Struktur Direktori Proyek**:
   - `src/core/`: Infrastruktur murni Node.js (loop, approval, executor, summarizer, undo, context, session, config, wizard, ui, skills).
   - `src/agent/`: Logika AI & interaksi agen (agent, llm, tools, roles, commands, filetools, webtools, processManager, subagent).
   - `src/tests/`: Rangkaian pengujian terisolasi Node.js native test runner.
3. **Konvensi Pengembangan**:
   - Zero runtime dependencies — dilarang menambah dependensi `dependencies` di `package.json`.
   - TypeScript strict mode, ESM format (`.js` extension pada relative imports).
   - Seluruh pesan interaksi CLI dan dokumentasi menggunakan Bahasa Indonesia.
   - Jangan membuat git tag baru sebelum diinstruksikan oleh pengguna.
