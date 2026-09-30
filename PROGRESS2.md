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

> Penamaan sprint memakai roadmap kontrak di `v2.0.0-blueprint` §3 (Fase 1–4 / F1-T0…F4-T3).
> Penanda lama (PR-A1 s.d. PR-E4) dicoret insofar sudah menjadi bagian Fase 1.

### Fase 1: Fondasi P0 Keamanan, State & I/O Lintas Platform — [SELESAI-nunggu review]
- [x] **F1-T0: hostFetch SSRF Pinning** (`src/core/network/hostFetch.ts`) — selesai
- [x] **F1-T1: Allowlist Sanitizer** (`src/core/prompt/sanitizer.ts`) — selesai
- [x] **F1-T2: fileLock Mutex** (`src/core/state/fileLock.ts`) — selesai
- [x] **F1-T3: Dual-Plane State** (`src/core/state/hostState.ts`) — selesai
- [x] **F1-T4: RedactionTransform + tail buffer** (`src/core/logging/redactionStream.ts`) — selesai
- [ ] **F1-T5: secureRead TOCTOU-safe** (`src/core/tools/secureRead.ts`) — belum dikerjakan (lihat §4)

### Fase A: Pure Logic & Memory-Only Tools (P0)
- [x] ~~PR-A1: Sanitizer & Astral Unicode Guard~~ → jadi **F1-T1** (selesai, lihat §3)
- [ ] **PR-A2: Manifest & Dependency Guard** (`src/core/verification/packageJsonGuard.ts`)
  - Status: Pending — dijadwalkan masuk Fase 2 (F2-T3) bersama `tieredGate`.
  - Tests: `src/tests/packageJsonGuard.test.ts` (SemVer validation, URL injection denial)

### Fase B: State & Local Mutex (P0)
- [x] ~~PR-B1: Atomic Directory FileLock~~ → jadi **F1-T2** (selesai)
- [x] ~~PR-B2: Dual-Plane State Management~~ → jadi **F1-T3** (selesai)

### Fase C: Boundary I/O & Network Guard (P0)
- [ ] **PR-C1: TOCTOU-Safe File Reader** (`src/core/tools/secureRead.ts`)
  - Status: Pending — sengaja tidak dipaksakan masuk Fase 1; lihat §4 "Ruang lingkup".
  - Tests: `test/secureRead.test.ts` (symlink escape, fstat descriptor, inode match)
- [x] ~~PR-C2: SSRF & IP Pinning Fetch~~ → jadi **F1-T0** (selesai)

### Fase D: Scope Contract & Execution Governor (P1)
- [ ] **PR-D1: Scope Amendment Manager** (`src/core/approval/scopeAmendment.ts`)
- [ ] **PR-D2: Subprocess Resource Governor** (`src/core/executor/resourceGovernor.ts`)
- [x] **PR-D3: Credential Redaction Stream** (`src/core/logging/redactionStream.ts`) → jadi **F1-T4** (selesai)
- [ ] **PR-D4: Tamper-Evident Hash Chain Log** (`src/core/logging/hashChainLog.ts`)

### Fase E: Orchestration & Release Gate (P2)
- [ ] **PR-E1: Unified SecurityPipeline Facade** (`src/core/securityPipeline.ts`)
- [ ] **PR-E2: TrustedRoots Manager** (`src/core/state/trustedRoots.ts`)
- [ ] **PR-E3: Direct Binary Tiered Gate** (`src/core/verification/tieredGate.ts`)
- [ ] **PR-E4: Adversarial Test Suite & CI Matrix (Node 22 & 24)**

---

## 3. Fase 1 — [status: SELESAI-nunggu review]

- **Objective:** Mengimplementasikan lima unit kerja P0 pada roadmap `v2.0.0-blueprint` §3
  (F1-T0 … F1-T4) sebagai modul siap pakai, lengkap dengan uji adversarial yang
  diambil langsung dari matriks QA.md. Fase ini murni *fondasi*: belum ada
  callsite di `src/agent/` atau `src/core/loop.ts` yang diarahkan ke modul baru —
  pemindahan callsite dijadwalkan bertahap di Fase 3 (Strangler Refactor).

