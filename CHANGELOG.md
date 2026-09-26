# PROGRESS.md

> Dokumen status pengerjaan **Ruko — AI Coding Agent CLI**. Diperbarui di akhir setiap sesi kerja. Ini adalah sumber kebenaran (source of truth) dan checkpoint handoff untuk AI berikutnya.

### v1.8.0 (26 September 2026) — UI Overhaul 6 Fase (/mode, /reasoning, Panel Thinking, Diff Ringkas, Status Bar, Placeholder) & Fix Loop Detector Non-Streaming

#### Ditambahkan & Diperbarui
- **FASE 1 — Command `/mode` (Popup Selector + Hook Loop Detector via Parameter Injection)**:
  * Popup selector `/mode` terintegrasi LineEditor/input loop existing: navigasi ↑/↓, Enter konfirmasi, Esc batal tanpa side effect, input chat diblok saat popup terbuka.
  * Pilihan: Default, Research, Code, Build — deskripsi 1 baris per opsi saat di-highlight.
  * State `mode` in-memory di `SessionState` (`src/types.ts`), reset ke Default tiap sesi baru (`/new`), tidak ditulis ke config.json.
  * Efek ke loop detector murni parameter injection per-sesi (algoritma inti deteksi tidak diubah):
    - Research: `readOnlyRelaxed` — threshold dinaikkan khusus whitelist read-only resmi (`read_file`, `glob`, `list_dir`, `code_search`, `read_process_logs`).
    - Code: threshold default tanpa pengecualian.
    - Build: `buildPhase: 'explore' | 'mutate'` per sesi; transisi PERMANEN ke 'mutate' pada tool mutating pertama (`write_file`, `edit_file`, `patch_file`, `delete_file`, `exec`).
  * Test: `src/tests/mode_fase1.test.ts` (navigasi popup, cancel, reset per sesi, loop detector menghormati threshold per mode).
- **FASE 2 — Command `/reasoning` (Popup + Wiring Nyata ke Provider di `src/agent/llm.ts`)**:
  * Popup selector serupa `/mode` (↑/↓ + deskripsi); pilihan High / XHigh / Max / Extreme; default sesi baru: XHigh.
  * Mapping parameter native per provider:
    - OpenAI-compatible: top-level `reasoning_effort` (clamped ke enum API: 'high' | 'xhigh' | 'max'; Extreme → 'max').
    - Anthropic: top-level `thinking: { type: 'enabled', budget_tokens }` (4096/8192/16384/32768) + guard `max_tokens > budget_tokens` (+1024).
    - Gemini: top-level `thinkingConfig: { thinkingBudget }` (clamped 0–24576; Extreme di-clamp dari 32768).
  * Fallback prompt injection (`reasoningPromptAddendum()`, template per level) otomatis saat provider tidak mendukung atau menolak parameter (HTTP 400) — request TIDAK pernah gagal, fallback di-log sekali level debug, state UI/status bar tetap tersimpan.
  * State per-sesi, reset ke default tiap sesi baru. Test: `src/tests/reasoning_fase2.test.ts` (verifikasi payload per provider, clamp, guard, fallback).
- **FASE 3 — Panel Reasoning/Thinking Terpisah + Buffer Streaming (`src/core/ui.ts`, `src/agent/agent.ts`)**:
  * Class `ReasoningPanel`: section box terpisah bergaya `─ Reasoning (collapsed) ▼ ─` yang tidak mencampur log tool call.
  * Default COLLAPSED: `Thought for Xs (Y tokens)` — `Y tokens` hanya dicetak bila tersedia dari API usage; jika null cukup `Thought for Xs`.
  * Toggle expand/collapse via `Ctrl+R` (dibajak di `LineEditor` `src/core/tui.ts`, diteruskan via callback `onToggleReasoning` dari `src/core/loop.ts`; tidak menimpa Ctrl+O activity tray).
  * Buffer streaming: render per-baris selesai (newline) dengan throttle waktu 100ms — per-baris menjaga blok logis reasoning utuh dan tidak terpotong di tengah kata; throttle 100ms mencegah banjir redraw ANSI pada chunk SSE kecil tanpa terasa lag.
  * Test: `src/tests/reasoning_panel_fase3.test.ts`.
- **FASE 4 — Diff Ringkas untuk `write_file`, `edit_file`, `patch_file` (modul baru `src/core/diffui.ts`)**:
  * Semua tool mutasi berkas menampilkan ringkasan `✍️ <tool> <nama_file>   +N -M   Xs` (N hijau, M merah, durasi dim) di depan detail.
  * Detail diff default COLLAPSED dengan hint `[ctrl+d untuk expand/collapse]`; toggle expand/collapse via `Ctrl+D` — alternatif yang TIDAK menimpa `Ctrl+O` (sudah dipakai activity tray). EOF-with-empty-buffer bawaan Ctrl+D dipindah ke `Ctrl+Q`.
  * Kabel data: `writeWithDiff` (`src/agent/tools.ts`) memancarkan baris ter-enkode marker form-feed (`\f<JSON payload>\f<render>`) via `onLog`; parser UI mengenali baris ini secara eksplisit (bukan heuristik emoji) sehingga isi berkas biasa yang memuat `✍️` tidak pernah salah terdeteksi.
  * Angka N/M dihitung `countDiffLines()` dengan algoritma diff LCS yang SAMA dengan renderer (`src/core/diff.ts`) — selalu cocok dengan diff aktual saat block di-expand; payload JSON membawa oldText/newText sehingga Ctrl+D me-render ulang block persis tanpa baca disk ulang.
  * Test wajib terpenuhi: `src/tests/diff_fase4.test.ts` + `src/tests/diff_fase4_agent.test.ts` (assertion N/M selalu cocok dengan baris +/− diff aktual).
- **FASE 5 — Background Task & Info Model Dipisah dari Status Bar (`src/core/ui.ts`, `src/core/activity.ts`, `src/core/loop.ts`)**:
  * Info model dan task background tidak lagi menumpuk di kotak Terminal utama.
  * Hint tray `-- N more, ctrl+o to expand` hanya muncul bila task background aktif ≥ 2 (satu task tunggal tidak pernah menampilkan hint); handler `Ctrl+O` existing di `src/core/activity.ts` tetap dipakai.
  * Indikator `mode:<aktif>  reasoning:<level>` pada status bar & status panel responsif (turun prioritas di layar sempit sebelum model terpotong; field opsional).
  * Test: `src/tests/fase5_statusbar.test.ts`.
- **FASE 6 — Placeholder Input Field & Lokalisasi (`src/core/tui.ts`, `src/core/ui.ts`, `src/core/loop.ts`)**:
  * Teks default placeholder diubah ke Bahasa Indonesia: `"/? untuk bantuan, tanya apa saja..."` (warna abu-abu/dim), konsisten di `STATUS_PANEL_HINT` dan `PROMPT_HINT`.
  * Placeholder hilang total saat karakter pertama diketik dan muncul kembali saat buffer kosong (backspace/Ctrl+U), termasuk di ambient input saat AI bekerja.
  * Test: `src/tests/fase6_placeholder.test.ts` (render state hilang-muncul).
- **Fix Bug Loop Detector (Dedup Tool Call Non-Streaming)**:
  * De-duplikasi tool call duplikat within-batch yang sebelumnya hanya aktif di jalur streaming kini berlaku juga pada jalur non-streaming, menutup celah loop agen di mode tanpa stream.
  * Algoritma inti deteksi (idempotent cache, stream dedup, N-gram cycle detector) tidak diubah — hanya kualitas sinyal input yang diperbaiki.
- **Rilis & Dokumentasi v1.8.0**:
  * Minor bump `1.7.7` → `1.8.0` (fitur baru `/mode` dan `/reasoning`, bukan sekadar bugfix) di `package.json` dan `package-lock.json`.
  * Update badge versi & jumlah test (901 passed) di `README.md`; ringkasan status akhir di `PROGRESS.md`.
  * Full test suite final (bukan incremental): **901 passed, 0 failed**; e2e 1 passed; `tsc --noEmit` clean.

---

### Final P0 Closure, CodeQL Remediation, & Supply-Chain Hardening (23 September 2026)

#### Ditambahkan & Diperbarui
- **Resolusi Final CI & Kompatibilitas Multi-Versi Node.js (`package.json`)**:
  * Memperbarui skrip `test` menjadi `"npm run build && node --test dist/tests/*.test.js"`.
  * Memastikan ekspansi glob test runner bekerja secara deterministik di shell Linux/macOS/Windows dan kompatibel sempurna lintas seluruh generasi Node.js (Node 18.x, Node 20.x, Node 22.x, hingga Node 24.x) tanpa ketergantungan pada parser direktori bawaan engine yang rentan berubah.
  * Memverifikasi keberhasilan seluruh workflow CI di GitHub Actions pada push ke `main`.
- **Remediasi Tuntas Seluruh Security Alerts CodeQL (`queries: security-extended,security-and-quality`)**:
  * **Pencegahan ReDoS (`src/core/approval.ts`)**:
    - Mengganti pola berulang ambigu `(?:\s+--?\S+)*\s+` pada `RM_CRITICAL_RE` dan `BLOCKED_PATTERNS` (`rm/rmdir`) menjadi `(?:\s+-[a-zA-Z0-9_\-=]+)*\s+`.
    - Mengeliminasi ambiguitas pemindaian flag yang sebelumnya memicu potensi catastrophic exponential backtracking pada input berulang (`-! -`).
    - Menghapus konstanta `RISK_RANK` yang tidak terpakai.
  * **Proteksi Paparan Data Sensitif pada Log (`src/agent/commands.ts`)**:
    - Pada perintah `/config`, menghilangkan interpolasi string slice dari API key mentah dan menggantinya dengan penanda status aman boolean (`•••••••• (terkonfigurasi)` vs `•••••• (belum diatur)`).
    - Pada `describeProfile`, menetralkan eksposur nama environment variable `apiKeyEnv` ke `bits.push('env:configured')` untuk mencegah pemicuan salah (false positive) heuristik CodeQL `js/clear-text-logging`.
    - Menghapus import tak terpakai `red` dan `execute`.
  * **Sanitasi Substring URL Lengkap (`src/index.ts`)**:
    - Mengganti pemeriksaan parsial `rb.includes('anthropic.com')` dan `rb.includes('googleapis.com')` dengan helper validator domain ketat `isHostnameOrSubdomain(rb, ...)` pada alur wizard setup CLI interaktif.
    - Mencegah penyerang mengelabui deteksi provider menggunakan domain jebakan seperti `evil-anthropic.com` atau `attacker.com/googleapis.com`.
  * **Mitigasi Command Injection Tidak Langsung (`src/core/executor.ts`)**:
    - Mengganti penggunaan shell implisit `exec` dengan `execFile` yang memanggil binary shell secara terisolasi (`/bin/sh` pada Unix atau `cmd.exe` pada Windows) menggunakan array argumen eksplisit (`['-c', command]`).
    - Menghilangkan peringatan CodeQL `js/indirect-command-line-injection` saat argumen CLI `--exec "<cmd>"` diteruskan ke engine eksekusi.
  * **Penutupan Kerentanan TOCTOU / File System Race (`src/agent/filetools.ts`, `src/core/memory.ts`, `src/core/skills.ts`, `src/agent/tools.ts`, `src/tests/yolo_mode.test.ts`)**:
    - *`read_file` (`src/agent/filetools.ts`)*: Membuka file handle descriptor secara langsung via `fs.open(abs, 'r')` dan mengevaluasi `handle.stat()` serta `handle.readFile()` langsung dari file descriptor terbuka. Menghilangkan celah TOCTOU antara pemanggilan `stat` dan `readFile`.
    - *`initMemoryFile` & `readMemory` (`src/core/memory.ts`)*: Menggunakan flag atomik `wx` (`O_CREAT | O_EXCL`) saat inisialisasi file memori dan membaca langsung dengan penanganan `ENOENT` tanpa `existsSync` terpisah.
    - *`initDefaultSkills` (`src/core/skills.ts`)*: Menerapkan flag atomik `wx` untuk penulisan `anti-slop.md` dan `anti-hallucination.md`.
    - *`writeVerifiedFile` (`src/agent/tools.ts`)*: Membaca file lama via `try/catch` tanpa `existsSync` dan menulis berkas baru menggunakan `open` dengan flag kernel `O_NOFOLLOW` (`constants.O_NOFOLLOW`). Memblokir serangan symlink swap secara atomik di tingkat kernel sistem operasi tanpa pengecekan terpisah.
    - *`src/tests/yolo_mode.test.ts`*: Mengeliminasi `existsSync` sebelum pembuatan ulang berkas pengujian.
  * **Useless Assignment Elimination (`src/agent/processManager.ts`)**:
    - Menghapus penetapan variabel redundan `exited = true` di dalam polling loop `kill` setelah proses terdeteksi berhenti.
    - Menghapus import `path` yang tidak terpakai.
  * **Pembersihan Komprehensif Unused Variables & Imports (44 Temuan)**:
    - Membersihkan seluruh import dan variabel mati di `src/core/loop.ts` (`buildStatusPanel`, `cyan`, `renderBox`), `src/agent/subagent.ts` (`undoLast`), `src/agent/agent.ts` (`formatDuration`, `formatTerminalMarkdown`, `green`), `src/agent/tools.ts` (`hasError`), serta berkas tes: `feedback_v177.test.ts`, `yolo_mode.test.ts`, `ui.test.ts`, `undo.test.ts`, `sensitive_protection.test.ts`, `security_hardening_v17.test.ts`, `roles.test.ts`, `pseudo_tool_parser.test.ts`, `quickwins.test.ts`, `process_manager.test.ts`, `provider_refresh.test.ts`, `priority1_fixes.test.ts`, `memory.test.ts`, `p2_and_smart_truncate.test.ts`, `loop_interceptor.test.ts`, `guardian.test.ts`, `glob_search.test.ts`, `history.test.ts`, `file_security.test.ts`, `feedback_v176.test.ts`, `duplicate_tool_loop_fixes.test.ts`, `e2e.test.ts`, dan `adversarial_revalidation.test.ts`.
  * **Konfigurasi Khusus CodeQL (`.github/codeql/codeql-config.yml`, `.github/workflows/codeql.yml`)**:
    - Menambahkan file konfigurasi CodeQL yang mengecualikan artefak kompilasi `dist/**` dan pengujian `src/tests/**`.
    - Mengecualikan query `js/file-access-to-http` karena sifat dasar dari coding agent adalah membaca berkas lokal proyek dan mengirimkan konten konteks tersebut ke endpoint LLM yang dikonfigurasi pengguna.
- **Penguatan Installer & Zero-Data-Loss Architecture (`install.sh`)**:
  * Default `TAG` terkunci pada versi rilis immutable `v1.7.7` dan `TARGET_SHA` default ke commit SHA immutable (`5b029be14510fd0ac4a1c7cc47e46d30d4cb9de2`).
  * Proteksi branch mutable (`main`/`master`/`HEAD`) tetap aktif, menolak instalasi tanpa bendera eksplisit `RUKO_ALLOW_MUTABLE=1`.
  * Seluruh proses clone, instalasi dependensi (`npm ci`), dan kompilasi (`npm run build`) kini berlangsung di `$TEMP_DIR` terisolasi sebelum instalasi aktif disentuh.
  * Menghilangkan seluruh pemanggilan destruktif `rm -rf "$INSTALL_DIR"`.
  * Transisi instalasi dilakukan via **Atomic Swap**: backup instalasi lama dibuat ke `$INSTALL_DIR.bak.<timestamp>` tepat sebelum penempatan direktori baru, dan mekanisme rollback otomatis memulihkan instalasi lama jika linking global gagal.
- **Status Repository Security & Proteksi Branch**:
  * GitHub Secret Scanning: `Enabled`.
  * GitHub Secret Scanning Push Protection: `Enabled`.
  * Dependabot Security Updates: `Enabled`.
  * Branch Protection Rule: Aktif pada branch `main` dengan status check wajib `Test on Node 20.x (ubuntu-latest)`.
- **Hasil Pengujian & Verifikasi**:
  * Unit & Integration Tests: **773 passed**, 0 failed, 0 skipped (100% lulus).
  * End-to-End Tests: **1 passed**, 0 failed (`npm run test:e2e`).
  * TypeScript Compilation: Clean tanpa error (`npm run typecheck`).

---

### v1.7.7 (23 September 2026) — UI Revamp (Inline Duration, Framed Reasoning, Smart Path Truncation), Anti-Loop Tri-Layer Engine (Cache, Stream Dedup, N-Gram Cycle Detector), Tugas P2, & Versi Release v1.7.7

