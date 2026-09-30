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
- [ ] **PR-A1: Sanitizer & Astral Unicode Guard** (`src/core/prompt/sanitizer.ts`)
  - Status: Pending
  - Tests: `test/sanitizer.test.ts` (NFKC, astral surrogate pairs, BiDi strip)
- [ ] **PR-A2: Manifest & Dependency Guard** (`src/core/verification/packageJsonGuard.ts`)
  - Status: Pending
  - Tests: `test/packageJsonGuard.test.ts` (SemVer validation, URL injection denial)

### Fase B: State & Local Mutex (P0)
- [ ] **PR-B1: Atomic Directory FileLock** (`src/core/state/fileLock.ts`)
  - Status: Pending
  - Tests: `test/fileLock.test.ts` (atomic mkdir, mtime heartbeat, stale crash recovery)
- [ ] **PR-B2: Dual-Plane State Management** (`src/core/state/hostState.ts`)
  - Status: Pending
  - Tests: `test/hostState.test.ts` (0600 permission, Win32 backoff, plan mode reset)

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
- **Current Step:** PR-A1 (`src/core/prompt/sanitizer.ts`)
- **Action Item:** Buat implementasi kode dan unit test-nya.
