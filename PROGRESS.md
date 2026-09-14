# PROGRESS.md

> Dokumen status pengerjaan **Ruko — AI Coding Agent CLI**. Diperbarui di akhir setiap sesi kerja. Ini adalah sumber kebenaran (source of truth) dan checkpoint handoff untuk AI berikutnya.

---

## 📦 Riwayat Rilis & Status Fitur (Changelog)

### v1.6.0 (14 September 2026) — Anti-Flickering TUI, Status Bar Process Indicator, SSE Stream Hardening, & Robust Tool Loop Handling

#### Ditambahkan & Diperbarui
- **Penanganan Empty Content Model Setelah Eksekusi Tool (`src/agent/agent.ts`, `src/core/loop.ts`)**:
  * Mengatasi kasus di mana model mengembalikan respons kosong (`""` atau `null`) setelah pemanggilan tool (seperti Read/Glob) dengan `finish_reason: "stop"`.
  * Mengirimkan follow-up message internal (`role: 'user'`) secara otomatis untuk meminta model merangkum hasil eksekusi tool, alih-alih mencetak `"(no response)"` dan menghentikan giliran tanpa penjelasan.
  * Menambahkan filter di `runTurn` agar teks `(no response)` tidak bocor ke output konsol pengguna.
- **Stream Ingestion Hardening untuk SSE Chunks (`src/agent/llm.ts`)**:
  * Mengimplementasikan buffering berbasis baris lokal (`lines.pop()`) pada parser Server-Sent Events (SSE).
  * Menjamin potongan chunk parsial yang terbelah antar paket jaringan disimpan utuh sebelum dilakukan parsing JSON, mencegah teks terpotong di tengah streaming.
  * Menyimpan dan mengekspos atribut `lastFinishReason` pada seluruh provider (`OpenAiCompatibleProvider`, `AnthropicProvider`, `GeminiProvider`).
- **Normalisasi Skema Tool Result & Tool Call (`src/types.ts`, `src/agent/llm.ts`, `src/agent/agent.ts`)**:
  * Menambahkan properti `tool_call_id`, `name`, dan `tool_calls` pada tipe `ContextMessage`.
  * Pesan asisten yang memicu eksekusi tool menyertakan `tool_calls` dengan `id` standar (format `call_<tool>_<iter>_<idx>_<ts>`).
  * Pesan hasil tool dikirimkan kembali ke provider dengan `role: 'tool'`, `tool_call_id` yang valid, dan nama tool yang sesuai, mencegah *silent rejection* dari API server standar OpenAI/Anthropic/Gemini.
- **Anti-Flickering & Pembaruan In-Place TUI (`src/core/tui.ts`)**:
  * Menerapkan dirty-checking berbasis cache (`lastRenderedStatus`, `lastRenderedLine`, `lastRenderedMenuKey`, `lastRenderedModalPrompt`, dll.) untuk mencegah escape sequence ANSI (`\r`, `\x1b[2K`, dsb.) dieksekusi jika konten baris tidak berubah.
  * Mengoptimalkan frame spinner (Pac-Man Thinking) agar memperbarui baris ekor secara in-place tanpa menghapus dan menggambar ulang seluruh status bar serta prompt di bawahnya setiap interval 100ms.
  * Mengeliminasi frame tearing dan kedipan pada layar mobile / emulator terminal (Termux).
- **Indikator Proses Latar Belakang di Status Bar (`src/core/ui.ts`, `src/core/loop.ts`, `src/agent/tools.ts`)**:
  * Menghapus log status proses aktif yang mengotori area chat percakapan biasa pada `get_status`.
  * Mengintegrasikan ringkasan proses aktif langsung ke baris status bawah di antara nama model dan persentase konteks (contoh: `⚡ [glm-5.3-flash] | ⚙️ 2 proc (sleep 301, vite) | ctx 20%`).
  * Menyediakan pemformatan responsif untuk terminal layar sempit (>= 40 kolom) dengan bentuk ringkas `⚙️ 2 proc`.
- **Rangkaian Pengujian & Penambahan Unit Test**:
  * Menambahkan uji unit di `src/tests/ui.test.ts` (formatProcessSummary & responsive narrow status bar), `src/tests/tui.test.ts` (anti-flickering in-place tail updates), `src/tests/llm.test.ts` (SSE partial chunk stream hardening & finish_reason), dan `src/tests/agent.test.ts` (penanganan empty content model & validasi skema tool_call_id).
  * Total pengujian meningkat menjadi **365 passed** (100% lulus, 0 gagal).

---

### v1.5.0 (13 September 2026) — Proteksi Dua Lapis Berkas & Environment Variable Sensitif (Mitigasi Eksfiltrasi Kredensial & Prompt Injection)

#### Latar Belakang & Temuan Keamanan yang Divalidasi Manual
1. **Temuan 1 (Pembacaan Berkas Konfigurasi Sensitif)**:
   - Skenario teruji: Subagent (via tool `delegate`) diminta membaca `.ruko/config.json` melalui tool `read_file` berhasil dieksekusi dan membocorkan API key *plaintext*.
   - Akar masalah: Hak akses berkas OS (`chmod 600`) hanya melindungi berkas dari proses/pengguna *lain* di sistem operasi. Ketika Ruko berjalan dengan identitas pengguna pemilik, seluruh tool internal Ruko memiliki izin baca penuh terhadap `.ruko/config.json`. Pemeriksaan `assertInsideWorkspace()` mengizinkan akses karena `.ruko/` berada di dalam root direktori kerja.