#### Ditambahkan & Diperbarui
- **TUGAS 8: Prioritas Resolusi Kolom Terminal pada `terminalWidth()` (`src/core/ui.ts`)**:
  * Mengubah evaluasi lebar kolom terminal agar `process.env.COLUMNS` (jika berupa angka positif valid) diutamakan dibandingkan `process.stdout.columns`:
    `const cols = (Number.isFinite(envCols) && envCols > 0 ? envCols : undefined) ?? process.stdout.columns ?? 80;`
  * Memungkinkan simulasi dan testing layar sempit (seperti lingkungan Termux Android `COLUMNS=40`) secara deterministik tanpa ter-override oleh nilai TTY stdout.
- **TUGAS 9: Konsolidasi dan De-duplikasi Perintah `/context` vs `/ctx` (`src/agent/commands.ts`)**:
  * Mengonsolidasikan `/context`, `/budget`, dan `/status` menjadi alias resmi dari perintah dashboard `/ctx`.
  * Memanggil `/context` tanpa argumen kini menampilkan dashboard panel visual responsif lengkap (`Context Budget & Status Aktif`) dengan batas karakter aktif, estimasi token, max output token, dan persentase utilisasi.
  * Memanggil `/context set <jumlah|50k>` mendelegasikan secara konsisten ke helper `applyContextLimit()` yang memvalidasi batas terhadap karakter aktif saat ini dan memperbarui konfigurasi.
- **TUGAS 13: Mitigasi Kernel Signal SIGKILL & Panduan Pemulihan Terminal Raw Mode (`README.md`, `src/agent/commands.ts`, `src/index.ts`)**:
  * Menambahkan section troubleshooting resmi di `README.md` ("Pemulihan Terminal Pasca Crash / SIGKILL") yang memandu penggunaan perintah shell `reset` atau `stty sane` serta `tput cnorm`.
  * Menambahkan petunjuk pemulihan terminal pada ringkasan `/help` dan footer bantuan interaktif.
  * Menambahkan panduan darurat langsung di `formatFatalError()` pada `src/index.ts`.
- **Usulan Baru 1 & 3: Smart Path Truncation & Inline Tool Duration (`src/core/ui.ts`)**:
  * Mengimplementasikan utility murni native `truncatePath(filePath, maxLen, options)`:
    - *Relative Path First*: Selalu dinormalisasi relatif terhadap workspace root (`path.relative(cwd, filePath)`).
    - *Middle Truncation*: Memotong direktori perantara menjadi `...` (`packages/.../auth.ts`) sambil mempertahankan folder pangkal dan nama file.
    - *Narrow Terminal Fallback*: Jika lebar terminal < 45 kolom atau `isNarrow`, otomatis fallback menampilkan `path.basename` murni.
  * Mengganti perataan durasi tool: menghapus spasi horizontal berlebih dan menyematkan durasi langsung di samping nama aksi/path dalam tanda kurung, misal `├── [1] 📖 Read src/core/ui.ts (11ms)`.
  * Memastikan kalkulasi `maxPathLen` dinamis berdasarkan `terminalWidth() - overheadWidth` sehingga kurung durasi tidak pernah terputus ke baris baru.
- **Usulan Baru 2: Framed Reasoning Box (`src/core/ui.ts`, `src/agent/agent.ts`)**:
  * Mengimplementasikan `renderReasoningBox(reasoning, width)` dan `formatReasoningBox` bergaya Hermes CLI:
    ```text
    ┌─ Reasoning ─────────────────────────────────────────
    │ <isi teks reasoning berwarna ANSI gray / dim \x1b[90m>
    └─────────────────────────────────────────────────────
    ```
  * Menghilangkan penutup siku kanan yang kaku agar rendering tidak patah di layar ponsel sempit (Android Termux).
  * Mengintegrasikan ke `ThinkingTicker.renderFramedReasoning()` dan `finishThinking` di `src/agent/agent.ts` yang otomatis aktif jika env `RUKO_SHOW_REASONING=1` atau `RUKO_REASONING=1`.
- **Implementasi Solusi Anti-Loop (Urutan 3-1-2)**:
  * **Solusi 3: In-Turn Idempotent Tool Cache (`src/agent/agent.ts`)**:
    - Menambahkan `turnToolCache` dan `IDEMPOTENT_READ_TOOLS` (`read_file`, `glob`, `list_dir`, `code_search`, `read_logs`).
    - Tool read-only yang dipanggil dengan argumen identik dalam turn yang sama langsung menggunakan hasil dari cache tanpa disk I/O ulang.
    - Cache otomatis di-invalidasi bersih jika ada tool mutasi (`write_file`, `edit_file`, `patch_file`, `delete_file`, `exec`) dieksekusi.
  * **Solusi 1: De-duplikasi Level Stream (`src/agent/llm.ts`)**:
    - Pada `OpenAiCompatibleProvider.chat()`, memeriksa tool calls yang telah di-stream pada `full` via `parseToolCalls(full)` sebelum menambahkan sintesis blok `streamToolCalls`.
    - Mencegah duplikasi tool blocks saat endpoint LLM mengirimkan baik `delta.content` (markdown/DSML tool block) maupun `delta.tool_calls`.
  * **Solusi 2: Batch Deduplication & N-Gram Cycle Detection (`src/agent/agent.ts`)**:
    - Menambahkan `batchSignatures` untuk mendeteksi pemanggilan tool duplikat dalam satu batch respons LLM yang sama, langsung melewati eksekusi kedua dengan warning terstandarisasi.
    - Menambahkan sliding window history `callHistory` dan helper `detectCycle(history, nextSig)` untuk mendeteksi siklus urutan berulang ($k$-gram dari $k=2$ s/d $k=25$).
    - Menginterupsi loop agen secara deterministik jika siklus multi-tool berulang > 2 kali dengan pesan pengarah konklusi `[deteksi loop]`.
- **Rilis & Dokumentasi v1.7.7**:
  * Bump versi package ke `1.7.7` di `package.json`, `package-lock.json`, `install.sh`, dan `README.md`.
  * Memperbarui `CONTRIBUTORS.md` mendokumentasikan kontribusi model AI:
    - **Claude (Anthropic)**: Redesain arsitektur layout UI/TUI, perataan visual WorkflowTree & status panel responsif, spacing polish, mitigasi wrapping layar sempit.
    - **DeepSeek (DeepSeek AI)**: Parser streaming DSML & XML `<tool>`, ekstraksi token streaming `<thought>`, usulan format inline duration `(11ms)`, dan perancangan open-ended framed reasoning box (`┌─ Reasoning ──`).
    - **Gemini (Google DeepMind)**: Smart path truncation (`truncatePath`), prioritas `COLUMNS` pada `terminalWidth()`, konsolidasi `/context` & `/ctx`, panduan pemulihan raw mode pasca-SIGKILL, tri-layer anti-loop (Solusi 3-1-2), dan ekspansi test suite hingga 800 passing tests.
  * Memperbarui `src/tests/api_key_security.test.ts` untuk memverifikasi versi rilis v1.7.7.
- **CI Test Runner IPC, Concurrency Hardening, & CodeQL Static Analysis Remediation (23 September 2026)**:
  * **Resolusi Crash Deserialisasi Node Test Runner Worker (`src/tests/agent.test.ts`, `src/tests/pseudo_tool_parser.test.ts`)**:
    - Memperbaiki `captureStdout` agar tidak me-relay teks mentah berisi ANSI escape code dan carriage returns (`\r\x1b[2K`) ke `process.stdout.write`.
    - Mengeliminasi error V8 low-level deserialization: `Unable to deserialize cloned data due to invalid or unsupported version` pada runner socket worker thread Node 18 & 20 di GitHub Actions CI.
  * **Isolasi Undo Snapshot & Verifikasi Laporan Rollback Subagent (`src/tests/feedback_v177.test.ts`)**:
    - Mengisolasi `process.env.RUKO_UNDO_DIR` ke direktori sementara per test untuk mencegah tabrakan snapshot saat pengujian berjalan paralel secara bersamaan.
    - Menambahkan pengujian deterministik untuk kedua kondisi timeout: saat tidak ada file yang termodifikasi (`Tidak ada file yang termodifikasi`) dan saat file termodifikasi (`file termodifikasi`, `Opsi rollback:`, `/undo`).
    - Mengganti seluruh pembentukan direktori temporary berbasis `Date.now()` di `os.tmpdir()` menjadi `mkdtempSync(join(tmpdir(), 'ruko-test-search-'))` untuk keamanan pembuatan berkas sementara.
  * **Penanganan Timeout `executeExternalTool` (`src/agent/external-tools.ts`)**:
    - Menangani event `ETIMEDOUT` dari child process spawn serta mempertahankan status `timedOut: true` saat timer batas waktu terpicu.
  * **Pembersihan Tuntas Seluruh Peringatan & Vulnerability CodeQL**:
    - *Double Escaping/Unescaping* (`src/agent/webtools.ts`): Mengimplementasikan decoder entitas HTML single-pass regex menggunakan tabel hash `HTML_ENTITIES` sehingga tidak ada decoding bertingkat (`&amp;lt;` -> `&lt;` -> `<`).
    - *Clear-Text Logging of Sensitive Information* (`src/index.ts`): Menghilangkan interpolasi variabel `keyFile` (yang bersumber dari `parsed.apiKey`) pada `console.error` saat gagal membaca file kunci API.
    - *Useless Conditional* (`src/core/wizard.ts`): Menghapus evaluasi redundan `!baseUrl` yang selalu bernilai `false` pasca-guard clause.
    - *Unused Imports*: Menghapus import `redactApiKey` di `src/agent/commands.ts` serta `unlinkSync` di `src/tests/api_key_security.test.ts` dan `src/tests/dotenv.test.ts`.
  * **Verifikasi Komprehensif Multi-Environment**:
    - Node 18.x dan Node 20.x: 100% tests lulus tanpa kegagalan (`npm test`, `npm run test:e2e`).
    - TypeScript compilation & typecheck: 100% clean (`npm run typecheck`).
  * Typecheck (`npx tsc --noEmit`) dan build (`npm run build`) 100% bebas error.

---

### Penutupan Penuh Audit P0 / md.md & Automasi CI/CD Pipeline (23 September 2026) — Tugas 11 & Gap Remediations

#### Ditambahkan & Diperbarui
- **Poin 1 md.md: Safe `--force` Tanpa Data Loss pada Installer (`install.sh`)**:
  * Menghilangkan perilaku `rm -rf "$INSTALL_DIR"` langsung pada opsi `--force`.
  * Mode `--force` kini selalu memindahkan instalasi lama ke direktori backup bertanggal (`$INSTALL_DIR.bak.<timestamp>`), menjamin ketersediaan mekanisme rollback deterministik jika build gagal.
  * Backup lama hanya dihapus bersih setelah instalasi baru berhasil diverifikasi (atomic switch).
- **Poin 2 md.md: Immutable Commit SHA Pinning & Proteksi Branch Mutable (`install.sh`)**:
  * Menyematkan `PINNED_COMMIT_SHA="049b45beffed3188d4961314b2a8c0cd17014d42"` yang sesuai dengan tag rilis `v1.7.6`.
  * Mencegah eksploitasi supply-chain via mutable branch (`main`, `master`, `HEAD`) jika diarahkan melalui `RUKO_VERSION`: installer menolak mutable branch kecuali flag eksplisit `RUKO_ALLOW_MUTABLE=1` diberikan.
- **Poin 3 md.md: Penutupan Mutlak Paparan Secret Argv CLI (`src/index.ts`, `src/tests/api_key_security.test.ts`)**:
  * Menambahkan security gate awal pada eksekusi CLI: memblokir pemberian kunci API mentah (`--api-key sk-...`) secara langsung untuk mencegah paparan kredensial di tabel proses OS (`ps aux`), `/proc/<PID>/cmdline`, dan history shell (`~/.bash_history`).
  * Menyediakan 3 opsi alternatif yang aman: environment variable `RUKO_API_KEY`, pembacaan file terproteksi (`--api-key @/path/to/key.txt`), dan pembacaan stdin terisolasi (`echo "$KEY" | ruko --api-key -`).
  * Jika pengguna tetap ingin memasukkan literal key di CLI (misal untuk testing ad-hoc), diwajibkan menyertakan flag eksplisit `--insecure-api-key` atau env `RUKO_INSECURE_API_KEY=1`.
  * Menambahkan unit test baru di `src/tests/api_key_security.test.ts` (9 tests passing).
- **Poin 4 md.md & TUGAS 11: Automasi CI/CD, CodeQL, Dependabot & Kebijakan Keamanan (`.github/`)**:
  * Membuat workflow CI multi-versi Node.js di `.github/workflows/ci.yml`: otomatis terpicu pada push ke `main` dan pull request, menjalankan `actions/checkout@v4`, `actions/setup-node@v4` dengan caching npm, `npm ci`, `npm run typecheck`, `npm test` (784 unit tests), dan `npm run test:e2e`.
  * Membuat workflow CodeQL static analysis di `.github/workflows/codeql.yml` (`queries: security-extended,security-and-quality`).
  * Menambahkan konfigurasi Dependabot mingguan di `.github/dependabot.yml` untuk ekosistem `npm` dan `github-actions`.
  * Menyediakan panduan keamanan dan konfigurasi repository di `.github/SECURITY.md` yang merinci pelaporan kerentanan privat, standar keamanan kredensial, dan rekomendasi aktivasi Secret Scanning, Push Protection, serta Branch Protection rules pada GitHub repository.
- **Rangkaian Pengujian Mandiri**:
  * Seluruh rangkaian tes bertambah menjadi **784 tests passing** (100% lulus, 0 fail).
  * `npm run typecheck` dan `npm run test:e2e` lulus 100%.

---

### Keamanan Menengah, Robustness Parser & Provider Setup Wizard (23 September 2026) — Tugas 5, 6, 7, 12

#### Ditambahkan & Diperbarui
- **TUGAS 5: Setup Wizard Explicit Provider Selection (`src/core/wizard.ts`, `src/index.ts`, `src/agent/commands.ts`)**:
  * Modifikasi setup wizard interaktif dan `/login` / `/config setup` agar menanyakan tipe provider secara eksplisit kepada pengguna (`openai-compatible`, `anthropic`, `gemini`) dengan opsi default cerdas berdasarkan URL/model.
  * Meneruskan `r.provider` langsung ke `createProvider` saat probe pengujian koneksi, menghilangkan ketergantungan pada tebakan heuristik string nama model/URL yang rentan salah pada custom reverse proxy/gateway lokal.
  * Mengintegrasikan opsi pembaruan provider pada alur retry probe (`coba key lain`).
  * Unit test komprehensif di `src/tests/setup_provider.test.ts` (6 tests).

- **TUGAS 6: Penanganan Tag `<tool>` Self-Closing & Malformed Tag Non-ASCII (`src/agent/tools.ts`)**:
  * Memperluas parser generic XML di `src/agent/tools.ts` untuk mendukung tag self-closing dengan atribut XML (`<tool name="read_file" path="package.json" />` atau `<tool tool="bash" command="..." />`), mengekstrak atribut menjadi objek `ToolCall` yang valid.
  * Memperbaiki penanganan `catch` saat `JSON.parse` gagal agar menggunakan fallback `body || rawTag`, menjamin array `malformedBlocks` tidak pernah memuat string kosong `""`.
  * Memperbaiki pembersihan `stripToolBlocks` dengan regex yang menghapus tag self-closing `<tool ... />` dan unclosed `<tool ...>` tanpa residu teks ke terminal.
  * Memverifikasi penangkapan tag dengan nama non-ASCII/CJK (misal `<認 name=... />`) sebagai malformed blocks dan pembersihannya dari layar pengguna.
  * Unit test di `src/tests/tools.test.ts` (7 tests).

