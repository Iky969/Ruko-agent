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
- [ ] **PR-A2: Manifest & Dependency Guard** (`src/core/verification/packageJsonGuard.ts`)
  - Status: Pending — ditunda ke Fase 2 (setara F2-T3 dalam roadmap blueprint)

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
- [ ] **PR-D1: Scope Amendment Manager** (`src/core/approval/scopeAmendment.ts`)
- [ ] **PR-D2: Subprocess Resource Governor** (`src/core/executor/resourceGovernor.ts`)
- [ ] **PR-D3: Credential Redaction Stream** (`src/core/logging/redactionStream.ts`)
- [ ] **PR-D4: Tamper-Evident Hash Chain Log** (`src/core/logging/hashChainLog.ts`)

### Fase E: Orchestration & Release Gate (P2)
- [ ] **PR-E1: Unified SecurityPipeline Facade** (`src/core/securityPipeline.ts`)
- [ ] **PR-E2: TrustedRoots Manager** (`src/core/state/trustedRoots.ts`)
- [ ] **PR-E3: Direct Binary Tiered Gate** (`src/core/verification/tieredGate.ts`)
- [ ] **PR-E4: Adversarial Test Suite & CI Matrix (Node 22 & 24)**

---

## 3. Active Task / Next Focus
- **Current Step:** Fase 2 (Blueprint) — BELUM MULAI
- **Action Item:** Mulai F2-T1 Dispatcher Gate Lock di hulu pipeline; baca ulang blueprint §2.6 (scope amendment) + QA.md §1.7 (fail-closed non-TTY) sebelum eksekusi.

---

## 4. Fase 1 — [status: DISETUJUI]
- **Ringkasan terarsip (aturan blueprint: fase disetujui diringkas 1 paragraf):** Fase 1 (F1-T0..T4) disetujui 100% oleh reviewer tanpa catatan — lima modul fondasi keamanan (`hostFetch` anti-SSRF IP-pinning, `sanitizer` NFKC+astral, `fileLock` mutex mkdir+heartbeat, `hostState` dual-plane 0600, `redactionStream` tail-buffer 512B) beserta 54 test adversarial (TC-NET/LCK/RED, QA.md §1.1–1.6). Delta test: 1064 → 1118 (1117 pass / 0 fail / 1 skip win32). Kode: commit `f7c516c`; test: commit `48a36cd`; dokumentasi: commit `docs:` ini.
- **Next step:** Fase 2 — F2-T1 Dispatcher Gate Lock (detail keputusan teknis F1 dipindah ke `CHANGELOGv2.md`).