- **Keputusan teknis penting + alasan:**
  1. **Sanitizer dipecah dua fungsi** (`sanitizeForPrompt` vs `sanitizePath`).
     Blueprint aslinya memakai satu allowlist ASCII untuk keduanya, yang membuat
     `résumé.md` berubah jadi `r\u00e9sum\u00e9.md`. QA.md §1.2 sudah memperingatkan
     hal ini; pemecahan wajib agar TC-SEC-03 tidak regresi.
  2. **Blueprint punya bug double-escape.** Urutan `CONTROL_RE` → per-code-point
     menghasilkan `\u000a` lalu backslash-nya ikut ter-escape jadi `\u005cu000a`.
     Diganti satu lintasan per code point.
  3. **NFKC tidak memetakan U+2215 (division slash).** Komentar blueprint
     mengklaim sebaliknya. Karakter ini tetap ditulis escape (aman), dan tidak
     dipaksa jadi `/` — tidak perlu, karena OS juga tidak memperlakukannya
     sebagai separator. Klaim yang salah dikoreksi di tes, bukan di kode diam-diam.
  4. **`hostState` menolak baseDir dari env.** Induk direktori state adalah jalur
     yang memegang otorisasi; variabel lingkungan bisa dipengaruhi lingkungan
     eksekusi. Base dir jadi parameter program, sementara golden test memakai
     direktori sementara. Konsekuensi: test tidak pernah menyentuh `~/.ruko`.
  5. **JSON rusak → karantina, error I/O → dilempar.** Menelan keduanya akan
     sama-sama berbahaya: karantina mencegah "state tak terbaca = mode act",
     sedangkan melempar error I mencegah Ruko "lupa" pada scope yang ada.
  6. **Seam pengujian (`HostFetchDeps`, `renameFn`) tetap melewati seluruh
     pemeriksaan keamanan.** Hasil resolver seam tetap disaring `isPrivateIP`,
     sehingga menyuntipkan seam tidak dapat melewati proteksi SSRF.
  7. **Heartbeat lock di-`unref()`.** Tanpa itu proses Ruko tidak akan keluar
     selama masih memegang lock. Kegagalan heartbeat berulang (QA §1.3) kini
     memberi peringatan dan lock ditandai "ditinggalkan" alih-alih diam-diam mati.

- **Rekonsiliasi test:**
  - Sebelum: **1064** test, 1063 pass, 0 fail, 1 skipped.
  - Sesudah: **1142** test, 1140 pass, 0 fail, 2 skipped.
  - Delta: **+78** test, **+77** pass, **+1** skipped (satu tes khusus Win32:
    escaping nama reserved `con` → `_con`), 0 regresi.
  - Distribusi per suite baru: `fase1_hostFetch` 20, `fase1_sanitizer` 18
    (17 pass + 1 skip), `fase1_hostState` 15, `fase1_redaction` 15, `fase1_fileLock` 10.
  - `npx tsc --noEmit` bersih. `zero_dependency_guard` (termasuk untuk dist/)
    tetap hijau — hanya `node:*` dan import relatif.

- **Belum di-commit / sudah di-commit:**
  - Modul + test: sudah di-commit (lihat §5).
  - `CHANGELOGv2.md` **belum disentuh** — sesuai aturan, changelog ditulis setelah
    fase disetujui, bukan saat draft.

- **Next step:**
  1. Review manusia atas §3. Jika disetujui → tulis entri ringkas di
     `CHANGELOGv2.md` (maks 5–8 baris) dan ringkas §3 ini jadi satu paragraf.
  2. Lanjut ke **F1-T5 `secureRead.ts`** (belum ada di roadmap blueprint §3 sebagai
     item tersendiri, tetapi TC-SEC-01/02/03 dan fasad `SecurityPipeline`
     membutuhkannya; lihat §4).
  3. Setelah itu Fase 2: gate dispatcher, subtree auto-approve, guard manifest,
     dan gate biner langsung.

---

## 4. Ruang lingkup & catatan carried-forward

- **F1-T5 `secureRead.ts` tidak dikerjakan di Fase 1.** Roadmap blueprint §3
  tidak menyebutnya sebagai item Fase 1 (F1-T0…T4 sudah terisi 5 Work-unit), dan
  PR-C1 memang masih "Pending". Modul ini krusial karena
  `SecurityPipeline` (Fase 3) memanggilnya untuk setiap operasi baca. Usulan:
  jadikan item Fase 1.5 / awal Fase 2.
- **Belum ada integrasi callsite.** Modul-modul Fase 1 terbukti lewat unit test,
  belum melindungi alur nyata. Integrasi harus bertahap (Fase 3) supaya diff
  keamanan tetap bisa di-review per-PR.
- **CI 3-OS belum ada.** Semua tes ini baru diverifikasi di Linux. Yang
  platform-spesifik (mode 0600/0700/0400, escaping nama reserved Win32, backoff
  rename) sudah ditulis dan di-skip dengan jelas di luar platform-nya, tetapi
  belum pernah dieksekusi di Windows/macOS.
- **Skema penamaan tes.** Konvensi repo adalah `src/tests/*.test.ts` (bukan
  `test/` seperti tertulis di PROGRESS2 lama). Suite baru mengikuti konvensi
  repo yang nyata: `src/tests/fase1_*.test.ts`.

---

## 5. Log Commit

| Commit | Isi |
|---|---|
| (lihat `git log --oneline`) | 5 modul Fase 1 + 5 suite pengujian |