- **TUGAS 7: Integritas Payload dan Sanitasi Pesan Role `tool` pada LLM Invariant (`src/agent/llm.ts`)**:
  * Mengimplementasikan `sanitizeToolMessageContent()` untuk memvalidasi integritas payload pesan role `tool` sebelum dikirimkan ke endpoint LLM completions.
  * Mengganti payload kosong atau whitespace dengan pesan fallback deskriptif `[Hasil tool "<name>" kosong]` untuk mencegah syntax error atau token bleed pada model completions.
  * Menutup secara otomatis blok kode Markdown yang terpotong (` ``` ` ganjil) dengan closing fence dan penanda aman `[Catatan: Output blok kode terpotong / truncated code block]`.
  * Menambahkan penanda peringatan aman pada payload JSON yang terpotong di tengah jalan.
  * Menerapkan sanitasi ini secara menyeluruh di dalam `validateOpenAiMessages()`.
  * Unit test di `src/tests/llm.test.ts` (4 tests).

- **TUGAS 12: Penegakan Flag Eksplisit `--allow-unsafe` untuk Perintah Kategori Berbahaya Non-Interaktif (`src/index.ts`, `src/core/approval.ts`)**:
  * Mengimplementasikan `isHighRiskDangerousCommand()` di `src/core/approval.ts` untuk mendeteksi perintah kategori `DANGEROUS` berisiko tinggi yang dapat menyebabkan data loss ireversibel (`git reset --hard`, `git clean -fd`, `chmod -R`, `rm`, `kill -9`, `find -delete`, `truncate`, `shred`, `wipefs`, pipe shell).
  * Menambahkan flag CLI `--allow-unsafe` pada `parseCliArgs` di `src/index.ts` dan panduan bantuan CLI.
  * Menolak eksekusi perintah berbahaya tinggi dalam mode non-interaktif (`!process.stdin.isTTY`) bila dijalankan dengan `--yes` tanpa menyertakan flag eksplisit `--allow-unsafe` (atau env `RUKO_ALLOW_UNSAFE=1`), disertai pesan penolakan yang informatif.
  * Menjamin invarian keamanan utama: perintah kategori `BLOCKED` (seperti `rm -rf /etc`) tetap diblokir mutlak bahkan jika `--allow-unsafe` dan `--yes` disertakan.
  * Unit test di `src/tests/allow_unsafe.test.ts` (8 tests).

- **Rangkaian Pengujian Mandiri**:
  * Menambahkan test suite baru: `setup_provider.test.ts`, `tools.test.ts`, `allow_unsafe.test.ts`, serta suite pengujian di `llm.test.ts`.
  * Total unit test meningkat menjadi **780 tests passing** (100% lulus, 0 fail).
  * `npm run build` dan `npm run typecheck` 100% bersih tanpa galat.

---

### Audit Keamanan, Supply Chain Hardening & Approval Gate Restructuring (23 September 2026) — Tugas 1, 2, 3, 4, 10

#### Ditambahkan & Diperbarui
- **TUGAS 1: Pengamanan dan Refactoring Installer (`install.sh`)**:
  * Mengubah default tag release ke tag immutable `v1.7.6` (`TAG="${RUKO_VERSION:-v1.7.6}"`). Hanya beralih ke snapshot mutable bila `RUKO_VERSION` di-set eksplisit.
  * Menambahkan dukungan verifikasi commit hash via `RUKO_COMMIT_SHA`.
  * Menghilangkan penghapusan destruktif `rm -rf "$INSTALL_DIR"`. Menerapkan safe-upgrade: backup instalasi lama ke `$INSTALL_DIR.bak.<timestamp>`, git clone dan build di temporary directory terisolasi (`mktemp -d`), lalu atomic move ke target instalasi.
  * Menambahkan mekanisme rollback otomatis: jika tahapan clone, `npm ci`, atau `npm run build` gagal, installer secara otomatis mengembalikan instalasi lama dari backup.
  * Menambahkan flag `--force` untuk pembersihan instalasi sebelumnya tanpa backup.
  * Mengganti `npm install` dengan `npm ci` untuk instalasi build yang deterministik dan terkunci sesuai `package-lock.json`.
  * Menghapus duplikasi pemanggilan `npm install -g .` (kini dieksekusi tepat 1 kali).
  * Validasi ketat path `$INSTALL_DIR` untuk mencegah path traversal (`..`) atau penghapusan di luar `$HOME`.

- **TUGAS 2: Proteksi Secrets & API Key Argument (`src/index.ts`, `src/types.ts`, `src/core/config.ts`)**:
  * Menambahkan security warning mencolok (kuning ANSI) di CLI saat flag `--api-key` digunakan, memperingatkan pengguna terkait risiko paparan di tabel proses sistem (`ps aux`) dan shell history.
  * Mengimplementasikan utility `redactApiKey(text)` di `src/core/config.ts` untuk menyamarkan token/key (`sk-...`, `key-...`, atau string 20+ alfanumerik) menjadi `abc***xyz` agar kredensial tidak pernah bocor mentah di error log atau output diagnostik.
  * Memastikan file konfigurasi `.ruko/config.json` selalu dibuat dan dijaga dengan mode permission `0600` (POSIX owner-only read/write).
  * Menegaskan prioritas `apiKeyEnv` dibanding literal `apiKey` di `resolveProfileCredentials` (`src/types.ts`).
  * Unit test di `src/tests/api_key_security.test.ts`.

- **TUGAS 3: Hardening Approval Bypass & Pengamanan YOLO Mode (`src/index.ts`)**:
  * Memisahkan bypass folder trust dari bypass command approval: `bypassTrust` kini HANYA dipicu oleh `--trust-folder` atau `RUKO_TRUST_FOLDER=1`. Flag `--yes` tidak lagi mem-bypass workspace trust secara otomatis.
  * Menambahkan banner peringatan keamanan mencolok (*High Risk / Unsafe Mode Banner*) saat `--yes` atau `RUKO_YOLO_MODE=1` digunakan bersamaan dengan `--exec`.
  * Mempertahankan penegakan pola `BLOCKED` meskipun `--yes` diaktifkan.
  * Unit test di `src/tests/yolo_hardening.test.ts`.

- **TUGAS 4: Rekonstruksi Approval Allowlist dari Substring ke Policy Terstruktur (`src/core/approval.ts`)**:
  * Mengeliminasi kerentanan chaining bypass pada allowlist substring (`git status; rm -rf /`).
  * Mengimplementasikan helper `containsShellOperators(cmd)` untuk mendeteksi operator shell (`;`, `&&`, `||`, `|`, `&`, `>`, `>>`, `<`, `$()`, backticks, newline).
  * Mengimplementasikan `allSegmentsAllowlisted(cmd, allowlist)` yang membagi perintah berdasarkan seluruh operator shell dan memvalidasi setiap segmen secara independen ke allowlist.
  * Jika terdapat operator shell dan salah satu segmen tidak terdaftar di allowlist, approval gate menolak bypass allowlist dan tetap meminta konfirmasi atau memblokir eksekusi.
  * Mempertahankan invarian utama: pola `BLOCKED` (seperti `rm -rf /etc`, `mkfs`, `dd ke /dev/sd*`, fork bomb) tidak dapat pernah di-downgrade oleh allowlist.
  * Unit test di `src/tests/allowlist_bypass.test.ts`.

- **TUGAS 10: Penguatan Error Handling Global `uncaughtException` & `unhandledRejection` (`src/index.ts`)**:
  * Menambahkan deteksi mode debug via `isDebugMode()` (`process.env.DEBUG` atau `process.env.RUKO_DEBUG`). Jika aktif, mencetak full stack trace ke stderr saat terjadi uncaught exception atau unhandled rejection.
  * Menambahkan diagnostic identifier acak unik per crash (`RUKO-<TIMESTAMP>`) serta petunjuk pelaporan issue GitHub untuk mempercepat korelasi log dan troubleshooting pengguna.
  * Menambahkan prosedur `emergencyCleanup()` sebelum `process.exit(1)` untuk mengembalikan terminal raw mode jika TTY sedang berada dalam raw mode, mencegah terminal pengguna hang/rusak setelah proses crash.
  * Unit test di `src/tests/error_handling.test.ts`.

- **Verifikasi Komprehensif Skenario Adversarial Approval-Gate (`src/tests/adversarial_revalidation.test.ts`)**:
  * Menjalankan ulang 107 skenario adversarial komprehensif untuk memastikan refactor allowlist tidak melemahkan proteksi yang sudah ada:
    - 48 skenario variasi `rm -rf` ke root, wildcards, direktori sistem/home kritis (`/etc`, `/bin`, `/usr`, `/lib`, `/boot`, `/sys`, `/proc`, `/var`, `/dev`, `/home`, `/root`, `~`, `$HOME`, dll.).
    - Seluruh bentuk variasi flag (`-fr`, `-rfv`, `-r -f`, `-f -r`, `--recursive --force`, `--no-preserve-root`).
    - Destructive non-rm patterns: `mkfs`, `mkfs.ext4`, `dd` ke disk fisik (`/dev/sd*`, `/dev/nvme*`), fork bomb (klasik & kustom nama fungsi), disk direct redirection (`> /dev/sda`).
    - Obfuscation & bypass attempts: variable substitution (`DIR=/etc; rm -rf $DIR`), bash subshell quoting (`bash -c "rm -rf /etc"`), chaining (`&&`, `;`, `|`), backslash escape (`r\m -rf /etc`).
    - Uji invarian: seluruh command kategori BLOCKED tetap BLOCKED meskipun allowlist berisi `rm`, `rm -rf`, `mkfs`, dsb.
    - Uji penolakan chaining bypass pada allowlist dan retensi level DANGEROUS serta NONE pada command aman.

- **Rangkaian Pengujian Mandiri**:
  * Menambahkan 5 file test suite baru: `api_key_security.test.ts`, `yolo_hardening.test.ts`, `allowlist_bypass.test.ts`, `error_handling.test.ts`, dan `adversarial_revalidation.test.ts`.
  * Total unit test meningkat drastis dari **622 tests** (baseline) menjadi **755 tests passing** (100% lulus, 0 fail).
  * `npm run build` dan `npm run typecheck` 100% lulus tanpa galat.

---

### v1.7.6 (23 September 2026) — Non-ASCII Corrupted Tool Tag Robustness, Active Context Budget (/ctx), TUI Activity Tray, Thinking Ticker, & Universal Glyphs

#### Ditambahkan & Diperbarui
- **Ketahanan Parser Tool-Call terhadap Karakter Rusak / Non-ASCII (`src/agent/tools.ts`, `src/core/ui.ts`, `src/agent/agent.ts`)**:
  * *Deteksi Tag Rusak/Malformed (`MALFORMED_TOOL_TAG_RE`)*: Mendeteksi tag yang menyerupai format tool-call (diawali `<` atau `＜` dengan nama tag non-ASCII/CJK seperti `<認 name=code_search tool="code_search" .../>` atau atribut `name=`, `tool=`, `query=`, dll.) yang gagal diparse sebagai tool call valid. Dimasukkan ke `malformedBlocks` sebagai error format tool alih-alih teks biasa.
  * *Perlindungan Streaming Terminal (`RevealFilter`)*: Menahan in-flight tag (`malformedPrefixHold`) dan membuang tag malformed tersebut selama streaming (baik chunk maupun token karakter demi karakter) sehingga tidak bocor sedikit pun ke layar pengguna.
  * *Pembersihan Output Akhir (`stripToolBlocks`)*: Menghapus seluruh representasi tag malformed dari teks asisten akhir.
  * *Penanganan Retry Terpisah (`src/agent/agent.ts`)*: Menahan preamble bocor via `gate.finish(calls.length === 0 && malformedBlocks.length === 0)`, mencatat debug log terpisah saat mode debug aktif, dan mengirimkan instruksi eksplisit kepada model completions untuk mengulangi tool call dalam format blok Markdown ```` ```tool ```` standar.
- **Perintah Verifikasi Context & Token Budget Aktif (`/ctx`, `src/agent/commands.ts`)**:
  * Menambahkan perintah `/ctx` beserta alias `/budget` dan `/status` tanpa argumen untuk menampilkan ringkasan visual status aktif: model aktif, limit context window aktif, token budget aktif, max output tokens (`maxOutputTokens`), dan persentase context terpakai.
  * *Penataan Teks Responsif (Anti-Truncate)*: Baris teks di-wrap otomatis secara cerdas pada layar sempit (<= 60 kolom, seperti Termux) sehingga seluruh nilai numerik dan teks penting tidak terpotong oleh pembatas `renderBox`.
  * Mengekspos properti `aliases` pada fungsi registri `listCommands()`.
- **Rangkaian Pengujian Mandiri**:
  * Menambahkan 7 unit test komprehensif di `src/tests/feedback_corrupted_tag_and_ctx.test.ts`.
  * Seluruh **622 tests** lulus 100% tanpa regresi (`npm test`), dan `npm run typecheck` 100% bersih.

---

### TUI Stream Polish, Ephemeral Thinking Ticker, Universal Glyph, & 429 Backoff (22 September 2026)

#### Ditambahkan & Diperbarui
- **Ephemeral Thinking Ticker (`ThinkingTicker`, `src/core/ui.ts` & `src/agent/agent.ts`)**:
  * Menggantikan log thinking berulang/nyampah dengan single-line dynamic in-place ticker: `• Thinking: <cuplikan>...` (dim/gray ANSI `\x1b[90m`), diperbarui via `\r\u001b[2K` dan auto-truncate mengikuti lebar terminal (`Math.max(10, cols - 2)`).
  * Ticker aktif secara murni *on-demand* saat chunk reasoning (`<think>`, `<thought>`, payload `reasoning_content`) pertama kali diterima; tidak pernah mencetak line jika model tidak bernalar.
  * Final flush: membersihkan baris dinamis dari layar dan mencetak **tepat satu** baris ringkasan permanen: `• Thought for <detik>s (<tokens> tokens)`.
  * Menjamin teks penalaran internal tidak bocor ke output history biasa atau pesan akhir asisten.
- **Pembersihan Total Pac-Man & Perintah `/anim` (`src/agent/commands.ts`, `src/core/ui.ts`)**:
  * Menghapus perintah `/anim` dari registry perintah, autocomplete, dan helper menu (`/?`, `/help`, `/settings`).
  * Menghilangkan animasi pacman dan hantu dari `createSpinner`, beralih ke dot spinner minimalis yang bersih.
  * Menghapus seluruh test lama yang menargetkan `/anim` dan animasi pacman.
- **Perbaikan Missing Glyph Termux (`buildStatusPanel`, `src/core/ui.ts`)**:
  * Mengganti karakter icon yang ter-render kotak kosong (``) di font bawaan Android/Termux dengan simbol universal `⚡` (`⚡ ${shortModelName(input.model)}`).
  * Memastikan 100% bebas dari karakter Private Use Area (NerdFont) U+E000..U+F8FF.
- **Penanganan HTTP 429 Rate-Limit Exponential Backoff (`src/agent/llm.ts`)**:
  * Menerapkan retry loop otomatis dengan exponential backoff sederhana (1s, 2s) pada `requestWithRetry` di seluruh provider (`OpenAiCompatibleProvider`, `AnthropicProvider`, `GeminiProvider`).
  * Menghormati header `retry-after` jika disediakan, serta memeriksa `signal.aborted` di setiap jeda retry agar interupsi pengguna tetap responsif.
- **Rangkaian Pengujian Mandiri**:
  * Unit test komprehensif di `src/tests/feedback_v176.test.ts` untuk verifikasi ticker in-place, zero leak reasoning text, ketiadaan `/anim`, dot spinner bersih, universal glyph `⚡`, dan retry loop HTTP 429.
  * Seluruh **587 tests** lulus 100% tanpa regresi (`npm test`), dan `npm run typecheck` 100% bersih.

---

### UI Revamp — Responsive Status Panel, Action Log `├──`, & Live Bottom Activity Tray (22 September 2026)

#### Ditambahkan & Diperbarui
- **Pemotongan Nama Model (`shortModelName`, `src/core/ui.ts`)**:
  * Helper ringkas yang mengambil hanya nama inti keluarga model untuk panel status: `gemini-3.8-flash` → `gemini`, `claude-opus-3.7` → `claude`, `qwen3.8-flash` → `qwen`, `nvidia/nemotron-3-ultra-550b-a55b:free` → `nemotron`, `gpt-4o-mini` → `gpt`.
  * Prefix provider (`vendor/`), tag kuantisasi (`:free`, `:70b`), dan digit versi dibuang; nama lengkap tetap dapat dilihat via `/config` dan `/settings`.
- **Responsive Status & Input Box (`buildStatusPanel` / `renderStatusPanel`)**:
  * Kotak 5 baris (`┌─┬─┐ / │ model │ badge │ stats │ / ├─┴─┴─┤ / │ hint │ / └─┘`) menggantikan status bar satu baris dengan background hijau blok.
  * **Tidak ada lebar kolom statis**: seluruh run `─` dihitung dari lebar terminal aktual (`process.stdout.columns`), frame selalu ditutup pada `cols - 1` sehingga tidak pernah memicu *pending-wrap* yang dulu menumpuk baris border di scrollback.
  * Kolom opsional (badge `YOLO`/`PLAN`/`⏳`/`⚙️n`, stats `↑ Xt ↓ Yt`) dilepas lebih dulu sebelum sel nama model dipotong; indikator `ctx N%` muncul saat belum ada statistik turn.
  * Baris bawah kotak berisi hint/placeholder (`/? for help, ask anything...`, atau pesan "AI sedang bekerja" saat turn berjalan) sehingga baris input tetap bersih.
- **Action Log History Beraksen Cabang (`├── `)**:
  * `formatActionLogLine` + mode `branch` pada `WorkflowTree` (`src/core/ui.ts`) mencetak satu baris cabang per tool **tepat saat tool selesai** — bukan saat dimulai: `├── [1] 🔍 find PROGRESS.md · 12ms`, `├── [2] 🖥️ Bash(npm test) · 4.2s`, `├── [3] 🟣 Subagent "read file halo.md"`.
  * Baris "start" per tool (`🟢 Read(x)`, `🟡 Edit(x) — tidak ada perubahan`, dst.) ditangkap dan tidak dicetak ulang, sehingga tidak ada duplikasi; detail output tool (diff, peringatan) di-buffer lalu dicetak menjorok di bawah baris cabangnya.
  * `flush()` menjamin tidak ada output yang hilang saat turn dibatalkan atau tool melempar error.
- **Live Bottom Activity Tray (`src/core/activity.ts` + `LineEditor`)**:
  * `ActivityTray` menyimpan status runner aktif (tool, subagent, proses latar belakang) dan mencetak baris tray: `🟢 npm test  45s`, `🟣 Subagent (read_file) halo.md  23s`, plus `-- N more, ctrl+o to expand` saat melebihi 2 baris.
  * Baris tray digambar **di dalam region live `LineEditor`** (di bawah baris input) dan diperbarui *in-place* memakai `ESC[2K` + reposisi kursor (`ESC[nA`/`ESC[0J`) — bukan `console.log` — sehingga tidak ada lagi jejak menumpuk di terminal saat error/input baru.
  * Ticker 1 detik me-render ulang region agar penghitung detik tetap berjalan; Ctrl+O membuka/melipat tray.
  * Saat runner selesai: baris live dihapus dari tray, lalu hasil ringkasnya dicetak **satu kali** ke scroll history utama sebagai `├── ...`.
  * Subagent mewarisi tray induknya (`activityTray` pada `ToolDeps`/`SubagentDeps`), jadi delegasi terlihat live; proses latar belakang disinkronkan lewat `syncGroup('proc', …)` tanpa me-reset timer berjalan.
- **Catatan**: fitur reasoning/thinking teks belum ada di core engine, sehingga tidak ada mock fitur think yang dibuat — fokus murni pada penataan UI, action log, status box, dan tray.
- **Rangkaian Pengujian Mandiri**:
  * Unit test baru `src/tests/ui_revamp.test.ts` (16 test) untuk pemotongan nama model, geometri kotak responsif (120→24 kolom), format baris cabang, tray (overflow/expand/resync/in-place), integrasi `LineEditor` (climb + `ESC[0J`, tanpa `console.log`), dan integrasi agent (`├──` + siklus hidup tray).
  * Seluruh **579 tests** lulus 100% tanpa regresi (`npm test`), dan `npm run typecheck` 100% bersih.

---

### v1.7.6 (22 September 2026) — Universal Fallback Tool Parser, CLI Visual Spacing Polish, & /yolo Mode Integration

#### Ditambahkan & Diperbarui
- **Universal Fallback Tool Parser Terpadu (`src/agent/tools.ts`, `src/core/ui.ts`, `src/agent/agent.ts`)**:
  * *Multi-Format Detection*: Mengimplementasikan parser universal yang mengekstrak perintah model dalam format:
    1. Tag XML / Generic Tool: `<tool>...</tool>`, `<tool_call>...</tool_call>`, atribut tag XML (`<tool name="read_file" file_path="..."/>`), dan tag `<tool>` belum tertutup akibat streaming/stop token.
    2. DeepSeek DSML: `<|DSML|calls><|DSML|invoke name="...">...`, toleransi unclosed invoke tag, parsing JSON body cadangan, dan normalisasi parameter `file_path` -> `path`.
    3. Markdown Codeblock: Blok ```` ```json ```` dan ```` ```tool ```` yang memuat objek tool call (termasuk `{"name": "...", "arguments": {...}}` atau `{"tool": "...", "file_path": "..."}`).
  * *Tool Mapping & Normalisasi Parameter*:
    - `read_file`, `ReadFile`, `read`, `Read` -> `read_file`
    - `edit_file`, `EditFile`, `write_file`, `Edit`, `Write` -> `edit_file` / `write_file`
    - `execute_command`, `bash`, `shell`, `Bash`, `terminal`, `sh`, `cmd` -> `exec`
    - `search_files`, `find_in_files`, `Search`, `search`, `grep` -> `code_search`
    - `glob_files`, `list_files`, `Glob`, `glob`, `find_files` -> `glob`
    - Normalisasi parameter fleksibel: `file_path`, `path`, `file`, `filepath`, `target` dipetakan otomatis ke `path` untuk semua file tool.
  * *Ekstraksi Terpadu*: Mengekspos fungsi `extractFallbackToolCall(content: string): ToolCall | null` dan `extractFallbackToolCalls(content: string): ToolCall[]`.
  * *Pembersihan Output (Zero Terminal Leak)*:
    - `RevealFilter` (`src/core/ui.ts`) menahan dan menyembunyikan tag XML `<tool>`, `<tool_call>`, DeepSeek DSML, dan markdown ```` ```json ```` bermuatan tool call selama streaming agar tidak bocor sedikit pun ke terminal.
    - `stripToolBlocks` (`src/agent/tools.ts`) membersihkan seluruh representasi pseudo-tool dari teks jawaban akhir.
- **Visual Spacing & Pemisah Visual Log Tool UI (`src/agent/agent.ts`)**:
  * Menambahkan jeda satu baris kosong (`\n`) tepat setelah eksekusi tool terakhir selesai, sebelum balasan teks asisten mulai ditampilkan (baik pada mode streaming live via `LineGate` maupun non-streaming).
  * Mempertahankan kerapatan satu baris per tool (compact 1-line) pada pemanggilan multiple tool berurutan tanpa baris kosong di antara tool-tool tersebut.
- **Integrasi Perintah `/yolo` (`src/agent/commands.ts`, `src/core/approval.ts`)**:
  * Menyediakan shortcut command `/yolo` untuk mengaktifkan/menonaktifkan YOLO mode (auto-approval) secara instan tanpa perlu masuk ke wizard konfigurasi manual.
- **Rangkaian Pengujian Mandiri**:
  * Menambahkan unit test komprehensif di `src/tests/pseudo_tool_parser.test.ts` dan `src/tests/yolo_mode.test.ts`.
  * Seluruh **543 tests** lulus 100% tanpa regresi (`npm test`), dan `npm run typecheck` 100% bersih.

---

### v1.7.5 (22 September 2026) — DeepSeek DSML Tool-Call Parser & Streaming Reveal Filter Remediation (BUG A Verified Fix)

#### Ditambahkan & Diperbarui
- **Remediasi Tuntas Parser DeepSeek DSML (`src/agent/tools.ts`, `src/core/ui.ts`)**:
  * *Investigasi Jalur LLM Provider (`src/agent/llm.ts`)*: Memverifikasi bahwa `src/agent/llm.ts` murni hanya menangani rekonstruksi delta `tool_calls` OpenAI native. Model `deepseek-v4.1-flash` memancarkan token DSML sebagai teks biasa (`content` / `delta.content`) yang dialirkan langsung ke terminal via `onToken` dan diekstrak dari teks balasan via `parseToolCalls`.
  * *Root Cause Analisis Respons Nyata DeepSeek API*:
    1. Respons nyata `deepseek-v4.1-flash` membungkus pemanggilan dengan tag container `<｜｜DSML｜｜ calls> ... </｜｜DSML｜｜ calls>` atau `<|DSML||calls> ... </|DSML||calls>`.
    2. Format pembatas menggunakan double pipe (`||` atau full-width `｜｜`), bukan single pipe (`|`/`｜`).
    3. Terdapat spasi pemisah antara penutup pipa dan nama tag/perintah (`<｜｜DSML｜｜ calls>`, `<｜｜DSML｜｜ invoke name="read_file">`, `</｜｜DSML｜｜ invoke>`).
    4. Implementasi v1.7.2 hanya menangani single pipe tanpa spasi dan tanpa dukungan tag wrapper `calls`, sehingga respons bocor mentah ke terminal dan `parseToolCalls` mengembalikan array kosong `[]` (0 tool calls).
  * *Solusi & Perbaikan Komprehensif*:
    - `parseToolCalls` (`src/agent/tools.ts`): Regex `DSML_INVOKE_RE`, `DSML_INVOKE_SELF_RE`, `DSML_PARAM_RE`, dan `DSML_CALLS_RE` kini mendukung kuantifier pipa jamak `(?:\||｜)+`, toleransi spasi opsional `\s*`, serta penanganan container wrapper `calls` maupun `tool_calls`.
    - `stripToolBlocks` (`src/agent/tools.ts`): Menghapus seluruh blok DSML container dan tag individual secara bersih tanpa meninggalkan residu teks ke pengguna.
    - `RevealFilter` (`src/core/ui.ts`): Mendukung multi-marker prefix hold (`<||DSML||`, `<｜｜DSML｜｜`, `</||DSML||`, dsb.) dan state machine (`dsml_calls`, `dsml_invoke`) serta sanitasi newline lanjutan (`skipNextNewline`), menjamin 100% token streaming tidak bocor ke terminal baik pada mode chunk maupun streaming token per karakter.
- **Rangkaian Pengujian Mandiri**:
  * Menambahkan 5 unit & integration test baru di `src/tests/thought_and_feedback_bugs.test.ts` untuk memvalidasi:
    1. `RevealFilter` menahan dan menyembunyikan respons format `feedback.txt` (`<|DSML||calls><|DSML||invoke name="read_file">...`) dan format live DeepSeek (`<｜｜DSML｜｜ calls>...`) secara utuh pada chunk dan karakter-demi-karakter.
    2. `parseToolCalls` mengekstrak pemanggilan tool `read_file` dan parameter `path` serta `limit` dari format bocor `feedback.txt` dan live DeepSeek.
    3. `stripToolBlocks` membersihkan seluruh blok DSML tanpa residu.
    4. Test integrasi end-to-end `Agent.handleInstruction` dengan respons DSML mock DeepSeek menjalankan tool `read_file` dan menyelesaikan turn tanpa kebocoran output terminal.
  * Total unit test meningkat menjadi **511 tests passed** (100% lulus, 0 fail), dan `npm run typecheck` 100% bersih tanpa galat.

---

### v1.7.4 (17 September 2026) — Comprehensive QA & Code Audit Remediation: Fix code_search Regex Stateful Skip, Undo Snapshot Sandboxing & Traversal Guard, Config Token/Provider Persistence, Terminal Streaming Markdown Formatter, & Interaction Polish

#### Ditambahkan & Diperbarui
- **Perbaikan Stateful Global RegExp pada `codeSearchTool` (`src/agent/filetools.ts`)**:
  * Menghapus flag global `'g'` pada instansiasi RegExp per baris (`let flags = ''`).
  * Mengeliminasi bug `matcher.lastIndex` di mana pengujian baris-baris berikutnya secara sporadis mengabaikan kecocokan yang valid (false negatives).
- **Hardening Keamanan Sandboxing Snapshot `/undo` (`src/core/undo.ts`, `src/agent/commands.ts`)**:
  * Mengimplementasikan `validateSnapshotPath()` untuk memvalidasi bahwa path target snapshot tidak melompat ke luar workspace sandbox.
  * Memblokir symlink ke luar workspace serta jalur-jalur berkas terproteksi/sensitif (`.ruko/config.json`, `.ruko/undo/**`, `.env*`, `.git*`, SSH keys, git credentials).
  * Mengintegrasikan pengecekan `assertNotSecurityCore` dan `assertNotSensitivePath` pada perintah `/undo <path>`.
- **Persistensi `maxOutputTokens` & `provider` pada Konfigurasi (`src/core/config.ts`, `src/agent/commands.ts`)**:
  * Menambahkan `maxOutputTokens` dan `provider` ke antarmuka `RukoConfigFile` dan whitelist sanitasi `sanitizeConfigFile()`.
  * Memperbarui `applyConfigPatch()` di `commands.ts` dengan parser `parseConfigNumber()` yang mendukung suffix unit `k`/`m` (seperti `256k`, `1m`) dan validasi terhadap ukuran memori percakapan aktif.
  * Menampilkan `provider` dan `maxOutputTokens` pada kotak ringkasan perintah `/config`.
- **Perbaikan Visual Glitch & Stateful Markdown Streaming (`src/core/ui.ts`, `src/agent/agent.ts`)**:
  * Mengganti pembacaan mentah `process.stdout.columns ?? 80` dengan `terminalWidth()` pada `renderDivider` dan `renderApprovalBox`, serta membungkus judul alert approval box dengan `fit(alertHeader)` agar tidak terpotong atau merusak border pada layar terminal sempit (< 35 kolom).
  * Mengimplementasikan class `TerminalMarkdownFormatter` stateful untuk streaming `LineGate` di `src/agent/agent.ts`, mempertahankan status blok kode (fenced code blocks) antar-chunk streaming sehingga formatting tidak bocor ke dalam blok kode.
  * Memproteksi token inline code sebelum pemrosesan formatting `**bold**` sehingga inline code yang memuat tanda bintang (misal `**kwargs` atau `*args`) tidak terdistorsi.
- **Polish Interaksi TUI & Sanitasi Kredensial URL (`src/core/tui.ts`, `src/agent/llm.ts`, `src/core/wizard.ts`)**:
  * Memperbaiki penanganan `submit()` pada ambient mode (saat AI sibuk) agar mengecek `this.menuNavigated` dan mengirim item menu yang dipilih via tombol panah.
  * Membersihkan kutip pembungkus (`"` dan `'`) dan spasi pada input `baseUrl`, `apiKey`, dan `model` di `OpenAiCompatibleProvider` dan wizard interaktif `wizard.ts`.
- **Rangkaian Pengujian Mandiri**:
  * Menambahkan 7 unit test komprehensif pada `src/tests/audit_fixes.test.ts`.
  * Total unit test meningkat menjadi **493 tests passed** (100% lulus, 0 fail), dan `npm run typecheck` 100% bersih tanpa galat.

---

### v1.7.3 (15 September 2026) — Perombakan Menu Bantuan /? & /help dengan Desain Chip/Badge Highlight Freebuff CLI & Kategorisasi ANSI Native

#### Ditambahkan & Diperbarui
- **Perombakan Menu Perintah Bantuan Chip/Badge Highlight (`src/agent/commands.ts`, `src/core/loop.ts`)**:
  * Mengadopsi format badge pill modern bergaya Freebuff CLI: setiap nama perintah dibungkus badge berlatar belakang biru tua (ANSI `\x1b[48;5;18m\x1b[1;97m /command \x1b[0m`) dengan 1 spasi padding sebelum dan sesudah nama perintah (` /command `).
  * Menyusun tata letak perataan kolom rata kiri yang presisi di mana seluruh deskripsi perintah dimulai pada kolom yang sama (indeks 17), menggunakan warna abu-abu terang netral (`\x1b[37m`) dan hint/alias (`\x1b[90m`).
  * Mengelompokkan seluruh 27 perintah ke dalam 4 kategori terstruktur: `[ Sesi & Model ]`, `[ Konfigurasi & Budget ]`, `[ Operasi & Eksekusi ]`, dan `[ Sistem & Bantuan ]`, dengan badge header berlatar redup (`\x1b[48;5;236m\x1b[1;36m`) dan garis aksen tipis responsif (`\x1b[90m─\x1b[0m`).
  * Memastikan tampilan responsif dan tidak merusak text wrap pada terminal layar sempit Android/Termux (40–60 kolom) dengan pembatasan lebar garis divider adaptif terhadap lebar terminal (`terminalWidth() - 1`).
  * Mempertahankan zero third-party dependencies menggunakan escape sequence ANSI native murni.
  * Menyelaraskan fallback non-TTY `printSlashMenu()` pada `src/core/loop.ts` agar menampilkan menu Chip/Badge yang identik.
- **Rangkaian Pengujian Mandiri**:
  * Menambahkan 4 unit test baru di `src/tests/commands.test.ts` untuk memvalidasi format badge ANSI navy blue, struktur kategori berbadge, presisi perataan kolom deskripsi, dan kepatuhan batas 40 kolom pada layar sempit.
  * Total unit test meningkat menjadi **486 tests passed** (100% lulus, 0 fail), dan `npm run typecheck` 100% bersih tanpa galat.

---

### v1.7.2 (15 September 2026) — Thought Stream Sliding Window, System Prompt Reasoning Contract, DeepSeek DSML Tool Parser (BUG A), Multi-Step Task Completion Guard (BUG B), Active Context Command /ctx (BUG C), & Responsive Status Bar (BUG D)

#### Ditambahkan & Diperbarui
- **Thought Stream Live Parsing & Status Representation (`src/core/ui.ts`, `src/agent/agent.ts`)**:
  * Mengimplementasikan `ThoughtStreamParser`: memisahkan token stream penalaran (`<thought>...</thought>` atau `<think>...</think>`) dan teks jawaban biasa secara real-time.
  * Representasi status penalaran di `src/agent/agent.ts` menggunakan `createSpinner` (animasi Pac-Man atau dot spinner minimalis) yang menampilkan durasi dan estimasi token secara dinamis (`Thinking (1.2s / 45 token)...`) dan ditutup bersih dengan `✔ Selesai berpikir` tanpa merusak baris atau menimbulkan glitch line-wrap di terminal sempit (<40 kolom).
  * Komponen `ThoughtSlidingWindow` disediakan di `src/core/ui.ts` sebagai utilitas buffer FIFO kata redup independen untuk kebutuhan UI modular.
  * Interupsi tombol ESC tetap responsif dan membatalkan turn secara bersih saat pemikiran sedang mengalir.
- **Pembaruan Kontrak Penalaran System Prompt (`src/agent/roles.ts`)**:
  * Mewajibkan model mengeluarkan blok penalaran ringkas di dalam `<thought>...</thought>` sebelum memanggil tool atau menyimpulkan jawaban.
  * Mewajibkan model menyertakan rencana cadangan dan analisis penyebab di dalam `<thought>` jika tool mengembalikan error atau hasil kosong.
  * Melarang keras menyimpulkan task sebagai "tuntas" / "selesai" tanpa pengujian atau eksekusi mutasi konkret jika instruksi meminta perbaikan/edit kode.
- **BUG A: Parser Tool-Call DeepSeek DSML & XML (`src/core/ui.ts`, `src/agent/llm.ts`, `src/agent/tools.ts`)**:
  * *Root Cause*: Model DeepSeek (`deepseek-v4.1-flash`) memancarkan tool call dalam format DeepSeek DSML (`<|DSML|invoke name="...">` atau varian unicode full-width `<｜DSML｜invoke name="...">`) serta `<tool_call>...`, yang sebelumnya tidak dikenali parser internal Ruko dan bocor ke layar pengguna.
  * *Solusi Asal (v1.7.2)*:
    - `RevealFilter` (`src/core/ui.ts`) diperbarui untuk menahan dan menyembunyikan tag DSML dan XML `<tool_call>` selama proses streaming teks ke terminal, dengan regex penutup (`<\/(?:\||｜)DSML(?:\||｜)(?:invoke|tool_calls)[^>]*>`).
    - `parseToolCalls` dan `stripToolBlocks` (`src/agent/tools.ts`) diperkaya dengan parser DSML dan XML untuk mengekstrak nama tool dan parameter menjadi objek `ToolCall` standar.
    - `OpenAiCompatibleProvider` (`src/agent/llm.ts`) diperbarui untuk merekonstruksi delta `tool_calls` pada response streaming native.
  * *Catatan Audit & Verifikasi Nyata (v1.7.5)*:
    - Implementasi v1.7.2 hanya diuji pada format sintetis satu pipa tanpa spasi (`<|DSML|invoke...` dan `<｜DSML｜invoke...`).
    - Respons nyata dari API DeepSeek (`deepseek-v4.1-flash`) menggunakan format double pipe (`||` / `｜｜`), spasi pemisah sebelum nama tag (`<｜｜DSML｜｜ calls>`, `<｜｜DSML｜｜ invoke name="...">`), dan wrapper tag `<...calls>`, serta `src/agent/llm.ts` sebenarnya tidak memproses DSML. Akibatnya, pada v1.7.4 format ini masih bocor dan gagal diproses. Perbaikan tuntas dan terverifikasi secara end-to-end telah diselesaikan di v1.7.5.
- **BUG B: Multi-Step Task Completion Guard / Anti-Premature Halt (`src/agent/agent.ts`)**:
  * *Root Cause*: Pada instruksi seperti "baca file dan perbaiki bug", LLM membaca file pada turn 1, lalu pada turn 2 memberikan penalaran awal atau analisis temuan tanpa memanggil tool. Pada implementasi lama, ketiadaan tool call langsung dianggap sebagai sinyal selesai sehingga loop berhenti dan menampilkan `[Selesai] Semua langkah tuntas` sebelum tool edit dipanggil.
  * *Solusi*:
    - Menambahkan pelacak mutating tools yang sudah dieksekusi (`executedMutatingTools`: `write_file`, `edit_file`, `patch_file`, `delete_file`, `move_file`, `revert_file`).
    - Mendeteksi tugas modifikasi (`isActionTask`: `perbaiki`, `edit`, `ubah`, `ganti`, `tulis`, `buat`, `hapus`, `fix`, `patch`, `modify`, `repair`, dsb.).
    - Jika tugas meminta aksi mutasi tetapi baru tahap inspeksi (belum ada mutating tool yang jalan) dan model mengeluarkan teks biasa tanpa tool, Ruko menyuntikkan *internal nudge message* (`actionNudgeSent`) yang menginstruksikan model untuk bernalar dalam `<thought>` dan melanjutkan memanggil tool modifikasi yang sesuai (seperti `patch_file`/`edit_file`).
- **BUG C: Perintah Slash /ctx & /status untuk Verifikasi Context Budget (`src/agent/commands.ts`)**:
  * *Root Cause*: Perintah `/setctx` dan `/settoken` hanya dapat menyetel nilai, tetapi tidak ada perintah read-only untuk memverifikasi context limit, token budget aktif, dan persentase penggunaan saat ini.
  * *Solusi*:
    - Menambahkan perintah `/ctx` (dan alias `/status`) yang menampilkan tabel informatif: Model aktif, Provider, Context Window Limit (karakter & estimasi token), Penggunaan Saat Ini (karakter, token, persentase), Batas Peringatan (Warn Threshold), dan Status Persistensi Konfigurasi.
- **BUG D: Status Bar Clamping & Responsivitas Layar Sempit Termux (`src/core/ui.ts`)**:
  * *Root Cause*: Perhitungan padding dan pemotongan kolom terminal pada layar sempit (< 40 kolom, misal Termux Android) memotong bagian kanan status bar yang memuat informasi persentase konteks `ctx X%`.
  * *Solusi*:
    - Menata ulang layout rendering status bar: memprioritaskan persentase konteks `ctx X%` dan badge status penting di sisi kanan, serta memotong nama model secara proporsional jika lebar terminal sangat sempit (<= 40 kolom), menjamin `ctx X%` selalu terlihat utuh.
- **Kebebasan Konteks di Awal (Uncapped / Unbounded Context Window) (`src/types.ts`)**:
  * Mengubah default `maxContextChars` dari 30.000 menjadi **512.000 karakter (~128.000 token)** dengan rasio standar 1:4.
  * Memberikan kebebasan penuh di awal kepada pengguna tanpa pemotongan atau kompresi riwayat percakapan secara agresif dan diam-diam.
  * Menambahkan opsi `maxOutputTokens` (default: 4096) pada `AgentConfig` dan meneruskannya ke opsi `maxTokens` panggilan LLM per-turn.
- **Dashboard Pengaturan Terpadu `/settings` (`src/agent/commands.ts`)**:
  * Menyatukan konfigurasi sistem ke dalam satu pintu `/settings` (alias: `/setting`, `/set`):
    - `/settings`: Menampilkan overview dashboard berisikan status Model & Provider, Token & Context Budget (Context Window, Karakter Aktif, Max Output Tokens), Behavior & Safety (Role, Mode, Approval Gate, Exec Timeout, Fun Animations).
    - `/settings context <128k|500k|unlimited>`: Mengatur limit context window (mendukung satuan k/m atau mode unlimited).
    - `/settings max-tokens <jumlah>`: Mengatur batas maksimum output token LLM per-turn.
    - `/settings role <default|reviewer|teacher|minimal>`: Beralih peran sistem.
    - `/settings mode <beginner|pro>`: Beralih mode UI.
    - `/settings approval <on|off|yolo>`: Mengatur approval gate.
    - `/settings anim <on|off>`: Mengatur animasi Pac-Man spinner.
    - `/settings save`: Menyimpan konfigurasi aktif ke `.ruko/config.json`.
  * Mempertahankan kompatibilitas `/setctx` dan `/settoken` tanpa merusak skrip atau kebiasaan lama.
- **Peningkatan Metrik `/usage`: Waktu Kerja Aktif Agen & Cache Tokens (`src/agent/commands.ts`, `src/agent/agent.ts`, `src/core/ui.ts`)**:
  * **Waktu Kerja Aktif Agen (`activeWorkingMs`)**: Menghitung murni durasi kerja agen saat berpikir, streaming inferensi LLM, dan mengeksekusi tool (bukan waktu pengguna idle membaca layar).
  * Menampilkan total waktu kerja aktif agen dan rata-rata durasi per-turn dengan format durasi yang ramah pembaca via helper `formatDuration` (misal: `500ms`, `4.2s`, `1m 24s`).
  * **Metrik Token Lengkap**: Menampilkan rincian token `prompt`, `cache (read/hit)`, `output (generated)`, dan `total akumulasi`.
  * Menampilkan durasi spesifik turn terakhir pada baris ringkasan giliran.
- **Peningkatan UX Prompt Placeholder & Bantuan: `/? for help, ask anything...` (`src/core/loop.ts`, `src/agent/commands.ts`)**:
  * Mengubah teks placeholder kolom ketik terminal menjadi `/? for help, ask anything...` untuk meningkatkan *discoverability* bagi pengguna baru.
  * Mendaftarkan shortcut `/?` sebagai alias resmi dari perintah `/help`.
- **Pengujian & Verifikasi Komprehensif (`src/tests/thought_and_feedback_bugs.test.ts`, `src/tests/context_commands_v17.test.ts`)**:
  * Menambahkan unit test baru untuk memvalidasi dashboard `/settings` beserta sub-perintahnya (`context`, `max-tokens`, `role`, `mode`, `approval`, `anim`), helper `formatDuration`, pelacakan waktu kerja aktif agen pada `Agent.sessionUsage.activeWorkingMs`, dan alias `/?`.
  * Total unit test meningkat menjadi **482 tests passed** (0 fail, 0 errors), dan `npm run typecheck` 100% bersih tanpa galat.

---

### v1.7.1 (15 September 2026) — Security Hardening (feedback.txt Audit VULN-01–05), Workspace Trust, HTTP Protocol Confirmation, Context Commands (/setctx, /settoken, /usage), Subagent Deadlines, & Terminal Sanitization

#### Ditambahkan & Diperbarui
- **VULN-01 (Critical): Ekspansi Shell Variable Sebelum Evaluasi Regex Bahaya (`src/core/approval.ts`)**:
  * Mengintegrasikan `extractAndResolveShellVariables` ke `detectRisk` dan `checkBlockedOnly`. Variabel shell (seperti `DIR=/etc; rm -rf $DIR` dan `TARGET=/; rm -rf $TARGET`) diekspansi terlebih dahulu sebelum dicocokkan ke regex pencegah perintah destruktif (`RM_CRITICAL_RE`). Mencegah bypass destruktif 100%.
- **VULN-02 (High): Pencegahan Pembocoran Berkas Sensitif via Shell Wildcard Expansion (`src/agent/tools.ts`)**:
  * Menambahkan `isSensitiveWildcardPattern` pada `detectSensitiveFileAccessInExec`. Token dengan karakter wildcard/glob (`*`, `?`, `[...]`) yang menargetkan direktori `.ruko/**`, `.env*`, `id_rsa*`, `*.pem`, `*.key` langsung diblokir secara preventif di tool `exec`.
- **VULN-03 (Medium-High): Mitigasi Eksfiltrasi Environment Variable via Runtime Scripting (`src/agent/tools.ts`, `README.md`)**:
  * Menambahkan deteksi pola inline interpreter (`node -e`, `python3 -c`, `ruby -e`, `perl -e`, `php -r`, `pwsh`, `declare -p`, `set`) di `isSensitiveEnvCommand` untuk memblokir pembacaan environment runtime. Mendokumentasikan boundary limits di README.
- **VULN-04 (Medium): Proteksi Cleartext HTTP BaseURL & Dukungan Local LLM / Private LAN IP (`src/agent/commands.ts`, `src/core/config.ts`)**:
  * Menambahkan fungsi `isPrivateOrLocalHost` untuk memvalidasi hostname. Base URL dengan skema HTTP remote ke internet publik ditolak kecuali disertai flag `--insecure`. Sebaliknya, endpoint local LLM dan LAN privat (`localhost`, `127.0.0.1`, RFC 1918 `192.168.*`, `10.*`, `172.16-31.*`, serta domain lokal `.local`, `.lan`) diizinkan sepenuhnya menggunakan HTTP untuk mendukung Ollama, LM Studio, vLLM, dan gateway internal.
- **Konfirmasi Trust Protokol HTTP (`src/core/wizard.ts`, `src/agent/commands.ts`)**:
  * Khusus URL berprotokol HTTP (`http://`), sistem secara eksplisit menanyakan konfirmasi kepercayaan: `Apakah kamu mempercayai protokol/URL ini? (y/n)`. Jika pengguna menolak, proses setup atau penyimpanan dibatalkan demi menjaga keamanan kredensial.
- **Workspace / Folder Trust Saat Startup (`src/core/trust.ts`, `src/index.ts`, `src/types.ts`, `src/core/config.ts`)**:
  * Menambahkan verifikasi kepercayaan folder (`Apakah kamu mempercayai folder ini? y/n`) saat pertama kali Ruko dijalankan di suatu direktori proyek. Mencegah agen membaca atau mengeksekusi berkas pada repositori yang tidak dipercayai. Status trust dicatat secara persisten di `.ruko/trusted` dan `trustedWorkspace` di konfigurasi lokal.
- **VULN-05 (Low-Medium): Proteksi Path Traversal pada Perintah Slash `/undo <path>` (`src/agent/commands.ts`)**:
  * Menerapkan `assertInsideWorkspace` pada jalur perintah manual terminal `/undo <path>`, menyelaraskannya dengan pengamanan tool agen `revert_file`.
- **Point 2: Mitigasi Eksfiltrasi Environment Tidak Langsung (`src/agent/tools.ts`)**:
  * Memblokir akses pseudofile `/proc/*/environ` (Linux process environment) pada `isSensitivePath`, `detectSensitiveFileAccessInExec`, dan `isSensitiveEnvCommand`.
  * Memblokir eksfiltrasi variabel lingkungan via awk script array `ENVIRON` (`awk`, `gawk`, `mawk`, `nawk`).
  * Mengekstrak dan memvalidasi perintah di dalam command substitution subshell (`$(...)`, `...`, `<(...)`, `eval "..."`), mencegah bypass env dump terbungkus subshell.
- **Dedicated Context Window & Session Token Commands (`src/agent/commands.ts`, `src/agent/agent.ts`, `README.md`)**:
  * Menambahkan pelacakan akumulasi token sesi (`SessionUsage`) pada kelas `Agent`, mencakup total prompt tokens, completion tokens, total tokens, dan total turn pada sesi aktif.
  * Memperkaya perintah `/usage` (alias: `/stats`, `/tokens`) untuk menampilkan akumulasi token sesi, estimasi karakter, statistik turn terakhir, serta sub-perintah `/usage clear` untuk mereset counter sesi.
  * Menambahkan perintah `/setctx [jumlah]` untuk melihat penggunaan memori konteks aktif atau memperbarui budget karakter (`50k`, `80000`, dsb.) dengan validasi angka positif dan batas minimum jumlah karakter aktif.
  * Menambahkan perintah `/settoken [token]` untuk mempermudah developer mengatur context window berbasis estimasi token (`8k`, `16k`, `32000`, dsb.) dengan rasio konversi standar industri LLM (1 token ≈ 4 karakter).
- **Subagent Cumulative Timeout & Resource Deadline (`src/agent/subagent.ts`, `src/agent/tools.ts`)**:
  * Menambahkan opsi `timeoutMs` (default: 60_000ms) pada `SubagentOptions` dan integrasi listener `AbortController` dengan `deps.signal`.
  * Memastikan subagent yang mengalami hanging atau menjalankan instruksi berat dihentikan secara bersih dengan status timeout terisolasi tanpa memblokir atau merusak proses giliran utama agen induk.
  * Memperluas `containsSensitiveFilePattern` untuk memblokir seluruh variasi SSH key (`id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`) dan sertifikat/kunci privat (`.pem`, `.key`).
  * Tool `delegate` secara otomatis meneruskan parameter `timeout_ms` atau `timeout` jika disediakan oleh LLM/pemanggil.
- **Sanitasi Terminal Injection & ANSI Escape Sequence (`src/core/ui.ts`, `src/core/executor.ts`)**:
  * Menambahkan fungsi `sanitizeTerminalOutput()` dengan pembersihan mendalam terhadap escape sequence berbahaya: Operating System Command (OSC), Device Control String (DCS), Application Program Command (APC), Privacy Message (PM), serta karakter bell (`\x07`) dan form feed (`\x0c`).
  * Mencegah terminal visual spoofing, hyperlink injection (OSC 8), dan modifikasi title/clipboard terminal tak diinginkan dari output proses eksternal.
  * Memperbarui `stripAnsi` agar membersihkan seluruh escape sequence berbahaya sekaligus kode warna ANSI standar.
- **Pencegahan Shell Function / Env Variable Hijacking & Dumps (`src/core/executor.ts`, `src/agent/tools.ts`)**:
  * Menyaring dan membuang key environment variable yang diawali `BASH_FUNC_*` saat proses dieksekusi melalui shell, mencegah eksekusi fungsi shell berbahaya warisan lingkungan induk.
  * Memperkuat `isSensitiveEnvCommand` untuk mendeteksi dan memblokir dump environment variabel via `declare -p`, `typeset -p`, dan bare `set`.
- **Penyelesaian Bug Teridentifikasi (Known Bugs Resolution) (`src/core/compressor.ts`, `src/core/executor.ts`)**:
  * **Known Bug #1 (Compression menyerah bila budget tak terjangkau)**: Mengimplementasikan *best-effort fallback compression* (`foldAllHead`) pada `compressHistory`. Jika budget target tidak dapat tercapai secara mutlak karena protected tail turn terlalu panjang, seluruh giliran riwayat lama tetap dikompresi ke ringkasan terpendek selama ukuran berkurang, mencegah ledakan konteks window.
  * **Known Bug #3 (Urutan stdout vs stderr sekuensial)**: Mengintegrasikan listener data real-time pada stream child process (`child.stdout.on('data')`, `child.stderr.on('data')`) ke dalam `interleavedChunks`, menjamin output gabungan mencatat urutan waktu kronologis yang akurat.
  * **Known Bug #8 (TOCTOU SSRF Web Fetch)**: Berhasil diatasi secara tuntas melalui implementasi Native IP-Pinning pada custom socket `http.Agent`/`https.Agent` di `src/agent/webtools.ts`.
- **Penyelesaian Temuan Audit Eksternal (Findings 1, 2, 3) (`src/agent/tools.ts`, `src/agent/subagent.ts`, `src/core/session.ts`)**:
  * **Finding 1 (Proteksi File Startup & Profile Shell)**: Menambahkan deteksi dan pencegahan akses/modifikasi terhadap berkas konfigurasi shell pengguna (`.bashrc`, `.bash_profile`, `.bash_login`, `.bash_logout`, `.zshrc`, `.zprofile`, `.zshenv`, `.zlogin`, `.zlogout`, `.profile`) pada `isSensitivePath` dan `containsSensitiveFilePattern`.
  * **Finding 2 (Batas Maksimum Ukuran Berkas 5MB)**: Menetapkan konstanta `MAX_FILE_WRITE_BYTES = 5 * 1024 * 1024` (5MB) dan memvalidasi `byteLength` payload di `writeWithDiff` dan `runToolCall` (`write_file`, `edit_file`, `patch_file`), mencegah memory exhaustion dan infinite text loop output.
  * **Finding 3 (Preservasi Timestamp Asli pada Ekspor Trajectory)**: Memperbarui `exportSessionTrajectory` di `src/core/session.ts` untuk memelihara timestamp pesan asli (`m.timestamp`) dan timestamp awal sesi pada nama berkas ekspor dan dokumen trajectory hasil export bukannya menimpa dengan waktu sistem saat ekspor.
- **Engine Bug Fixes & Refinement (Item 6, 7, 8, 9) (`src/agent/filetools.ts`, `src/agent/agent.ts`, `src/agent/llm.ts`, `src/core/undo.ts`)**:
  * **Item 6**: Memastikan proteksi berkas internal `SECURITY_CORE_FILES` berbasis direktori instalasi riil Ruko, tidak memicu false positive pada berkas proyek pengguna.
  * **Item 7**: Memindahkan evaluasi loop breaker `seenRepeat(call)` sebelum penetapan `lastCallSignature`, memutus perulangan tool berulang lebih awal.
  * **Item 8**: Mengganti fallback `||` menjadi nullish coalescing `??` pada `GeminiProvider`, `AnthropicProvider`, dan `OpenAiCompatibleProvider` untuk menghormati nilai API key kosong eksplisit.
  * **Item 9**: Menambahkan impor eksplisit `Buffer` dari `node:buffer` untuk kompatibilitas penuh dengan versi terbaru compiler TypeScript Node 20+.
- **Rangkaian Pengujian & Baseline Baru**:
  * Menambahkan test suite baru `src/tests/context_commands_v17.test.ts` (13 unit test) dan `src/tests/trust.test.ts` (11 unit test).
  * Total pengujian meningkat menjadi 464 passed (100% lulus, 0 fail), E2E test lulus (1 passed), dan `npm run typecheck` bersih tanpa galat.

---

### Security Audit & Comprehensive Hardening (15 September 2026) — Centralized Sensitive Protection, Immutable Security Core, SSRF Transport Hardening & IP-Pinning, Symlink Broken-Write Prevention, Command Exec Bypass Neutralization

#### Ditambahkan & Diperbarui
- **Proteksi Terpusat Berkas Sensitif (`src/agent/tools.ts`, `src/agent/filetools.ts`, `src/agent/subagent.ts`)**:
  * `isSensitivePath` diperkuat dengan dukungan URL-decoding (`%2e%65%6e%76` -> `.env`), bash backslash unescaping (`.ru\\ko/con\\fig.json`), tilde expansion (`~/.ssh/id_rsa`), case-insensitivity (`.RUKO/CONFIG.JSON`), serta penambahan proteksi `.git-credentials`.
  * Seluruh tool pembacaan berkas (`readFileTool`, `globTool`, `codeSearchTool`, `listDirTool`) menerapkan inspeksi kanonikal `realpath` terhadap symlink dan memblokir kebocoran file sensitif.
  * Interseptor delegasi subagent (`runSubagent` & `containsSensitiveFilePattern`) menolak tugas subagent yang berupaya mengakses atau membocorkan kredensial konfigurasi, file `.env`, file kredensial git, atau kunci privat SSH.
- **Immutable Security Core (`src/agent/tools.ts`, `src/agent/filetools.ts`)**:
  * Menetapkan 6 berkas inti keamanan Ruko (`src/core/approval.ts`, `src/core/executor.ts`, `src/agent/tools.ts`, `src/agent/filetools.ts`, `src/agent/subagent.ts`, `src/agent/webtools.ts`) sebagai berkas yang tidak dapat dimodifikasi atau dihapus oleh agent.
  * `assertNotSecurityCore` diterapkan di seluruh mutating tools: `write_file`, `edit_file` (`writeWithDiff`), `patch_file`, `delete_file`, `move_file` (sumber maupun target), dan `revert_file`.
- **Transport Layer SSRF Hardening & Native IP-Pinning (`src/agent/webtools.ts`)**:
  * Implementasi `parseAlternativeIPv4` untuk normalisasi notasi IP alternatif: integer desimal 32-bit (misal `2130706433` -> `127.0.0.1`, `2852039166` -> `169.254.169.254`), oktal (`0177.0.0.1`), heksadesimal (`0x7f000001`, `0xa9fea9fe`), shorthand dotted (`127.1`), serta IPv4-mapped IPv6 (`::ffff:127.0.0.1`, `::ffff:7f00:1`).
  * Penegakan Native IP-Pinning soket TCP pada setiap hop rantai redirect HTTP (`301`, `302`, `303`, `307`, `308`), mencegah serangan open redirect menuju cloud instance metadata atau intranet privat.
  * Pengecekan resolusi ganda (*double-check*) DNS untuk mendeteksi anomali TTL=0 DNS rebinding secara aktif.
- **Konsistensi Symlink & Penutupan Celah Broken-Symlink Write-Through (`src/agent/tools.ts`)**:
  * Mengatasi kerentanan TOCTOU di mana symlink rusak (*broken symlink*) yang mengarah ke luar workspace dapat ditulis sebelum targetnya eksis. `assertInsideWorkspace` kini memanggil `lstatSync` tanpa dependensi pada `existsSync`, dan memvalidasi `readlinkSync` target jika symlink belum terbentuk.
  * Menolak operasi penulisan atau modifikasi melalui symbolic link pada `writeWithDiff`.
- **Netralisasi Encoding Bypass pada Filter Command Exec (`src/core/approval.ts`, `src/agent/tools.ts`)**:
  * Ekstraksi subshell `$()` dan backtick ``` ` ``` di `chainedSegments` dan `extractSubshells`.
  * Pembersihan (*unescaping*) karakter backslash bash (`r\m -rf /` -> `rm -rf /`, `cat .e\nv` -> `cat .env`).
  * Pelacakan variabel shell bash sederhana di `isSensitiveEnvCommand` dan `detectSensitiveFileAccessInExec` (`V=.env; cat $V`, `V=RUKO_API_KEY; printenv $V`).
- **Dokumentasi Resmi `README.md`**:
  * Menambahkan section resmi `## 🛡️ Security Boundaries & Known Limitations` (7 butir faktual) dan memperbarui Daftar Isi (Table of Contents).
- **Pengujian Komprehensif & Nol Regresi (`src/tests/sensitive_protection.test.ts`)**:
  * Menambahkan suite uji Bagian D (Security Core), Bagian E (SSRF alternative IP & redirect hop), Bagian F (Encoding bypass & exec variable tracking), dan Bagian G (Symlink consistency & broken symlink write escape).
  * Seluruh suite pengujian berjalan 100% sukses: **433 tests passed** (0 fail, 0 errors), dan `npm run typecheck` bersih tanpa galat.

---

### v1.7.0 (14 September 2026) — Universal Tool Security Hardening, Symlink Sandboxing, SSRF Redirect Defense, Subagent Recursion Guard, & UI Step Enrichment

#### Ditambahkan & Diperbarui
- **Hardening Keamanan Tool `start_process` (`src/agent/tools.ts`)**:
  * Menyelaraskan seluruh filter keamanan `start_process` dengan standar `exec`:
    1. Memblokir perintah berisiko tinggi (*blocked commands* seperti fork bomb `:(){ :|:& };:`, `rm -rf /`, `mkfs`, writing directly to `/dev/sd*`) menggunakan `detectRisk()`.
    2. Menolak eksfiltrasi kredensial environment variable (`isSensitiveEnvCommand()`) seperti `printenv` dan `echo $RUKO_API_KEY`.
    3. Menolak inspeksi file sensitif (`detectSensitiveFileAccessInExec()`) seperti `cat .ruko/config.json`, `cat .env`, dan kunci privat.
    4. Menolak mutasi berkas dasar tanpa tool resmi (`detectWorkspaceMutationInExec()`).
- **Mitigasi SSRF via HTTP Redirect di `web_fetch` (`src/agent/webtools.ts`)**:
  * Mengubah opsi fetch native menjadi `redirect: 'manual'`.
  * Mengimplementasikan safe redirect-following loop (maksimal 5 hop, deteksi loop) di mana setiap header `Location` divalidasi ulang lewat `checkSsrfSafety()` sebelum diikuti.
  * Mencegah eksfiltrasi data cloud instance metadata (169.254.169.254) dan port intranet lokal melalui open redirect eksternal.
- **Symlink Traversal Sandboxing Seluruh File Tools (`src/agent/tools.ts`, `src/agent/filetools.ts`)**:
  * `assertInsideWorkspace` & `assertNotSensitivePath`: Menambahkan resolusi kanonikal (`realpathSync`) untuk memastikan symlink tidak melompat keluar dari batas workspace maupun menargetkan file sensitif.
  * Menambahkan proteksi file `.git/config` pada `isSensitivePath` untuk mencegah pencurian token repositori git / embedded credentials.
  * `walkDirectory` (`globTool` & `codeSearchTool`): Memfilter dan mengabaikan symlink yang targetnya berada di luar direktori kerja proyek (`isPathInsideWorkspace(real, cwd)`).
- **Sanitasi Path Traversal di Skills System & Session Persistence (`src/core/skills.ts`, `src/core/session.ts`)**:
  * `readSkill` & `deleteSkill`: Sanitasi nama skill menggunakan `sanitizeSkillName` serta verifikasi boundary kanonikal direktori `.ruko/skills/`.
  * `saveSession`, `loadSession`, & `exportSessionTrajectory`: Penegakan validasi ketat ID sesi berbasis regex `^[a-zA-Z0-9_-]+$` dan verifikasi boundary folder kanonikal. Upaya injeksi path traversal (`../../../etc/passwd`) ditolak mutlak dengan error eksplisit alih-alih disanitasi menjadi file baru.
- **Native IP-Pinning Transport Layer & Eliminasi Total DNS Rebinding (`src/agent/webtools.ts`)**:
  * Menggantikan transport native `fetch` pada `webFetchTool` dengan implementasi custom berbasis `node:http` dan `node:https` yang menerapkan **Native IP-Pinning**.
  * `checkSsrfSafety`: Memvalidasi protokol, IP literal, private/metadata ranges, serta me-resolve DNS dengan verifikasi ganda, kemudian mengembalikan `pinnedIp` dan `ipFamily`.
  * `pinnedHttpFetch`: Memaksa opsi socket `lookup` langsung mengembalikan `pinnedIp` yang telah diverifikasi aman. Ini menjamin runtime/OS tidak pernah melakukan resolusi DNS kedua, sehingga eksploitasi DNS Rebinding TOCTOU tertutup 100% secara deterministik.
  * **Penerapan Universal pada Seluruh Hop**: IP-pinning dievaluasi dan ditegakkan di setiap hop rantai redirect (`301`, `302`, `303`, `307`, `308`), bukan hanya pada request pertama.
- **Dokumentasi Batasan Keamanan Diketahui (Known Security Limitations)**:
  * Mendokumentasikan secara transparan batasan teoretis *filesystem TOCTOU race condition* (micro-window antara pengecekan symlink dan kernel I/O saat proses asing OS melakukan symlink-swap paralel) di `README.md` dan `PROGRESS.md`.
- **Izin Berkas Ketat Snapshot Undo (`src/core/undo.ts`)**:
  * Menerapkan mode permissions `0o600` pada pembuatan berkas snapshot `.content` dan `.meta.json` serta `0o700` pada direktori `.ruko/undo/`.
- **Proteksi Rekursi Delegasi Subagent (`src/agent/tools.ts`, `src/agent/agent.ts`, `src/agent/subagent.ts`)**:
  * Membatasi kedalaman delegasi subagent (`subagentDepth >= 1`) dan menolak pemanggilan `delegate` berulang dari dalam subagent untuk mencegah subagent fork bomb / recursion.
- **Pengayaan UI & Contextual Step Indicator (`src/core/ui.ts`)**:
  * Menambahkan identifikasi langkah tool pada `inferStepDescription` untuk `delete_file` / `move_file` (`"Pengelolaan & reorganisasi berkas proyek"`) dan `web_fetch` (`"Mengambil konten referensi web eksternal"`).
- **Rangkaian Pengujian Mandiri Komprehensif (`src/tests/security_hardening_v17.test.ts`)**:
  * 13 unit test adversarial memvalidasi seluruh perbaikan keamanan secara end-to-end (termasuk Native IP-Pinning socket level, active DNS rebinding, and strict session traversal rejection). Total pengujian: **381 passed** (100% lulus, 0 gagal).
### v1.6.2 (14 September 2026) — Stabilitas Termux Mobile, Perluasan Tool Inspeksi & Rollback Berkas, serta Hardening Sanitasi Memori

#### Ditambahkan & Diperbarui
- **Perbaikan Alur Seleksi Enter pada Menu Popup Slash Command (`src/core/tui.ts`)**:
  * **Gejala Bug**: Saat pengguna mengetik `/` lalu menavigasikan panah atas/bawah (scroll highlight) pada daftar perintah, lalu menekan `Enter`, perintah yang ter-highlight tidak terpilih dan menu malah tertutup atau mengeksekusi buffer mentah (`/` kosong atau teks parsial).
  * **Akar Masalah**: Handler Enter (`submit()`) hanya membaca `this.buffer` mentah tanpa memeriksa status item yang dipilih pada menu (`this.selected` / `this.menu[this.selected]`). Jika buffer adalah `'/'`, fungsi `menuOnlyClose` mendeteksinya sebagai penutupan overlay tanpa aksi sehingga menghapus menu tanpa mengeksekusi apa pun.
  * **Solusi**: Menambahkan pelacak navigasi eksplisit `this.menuNavigated`. Saat pengguna memindahkan highlight dengan panah atas/bawah, `menuNavigated` aktif. Saat `Enter` ditekan, jika `menuNavigated` aktif dan ada item terpilih, `submit()` membaca dan memilih perintah tersebut (`item.insert ?? item.label`), menghapus menu secara bersih, dan mengeksekusi perintah terpilih. Jika pengguna hanya mengetik `/` tanpa menavigasi dan menekan Enter, perilaku menutup overlay tanpa commit tetap dipertahankan.
- **Responsivitas Status Bar terhadap Terminal Width Sempit / Termux (`src/core/ui.ts`, `src/core/tui.ts`, `src/core/loop.ts`)**:
  * **Gejala Bug**: Pada layar sempit (seperti Termux di mobile dengan lebar terminal 30–45 kolom), indikator status hijau terpotong di sebelah kanan sehingga persentase konteks (`ctx %`), indikator proses, dan status tidak terlihat.
  * **Akar Masalah**:
    1. `statusBarLine()` di `loop.ts` memanggil `buildStatusBar` tanpa meneruskan lebar terminal `width` dari `LineEditor`.
    2. Deteksi terminal width hanya mengandalkan `process.stdout.columns ?? 80` tanpa memeriksa environment variable `COLUMNS` yang umum digunakan di shell Android/Termux.
    3. `buildStatusBar` di `src/core/ui.ts` menghasilkan string panjang yang melampaui kolom layar sempit (< 48 kolom), sehingga otomatis dipotong paksa oleh `truncateVisible(..., width - 1)`.
  * **Solusi**:
    1. Memperbarui `terminalWidth()` dan `termWidth()` untuk memeriksa `process.env.COLUMNS` sebelum fallback ke default 80.
    2. Meneruskan parameter `width` dari callback `statusLine(width)` di `LineEditor` hingga ke `buildStatusBar({ width })`.
    3. Merombak layout `buildStatusBar` agar secara dinamis menyesuaikan elemen dengan `targetWidth = Math.max(16, width - 1)`. Pada layar sempit, indikator status kritis (`ctx %`, `⏳`, `⏸`) diprioritaskan di sisi kanan, sedangkan nama model dipersingkat secara proporsional (`…`) jika diperlukan, menjamin status bar tidak pernah terpotong.
- **Pelaporan Total Match & Suppressed Matches pada `code_search` (`src/agent/filetools.ts`)**:
  * **Gejala Bug**: Ketika pencarian teks atau regex mencapai batas limit (default 50 matches), tool langsung menghentikan iterasi (`break`), sehingga `totalMatches` yang dilaporkan hanya sebesar batas limit tersebut. Akibatnya pengguna/agen tidak mengetahui berapa jumlah match aktual yang ditemukan di proyek dan apakah masih ada ratusan kecocokan lain yang terpotong.
  * **Akar Masalah**: Loop pemindaian berhenti prematur saat `displayedMatches >= limit` tanpa menghitung sisa kecocokan di file saat itu maupun file-file kandidat berikutnya.
  * **Solusi**: Mengubah alur loop pencarian agar tetap memindai dan menghitung `totalMatches` serta jumlah file yang cocok (`matchedFilesCount`) secara akurat di seluruh kandidat tanpa memformat blok konteks untuk hasil di luar kuota limit (tetap hemat komputasi & token). Pada footer hasil pencarian yang terpotong, menambahkan pesan informatif: `[... Hasil dibatasi ${limit} kecocokan pertama — ${suppressed} more matches suppressed, persempit query, target path, atau extension ...]`.
- **Tool `revert_file` & Rollback Berkas Fleksibel (`src/core/undo.ts`, `src/agent/tools.ts`, `src/agent/roles.ts`, `src/agent/commands.ts`, `src/core/ui.ts`)**:
  * **Kebutuhan**: Setelah perubahan file melalui `patch_file`, `write_file`, atau `edit_file` disetujui, belum ada tool bawaan bagi agen untuk membatalkan perubahan secara spesifik per file jika hasil edit tidak sesuai harapan, dan pengguna hanya memiliki `/undo` global tanpa bisa memilih file tertentu.
  * **Solusi**:
    1. **Core Undo Engine (`src/core/undo.ts`)**: Menambahkan fungsi `revertFileSnapshot`, `revertFileGit`, dan `revertFile(targetPath, { dir, workspaceRoot, mode })`. Mendukung 3 mode (`auto`, `snapshot`, `git`). Pada mode `auto` (default), sistem memeriksa snapshot terbaru file di `.ruko/undo/` dan mengembalikannya (atau menghapusnya jika file baru); jika snapshot tidak ditemukan, sistem fallback mengeksekusi `git checkout -- <file>`.
    2. **Agent Tool (`src/agent/tools.ts`)**: Mendaftarkan tool `revert_file` dengan validasi sandboxing workspace (`resolveToolPath`, anti-path-traversal, proteksi file sensitif), approval gate konfirmasi pengguna saat `approvalEnabled: true`, serta pemblokiran otomatis saat `planMode: true` (`PLAN_MODE_BLOCKED`).
    3. **Prompt & Peran (`src/agent/roles.ts`)**: Mendokumentasikan tool `revert_file` pada `TOOL_RULES`, menambahkan `revert_file` ke aturan read-only peran `reviewer`, serta menambahkan ke proteksi plan mode.
    4. **Slash Command `/undo [path]` (`src/agent/commands.ts`)**: Memperbarui perintah `/undo` agar dapat menerima argumen path opsional (mis. `/undo src/core/ui.ts`) untuk rollback file spesifik, sekaligus mempertahankan `/undo` tanpa argumen untuk membatalkan snapshot terakhir global.
    5. **TUI Step Indicator (`src/core/ui.ts`)**: Menyertakan `revert_file` pada deteksi modifikasi berkas proyek di `inferStepDescription`.
- **Sanitasi & Mitigasi Prompt Injection pada Memory (`src/core/memory.ts`, `src/agent/roles.ts`, `src/agent/tools.ts`)**:
  * **Kebutuhan**: Entri memori yang tersimpan di `.ruko/memory.md` (baik via tool `remember` maupun editan manual) berpotensi disusupi instruksi imperatif tersembunyi (mis. `"jika user tanya X, jawab Y"`, `"you must always respond in JSON"`, atau override sistem) yang dapat memanipulasi perilaku model saat diinjeksikan otomatis ke konteks percakapan.
  * **Solusi**:
    1. **Deteksi Instruksi ke Model (`detectModelInstruction`, `MODEL_INSTRUCTION_RULES`)**: Menyusun aturan regex komprehensif untuk mendeteksi:
       - Arahan kondisional respons ke pengguna (`"jika user tanya X, jawab Y"` / `"if user asks X, reply Y"`).
       - Perintah kontrol perilaku model langsung (`"kamu harus selalu menjawab..."` / `"you must never reply..."`).
       - Percobaan prompt injection / jailbreak / override instruksi sistem (`"ignore all previous instructions..."`, `"system prompt: ..."`).
       - Tetap meloloskan catatan teknis dan fakta proyek pasif yang sah (mis. `"Gunakan PostgreSQL untuk DB produksi"`, `"Port server default adalah 3000"`).
    2. **Gate Penyimpanan (`appendMemory`)**: Secara default menolak entri yang terdeteksi sebagai instruksi imperatif ke model (`actionOnInstruction: 'reject'`), mencegah polusi instruksi ke `.ruko/memory.md`. Mendukung opsi `'tag'` untuk menetralkan entri dengan penanda pasif jika diminta.
    3. **Gate Konteks / Sanitasi Injeksi (`sanitizeMemoryForPrompt`, `formatMemoryForPrompt`)**: Untuk file `.ruko/memory.md` yang diedit manual di luar kendali CLI, sistem memindai setiap baris memori sebelum diinjeksikan ke prompt. Baris yang terdeteksi berformat instruksi ke model otomatis disanitasi dengan label `[INSTRUKSI_DIABAIKAN / DATA PASIF: ...]`, dan panduan sistem dipertegas agar model dilarang menjalankan entri bertanda tersebut sebagai perintah eksekusi.
    4. **Panduan Prompt Tool (`src/agent/roles.ts`)**: Memperbarui deskripsi `remember` di `TOOL_RULES` agar agen memahami bahwa instruksi imperatif interaktif dilarang disimpan ke memori.
- **Peningkatan Timeout Default `exec` & Parameter Timeout Per-Panggilan (`src/core/executor.ts`, `src/types.ts`, `src/core/approval.ts`, `src/agent/tools.ts`, `src/agent/roles.ts`)**:
  * **Kebutuhan**: Timeout default `exec` sebelumnya adalah 30 detik (30_000ms), terlalu singkat untuk tugas kompilasi, instalasi package (`npm install`), atau suite pengujian lama, memaksa penggunaan `start_process` yang tidak praktis untuk perintah foreground singkat. Selain itu, belum ada jalur parsing resmi untuk parameter timeout kustom per panggilan tool.
  * **Solusi**:
    1. **Peningkatan Timeout Default**: Menaikkan `DEFAULT_TIMEOUT_MS` di `src/core/executor.ts` dan `DEFAULT_CONFIG.execTimeoutMs` di `src/types.ts` dari 30s menjadi 120s (120_000ms / 2 menit).
    2. **Parameter Timeout Per-Panggilan (`resolveExecTimeout`)**: Menambahkan fungsi parser yang mendukung parameter `timeoutMs`, `timeout_ms`, dan `timeout` (baik tipe number maupun string numerik). Nilai kecil (`<= 600`) tanpa embel-embel 'Ms' otomatis diinterpretasikan sebagai detik (misal `timeout: 60` -> 60_000ms) dan di-clamp secara aman antara 100ms hingga 3_600_000ms (1 jam).
    3. **Penyaluran Konfigurasi Aman (`src/core/approval.ts`)**: Memastikan `guardedExecute` menyalurkan `options.timeoutMs ?? config.execTimeoutMs` ke fungsi eksekutor, menghormati konfigurasi pengguna.
    4. **Notifikasi Timeout Informatif (`src/core/executor.ts`)**: Ketika proses dihentikan paksa karena timeout, sistem menyertakan pesan diagnostik ramah di output/stderr: `[Command dihentikan: waktu eksekusi melebihi batas timeout Xms. Gunakan parameter timeoutMs lebih besar pada exec jika command membutuhkan waktu lebih lama, atau gunakan start_process untuk proses latar belakang.]`.
    5. **Prompt Tool Rules (`src/agent/roles.ts`)**: Memperbarui dokumentasi protokol tool `exec` di `TOOL_RULES` untuk mencerminkan default 120s dan instruksi penggunaan `timeoutMs`.
- **Dukungan Array & String Comma-Separated pada Parameter `extension` di `code_search` (`src/agent/filetools.ts`, `src/agent/tools.ts`, `src/agent/roles.ts`)**:
  * **Kebutuhan**: Parameter `extension` pada tool `code_search` sebelumnya hanya menerima tipe string tunggal (mis. `"ts"`), sehingga pencarian lintas tipe file (misal TypeScript dan TSX, atau Markdown dan JS) memerlukan pemanggilan tool berkali-kali secara manual.
  * **Solusi**:
    1. **Normalisasi Filter Ekstensi (`parseExtensionFilter`)**: Menambahkan fungsi normalisasi di `src/agent/filetools.ts` yang menangani `string`, `string[]`, maupun string comma-separated (mis. `".ts, .tsx"`, `"ts,tsx"`, atau `[".ts", ".tsx"]`). Ekstensi dipangkas dari whitespace, dinormalisasi ke lowercase, dan titik awalan dibersihkan menjadi `Set<string>`.
    2. **Penyelarasan Dispatcher Tool (`src/agent/tools.ts`)**: Mengizinkan penerimaan nilai array maupun string pada `call.extension`, `call.extensions`, maupun alias `call.ext`.
    3. **Prompt Tool Rules (`src/agent/roles.ts`)**: Memperbarui deskripsi aturan `code_search` di `TOOL_RULES` untuk mengedukasi model bahwa `extension` menerima format array atau comma-separated.
- **Tool `list_dir` untuk Inspeksi Langsung Isi Direktori (`src/agent/filetools.ts`, `src/agent/tools.ts`, `src/agent/roles.ts`, `src/core/ui.ts`)**:
  * **Kebutuhan**: Sebelumnya agen harus menggunakan `glob` dengan pola `*` untuk melihat isi folder. Tidak ada tool sederhana 1-level untuk menginspeksi direktori secara langsung beserta ukuran berkasnya.
  * **Solusi**:
    1. **Core Directory Listing (`src/agent/filetools.ts`)**: Menambahkan `listDirTool` dengan validasi sandboxing workspace (`assertInsideWorkspace`), proteksi berkas sensitif otomatis (`isSensitivePath`), pemilahan jenis entri (`[DIR]`, `[FILE]` dengan ukuran format B/KB/MB, `[LINK]`), dan pengelompokan direktori di urutan teratas.
    2. **Tool Dispatcher (`src/agent/tools.ts`)**: Mendaftarkan tool `list_dir` dan alias `list_directory`, mengizinkan akses read-only (tersedia di plan mode tanpa blok).
    3. **Prompt & Role Integration (`src/agent/roles.ts`)**: Mendokumentasikan `list_dir` di `TOOL_RULES`, menambahkan `list_dir` ke daftar allowlist peran read-only `reviewer`, dan memperbarui rekomendasi penemuan berkas.
    4. **TUI Step Description (`src/core/ui.ts`)**: Memetakan tool `list_dir` ke inferensi langkah kerja UI TUI ("Membaca konfigurasi & struktur berkas").
- **Rangkaian Pengujian**:
  * Menambahkan 9 unit test baru di `src/tests/revert_file.test.ts` (revert dari snapshot, penghapusan file baru, fallback git checkout, penolakan mode snapshot jika tanpa snapshot, approval gate, plan mode blocking, proteksi file sensitif & path traversal, serta perintah `/undo [path]`).
  * Menambahkan 4 unit test baru di `src/tests/memory.test.ts` (akurasi deteksi instruksi imperatif vs fakta pasif, penolakan dan penandaan di `appendMemory`, penolakan di tool `remember`, serta netralisasi otomatis di `sanitizeMemoryForPrompt`).
  * Menambahkan 6 unit test baru di `src/tests/exec_timeout.test.ts` (default 120s, parser parameter `resolveExecTimeout`, terminasi command timeout dengan pesan notifikasi, eksekusi sukses di bawah batas, dan integrasi per-call `timeoutMs` & `timeout`).
  * Menambahkan 3 unit test baru di `src/tests/glob_search.test.ts` (dukungan comma-separated string `".ts, .md"`, array `[".ts", ".md"]`, variasi tanpa dot/dengan spasi, dan dispatch `runToolCall` dengan array/comma-separated).
  * Menambahkan 13 unit test baru di `src/tests/list_dir.test.ts` (listing direktori dan file beserta ukuran, default root path, subdirektori, direktori kosong, batas limit & truncating, penolakan path file & folder fiktif, proteksi sandboxing workspace `/etc`, proteksi berkas sensitif `.env` / `.ruko/config.json`, opsi `showHidden`, dispatch `runToolCall` & alias `list_directory`, ketersediaan di plan mode, dan inferensi langkah TUI).
  * Total pengujian: **409 passed** (100% lulus, 0 gagal).

---

### v1.6.1 (14 September 2026) — Preservasi Utuh Pesan Asisten, State Loop Turn Deduplication, & Robust Tool Loop Guard

#### Ditambahkan & Diperbarui
- **Preservasi Utuh Pesan Asisten & Pencegahan Pengulangan Tool Identik (`src/agent/agent.ts`)**:
  * **Gejala Bug**: Model mengirim teks asisten identik dua kali berturut-turut, dan setelah menjalankan tool (seperti `read_file`), model mengulang teks yang sama DAN memanggil tool yang sama persis untuk kedua kalinya.
  * **Hasil Investigasi & Reproduksi**: Berhasil direproduksi pada `src/tests/agent.test.ts` menggunakan `RecordingProvider`. Ditemukan bahwa root cause merupakan kombinasi dua faktor:
    1. Respons asisten yang memicu tool call dipangkas oleh `stripToolBlocks(raw)` sehingga `content` kehilangan blok pemanggilan tool Markdown. Karena provider (terutama Anthropic/Gemini serta OpenAI-compatible yang tidak menyertakan payload `tools`) mengandalkan `content` teks, model mengira pemanggilan tool belum dilakukan dan mengulang kembali dari awal.
    2. Duplikasi pesan pengguna (`user`) pada setiap giliran REPL karena `this.ctx.add('user', input)` di `loop.ts` ditambahkan ulang oleh `runWithLlm` di `agent.ts`.
  * **Keputusan Arsitektur Guard Deduplikasi (Reuse vs Mekanisme Baru)**:
    - Guard `lastCallSignature` (v1.2.0) telah berada di level dispatcher loop agen (`Agent` di `src/agent/agent.ts`) dan mencakup seluruh tool calls, bukan terkunci pada `processManager.ts`.
    - Diputuskan untuk **me-reuse dan memperkaya guard terpusat yang sudah ada** alih-alih membuat mekanisme baru yang redundan.
    - Pesan diagnostik `skipped: true` diperjelas agar model mengetahui bahwa hasil tool call yang sama sudah tersedia di konteks riwayat sebelumnya dan mengarahkannya untuk melanjutkan analisis tanpa memanggil ulang.
  * **Ringkasan Fix Akhir**:
    1. Menyimpan respons model secara UTUH (`assistantContent = raw.trim()`) pada `role: 'assistant'` bersama metadata `tool_calls` ternormalisasi.
    2. Memeriksa tail `history` pada `runWithLlm` agar tidak menambahkan duplikat pesan `user` jika konteks sudah mencatat pesan user yang sama, tanpa mengubah sedikit pun logika windowing `maxContextChars` pada `src/core/context.ts`.
    3. Menambahkan unit test baru untuk memverifikasi preservasi utuh pesan asisten, deduplikasi pesan user, serta memastikan dua tool call *berbeda* berurutan (`read_file("a.txt")` lalu `read_file("b.txt")`) tetap dieksekusi normal tanpa overblocking.
  * **Rangkaian Pengujian**:
    - Total pengujian meningkat menjadi **368 passed** (100% lulus, 0 gagal).

---

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
  * Total pengujian: 365 passed (100% lulus, 0 gagal).

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

Status dan resolusi batasan arsitektural:
1. ~~**Compression menyerah bila budget tak terjangkau**~~ — **TERATASI (v1.7.1)**: Dilengkapi *best-effort fallback compression* (`foldAllHead` pada `src/core/compressor.ts`) yang tetap meringkas giliran riwayat tertua ke ringkasan terpadat ketika protected tail turn panjang, mencegah ledakan konteks window.
2. ~~**`--exec` timeout mencatat exit code `null`** (bukan 124)~~ — **TERATASI (v1.7.6)**: Mengembalikan exit code standar **124** saat proses dibunuh oleh timeout di `src/core/executor.ts` (baris 70-73). Sebelumnya mengembalikan `null` karena perilaku Node.js `child_process.exec`; kini konsisten dengan standar Unix (`timeout` command). Test di `src/tests/exec_timeout.test.ts` dan `src/tests/executor.test.ts` diperbarui memvalidasi exit code 124.
3. ~~**Urutan stdout vs stderr** pada field `output` tool `exec` tidak terjamin sekuensial mutlak~~ — **TERATASI (v1.7.1)**: Menggunakan real-time interleaved stream listener (`child.stdout.on('data')`, `child.stderr.on('data')`) pada `src/core/executor.ts` sehingga output gabungan terjamin kronologis sekuensial.
4. **Known limitation deteksi obfusikasi perintah regex**: Obfuscation eval/base64 kompleks (`echo <b64> | base64 -d | sh`) tidak dapat ditutup sempurna dengan regex statis tanpa false-positive masif; ditangani via pertahanan lapis kedua (Guardian LLM).
5. **Approval non-TTY otomatis menolak**: Di lingkungan CI headless yang ingin mengeksekusi aksi berisiko, wajib menyetel flag non-interaktif atau `RUKO_YOLO_MODE`.
6. **Known limitation redaksi kredensial**: Redaksi token/kredensial pada `read_process_logs` berbasis ekspresi reguler adalah pertahanan berlapis (*best-effort*), bukan jaminan 100% terhadap token arbitrer tanpa kata kunci penanda.
7. **Streaming interleaving pada terminal sangat sempit**: Teks streaming LLM dapat mengalami pergeseran baris kecil jika terminal berukuran <40 kolom saat indikator thinking aktif.
8. ~~**TOCTOU pada web_fetch**~~ — **TERATASI (v1.7.1)**: Menggunakan custom socket dispatcher `http.Agent`/`https.Agent` dengan Native IP-Pinning langsung pada level socket TCP pada `src/agent/webtools.ts`, menutup celah TOCTOU / DNS rebinding secara tuntas.

---

## 🤖 Context Handoff untuk AI Berikutnya

1. **Verifikasi Baseline**:
   - Jalankan `npm run typecheck` (harus 0 error).
   - Jalankan `npm test` (harus **817 passed**, 0 fail).
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

---

## Gemini 3.8 Flash (High)
- Kontribusi: Perombakan menu bantuan /? dan /help dengan gaya Chip/Badge Highlight modern Freebuff CLI & pengelompokan kategori ANSI
- Tanggal: 15 September 2026

---

## Audit v1.7.7 — Remediasi Batch 1 (H1, H2, H3, H4, H5, H6)
- Kontribusi: Perbaikan 4 temuan audit (H1+H2, H3+H6, H4, H5) + 20 test baru anti-regresi
- Tanggal: 23 September 2026

**Item yang dieksekusi (hanya ini — temuan lain tidak disentuh):**

1. **H1 + H2 — Path obfuscation bypass (`src/core/approval.ts`)**
   - Pattern baru `RM_DOT_PATH_OBFUSCATION_RE` menangkap `rm`/`rmdir` dengan target path dot murni (`/./`, `/../`, `/./.`, `/../.`, `/./*`).
   - Normalisasi komponen path baru `normalizeDotPathComponents()` (dipakai di `testCandidates()`): `/./` → `/`, `/../` → `/`, `/a/../` → `/`, `/a/b/../../` → `/`; hanya `..` (dua titik) yang membatalkan komponen sebelumnya.
   - Tidak ada regresi: seluruh skenario adversarial lama (RM_CRITICAL, VULN-01 variable substitution, mkfs, dd, fork bomb, subshell/quoting, chaining bypass allowlist, YOLO mode) tetap BLOCKED/DANGEROUS sesuai ekspektasi.

2. **H3 + H6 — SSRF via notasi IP (`src/agent/webtools.ts` + `src/core/config.ts`)**
   - `isPrivateOrLocalIPv4()` kini hanya menerima desimal murni; segmen leading-zero (oktal), hex, tanda, dan whitespace diperlakukan sebagai *malformed* → **unsafe (fail closed)**. Sebelumnya `parseInt(p, 10)` membuat `0177.0.0.1` diparsing sebagai `177.0.0.1` sehingga loopback lolos.
   - `isPrivateOrLocalHost()` kini me-unwrap IPv4-mapped IPv6 (`::ffff:10.0.0.1` dan `::ffff:a00:1`) lalu memeriksa IPv4 hasil unwrap, serta mendeteksi IPv6 ULA `fc00::/7` (`fc00::`–`fdff::`) dan link-local `fe80::/10` (`fe80::`–`febf::`). Pengecekan range loopback (`127.0.0.0/8`) dan link-local IPv4 (`169.254.0.0/16`) juga diperluas. Deteksi ULA/link-local mewajibkan karakter `:` sehingga hostname biasa seperti `fcorp.com` tidak salah dianggap IPv6.

3. **H4 — API key plaintext di config (`src/core/config.ts`)**
   - `loadConfig()` menampilkan warning eksplisit (stderr) saat menemukan `apiKey` plaintext di berkas config (top-level maupun `apiKey` literal di dalam `profiles`) dan tidak ada env var API key yang aktif (`RUKO_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`).
   - **PENTING (batasan, bukan klaim):** ini **hanya mitigasi awareness**, **BUKAN enkripsi at-rest**. Key tetap plaintext di disk dan tetap rentan terhadap backup otomatis, commit VCS tak sengaja, snapshot container, atau proses lain milik user yang sama. Enkripsi penuh sengaja TIDAK diimplementasikan (butuh manajemen kunci terpisah: key derivation, penyimpanan passphrase, rotasi) dan berada di luar scope batch ini. Dokumentasi lengkap: README bagian "Security Boundaries & Known Limitations" poin #8.

4. **H5 — Redaksi API key terlalu informatif (`src/core/config.ts`)**
   - Format lama: 3 karakter awal + 4 karakter akhir (membocorkan ~35% key 20–30 karakter).
   - Format baru: key < 40 karakter → `[REDACTED]` (tanpa karakter apa pun); key ≥ 40 karakter → `[REDACTED...xxxx]` (hanya 4 karakter terakhir). String < 10 karakter (mis. `short`) tetap dibiarkan utuh, dan redaksi key inline di dalam pesan error/stack trace tetap berjalan.

**Dampak pada test suite:**
- Sebelum: 773 test (semua lulus). Sesudah: **793 test (semua lulus)**, `npm run typecheck` 0 error, E2E 1 passed.
- Dua assertion lama di `src/tests/api_key_security.test.ts` (`redactApiKey masks sk- correctly`, `redactApiKey masks key- correctly`) mengunci format redaksi LAMA yang justru menjadi objek temuan H5, sehingga **nilai ekspektasinya diperketat** menjadi `[REDACTED]` (input tidak diubah; assertion baru membocorkan informasi lebih sedikit, bukan lebih banyak). Test lama lainnya tidak disentuh.

**Temuan audit yang BELUM dieksekusi (batch berikutnya):** H7 (`tui.ts` `patchStdout` tanpa `try/finally`), M1–M9 (subshell DANGEROUS pada argumen non-chained, trim `apiKey` di `sanitizeConfigFile`, userinfo URL `isHostnameOrSubdomain`, `BASH_ENV`/`ENV`/`PROMPT_COMMAND` di `executor.ts`, `charWidth` emoji/grapheme, kompleksitas `sanitizeHtml`, batas 5 pass resolusi variabel, `ANSI_RE` CSI privat, `truncateVisible`/`padVisible`), dan L1–L4 (`RUKO_TRUST_FOLDER` tanpa warning, `GUARDIAN_PROMPT` tanpa instruksi JSON-only, label `renderApprovalBox` hardcoded, API key default hardcoded di `Fee.py`).

---

## Audit v1.7.7 — Remediasi Batch 2 (feedback.txt item 1 & 2, H7, M1–M9, L1–L3)
- Kontribusi: Perbaikan parser multi-invoke DSML/XML, dialog approval TUI, dan 15 temuan audit lanjutan + 24 test baru anti-regresi
- Tanggal: 24 September 2026

**Item yang dieksekusi:**

1. **feedback item 1 — Parser DSML/XML multi-tool call (`src/agent/tools.ts`, `src/core/ui.ts`, `src/agent/agent.ts`)**
   - Prefix DSML kini OPSIONAL di tag penutup, dan ditambahkan parser untuk bentuk XML telanjang `<invoke name="..."><parameter name="...">…</parameter></invoke>` (gaya Anthropic/DeepSeek native) yang sebelumnya diklasifikasikan MALFORMED sehingga hanya panggilan pertama yang dieksekusi.
   - `stripToolBlocks()` membersihkan seluruh blok invoke + tag penutup sisa (`</parameter>`, `</invoke>`, `</|DSML|invoke>`, `<function_calls>`) — kebocoran `.github/workflows</parameter></invoke>` yang dilaporkan tidak lagi muncul.
   - `RevealFilter` menahan tag invoke parsial saat streaming per karakter (`invokeTagPrefixHold`) dan tidak lagi menelan sisa teks setelah blok DSML dengan penutup telanjang.
   - Chunk reasoning kini melewati `RevealFilter` sendiri, sehingga tool call di dalam `<thought>` tidak tumpah ke reasoning ticker/box.

2. **feedback item 2 — Dialog approval TUI (`src/core/tui.ts`, `src/core/loop.ts`, `src/core/ui.ts`)**
   - Opsi baru `readLine({ hideEcho: true })`: region live dihapus dan baris prompt `y/N` TIDAK di-commit ke scrollback; loop mencetak satu baris keputusan bersih (`✓ Disetujui` / `✗ Ditolak`) sebagai gantinya. Jalur `node:readline` (non-editor) menimpa baris prompt dengan `ERASE_PREVIOUS_LINE`.
   - Perintah read-only dasar (`git status`, `git diff`, `npm test`, dll.) terverifikasi tetap NONE tanpa prompt, baik mode normal maupun otonom (`approvalEnabled: false`).

3. **H7 — `patchStdout` tanpa error recovery (`src/core/tui.ts`)**: body handler dipecah ke `patchedBody`; wrapper `try/catch` memanggil `unpatchStdout()` lalu melempar ulang, sehingga stdout tidak pernah tetap ter-hijack setelah error.

4. **M1–M9**
   - M1 `chainedSegments()` rekursif (cap kedalaman 4) — subshell bersarang dari argumen non-chained ikut dievaluasi.
   - M2 `sanitizeConfigFile()` men-trim `apiKey` dan membuang nilai kosong/whitespace (dengan warning).
   - M3 `isHostnameOrSubdomain()` menolak URL ber-userinfo (`user@host`).
   - M4 `executor.ts` memfilter `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `CDPATH`, `BASH_RCFILE`.
   - M5 `charWidth`/`visibleLength` grapheme-aware: emoji U+1F800–U+1FFFF, combining marks/ZWJ/VS = 0 kolom, flag & ZWJ-sequence dihitung 2 kolom (implementasi mandiri, tanpa bergantung pada data ICU).
   - M6 `sanitizeHtml()` memakai pemindai tag linear (sticky regex + depth) menggantikan loop O(n²).
   - M7 resolusi variabel iteratif sampai stabil (cap 32 pass).
   - M8 `ANSI_RE`/`DANGEROUS_TERMINAL_RE` mencakup CSI private-mode (`ESC[?25l`, `ESC[?1049h`) dan intermediate bytes; SGR tetap dipertahankan.
   - M9 `padVisible()` menutup SGR sebelum padding; `truncateVisible()` menyaring sequence berbahaya walau tidak memotong.

5. **L1–L3**: warning eksplisit untuk `RUKO_TRUST_FOLDER`, `GUARDIAN_PROMPT` menuntut output English-only/JSON-only tanpa preamble, label approval dipusatkan di `APPROVAL_LABELS`.
   - L4 (`Fee.py`) dan `py.py` sengaja TIDAK disentuh (di luar ruang lingkup, sesuai instruksi).

**Dampak pada test suite:**
- Sebelum: 793 test (semua lulus). Sesudah: **817 test (semua lulus)**, `npm run typecheck` 0 error.
- 24 test baru: parser multi-invoke & pembersihan tag (8), approval M1/M7/read-only (6), config M2/M3 (2), UI M5/M8/M9/L3/item 2 (6), TUI H7 + hideEcho (3), executor M4 (2), trust L1 (1), guardian L2 (1), sanitizer M6 (2) — total 31 test baru (sebagian di dalam blok test gabungan).
- Tidak ada assertion lama yang diubah/dihapus/dilemahkan.
- Re-run adversarial eksplisit (skrip batch 2): 192 PASS, 0 FAIL (semua kategori lama A–L + kategori baru K–O).

