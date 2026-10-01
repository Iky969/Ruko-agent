# RUKO v2.0.0 IMPLEMENTATION TRACKER

## 1. Project Context & Non-Negotiable Invariants
- **Identity:** Local-first, zero-dependency coding agent (Node.js 22/24 native).
- **Threat Model:** Single-user developer workstation vs Malicious Repositories & Indirect Prompt Injection.
- **Invariants:** 
  1. Dual-Plane State: Authoritative state in `~/.ruko/sessions/` (0600), workspace projection is read-only.
  2. Plan Mode: Mutation & shell are strictly DENIED by default.
  3. Zero external npm dependencies in core runtime.
  4. Resuming session ALWAYS resets mode to `plan`.

---

## 2. Roadmap & Execution Status

### Fase A: Pure Logic & Memory-Only Tools (P0)
- [x] **PR-A1: Sanitizer & Astral Unicode Guard** (`src/core/prompt/sanitizer.ts`)
  - Status: SELESAI (Fase 1 — F1-T1, commit `f7c516c`)
- [x] **PR-A2: Manifest & Dependency Guard** (`src/core/verification/packageJsonGuard.ts`)
  - Status: SELESAI (Fase 2 — F2-T3, commit `5bca61b`)

### Fase B: State & Local Mutex (P0)
- [x] **PR-B1: Atomic Directory FileLock** (`src/core/state/fileLock.ts`)
  - Status: SELESAI (Fase 1 — F1-T2, commit `f7c516c`)
- [x] **PR-B2: Dual-Plane State Management** (`src/core/state/hostState.ts`)
  - Status: SELESAI (Fase 1 — F1-T3, commit `f7c516c`)

### Fase C: Boundary I/O & Network Guard (P0)
- [ ] **PR-C1: TOCTOU-Safe File Reader** (`src/core/tools/secureRead.ts`)
  - Status: Pending
  - Tests: `test/secureRead.test.ts` (symlink escape, fstat descriptor, inode match)
- [ ] **PR-C2: SSRF & IP Pinning Fetch** (`src/core/network/hostFetch.ts`)
  - Status: Pending
  - Tests: `test/hostFetch.test.ts` (private CIDRs, redirect DNS check, no-socket-reuse)

### Fase D: Scope Contract & Execution Governor (P1)
- [x] **PR-D1: Scope Amendment Manager** (`src/core/approval/scopeAmendment.ts`)
  - Status: SELESAI (Fase 2 — F2-T2, commit `5bca61b`)
- [x] **PR-D2: Subprocess Resource Governor** (`src/core/executor/resourceGovernor.ts`)
  - Status: SELESAI (Fase 2 — F2-T4, commit `5bca61b`)
- [ ] **PR-D3: Credential Redaction Stream** (`src/core/logging/redactionStream.ts`)
- [ ] **PR-D4: Tamper-Evident Hash Chain Log** (`src/core/logging/hashChainLog.ts`)

### Fase E: Orchestration & Release Gate (P2)
- [ ] **PR-E1: Unified SecurityPipeline Facade** (`src/core/securityPipeline.ts`)
- [ ] **PR-E2: TrustedRoots Manager** (`src/core/state/trustedRoots.ts`)
- [x] **PR-E3: Direct Binary Tiered Gate** (`src/core/verification/tieredGate.ts`)
  - Status: SELESAI (Fase 2 — F2-T4, commit `5bca61b`)
- [ ] **PR-E4: Adversarial Test Suite & CI Matrix (Node 22 & 24)**

---

## 3. Active Task / Next Focus
- **Current Step:** Fase 1 Hardening (TC-LCK-01/02 v2 FileLock & TC-STA-01/02 State Corruption Fail-Closed) — SELESAI-nunggu review
- **Action Item:** Menunggu review persetujuan TC-LCK-01/02 v2 & TC-STA-01/02; bersiap lanjut ke Fase 3 sisanya (F3-T1 Fasad SecurityPipeline Tunggal Fail-Closed & F3-T3 TrustedRoots).

---

## 4. Fase 1 — [status: DISETUJUI]
- **Ringkasan terarsip (aturan blueprint: fase disetujui diringkas 1 paragraf):** Fase 1 (F1-T0..T4) disetujui 100% oleh reviewer tanpa catatan — lima modul fondasi keamanan (`hostFetch` anti-SSRF IP-pinning, `sanitizer` NFKC+astral, `fileLock` mutex mkdir+heartbeat, `hostState` dual-plane 0600, `redactionStream` tail-buffer 512B) beserta 54 test adversarial (TC-NET/LCK/RED, QA.md §1.1–1.6). Delta test: 1064 → 1118 (1117 pass / 0 fail / 1 skip win32). Kode: commit `f7c516c`; test: commit `48a36cd`; dokumentasi: commit `docs:` ini.
- **Next step:** Fase 2 — F2-T1 Dispatcher Gate Lock (detail keputusan teknis F1 dipindah ke `CHANGELOGv2.md`).


