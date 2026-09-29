# PROGRESS — Ruko AI Coding Agent CLI

> Ringkasan status pengerjaan & checkpoint handoff untuk AI berikutnya.  
> Histori lengkap dipindahkan ke [CHANGELOG.md](CHANGELOG.md).

## ⚠️ Keamanan — Temuan Penting dari Review PR #22 (29 Sep 2026)

1. **Bypass sandbox tulis via symlink di Windows (C1, TERTUTUP)**: libuv **mengabaikan `O_NOFOLLOW`** — `edit_file` lewat symlink file yang menunjuk keluar workspace BERHASIL MENULIS di luar sandbox. Fix di `writeWithDiff()`/`readFileTool()`: guard eksplisit `lstat` symlink → `assertInsideWorkspace(realpath)` + deny-by-default internal (commit `134888d`). Detail lengkap di CHANGELOG.md. **Pelajaran: jadikan `O_NOFOLLOW` satu-satunya lapisan anti-symlink lintas platform.**
2. **Perilaku libuv Windows yang wajib diingat (semua telah difix, CI hijau 9/9)**:
   - `PSModulePath` ter-set machine-wide → jangan dipakai sebagai sinyal sesi PowerShell (`env.ts` kini hanya percaya ComSpec eksplisit).
   - `cmd /d /s /c` melepas kutip luar → command ber-quote wajib dibungkus kutip luar tambahan (executor runtime), jika tidak node masuk mode REPL (hang).
   - `spawn detached+unref` + pipe → data stdout tak pernah sampai ke parent; `detached` hanya untuk POSIX (taskkill /T tidak butuh detachment).
   - `fs.realpath` async → long-name (`runneradmin`) vs `realpathSync` → 8.3 (`RUNNER~1`): containment membandingkan ke SEMUA bentuk workspace via `workspacePathForms()` (lexical + realpath + realpath.native). Sandbox tetap menolak symlink escape.
3. **Follow-up keamanan terbuka (non-blocking)**: `workspaceRoot` di system prompt layer (`roles.ts`) belum disanitasi dari newline/control chars — permukaan prompt-injection kecil; sanjung saat refactor prompt berikutnya.

## Status Saat Ini — v1.9.0 (29 Sep 2026)

- **Versi**: 1.9.0 (stable)
- **Tests**: 1064 total — 1063 passed, 0 failed, 1 skipped (test khusus win32; di Linux/macOS di-skip)
- **E2E**: 1 passed
- **Typecheck**: clean
- **Node**: >=18.0.0; CI matrix Linux + Windows + macOS × Node 18.x/20.x (+ 22.x di Linux)
- **Dependencies**: 0 runtime (zero-dep) — ditegakkan otomatis oleh `src/tests/zero_dependency_guard.test.ts`

### Apa yang Baru (29 Sep 2026) — Konteks OS/Shell di System Prompt + Cross-Platform Test & CI

- **Fix macOS (temuan job CI `macos-latest`)**: `src/core/undo.ts` menilai containment snapshot pada bentuk **fisik** (symlink di-resolve) — `/undo` tidak lagi menolak berkas workspace sendiri saat workspace ber-symlink (`/var/folders` → `/private/var/folders`, `process.cwd()` selalu bentuk fisik); sekaligus menutup escape lewat directory symlink yang lolos dari cek lexical lama. +2 test regresi di `src/tests/undo.test.ts`

- **Konteks lingkungan otomatis**: `formatEnvironmentContext()` (`roles.ts`) menyuntikkan OS/shell/pemisah path + aturan perintah (Windows vs POSIX) ke system prompt via `Agent.systemPrompt()`; memakai `getEnvProfile()` yang sama dengan `executor.ts` → model tidak lagi mengirim `grep`/`rm -rf`/`$VAR` di cmd.exe. Test: `src/tests/env_prompt_context.test.ts` (8 test)

