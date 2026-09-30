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
- **Current Step:** Fase 2 (Blueprint) — SELESAI-nunggu review
- **Action Item:** Menunggu review persetujuan Fase 2; bersiap lanjut ke Fase 3 (Strangler Refactor Pipa Keamanan & Profil Monoton: F3-T1 Fasad SecurityPipeline Tunggal Fail-Closed).

---

## 4. Fase 1 — [status: DISETUJUI]
- **Ringkasan terarsip (aturan blueprint: fase disetujui diringkas 1 paragraf):** Fase 1 (F1-T0..T4) disetujui 100% oleh reviewer tanpa catatan — lima modul fondasi keamanan (`hostFetch` anti-SSRF IP-pinning, `sanitizer` NFKC+astral, `fileLock` mutex mkdir+heartbeat, `hostState` dual-plane 0600, `redactionStream` tail-buffer 512B) beserta 54 test adversarial (TC-NET/LCK/RED, QA.md §1.1–1.6). Delta test: 1064 → 1118 (1117 pass / 0 fail / 1 skip win32). Kode: commit `f7c516c`; test: commit `48a36cd`; dokumentasi: commit `docs:` ini.
- **Next step:** Fase 2 — F2-T1 Dispatcher Gate Lock (detail keputusan teknis F1 dipindah ke `CHANGELOGv2.md`).


## 5. Fase 2 — [status: SELESAI-nunggu review]
- **Objective:** Disiplin AI, Scope Amendment & Verifikasi Mandiri (F2-T1 Dispatcher Gate Lock, F2-T2 ScopeAmendmentManager & micro-prompt terminal, F2-T3 packageJsonGuard anti-value injection & SemVer check, F2-T4 TieredGate & ResourceGovernor subprocess isolation).
- **Keputusan teknis penting + alasan:**
  1. Dispatcher Gate Lock (`src/core/dispatcher/dispatcherGate.ts` & `src/agent/tools.ts`): Memblokir seluruh mutasi disk dan eksekusi subprocess secara mekanis selama Plan Mode aktif; kebal terhadap flag `/yolo` (`approvalEnabled: false`) sesuai DoD #1.
  2. Scope Amendment Manager (`src/core/approval/scopeAmendment.ts`): Menerapkan subtree auto-approval jika target berada di dalam subtree folder yang diizinkan (TC-SCM-01); fail-closed otomatis di lingkungan non-TTY/headless CI (TC-SCM-02); micro-prompt terminal `[Y/n]` interaktif dengan timeout 30s untuk mencegah proses hang; mismatch activePlanHash otomatis membatalkan izin (DoD #2); pembaruan allowedPaths dilindungi FileLock atomik.
  3. Manifest & Dependency Guard (`src/core/verification/packageJsonGuard.ts`): Memblokir injeksi URL eksternal/Git (TC-PKG-01), modifikasi lifecycle scripts (TC-PKG-02), ReDoS pada string versi >64 karakter (TC-PKG-03), subpath imports hijacking (QA.md §1.5), dan prototype pollution.
  4. Direct Binary Tier 0 Compiler Gate (`src/core/verification/tieredGate.ts` & `src/core/executor/resourceGovernor.ts`): Menolak modifikasi lockfile; mengeksekusi biner tsc langsung tanpa wrapper script npm; resource governor membersihkan NODE_OPTIONS, NODE_PATH, LD_PRELOAD (TC-GOV-02) dan menghentikan process tree saat timeout/overflow (TC-GOV-01).
- **Rekonsiliasi test (sebelum/sesudah/delta):**
  - Sebelum: 1118 tests (1117 pass / 0 fail / 1 skip win32).
  - Sesudah: 1149 tests (1148 pass / 0 fail / 1 skip win32).
  - Delta: +31 test adversarial baru (fase2_dispatcherGate, fase2_scopeAmendment, fase2_packageJsonGuard, fase2_resourceGovernor, fase2_tieredGate).
- **Commit hash:**
  - Kode fungsional: `5bca61b`
  - Test suites: `dce22f1`
- **Next step:** Fase 3 — F3-T1 Fasad SecurityPipeline Tunggal Fail-Closed & F3-T3 TrustedRoots.