## 5. Fase 2 — [status: DISETUJUI]
- **Ringkasan terarsip (aturan blueprint: fase disetujui diringkas 1 paragraf):** Fase 2 disetujui 100% — mengimplementasikan gerbang dispatcher hulu anti-mutasi saat Plan Mode (kebal flag `/yolo`), `ScopeAmendmentManager` subtree auto-approve dengan micro-prompt terminal `[Y/n]` dan fail-closed non-TTY, `packageJsonGuard` anti-value injection & SemVer ReDoS guard, serta `TieredGate` verifikasi biner tsc mandiri via `resourceGovernor` subproses terisolasi dengan pembersihan `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`. Delta test: 1118 → 1149 (+31 test baru). Kode: commit `5bca61b`; test: commit `dce22f1`.
- **Next step:** Fase 3 — Scope & Boundary Hardening.


## 6. Fase 3 — TC-SCM-03 Symlink Hardening [status: DISETUJUI]
- **Ringkasan terarsip (aturan blueprint: fase disetujui diringkas 1 paragraf):** Hardening `ScopeAmendmentManager` (QA.md §5, TC-SCM-03) dengan validasi fisik `fs.realpathSync` pada direktori induk target dan allowedPaths untuk memblokir mutasi via symlink pra-eksisting ke luar workspace. Dilengkapi walk-up ancestor untuk file baru serta pengecualian monorepo sah (`monorepoRoots`). Delta test: 1149 → 1157 (+8 test baru).
- **Next step:** Fase 2 Hardening (TC-GOV-03 & TC-GOV-04) & Fase 3 sisanya.


## 7. Fase 2 Hardening — TC-GOV-03 Windows tsc.cmd Spoofing & TC-GOV-04 Argv Locking [status: DISETUJUI]
- **Ringkasan terarsip (aturan blueprint: fase disetujui diringkas 1 paragraf):** Hardening Direct Binary Tier 0 Compiler Gate (`resourceGovernor.ts` & `tieredGate.ts`) mem-bypass mutlak direktori `.bin/` (meniadakan celah eksekusi batch wrapper palsu `tsc.cmd` di Windows), mengeksekusi biner JS compiler asli (`node_modules/typescript/bin/tsc`) langsung via `process.execPath`, serta mengunci parameter baris perintah kompilator secara absolut ke `['--noEmit']` untuk menolak injeksi flag berbahaya seperti `--outDir` (TC-GOV-03 & TC-GOV-04). Delta test: 1157 → 1164 (+7 test baru).
- **Next step:** Fase 3 sisanya — F3-T1 Fasad SecurityPipeline Tunggal Fail-Closed & F3-T3 TrustedRoots.