- **Fix `ERR_INVALID_URL` Windows**: konstruksi file URL `'file://' + path` dihapus total dari suite; semua path → URL lewat `pathToFileURL()` (`node:url`) di helper baru `src/tests/helpers/platform.ts`, dan injeksi URL ke `.mjs` mock memakai `JSON.stringify()` (escape-proof)
- **Runner test cross-platform** `scripts/run-tests.mjs`: enumerasi `dist/tests/**/*.test.js` di Node lalu `node --test <argv…>` — tidak bergantung ekspansi glob shell (cmd.exe/PowerShell tidak meng-expand) maupun directory-mode Node yang berubah antar generasi; dukung `--filter`
- **Spawn tanpa shell**: `runNodeSync()`/`runNodeAsync()` memakai `process.execPath` + array argv (`execFile`), stdin eksplisit (`echo "n" | node` diganti `input: 'n\n'`), env dibersihkan dari `RUKO_*` warisan → deterministik di RDP/CI
- **Kelas kegagalan Windows lain ikut diperbaiki**: path relatif via `path.relative()` (bukan replace string), `windowsVerbatimArguments` di `executor.ts` (quote `node -e "..."` tidak lagi rusak di cmd.exe), symlink direktori jadi **junction** via `tryCreateSymlink()` + skip bila tanpa hak, assertion bit `0o600` dijaga `!== 'win32'`, dan perintah POSIX-only di `executor.test.ts` diganti padanan Windows
- **Suite regresi baru**: `src/tests/platform_paths.test.ts` (7 test — round-trip URL, penolakan string malformed, bukti korupsi concat/interpolasi mentah, import `.mjs` mock, drive letter & UNC khusus win32) + `src/tests/zero_dependency_guard.test.ts` (4 test — kontrak zero-dep di package.json, lockfile, `src/**`, `dist/**`)
- **CI matriks multi-OS** `.github/workflows/ci.yml`: 7 job (ubuntu/windows/macos × Node 18.x/20.x + 22.x di Linux), `fail-fast: false`, trigger `push` ke `main` & `feat/**`, `workflow_dispatch`, plus `scripts/ci-diagnostics.mjs` yang otomatis mencetak platform/temp-path/URL saat gagal
- **Diverifikasi**: `TMPDIR="/tmp/ruko tmp#a%20b"` (spasi + `#` + `%`) → suite tetap 1053 pass / 0 fail
- **Catatan**: nama job CI berubah → perbarui daftar required status checks di branch protection `main` (nama baru tercantum di `.github/SECURITY.md`)

### Apa yang Baru di v1.8.0 — UI Overhaul 6 Fase + Fix Loop Detector

- **Fase 1 — `/mode`**: popup selector (Default/Research/Code/Build), state per-sesi in-memory; efek ke loop detector via parameter injection (`loopThreshold`, `readOnlyRelaxed`, `buildPhase: explore→mutate` permanen saat tool mutating pertama) — algoritma inti deteksi tidak disentuh
- **Fase 2 — `/reasoning` + wiring provider**: High/XHigh/Max/Extreme (default XHigh); param native per provider (`reasoning_effort` / `thinking.budget_tokens` / `thinkingConfig.thinkingBudget`) + fallback prompt injection otomatis saat endpoint menolak — request tidak pernah gagal
- **Fase 3 — Panel Reasoning terpisah**: box `─ Reasoning (collapsed) ▼`, ringkasan `Thought for Xs (Y tokens)` (Y hanya jika tersedia dari usage), toggle `Ctrl+R`, buffer streaming per-baris + throttle 100ms
- **Fase 4 — Diff ringkas**: `✍️ <tool> <file>   +N -M   Xs` untuk write/edit/patch_file; detail diff default collapsed, toggle `Ctrl+D`; N/M dihitung algoritma LCS yang sama dengan renderer → selalu cocok dengan diff aktual
- **Fase 5 — Status bar dipisah**: info model & task background tidak menumpuk kotak Terminal; hint tray `-- N more, ctrl+o to expand` hanya saat task aktif >= 2 (Ctrl+O tetap); indikator `mode:<aktif>  reasoning:<level>` responsif
- **Fase 6 — Placeholder & lokalisasi**: `"/? untuk bantuan, tanya apa saja..."` (dim), hilang total saat mengetik, muncul kembali saat buffer kosong
- **Fix loop detector**: dedup tool call duplikat within-batch kini berlaku juga di jalur non-streaming (deteksi siklus N-gram tidak diubah)

