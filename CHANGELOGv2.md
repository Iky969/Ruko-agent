# Changelog Ruko-agent v2.x

Seluruh pembaruan penting pada lini rilis 2.x akan dicatat dalam berkas ini.
Format berbasis [Keep a Changelog](https://keepachangelog.com/id/1.0.0/) dan tunduk pada [Semantic Versioning](https://semver.org/).

---

## [2.0.0-dev] - Unreleased

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
