# Changelog Ruko-agent v2.x

Seluruh pembaruan penting pada lini rilis 2.x akan dicatat dalam berkas ini.
Format berbasis [Keep a Changelog](https://keepachangelog.com/id/1.0.0/) dan tunduk pada [Semantic Versioning](https://semver.org/).

---

## [2.2.0] - Unreleased

### Security & Approval
- **Scope & Plan/Act:** bootstrap scope yang memerlukan otorisasi host, perintah `/scope allow|status|reset`, validasi input `/plan`, serta diagnostik penolakan scope yang menyebut penyebabnya.
- **Approval sesi:** grant `[a/y/n]` untuk command yang aman dan exact-match selama sesi aktif; tidak mengubah allowlist persisten atau melewati Plan Mode maupun scope.
- **Security hardening:** validasi approval binding, trust boundary konfigurasi, pembatasan mutasi subprocess, persistence scope/undo, sanitasi web content, dan penguncian state sesi.
- **Status UI:** PLAN/ACT dan scope aktif ditampilkan dari HostState otoritatif.

### Feedback PR — Scope & Security
- **`move_file` (`f0c92ae`):** sumber dan tujuan dievaluasi dengan `evaluateMutationDecision` yang sama sebelum approval file atau I/O. Prioritas alias/nullish disamakan dengan handler eksekusi agar tujuan decoy tidak membypass scope. `isSensitivePath` memblokir direktori `.git/hooks` dan seluruh turunannya, termasuk path absolut, nested repository, casing, backslash, dan encoding; sibling `hooks-backup` tetap normal.
- **Session allowlist (`6f95536`):** grant `always` menolak path yang resolve di luar workspace melalui `path.resolve`/`path.relative`, termasuk traversal, absolut, varian backslash, foreign Windows drives/drive-relative, serta nilai opsi path. `start_process` memasok workspace root dari host bersama cwd; key exact-command mengikat root/cwd fisik dan jenis operasi. Path dalam workspace tetap dapat diingat hanya setelah persetujuan pertama; one-shot dan gate PLAN/scope/blocked/high-risk tidak dilonggarkan.
- **Circuit breaker (`40e8fc0`):** setelah tiga penolakan per canonical path, path tetap diblokir selama sesi. Approval path lain, allow/reset/seed/kontraksi scope, pemberian subtree induk, atau jawaban approval lama yang datang setelah rejection ketiga tidak membuka kembali path tersebut. Pemeriksaan mendahului subtree auto-approve dan diulang setelah prompt. Counter disimpan in-memory selama sesi aktif, bukan lintas sesi/restart.
- **Fallback TTY (`76ebe1e`):** jika override host `options.isTTY` tidak diberikan, gunakan `Boolean(process.stdin.isTTY)` tanpa membaca `CI`, konsisten dengan pipeline runtime. `CI=true` dengan stdin TTY tetap menampilkan prompt; non-TTY tetap fail-closed tanpa membaca stdin atau menyimpan amandemen.

### Tests — Feedback PR
- Empat commit kode memasukkan **37 tests baru terhadap HEAD awal `338f57c`**: move/hooks 12 (8 existing unstaged + 4 tambahan), allowlist 15, breaker 7, TTY 3. Delta terhadap baseline working tree yang sudah memuat 8 tes unstaged adalah **+29**.
- Tes move runtime membuktikan sumber tetap ada dengan isi yang sama, tujuan/undo tidak dibuat saat ditolak, dan move sah benar-benar berhasil setelah approval. Tes allowlist memverifikasi penolakan tidak tersimpan/reused, nested cwd tetap tunduk pada workspace host, serta persetujuan pertama tetap wajib.
- Dua tes reset breaker existing diperbarui menjadi asersi permanensi; empat transisi scope, approval path lain sebelum/sesudah threshold, sesi baru, serta late approval diuji. Fresh input per prompt membuktikan jawaban nyata, bukan timeout karena stream habis. Tes TTY memulihkan property stdin dan environment pada cleanup.
- Checkpoint implementasi sebelum rebase: move/dispatcher/sensitive **51/51 pass**, allowlist/session/approval **93/93 pass**, scope/symlink/bootstrap **66/66 pass**; final scope standalone **25/25 pass**, sessionAllowlist **14/14 pass**, feedback_approval_session **11/11 pass**. Full suite **1373 total / 1372 pass / 0 fail / 1 skip / 69 suites**, E2E filter existing **1/1 pass**; skip Windows-only, tanpa test dihapus atau skip baru. Regresi bug diamati RED→GREEN pada pengerjaan awal.

### Dokumentasi & Riwayat Lokal — Feedback PR
- Audit keempat commit awal (`39115ab`, `8091d4f`, `48c83f1`, `844816a`) menemukan dokumentasi di `CHANGELOGSv2.md` dan `PROGRESS2.md`, bukan changelog rilis ini. Rebase interaktif memisahkan seluruh dokumentasi dari empat commit kode; setiap source tree per commit baru identik dengan source tree commit asalnya.
- Catatan batch dipusatkan dalam satu commit docs terakhir yang hanya mengubah **`CHANGELOGv2.md` dan `PROGRESS2.md`**. `CHANGELOGSv2.md` tetap pada isi sebelum empat commit awal (`338f57c`); arsip batch terdahulu tidak dipindah atau dihapus.
- Semua pekerjaan hanya pada `/workspaces/Ruko-agent-pr`, branch `fix/feedback-scope-security-pr`; repo utama dan catatan `ANALISIS_*` tidak diubah. Tidak push, merge, perubahan versi/dependency, tag, atau release. Backup riwayat awal disimpan sebagai bundle lokal di scratch.
- Verifikasi ulang setelah rebase pada Linux / Node v24.21.0 / npm 11.19.0: `npm run typecheck` exit 0, `npm run build` exit 0, dan `npm test` (tanpa perubahan runner/reporter) exit 0 — **1373 total / 1372 pass / 0 fail / 1 skip / 69 suites**, cancelled/todo 0. `git diff --check` lulus. Log: `/home/codespace/.hermes/cache/scratch/ruko-feedback-rebase/pre-docs-{1,2,3}.log`. Hasil akhir setelah commit docs dilaporkan pada jawaban; STOP tanpa push/merge.

### CI follow-up — absolute path Windows
- Pada commit `b0b5edb`, CI Windows (Node 18 dan 20) menemukan regresi nyata: karakter `~` tidak ada pada grammar reusable-command, sehingga absolute temp path Windows yang mengandung 8.3 short component `RUNNER~1` gagal. Kedua Windows jobs gagal; log `gh run view 38080042867 --log-failed` mencatat assertion `remember(...)=false` untuk path workspace-local.
- Commit `889f4d1` memperbaiki resolusi path absolute versus relative terhadap cwd/workspace. Retry `38080881880` masih memakai head `d8281da` sebelum fix grammar. Commit `d105d88` menambahkan `~` untuk komponen path literal sambil menolak shell-leading `~` dan `=~` (tilde expansion); tes temp absolute sekarang menaruh workspace tepat di bawah checkout agar path temp berada dalam workspace. Komponen `RUNNER~1` diuji eksplisit.
- Checkpoint lokal setelah fix dan sebelum CI baru: `npm run typecheck`, `npm run build`, `npm test` exit 0; **1375 total / 1374 pass / 0 fail / 1 skip / 69 suites**. `sessionAllowlist.test.js` **16/16 pass**. Skip tetap Windows-only.
- Run CI `38080881880` memang gagal dua job Windows pada head lama (`d8281da`); ia tidak mengeksekusi perubahan d105d88/1784b38. Push run baru hanya setelah verifikasi penuh lokal; tunggu `gh pr checks` hijau untuk head terbaru sebelum klaim selesai. Tidak merge.

### Review clarification — session approval risk gating
- Temuan #2 pada review (perbedaan syarat reusable `exec` versus `start_process`) adalah keputusan desain yang disengaja, bukan bug. `exec` merupakan jalur shell umum, sehingga “always” dibatasi ke command berisiko yang telah melewati gerbang approval; `start_process` adalah launcher tool tersendiri, menerima command exact-match yang sederhana dengan binding kind/cwd/workspace dan tetap meminta persetujuan pertama. Keputusan ini tidak memberi bypass PLAN/scope/blocked/high-risk.
- Klarifikasi yang diminta diposting di PR #37: “Temuan #2 (exec vs start_process) dianggap perilaku yang disengaja, bukan bug.”
- Rerun status checks terakhir (PR head `1784b3888e80caae0d4af9e96057c103657542ee`) semuanya pass: Test Ubuntu Node 18/20/22, Windows 18/20, macOS 18/20, Analyze JS/TS, CodeQL Analysis dan CodeQL. PR masih open dan tidak di-merge.
- Workflow terpisah GitHub Advanced Security “Code scanning AI findings” tetap failed karena kuota bulanan Copilot terlampaui (HTTP 402 / `SessionModelError: You have exceeded your monthly quota`), bukan finding; check ini tidak termasuk status-check rollup PR. Catat sebagai keterbatasan automation meski seluruh PR required checks hijau.

Rilis ini belum diterbitkan. `install.sh` sengaja tetap mem-pin `v2.1.0` hingga tag immutable `v2.2.0` tersedia.

---

## [2.1.0] - 2026-10-07

### Security & Hardening
- **Hardlink Escape Detection (`secureReadFile`):** Menolak berkas dengan `st_nlink > 1` (`HARDLINK_ESCAPE`) secara fail-closed pada fstat kernel descriptor untuk mencegah pelarian file sandbox melalui hardlink ke berkas sensitif di luar workspace.
- **Interpreter Injection Denylist (`executor.ts` / `dotenv.ts`):** Memperluas pembersihan environment subprocess dan denylist `.env` untuk Python (`PYTHONSTARTUP`, `PYTHONPATH`, `PYTHONWARNINGS`), Perl (`PERL5OPT`, `PERL5LIB`), dan Ruby (`RUBYOPT`, `RUBYLIB`).
- **Installer & Version Alignment:** Memperbarui installer `install.sh` untuk mengarah ke tag rilis immutable `v2.1.0`.

## [2.0.0] - 2026-10-02

### Breaking Changes (Arsitektur Baru)
- **Zero-Dependency Mandate:** Menghapus seluruh dependensi runtime npm; beralih murni ke modul native Node.js 22/24 (`node:*`).
- **Dual-Plane State Machine:** Memindahkan state otoritatif (`state.json`) ke direktori host `~/.ruko/sessions/` dengan hak akses `0600`. File `.ruko/plan.json` di dalam workspace murni berstatus *read-only projection*.
- **Plan Mode Mutation Lock:** Pemblokiran total pemanggilan shell arbitrer dan operasi mutasi berkas selama Plan Mode aktif (*fail-closed*).
- **Direct Compiler Verification:** Verifikasi Tier 0 mengeksekusi biner `./node_modules/.bin/tsc` secara langsung tanpa melalui script npm `package.json`.

### Security Enhancements
- **Network Boundary:** Implementasi `HostFetch` dengan mitigasi SSRF, DNS Rebinding check per-hop, IP Pinning, preservasi SNI TLS, dan penonaktifan socket-reuse.
- **Atomic Concurrency Mutex:** Implementasi `FileLock` berbasis primitif kernel `fs.mkdir` dengan deteksi *stale lock* berbasis heartbeat `mtime`.
- **TOCTOU Immune File I/O:** `secureReadFile` menggunakan validasi segmen bertahap, pembukaan via file descriptor kernel (`O_NOFOLLOW | O_CLOEXEC`), dan verifikasi silang pasangan inode/dev.
- **Manifest Guard:** Validasi ketat format SemVer dan pemblokiran injeksi URL/Git eksternal serta script *lifecycle* berbahaya pada `package.json`.
- **Audit Logging:** Pencatatan tamper-evident menggunakan hash chain kriptografis SHA-256 (`hashChainLog.ts`).

### Added
- Modul `sanitizer.ts` dengan normalisasi Unicode NFKC dan penanganan *code point* non-BMP.
- Subtree auto-approval dan terminal micro-prompt `[Y/n]` untuk amandemen scope dinamis.
- Identifikasi repositori tepercaya berbasis Git Remote Origin kanonis dan UID kepemilikan.

### [Fase C & Boundary Hardening] PR-C1 TOCTOU-Safe File Reader & Network Guard — 2026-10-02
- Implementasi pembacaan berkas TOCTOU-safe (`secureReadFile`), validasi segmen lstat bertahap, pembukaan via file descriptor kernel `O_RDONLY | O_NOFOLLOW | O_CLOEXEC`, post-open inode/dev matching, serta mitigasi NTFS Alternate Data Streams (PR-C1). Hardening soket `lookup` fail-closed dan blokir IPv4 non-standar / IPv6 loopback / metadata link-local (TC-NET-04 & TC-NET-05). Validasi penolakan sibling prefix collision pada amandemen scope (TC-SCM-04).
- File: `src/core/tools/secureRead.ts`, `src/core/network/hostFetch.ts`, `src/tests/secureRead.test.ts`, `src/tests/fase1_hostFetch.test.ts`, `src/tests/fase2_scopeAmendment.test.ts`.
- Delta test: 1198 (1197 pass / 0 fail / 1 skip win32) → 1210 (1209 pass / 0 fail / 1 skip win32) = +12.

### [P0 Critical Triage & Subagent Confinement] Pipeline Wiring & Isolation — 2026-10-01
- Fasad tunggal `bootstrapSecurityPipeline()` mengikat FileLock, HostState, ScopeAmendmentManager, dan DispatcherGate ke CLI nyata (`index.ts`, `agent.ts`, `loop.ts`). Remediasi parent symlink directory traversal (`assertPhysicalContainment`) pada operasi file I/O (CVSS 9.3). Denylist `DANGEROUS_WORKSPACE_ENV_VARS` di `loadDotenv()` menutup celah injeksi RCE/SSRF. Pengurungan non-interaktif dan pewarisan batas subtree pada subagent delegation.
- File: `src/core/securityPipeline.ts`, `src/agent/agent.ts`, `src/agent/subagent.ts`, `src/agent/tools.ts`, `src/agent/filetools.ts`, `src/core/dotenv.ts`, `src/core/loop.ts`, `src/core/state/hostState.ts`, `src/index.ts`, 4 test suites.
- Delta test: 1178 (1177 pass / 0 fail / 1 skip win32) → 1198 (1197 pass / 0 fail / 1 skip win32) = +20.

### [req.md Fixes] Stabilisasi Eksekusi Model & Token Safety — 2026-10-01
- **UI Streaming Buffer (Fase V):** `RevealFilter` menampung potongan token saat `{` terdeteksi hingga JSON tool call tervalidasi/timeout, mencegah kebocoran payload mentah `{"tool":"write_file",...}` ke terminal sebelum badge aksi dirender.
- **Active Loop Intervention (Fase II):** Loop detector menyuntikkan *synthetic tool result* eksplisit saat deteksi ulang: soft warning → "Dilarang membaca ulang berkas/printf, segera jalankan patch_file", hard stop → `[detesi loop] — eksekusi dihentikan, berikan respons akhir`.
- **Context Sanitization/Rollback (Fase IV):** Middleware `maybeRollbackContext` mendeteksi token collapse (spam Mandarin, ChatML leak, repetisi ekstrem) dan rollback otomatis pesan asisten gagal dari history setelah 2 turn gagal berturut-turut.
- **Bash Scope Restriction (Blueprint §2.7):** System prompt `TOOL_RULES` dibatasi: `exec` hanya untuk kompilasi (tsc, cargo build), test runner (npm test, pytest), dan git — operasi file baca/tulis wajib lewat tool resmi.
- File: `src/core/ui.ts` (RevealFilter), `src/agent/agent.ts` (loop guard, rollback, detectTokenCollapse), `src/agent/roles.ts` (TOOL_RULES).
- Delta test: 1164 (1163 pass / 0 fail / 1 skip) → 1171 (1170 pass / 0 fail / 1 skip) = +7.

### [TC-FSM-01 & TC-SCM-05] Circuit Breaker Anti-DoS & Scope Contraction — 2026-10-01
- **TC-FSM-01 Circuit Breaker:** Lacak penolakan berturut-turut per canonical path (pakai `realpathSync` konsisten dengan TC-SCM-03). Trigger pada 3x penolakan identik berturut-turut → blokir amandemen berikutnya ke path itu untuk sisa sesi (non-punitif, pesan jelas). Counter reset saat user approve path LAIN di antaranya.
- **TC-SCM-05 Scope Contraction:** Method `contractScope()` reset `allowedPaths` ke snapshot awal sesi (tanpa sesi baru), clear circuit breaker state. Dipanggil manual (command eksplisit) atau otomatis pasca-breaker.
- File: `src/core/approval/scopeAmendment.ts`, `src/tests/fase2_scopeAmendment.test.ts`.
- Delta test: 1171 (1170 pass / 0 fail / 1 skip) → 1178 (1177 pass / 0 fail / 1 skip) = +7.
- Catatan historis: kebijakan reset breaker pada dua poin di atas adalah perilaku saat implementasi 2.0.0; mulai 2.2.0 diganti dengan blokir permanen selama sesi, termasuk setelah kontraksi scope (lihat bagian Unreleased).

### [Fase 1 Hardening] TC-STA-01 & TC-STA-02 Corrupted State Fail-Closed & Directory Fsync — 2026-10-01
- Eliminasi reset state diam-diam saat parsing berkas state gagal akibat crash atau simulasi ENOSPC; melempar `CorruptedStateError` eksplisit halt secara fail-closed (TC-STA-01). Ditambahkan best-effort directory fsync pada POSIX dengan graceful fallback EINVAL untuk lingkungan OverlayFS/WSL (TC-STA-02).
- File: `src/core/state/hostState.ts`, `src/tests/fase1_hostState.test.ts`.
- Delta test: 1168 (1167 pass / 0 fail / 1 skip) → 1172 (1171 pass / 0 fail / 1 skip win32) = +4.

### [Fase 1 Hardening] TC-LCK-01 & TC-LCK-02 v2 FileLock Split-Brain & Deterministic Reclamation — 2026-10-01
- Migrasi mutex native ke pembuatan berkas eksklusif kernel atomik `openSync('wx', 0o600)`, verifikasi keaktifan proses via `process.kill(pid, 0)` tanpa auto-eviction buta, eliminasi split-brain 50 worker paralel, dan proteksi metadata fail-closed dengan opsi `--force-unlock`.
- File: `src/core/state/fileLock.ts`, `src/tests/fase1_fileLock.test.ts`.
- Delta test: 1164 (1163 pass / 0 fail / 1 skip) → 1168 (1167 pass / 0 fail / 1 skip win32) = +4.

### [Fase 2 Hardening] Windows tsc.cmd Spoofing & Argv Locking — 2026-10-01
- Bypass mutlak wrapper `.bin/tsc.cmd` di Windows dengan mengeksekusi biner JS compiler (`node_modules/typescript/bin/tsc`) langsung via `process.execPath`, serta penguncian ketat argumen kompilator hanya pada `['--noEmit']` (anti-injeksi `--outDir`).
- File: `src/core/executor/resourceGovernor.ts`, `src/core/verification/tieredGate.ts`, `src/tests/fase2_resourceGovernor.test.ts`, `src/tests/fase2_tieredGate.test.ts`.
- Delta test: 1157 (1156 pass / 0 fail / 1 skip) → 1164 (1163 pass / 0 fail / 1 skip win32) = +7.

### [Fase 3] TC-SCM-03 Symlink Hardening — 2026-10-01
- Validasi fisik `realpathSync` pada parent directory target dan allowedPaths untuk memblokir eksfiltrasi/mutasi via symlink pra-eksisting ke luar workspace, dengan walk-up ancestor dan pengecualian monorepo legit.
- File: `src/core/approval/scopeAmendment.ts`, `src/tests/fase2_scopeAmendment.test.ts`, `src/tests/fase3_scopeAmendment_symlink.test.ts`.
- Delta test: 1149 (1148 pass / 0 fail / 1 skip) → 1157 (1156 pass / 0 fail / 1 skip win32) = +8.

### [Fase 2] Disiplin AI, Scope Amendment & Verifikasi Mandiri — 2026-09-30
- Implementasi gerbang dispatcher hulu anti-mutasi saat Plan Mode (kebal terhadap flag `/yolo`), `ScopeAmendmentManager` subtree auto-approve dengan micro-prompt terminal `[Y/n]` dan fail-closed non-TTY, `packageJsonGuard` anti-value injection & SemVer ReDoS guard, serta `TieredGate` verifikasi langsung biner `./node_modules/.bin/tsc` via `resourceGovernor` subproses terisolasi.
- File: `src/core/dispatcher/dispatcherGate.ts`, `src/core/approval/scopeAmendment.ts`, `src/core/verification/packageJsonGuard.ts`, `src/core/executor/resourceGovernor.ts`, `src/core/verification/tieredGate.ts`, `src/agent/tools.ts` + 5 suite test `src/tests/fase2_*.test.ts`.
- Delta test: 1118 (1117 pass / 0 fail / 1 skip) → 1149 (1148 pass / 0 fail / 1 skip win32) = +31.

### [Fase 1] Fondasi P0 Keamanan, State & I/O Lintas Platform — 2026-09-30
- Implementasi 5 modul fondasi blueprint v2.0.0: `hostFetch` anti-SSRF (IP pinning per-hop, blokir CIDR privat, anti socket-reuse, SNI utuh), `sanitizer` NFKC + astral code point + `sanitizePath` non-mangling, `fileLock` mutex (mkdir atomik + heartbeat mtime + eviksi stale lock), `hostState` dual-plane `~/.ruko/sessions` 0600 (backoff Win32 + fail-safe resume reset ke plan mode), dan `redactionStream` tail-buffer 512B anti token-terbelah.
- File: `src/core/network/hostFetch.ts`, `src/core/prompt/sanitizer.ts`, `src/core/state/fileLock.ts`, `src/core/state/hostState.ts`, `src/core/logging/redactionStream.ts` + 5 suite test adversarial `src/tests/fase1_*.test.ts` (TC-NET/LCK/SEC/RED sesuai QA.md).
- Delta test: 1064 (1063 pass / 0 fail / 1 skip) → 1118 (1117 pass / 0 fail / 1 skip win32) = +54.