### Rilis Sebelumnya (Ringkas)

#### v1.7.7 — UI Revamp, Anti-Loop Tri-Layer (3-1-2), Security Hardening
- Inline duration `(11ms)`, framed reasoning box `┌─ Reasoning ─`, smart path truncation `truncatePath()`
- Tri-layer anti-loop: in-turn idempotent cache, stream-level dedup, N-gram cycle detection
- Security: ReDoS fix, clear-text logging fix, TOCTOU fix (O_NOFOLLOW), CodeQL 0 alerts
- Installer: immutable SHA pinning, atomic swap, rollback otomatis

#### v1.7.6 — Universal Fallback Parser & Visual Polish
- Parser universal: XML `<tool>`, DeepSeek DSML `<|DSML|invoke>`, markdown ```tool
- Visual spacing polish, `/yolo` integration

#### v1.7.5 — DeepSeek DSML Fix
- Fix double-pipe `||` / full-width `｜｜` + spasi wrapper `<... calls>`
- RevealFilter 100% no-leak streaming

> Detail lengkap semua versi: lihat [CHANGELOG.md](CHANGELOG.md)

## Roadmap Status

- [x] File tools (read, write, edit, patch, delete, move, glob, code_search, list_dir, revert)
- [x] Multi-provider (OpenAI, Anthropic, Gemini) + profiles
- [x] Subagent delegation + timeout guard
- [x] Skills system (load/save/list/delete)
- [x] Approval dual-layer + Guardian LLM audit
- [x] Search sessions & trajectory export
- [x] Process manager (start/read/get/stop)
- [x] TUI polish (raw-mode, ambient input, ESC cancel, activity tray, responsive 40 cols)
- [x] Security hardening (SSRF IP-pinning, symlink sandbox, sensitive protection)
- [ ] Cron / gateway messaging (ditunda)
- [ ] Plugin / MCP support (future)
- [ ] npm publish & Docker image (future)

## Known Bugs / Limitations (Ringkas)

1. **Obfuscation eval/base64** — tidak bisa 100% regex, ditangani Guardian LLM Layer 2
2. **Redaksi kredensial** — best-effort regex, bukan jaminan mutlak
3. **TOCTOU filesystem** — micro-window symlink swap (mitigasi: O_NOFOLLOW, lstat, atomic wx)
4. **Single-user trusted env** — rekomendasikan Docker/VM untuk repo tak tepercaya

> Detail 8 poin batasan: lihat README bagian Security Boundaries

## Verifikasi Baseline (Wajib Sebelum Coding)

```bash
npm run typecheck   # harus 0 error
npm test            # harus 901 passed
npm run test:e2e    # harus 1 passed
```

## Struktur Direktori

- `src/core/`: loop, approval, executor, ui, config, undo, session, skills, etc.
- `src/agent/`: agent, llm, tools, filetools, webtools, subagent, commands, roles
- `src/tests/`: unit & e2e tests (node:test)
- `.github/`: CI, CodeQL, dependabot, SECURITY.md

## Konvensi Pengembangan

- Zero runtime dependencies
- TypeScript strict + ESM (`.js` extension di import)
- Bahasa CLI & docs: Indonesia
- Jangan buat git tag baru tanpa instruksi user
- Simpan snapshot undo di `.ruko/undo/` dengan mode 0600

## Handoff Checklist untuk AI Berikutnya

1. Baca README.md & SECURITY.md terbaru
2. Jalankan baseline tests
3. Cek CHANGELOG.md untuk konteks histori jika perlu detail
4. Fokus pada file pendek & modular, hindari menambah panjang PROGRESS.md
5. Selalu validasi security: approval gate, workspace sandbox, sensitive path