## 8. Fase 1 Hardening — TC-LCK-01 & TC-LCK-02 v2 FileLock Split-Brain & Deterministic Reclamation [status: SELESAI-nunggu review]
- **Objective:** Mengeliminasi celah split-brain pada mutex konkurensi native akibat auto-eviction buta berbasis mtime serta scheduler-skew starvation (QA.md §3, halo.md Gap #3).
- **Keputusan teknis penting + alasan:**
  1. **Migrasi ke Pembuatan Berkas Eksklusif Kernel (`openSync 'wx' 0o600`)**: Menggantikan primitif `fs.mkdir` dengan `fs.openSync(lockPath, 'wx', 0o600)` (O_CREAT | O_EXCL atomik tingkat OS). Gagal seketika dengan `EEXIST` jika berkas sudah ada, menjamin eksklusivitas mutlak.
  2. **Metadata Lock Terstruktur & Nonce Matching**: Berkas lock menyimpan payload JSON `{ pid, nonce, createdAt }` dengan hak akses 0600. Pelepasan lock dan reklamasi stale memvalidasi kecocokan `nonce` unik untuk mencegah race condition pelepasan lock yang sedang dipegang proses lain (anti-ABA).
  3. **Verifikasi Keaktifan PID (`process.kill(pid, 0)`) Tanpa Auto-Eviction Buta**: Menghapus mekanisme auto-eviction otomatis mtime. Lock eksis diperiksa keaktifan prosesnya via `process.kill(pid, 0)`. Jika proses sudah mati (`ESRCH`), lock dianggap stale dan direklamasi secara otomatis. Jika proses masih hidup, lock DILARANG dieviksi otomatis, wajib melalui opsi eksplisit `force: true` (`--force-unlock`) atau callback `onStalePrompt`.
  4. **Fail-Closed pada Metadata Corrupt**: Jika berkas lock korup, terpotong, atau tidak dapat di-parse sebagai JSON valid, sistem memperlakukannya sebagai "locked" secara fail-closed dan menolak mengambil alih tanpa opsi `force: true`.
- **File yang dimodifikasi:**
  - `src/core/state/fileLock.ts` — Implementasi FileLock eksklusif kernel 'wx', metadata PID/nonce, liveness check via process.kill, fail-closed, dan anti auto-eviction
  - `src/tests/fase1_fileLock.test.ts` — Pembaruan suite test mencakup 5 skenario wajib (konkurensi 50 proses TC-LCK-01 v2, PID hidup vs force-unlock TC-LCK-02 v2, PID mati ESRCH reklamasi otomatis, metadata corrupt fail-closed, dan regresi normal)
- **Rekonsiliasi test (sebelum/sesudah/delta):**
  - Sebelum: 1164 tests (1163 pass / 0 fail / 1 skip win32).
  - Sesudah: 1168 tests (1167 pass / 0 fail / 1 skip win32).
  - Delta: +4 test baru (1167 pass / 0 fail / 1 skip win32).
- **Belum di-commit.**
- **Next step:** Menunggu review persetujuan; lanjut ke Fase 3 sisanya (F3-T1 Fasad SecurityPipeline Tunggal Fail-Closed & F3-T3 TrustedRoots).


## 9. Fase 1 Hardening — TC-STA-01 & TC-STA-02 Corrupted State Fail-Closed & Directory Fsync Portability [status: SELESAI-nunggu review]
- **Objective:** Mengeliminasi penanganan diam-diam berkas state korup (disk penuh/crash) yang mereset state tanpa sepengetahuan pengguna (halo.md Gap #3, QA.md §4, TC-STA-01/02).
- **Keputusan teknis penting + alasan:**
  1. **CorruptedStateError Eksplisit Halt (Fail-Closed)**: Menggantikan blok try-catch yang secara diam-diam membuat state baru saat parsing gagal. Jika berkas state korup (truncated payload dari simulasi ENOSPC/crash, format JSON rusak, atau skema HostState cacat/sessionId mismatch), sistem melempar `CorruptedStateError` dan menghentikan eksekusi secara fail-closed alih-alih me-reset state. Pembuatan state baru hanya diizinkan untuk sesi baru yang berkasnya belum pernah ada (`ENOENT`).
  2. **Protokol Penulisan Atomik & Directory Fsync Portability (TC-STA-02)**: Menambahkan best-effort directory fsync pada direktori induk di platform POSIX (`process.platform !== 'win32'`) setelah operasi penulisan file sementara (0600) dan atomic rename. Dilengkapi penanganan graceful fallback untuk lingkungan tanpa dukungan directory fsync seperti Docker OverlayFS, WSL2, atau FAT32 (menangkap `EINVAL`, `ENOTSUP`, `EOPNOTSUPP`, `EBADF`, `EPERM`, `EACCES`).
- **File yang dimodifikasi:**
  - `src/core/state/hostState.ts` — Definisi `CorruptedStateError`, implementasi fail-closed pada `loadHostState`, dan directory fsync best-effort pada `saveHostState`
  - `src/tests/fase1_hostState.test.ts` — Pembaruan suite test F1-T3 mencakup TC-STA-01 (truncated payload, invalid JSON, invalid schema fail-closed) dan TC-STA-02 (POSIX directory fsync & OverlayFS EINVAL fallback)
- **Rekonsiliasi test (sebelum/sesudah/delta):**
  - Sebelum: 1168 tests (1167 pass / 0 fail / 1 skip win32).
  - Sesudah: 1172 tests (1171 pass / 0 fail / 1 skip win32).
  - Delta: +4 test baru (1171 pass / 0 fail / 1 skip win32).
- **Belum di-commit.**
- **Next step:** Menunggu review persetujuan; lanjut ke Fase 3 sisanya (F3-T1 Fasad SecurityPipeline Tunggal Fail-Closed & F3-T3 TrustedRoots).




