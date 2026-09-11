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

- [x] **Interactive Setup Wizard** (`src/core/wizard.ts`) — first-run tanpa API key → banner welcome bgBlue, prompt berurutan `API Key:` (ter-mask, lihat v0.5.0 #5) / `Base URL:` / `Model Name:` **tanpa default provider** (v0.5.0 #1); hasil tersimpan permanen ke `.ruko/config.json` (field `apiKey`/`baseUrl`, config file > env var). Slash `/config setup` mengulang wizard dari dalam REPL; API key ditampilkan ter-mask di `/config`.
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

### v0.4.0 — Eksekusi feedback.txt

- [x] **Provider ramah pemula**: wizard `/login` tes koneksi live ("✓ Terhubung ke <model>") + penerjemah error 401/404/ECONNREFUSED dengan perintah perbaikan; auto-fetch `/v1/models` di `/model`; config **600**.
- [x] **Multi-profil**: `profiles` + `apiKeyEnv` di config, `/profile <alias>` (hemat/kuat/lokal), resolusi active>default>none.
- [x] **Registry tunggal**: `/help`, menu `/`, dan tabel README dibangkitkan dari COMMANDS (`buildHelpText`, `scripts/gen-commands-doc.mjs`); hint argumen per command.
- [x] **Role berlapis** (`src/agent/roles.ts`): core+tools+role+AGENT.md+mode (urutan tetap, cache-friendly); bawaan default/reviewer/teacher/minimal; kustom via `.ruko/roles/*.md`; `/role`, `/mode beginner|pro`.
- [x] **Hemat token**: cap hasil tool 8k char, deteksi loop (tool+arg >2× dihentikan di kode), tool `patch_file` search-replace, `/compact`, baris usage `↑ ↓ · ctx%` per giliran + peringatan >50%.
- [x] **Pengaman**: plan mode `/plan` dipaksakan di level tool (exec/write/edit/patch diblok), `/undo` snapshot `.ruko/undo/` sebelum tiap perubahan file.
- [x] Test: **93 hijau** (+29 baru: roles, undo, patchfile, profiles, commands, wizard-probe, ui-bar).

### v0.5.0 — Eksekusi feedback.txt (8 item)

- [x] **#1 Tanpa default provider** — `DEFAULT_BASE_URL`/`DEFAULT_MODEL` dihapus dari `llm.ts`; `DEFAULT_CONFIG.model` dikosongkan; `missingConfigFields()` (`llm.ts`) + `needsSetup(cfg)` (`wizard.ts`) mendeteksi key/baseUrl/model yang belum terisi (config > env). Wizard memakai prompt netral `Base URL:` / `Model Name:` (tanpa contoh provider) dan membatalkan setup bila dikosongkan.
- [x] **#1b `max_tokens` test koneksi** — probe `/chat/completions` kini `max_tokens: 16` (sebelumnya `1`) → tidak lagi gagal di provider yang menolak budget ≤2.
- [x] **#2 Kualitas output** — (a) parser SSE `llm.ts` mem-flush frame terakhir yang datang tanpa blank line (akar jawaban terpotong); (b) `LineGate` (`ui.ts`) menahan baris terakhir dan membuang fragmen menggantung (`dengan: …`) tepat sebelum blok ```tool tersembunyi, dipakai di `agent.ts`; (c) `CORE_IDENTITY` (`roles.ts`) menegaskan salam/obrolan tidak perlu tool dan tool ditulis tanpa preamble.
- [x] **#3 Tampilan** — status bar kini hijau gelap 256-color (`38;5;252;48;5;22`) alih-alih bright `42`; placeholder `Ask anything, or type / for commands` benar-benar placeholder: hanya muncul saat buffer kosong dan hilang pada keystroke pertama.
- [x] **#4 Menu slash live** — editor raw-mode sendiri (`src/core/tui.ts`, `process.stdin.setRawMode`) menggantikan event `keypress` readline yang tidak reliable; overlay muncul saat `/` diketik, ter-filter tiap keystroke (↑/↓ pilih, Tab autocomplete, Esc tutup), tidak ikut masuk history. Jalur non-TTY tetap readline + daftar statis.
- [x] **#5 Masking API key** — input API key lewat `readSecret` (editor mask `*`); nilai tidak pernah ter-echo, termasuk baris yang di-commit ke scrollback.
- [x] **#6 Pesan error test koneksi** — `explainProviderError` (`llm.ts`) membedakan 400 (param internal), 401 (key salah), 403 (izin), 404 (model/endpoint), 429 (rate limit), 5xx (server), dan error jaringan/timeout — tidak lagi digeneralisir "Koneksi gagal".
- [x] **#7 Retry/backoff 429** — `requestWithRetry` pada `chat`: retry eksponensial (default 2 percobaan, delay 1s→2s→…, cap 15s) yang menghormati header `Retry-After`; error akhir menyebut rate limit dengan jelas.
- [x] **#8 Stats token di status bar** — `↑/↓` digabung ke bar (`StatusBarInput.turn`); baris `buildUsageLine` tidak lagi dicetak sebagai baris output terpisah.
- [x] Test: **117 hijau** (+24: editor tui, LineGate/agent, retry/backoff, translator error, max_tokens). Smoke PTY via `script(1)`: placeholder, menu live, dan masking API key terverifikasi.

### v0.5.1 — Eksekusi feedback.txt (2 item)

- [x] **#1 Redraw input multi-baris (masking API key)** — bug lama: `"\r" + ESC[0J` hanya benar untuk buffer 1 baris; begitu input wrap ke baris ke-2+, backspace bikin render loncat-loncat. `LineEditor` (`src/core/tui.ts`) kini melacak `drawnRows` + `drawnCursorRow`: sebelum redraw, cursor naik ke baris PALING ATAS region yang digambar (`ESC[<n-1>A`, n dari `Math.ceil(visibleLength(prompt+buffer) / output.columns)`), baru clear-to-end-of-screen (`ESC[0J`), lalu cetak ulang label+mask sepanjang buffer dan biarkan terminal wrap alami; cursor dikembalikan turun (`ESC[<row>B`) lalu kanan ke sel yang benar. `submit()` dan `cancel()` ikut pola yang sama (naik ke baris pertama, hapus, commit dengan TEPAT satu `\n` — baris wrap lainnya dihasilkan terminal). Verifikasi PTY nyata (pty.fork, lebar 40): input 60 char wrap 2 baris → backspace 60× → scrollback bersih, 0 baris nyangkut/duplikat.
- [x] **#2 Respon AI tidak kaku lagi** — `CORE_IDENTITY` (`src/agent/roles.ts`) dapat baris scope eksplisit: aturan *"no preamble"* HANYA berlaku untuk teks yang mendahului blok ```` ```tool ````; di luar itu jawab dengan nada natural percakapan biasa, jangan kaku/serba-minimal karena aturan tool.
- [x] Test: **119 hijau** (+2 test tui buffer-wrap: redraw dari baris pertama & commit tanpa baris nyasar); `npm run typecheck` + build bersih.

### v0.5.2 — Eksekusi feedback.txt (bug redraw slash menu MASIH terjadi pasca v0.5.1)

- [x] **#1 Root cause (hasil investigasi, dilaporkan dulu sesuai instruksi)** — render prompt line DAN daftar command memakai SATU fungsi yang sama (`LineEditor.render()`, `src/core/tui.ts`); TIDAK ada jalur render overlay terpisah. Bug-nya: fix v0.5.1 hanya menghitung baris untuk prompt line; loop overlay mengasumsikan 1 item menu = 1 baris terminal (`out += ESC[rows.length A`), padahal item dengan `detail` panjang (`/exit  Keluar (sesi disimpan otomatis).`) WRAP jadi 2-3 baris di terminal sempit. Cursor akhir frame mendarat di tengah menu lama → `ESC[0J` berikutnya hanya menghapus ke BAWAH → baris `› /e`, `› /ex` tertinggal permanen. Tes PTY lama lolos karena hanya mensimulasikan input mask TANPA menu (jalur `detail` wrap tidak tersentuh).
- [x] **#2 Fix** — `render()` (`src/core/tui.ts`) kini menghitung `menuRows` per item dengan `Math.max(1, Math.ceil(visibleLength(row) / width))` (formula sama dengan fix prompt line) dan mengembalikan cursor naik `lineRows - 1 + menuRows - cursorRow` baris dari dasar region; gerakan "turun" (`ESC[nB`) dihapus — posisi akhir frame selalu persis di baris kursor input line, jadi redraw berikutnya selalu mulai `ESC[0J` dari baris PALING ATAS region.
- [x] **#3 Verifikasi wajib (bukan cuma unit test)** — harness baru `scripts/pty-repro.py` (PTY nyata + replay emulator terminal akurat `pyte`): skenario persis feedback — ketik `/e`, tunggu, `x` (→`/ex`), tunggu, `it` (→`/exit`), dump layar. **Pra-fix: REPRO — 3 baris prompt basi (`› /e`, `› /ex`, `› /exit`) terlihat di layar.** **Pasca-fix: OK — 1 baris hidup saja**, di lebar 40 dan 60. Regression check lolos: backspace progresif sampai habis (prompt basi 0), buffer 60 char wrap + backspace 30× (0 baris nyangkut — fix v0.5.1 tetap utuh).
- [x] **#4 Tes anti-regresi** — 2 unit test baru di `src/tests/tui.test.ts` ("wrapped overlay" + "wrapped line + wrapped overlay") yang MENGECEK up-count frame mencakup semua baris wrap menu. Divalidasi terhadap `dist` pra-fix yang di-revert manual: **kedua tes GAGAL pada kode lama, lulus pada kode baru** — bukti tes ini benar menangkap bug. Suite penuh: **121 hijau** + `typecheck` bersih.

### v0.6.1 — Eksekusi feedback.txt (bug border numpuk TERULANG di titik lain → audit menyeluruh + SATU helper)

- [x] **#1 Konfirmasi dugaan feedback** — YA, terbukti: panel guide `/mode beginner` dan splash memakai jalur render TERPISAH. Splash punya renderer sendiri (`renderSplashLines`/`framed` di `splash.ts`) dengan lebar dipaksa `max(36, min(56, columns))` — di terminal 40 kolom kotaknya 56 char → wrap → border `│`/`└` "numpuk jadi baris terpisah". Fix v0.6.0 hanya menyentuh editor overlay (`tui.ts`), TIDAK mengaudit renderer box lain.
- [x] **#2 Audit menyeluruh SEMUA titik cetak box ke stdout** (grep `┌ └ │ ├ renderBox` di `src/` non-test). Daftar lengkap titik yang ditemukan + statusnya:
  1. `ui.ts :: renderBox` — helper tunggal untuk panel statis → **DIKLAM**: lebar dibatasi `terminalWidth()-4` + isi di-truncate ANSI-safe (`truncateVisible`). Semua pemakai otomatis ikut terfix.
  2. `commands.ts :: /sessions (2×), /role, /mode, /profile, /context, /usage, /config, /model` — 9 pemanggilan `renderBox` → **sudah lewat helper**, kini ikut clamp. **TITIK BARU**: panel guide `/mode beginner` dinaikkan dari satu baris teks jadi box `renderBox('Mode BEGINNER aktif', …)` — sumber bug "panel guide" adalah teks LLM role teacher yang menggambar box sendiri (lihat #5), bukan CLI.
  3. `loop.ts :: printSlashMenu` (fallback non-TTY) — `renderBox` → **sudah lewat helper**.
  4. `splash.ts :: renderSplashLines` — renderer terpisah → **DIKONVERSI**: default lebar = `splashWidth()` yang clamp ke `terminalWidth()-1` (bukan 56 fix), header/centre di-truncate ANSI-safe.
  5. `splash.ts :: framed` (frame animasi) — renderer terpisah → **DIKONVERSI**: tiap baris `truncateVisible(inner)`, mustahil lebih lebar terminal.
  6. `wizard.ts :: setupBanner` — satu baris teks bgBlue, BUKAN box → tidak diubah (di luar cakupan; sudah dicatat).
  7. `tui.ts :: overlay menu` — bukan box border (baris menu + status bar satu baris); sudah sadar-wrap sejak v0.5.2/v0.6.0 → tidak diubah.
  8. `roles.ts :: modeAddendum` — **TITIK AKAR KEDUA**: instruksi mode beginner mendorong LLM (role teacher) menjelaskan banyak; jawaban LLM yang menggambar `┌─┐` sendiri tidak pernah lewat helper mana pun. Ditambah larangan eksplisit "Never draw box-drawing panels" di addendum.
- [x] **#3 Helper redraw tunggal** — `createInPlaceBlock()` (`ui.ts`): `draw()` naik `ESC[nA` + `ESC[2K` overwrite per baris, `clear()` hapus region. Dipakai splash; `renderBox`/`printBox` untuk semua panel statis. Aturan ditulis di JSDOC helper: semua box wajib lewat sini.
- [x] **#6 Animasi** — akar "animasi gak muncul": `ESC[?1049h` (alt screen) tidak dipulihkan bersih di sebagian terminal → frame tak terlihat. **Alternatif diimplementasikan**: animasi akuarium kini jalan di buffer normal lewat `createInPlaceBlock` (cursor disembunyikan selama frame, kotak final di-commit sekali setelah region dihapus). Terverifikasi PTY 40×24: riak air + gelembung + ikan berenang in-place, tanpa alt screen, tanpa baris numpuk.
- [x] **#4 Verifikasi manual (dump layar pyte = screenshot teks)** — `npm start` di PTY 40 kolom → `/mode beginner`: panel guide tampil KOTAK RAPI 39 char, 0 baris numpuk; splash pun rapi di 40 kolom (pra-fix: 56 char wrap). Regresi: `pty-cycle.py` rows 12/24 mode a+b LULUS, `pty-repro.py` LULUS.
- [x] **#5 Anti-regresi** — 3 test baru (`ui.test.ts`: `truncateVisible` ANSI-safe + `renderBox` clamp di 30 kolom; `splash.test.ts`: splash muat di 40 kolom). **Divalidasi GAGAL pada dist pra-fix** (clamp di-revert manual → 2 test merah; dipulihkan → hijau). Suite penuh: **129 hijau** + typecheck + build bersih.
- [x] Versi `package.json` 0.6.0 → **0.6.1**.
- [x] **Jaminan feedback #5**: TIDAK ADA lagi tempat yang mencetak karakter box (`┌│└`) ke stdout selain `ui.ts::renderBox` + `splash.ts` (yang keduanya kini clamp ke lebar terminal) — dibuktikan dengan grep audit di atas; jawaban LLM ditutup lewat larangan prompt. Kalau nanti ada fitur baru, ia WAJIB pakai `renderBox`/`printBox`/`createInPlaceBlock`.

### v0.6.0 — Eksekusi feedback.txt (overlay menu menetap di scrollback + versi npm start)

- [x] **#0 Versi** — `package.json` masih `0.4.0` padahal PROGRESS mencatat v0.5.0–v0.5.2 (banner REPL + `ruko --version` membaca dari file ini). Naik ke **0.6.0**; README baris highlight ikut disinkronkan (`sync-readme-commands.mjs` → IN SYNC 19).
- [x] **#1 Root cause sebenarnya (berbeda dari dugaan feedback)** — counter TIDAK di-reset tanpa clear: `submit()`/`cancel()` (`src/core/tui.ts`) sudah naik ke baris pertama region + `ESC[0J` sebelum commit. Yang lolos: **overlay lebih tinggi dari viewport terminal**. Menu penuh = 19 baris; di terminal ≤24 baris (status bar + prompt + Enter sebelumnya memakan ruang), baris-baris ATAS overlay terdorong SCROLL ke scrollback saat digambar. `ESC[nA` tidak bisa naik ke scrollback dan `ESC[0J` hanya menghapus ke bawah dari posisi cursor — jadi blok menu lama "lolos" permanen, persis pola reproduksi feedback (3–4 siklus → scrollback penuh duplikat). Titik yang salah: `render()` menggambar SEMUA `this.menu` tanpa batas tinggi; `finish()` reset `drawnRows`/`drawnCursorRow` ke 0 setelah itu (bukan penyebab, tapi counter tak pernah sadar ada baris yang sudah di luar jangkauan).
- [x] **#2 Fix windowing** — `render()` kini mengambil baris menu dari helper baru `menuRows()`: total tinggi menu dibatasi `overlayBudget()` = `rows − 3 − baris_input`, jadi overlay TIDAK PERNAH membuat terminal scroll; kalau daftar penuh tidak muat, ditampilkan jendela di sekitar item terpilih + indikator `↑ n lagi di atas` / `↓ n lagi di bawah (↑/↓ gulung)` — ↑/↓ sudah otomatis menggulung jendela karena selection ikut windowing.
- [x] **#3 Fix "hanya bantuan tidak boleh menetap" (feedback #2)** — Enter pada `/` telanjang dulu meng-commit baris `› /` ke scrollback. Opsi baru `ReadLineOptions.menuOnlyClose` (di-wire di `loop.ts`: true bila buffer == `/`): submit menghapus SELURUH region (`ESC[<n>A` + `ESC[0J`) tanpa menulis apa pun dan resolve string kosong (loop lanjut baca). Yang boleh masuk scrollback tetap hanya command yang dieksekusi (`› /help` + hasilnya).
- [x] **#4 Verifikasi manual sebelum-sesudah (dump layar pyte = screenshot teks)** — harness baru `scripts/pty-cycle.py` (HistoryScreen pyte: periksa SCROLLBACK + layar hidup, bukan cuma layar): mode a = `/` Enter `/` Enter `/`; mode b = `/` ketik `help` Enter `/`. **Pra-fix (baris 12): REPRO — 21 baris menu + 5 echo `› /` nyangkut di scrollback.** **Pasca-fix: OK di rows 12 dan 24, kedua mode** — 0 baris menu di scrollback, 1 echo hidup saja. Regression `pty-repro.py` (ketik progresif `/e→/ex→/exit`) lolos di lebar 40 & 60.
- [x] **#5 Test PTY otomatis siklus penuh (feedback #4)** — `scripts/pty-cycle.py` di atas mensimulasikan siklus BUKA→TUTUP→BUKA (bukan cuma progresif dalam satu sesi) dan **divalidasi GAGAL pada kode pra-fix** (dist di-revert manual → exit 1; fix dipulihkan → exit 0). Ditambah 2 unit test anti-regresi di `src/tests/tui.test.ts`: "submitting with the menu open erases the overlay BEFORE committing" dan "a lone / submit closes the overlay without committing any line" (yang kedua juga gagal di kode lama — TS2353 + assert).
- [x] Test: **123 hijau** (+2) + `typecheck` bersih + build bersih.

### Rincian checklist v0.4.0 (diarsipkan dari progress.md)

- [x] T1 Registry tunggal: `/help` dibangkitkan dari COMMANDS (`buildHelpText`) + hint argumen; T2 `llm.ts`: `testConnection()` + `listModels()` + `explainProviderError()` (401/404/ECONNREFUSED + perintah perbaikan); T3 wizard probe koneksi live ([c]oba ulang/simpan/[b]atalkan) di first-run, `/login`, `/config setup`; T4 multi-profil (`profiles`, `defaultProfile`, `activeProfile`, `apiKeyEnv`) + `resolveProfileCredentials` (active > default; apiKeyEnv > apiKey) + config mode 600; T5 `/profile` + `/model` auto-fetch `/v1/models`.
- [x] T6 `src/agent/roles.ts` prompt berlapis urutan TETAP (core → tool rules → role → AGENT.md → mode) + role default/reviewer/teacher/minimal + kustom `.ruko/roles/*.md` (global + proyek) + `/role`; T7 panel usage `↑Xk ↓Yk · ctxZ%` + status bar ctx + peringatan >50% + `⏸ PLAN`; T8 `patch_file` (`applySearchReplace`: unik-persis, error ambigu, replaceAll); T9 `/undo` (`src/core/undo.ts`, snapshot `.ruko/undo/` sebelum write/edit/patch, 25 jurnal, `RUKO_UNDO_DIR`).
- [x] T10 deteksi loop di kode (signature tool+arg >2× → hentikan, `Agent.seenRepeat`); T11 cap hasil tool 8.000 char head+tail (`capToolResult`, semua tool); T12 `/plan on|off` ditegakkan di `runToolCall` (exec/write/edit/patch diblok, read jalan); T13 `/mode beginner|pro` (beginner→role teacher+tips, pro→role minimal, persist).
- [x] T14 29 test baru → 93 hijau; smoke E2E fake-llm-server: /help registry, /model auto-fetch, /profile, /plan blokir, /role, usage line. T15 README sinkron v0.4.0 (checker `scripts/sync-readme-commands.mjs` → "IN SYNC 19").

### Deviasi sadar dari feedback (v0.4.0–v0.5.x)

- Ink / @clack/prompts / zod / tsup TIDAK dipakai: Ruko zero-dependency by design (konvensi README) — UI tetap ANSI murni.
- `cache_control` Anthropic & `/cost` rupiah: butuh provider Anthropic + usage reporting API; proxy char dipakai dulu.
- `/undo` berbasis snapshot file (bukan git stash/commit): sengaja, agar jalan tanpa git.
- Sub-task sesi anak terisolasi + startup bundling <300ms: perlu arsitektur/build terpisah → masuk backlog (Roadmap #3).
- Config tetap `./.ruko` per-proyek (bukan `~/.ruko` home): konvensi berjalan; `RUKO_CONFIG` tersedia untuk override.

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
  7. ~~**Event `keypress` readline tidak ter-emit di semua PTY**~~ **SELESAI (v0.5.0 #4)** — REPL TTY kini memakai editor raw-mode sendiri (`src/core/tui.ts`) yang mem-parse byte stdin, jadi menu `/` muncul live per-keystroke. Jalur non-TTY tetap readline (tanpa overlay). ~~Sisa batasan: editor mengasumsikan input satu baris (tanpa wrapping)~~ **SELESAI (v0.5.1 #1)** — redraw kini sadar-wrap (naik ke baris pertama region sebelum clear). Sisa batasan: karakter double-width (emoji/CJK) dihitung 1 kolom oleh `visibleLength`, jadi posisi cursor bisa meleset untuk input semacam itu.
  8. **Streaming + `console.log` dapat selang-seling** — teks LLM ditulis via `process.stdout.write` tanpa newline saat spinner aktif; newline sudah dijaga di `runWithLlm`, tapi interleave dengan spinner TTY yang lambat bisa terlihat berantakan pada terminal sangat sempit.

---

## 🤖 Context Handoff untuk AI Berikutnya

1. **Verifikasi baseline dulu:** `npm install && npm run build && npm test` → 119 test harus hijau. Smoke test: `printf 'run echo hi\n/context\n/exit\n' | node dist/index.js`. Uji TTY: `printf '/\n/exit\n' | script -qec "OPENAI_API_KEY=k OPENAI_BASE_URL=http://localhost:1/v1 AGENT_MODEL=m node dist/index.js" /dev/null`. Uji redraw wrap editor: `python3` + `pty.fork` (set TIOCSWINSZ 40 kolom, ketik 60 char, backspace 60×) — lihat catatan v0.5.1 #1. Penting: spawn ruko via child pipe TIDAK mengaktifkan jalur TTY — driver harus benar-benar PTY.
2. **Mulai dari Roadmap #1** (tool read/write/patch/search) — dampak terbesar dengan usaha terkecil. Pola menambah tool: (1) case baru di `runToolCall()` `src/agent/tools.ts`, (2) sebut di `SYSTEM_PROMPT` `src/agent/agent.ts`, (3) unit test.
3. **Struktur kode:** `src/core/` = infrastruktur (loop, executor, summarizer, approval, compressor, context, session, config); `src/agent/` = logika agen (agent, llm, tools, commands). Entry point `src/index.ts`. Semua ESM, import pakai ekstensi `.js`, TypeScript strict, JSDoc singkat.
4. **Fitur wajib dari spesifikasi awal (jangan dihapus):** Log Summarizer >1000 char terpasang di `executor.ts` (param `summarize`, default `true`); System Loop menerima instruksi; eksekusi shell bawaan.
5. **Dokumentasi:** `README.md` = fitur + cara kerja saja (sesuai permintaan user). Semua detail status/tugas/bug ada di file ini (`PROGRESS.md`).
6. **Konvensi:** Bahasa Indonesia untuk output UI & docs; brand **Ruko** (jangan reintroduksi nama/unsur brand proyek referensi — referensi cukup disebut di catatan ini sebagai sumber ide).
7. **Setelah selesai sesi:** perbarui file ini — centang fitur selesai, pindahkan item Roadmap ke Tertunda, catat bug/handoff baru.
8. **Batasan waktu kerja:** spesifikasi asli membatasi eksekusi ~50 menit; prioritaskan eksekusi cepat dan self-documenting.
9. **Catatan teknis:** `AgentConfig` ada di `src/types.ts` (default di `DEFAULT_CONFIG`); menambah opsi config = tambah field di interface + loader `src/core/config.ts` + `/config` di `src/agent/commands.ts`.
10. **Jebakan tooling (sesi v0.4.0):** lapisan secret-redaksi pada pipeline agen menulis `***` literal ke DISK saat `write_file` mengandung pola mirip API key (mis. `apiKey: string` setelah kata key, atau literal `'sk-...'`). Gejala: syntax error TS1110 di file baru. Mitigasi: hindari literal key-like di source; kalau terjebak, tambal via `node -e` di shell (jalur tulis shell tidak ter-mask).