2. **Temuan 2 (Ketidakefektifan Solusi "Pindah ke Environment Variable")**:
   - Skenario teruji: Kredensial dipindahkan ke environment variable shell induk (`export RUKO_API_KEY=sk-TEST-dummy && ruko`), lalu subagent diminta mengeksekusi `printenv`. Subagent berhasil menjalankan `printenv` via tool `exec` dan membocorkan nilai API key tersebut.
   - Akar masalah: Masalah fundamental bukan terletak pada *media penyimpanan* kredensial (file vs environment variable), melainkan *ketiadaan lapisan filter otorisasi dan kontrol akses data sensitif pada antarmuka tool agen*. Jika agen memproses konten eksternal yang disusupi *prompt injection* (misalnya dari halaman web via `web_fetch` atau repositori/PR tak tepercaya), agen dapat dimanipulasi untuk membaca konfigurasi atau men-dump environment.
3. **Cakupan Universal Agent & Subagent (`delegate`)**:
   - Subagent diisolasi dari konteks percakapan pengguna demi efisiensi token, namun **tidak boleh terisolasi dari kebijakan keamanan sistem**. Proteksi keamanan diterapkan di tingkat dispatcher tool tunggal (`runToolCall`), sehingga setiap subagent mewarisi kebijakan dan proteksi yang identik tanpa celah isolasi.

#### Ditambahkan & Diperbarui
- **Fungsi `isSensitivePath()` & `assertNotSensitivePath()` (`src/agent/tools.ts`)**:
  * Memblokir akses sebelum berkas dibaca pada daftar path sensitif (*case-insensitive*, mencakup variasi relative dan absolute path):
    - `.ruko/config.json`
    - `.ruko/undo/**` (snapshot cadangan yang berpotensi menyimpan konten sensitif lama)
    - `.env`, `.env.*`
    - `id_rsa`, `id_ed25519`, `*.pem`, `*.key`
  * Ditegakkan pada `readFileTool` (`src/agent/filetools.ts`), `resolveToolPath` (`src/agent/tools.ts`), serta penolakan langsung di case `read_file`.
- **Sanitasi Pencarian & Inspeksi Berkas (`src/agent/filetools.ts`)**:
  * `globTool`: Menyaring dan tidak pernah menampilkan path sensitif di hasil pencarian, serta menolak traversal jika target path adalah direktori/file sensitif.
  * `codeSearchTool`: Melewatkan (*skip*) pengindeksan isi berkas sensitif dari pencarian teks/regex, menjamin token tidak bocor lewat hasil pencarian kode.
- **Fungsi `isSensitiveEnvCommand()` (`src/agent/tools.ts`)**:
  * Mendeteksi dan menolak eksekusi shell yang men-dump environment secara luas: `printenv` (tanpa argumen atau dengan flag/grep/pipe), `env` (tanpa argumen atau dengan pipe/redirect), dan `export` polos.
  * Mendeteksi upaya penargetan variabel sensitif via regex: `/(_API_KEY|_TOKEN|_SECRET|_PASSWORD|API_KEY|TOKEN|SECRET|PASSWORD)/i` pada `printenv <NAMA>` serta ekspansi `$<NAMA>` atau `${<NAMA>}`.
  * **Anti-Overblocking**: Perintah `echo` variabel biasa non-sensitif (seperti `echo $PATH`, `echo $HOME`, `echo $USER`, `echo $NORMAL_VAR`) tetap diizinkan.
  * Menolak eksekusi dengan pesan terstandardisasi: `"exec ditolak: command berpotensi membocorkan environment variable sensitif. Kredensial tidak dapat diakses lewat tool ini."`
- **Fungsi `detectSensitiveFileAccessInExec()` (`src/agent/tools.ts`)**:
  * Mendeteksi dan memblokir perintah shell pada `exec` yang secara eksplisit menargetkan berkas sensitif (mis. `cat .ruko/config.json`, `cat .env`, `tail id_rsa`, redirect input `< .ruko/config.json`).
- **Integrasi Penuh ke Subagent & Propagasi Workspace (`src/agent/agent.ts`, `src/agent/subagent.ts`)**:
  * Menambahkan parameter `workspaceRoot` opsional pada kelas `Agent`, diteruskan ke seluruh pemanggilan `runToolCall`.
  * Runner `runSubagent` meneruskan `options.workspaceRoot` ke instans subagent sehingga kebijakan workspace dan keamanan jalur sensitif tersinkronisasi penuh.
- **Rangkaian Pengujian Komprehensif (`src/tests/sensitive_protection.test.ts`)**:
  * 11 unit test baru mencakup: verifikasi path sensitif, penolakan `read_file`, penyembunyian pada `glob`, pengabaian pada `code_search`, penolakan `cat .ruko/config.json`, penolakan `printenv` polos, penolakan `printenv RUKO_API_KEY`, lolosnya `echo $NORMAL_VAR`, reproduksi skenario eksfiltrasi subagent `delegate` (kedua skenario berhasil ditolak), dan uji regresi startup aplikasi Ruko (`loadConfig` internal tetap berfungsi tanpa gangguan).

#### Detail Arsitektural
- **Pemisahan Jalur Startup Internal vs Tool Agen**:
  * Pemuatan kredensial internal saat inisiasi CLI (`loadConfig` di `src/core/config.ts`) menggunakan API `node:fs` murni (`readFileSync`) dan tidak melalui tool agen. Dengan demikian, proteksi tool agen tidak mempengaruhi proses startup normal aplikasi.
- **Verifikasi & Test Suite**:
  * Total test: **353 passed** (100% lulus, 0 gagal), `npm run typecheck` bersih, `npm run test:e2e` lulus (1 passed).

---

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
   - Jalankan `npm test` (harus **365 passed**, 0 fail).
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
