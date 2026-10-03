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
- [x] **PR-C1: TOCTOU-Safe File Reader** (`src/core/tools/secureRead.ts`)
  - Status: SELESAI (`src/core/tools/secureRead.ts`, `src/tests/secureRead.test.ts`)
  - Tests: `src/tests/secureRead.test.ts` (TC-SEC-01..03, null byte, traversal, symlink segment, not a file, file size)
- [x] **PR-C2: SSRF & IP Pinning Fetch** (`src/core/network/hostFetch.ts`)
  - Status: SELESAI (`src/core/network/hostFetch.ts`, `src/tests/fase1_hostFetch.test.ts`)
  - Tests: `src/tests/fase1_hostFetch.test.ts` (TC-NET-01..05, IPv4 non-standard literal, link-local, loopback IPv6, lookup lock)

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
- **Current Step:** Sisa Audit Remediasi (Section 15: UI Streaming Glitch, Subprocess Env Harmonization, E2E CLI Integration Harness) — [status: SELESAI-nunggu review]
- **Action Item:** Menunggu review persetujuan untuk seluruh perbaikan Fase C, Section 14, dan Section 15 sebelum commit dan tagging rilis.

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
## 10. P0-1: Security Pipeline Wiring & Anti-Phantom Security (`bootstrapSecurityPipeline`) [status: DISETUJUI]
- **Objective:** Mengeliminasi "Phantom Security" (modul v2.0.0 FileLock, HostState, ScopeAmendmentManager, DispatcherGate hanya aktif di unit test dan 0% terhubung ke CLI nyata) dengan membangun fasad komposisi tunggal fail-closed `bootstrapSecurityPipeline()` yang mengikat seluruh guardrail ke `src/index.ts`, `src/agent/agent.ts`, dan `src/core/loop.ts`.
- **Keputusan teknis penting + alasan:**
  1. **Fasad F3-T1 `bootstrapSecurityPipeline()` (`src/core/securityPipeline.ts`)**: Komposisi root terpadu yang mengeksekusi urutan fail-closed: 1) Memperoleh FileLock eksklusif kernel pada state sesi, 2) Memuat HostState terisolasi (0600) di `~/.ruko/sessions/<sessionId>/state.json` dengan fail-safe reset ke Plan Mode saat resume, 3) Menginstansiasi `ScopeAmendmentManager`, 4) Mengekspos gerbang evaluasi `DispatcherGate`. Jika ada langkah yang gagal, lock dilepaskan seketika dan melempar error (fail-closed).
  2. **Injeksi ke Agent & Loop (`src/agent/agent.ts` & `src/core/loop.ts`)**: `Agent` menerima setter `setHostState()` dan `setScopeAmendmentManager()`, menyinkronkan mode host state dengan planMode, dan menyuntikkan dependensi ini langsung ke `runToolCall`. `SystemLoop` menerima instance pipeline dan menjamin pelepasan lock pada `stop()`.
  3. **Wiring CLI Entrypoint & Emergency Cleanup (`src/index.ts`)**: CLI interaktif memanggil `bootstrapSecurityPipeline()` saat inisialisasi. Jika gagal, proses berhenti seketika dengan `process.exit(1)` (menolak beroperasi tanpa proteksi). `emergencyCleanup` membebaskan lock jika terjadi uncaught crash sebelum terminal di-restore.
  4. **Sinkronisasi Atomik Reset Mode saat Resume (`src/core/state/hostState.ts`)**: Memastikan perubahan mode kembali ke `'plan'` saat memuat sesi lama disimpan secara atomik ke disk (`await saveHostState(state)`).
- **File yang dimodifikasi / dibuat:**
  - `src/core/securityPipeline.ts` (baru) — Fasad terpadu `bootstrapSecurityPipeline` dan interface `SecurityPipeline`.
  - `src/index.ts` — Wiring bootstrap pipeline, passing ke Agent dan SystemLoop, emergency cleanup lock release.
  - `src/agent/agent.ts` — Integrasi `setHostState()`, `setScopeAmendmentManager()`, dan injeksi ke `runToolCall`.
  - `src/core/loop.ts` — Menyimpan `sessionId`, pelepasan lock otomatis pada `stop()`.
  - `src/core/state/hostState.ts` — Simpan atomik `saveHostState(state)` saat resume reset ke mode `'plan'`.
  - `src/tests/security_pipeline_wiring.test.ts` (baru) — Suite uji regresi adversarial: verifikasi default plan mode, anti split-brain 2 proses, penolakan mutasi YOLO dalam plan mode, izin mutasi dalam scope approved ACT mode, pelepasan lock pada SystemLoop stop, dan fail-closed mutasi luar scope di lingkungan headless.
- **Rekonsiliasi test (sebelum/sesudah/delta):**
  - Sebelum: 1179 tests (1178 pass / 0 fail / 1 skip win32, 56 suites).
  - Sesudah: 1185 tests (1184 pass / 0 fail / 1 skip win32, 57 suites).
  - Delta: +6 test baru (1184 pass / 0 fail / 1 skip win32, 57 suites).
- **Next step:** Eksekusi Item 2 P0: implementasi `assertPhysicalContainment()` dengan `realpathSync` walk-up ancestor di `writeWithDiff` dan `readFileTool` untuk menutup celah symlink direktori induk (CVSS 9.3).


## 11. P0-2: Parent Directory Symlink Traversal Escape Remediation (`assertPhysicalContainment`) [status: DISETUJUI]
- **Objective:** Menutup celah bypass sandbox CVSS 9.3 (CWE-59 / CWE-61) di mana `O_NOFOLLOW` POSIX hanya melindungi komponen akhir (basename) dan membiarkan direktori induk symlink (`./link_dir -> /etc`) melarikan diri ke direktori sensitif host pada operasi `writeWithDiff`, `readFileTool`, dan `delete_file`.
- **Keputusan teknis penting + alasan:**
  1. **Primitif Defensif `assertPhysicalContainment` (`src/agent/tools.ts`)**: Utilitas defensif walk-up ancestor traversal yang mengevaluasi apakah `targetPath` dan seluruh rantai direktori induknya (`path.dirname(absTarget)`) secara fisik berada di dalam direktori kerja kanonis (`canonicalWs = realpathSync(workspaceRoot)`).
  2. **Walk-up Ancestor Traversal Fail-Closed**: Menelusuri seluruh rantai direktori induk hingga ke direktori terdekat yang eksis pada disk. Jika ditemukan komponen direktori yang merupakan symbolic link ke luar workspace atau direktori induk ter-resolve ke lokasi fisik di luar `canonicalWs`, melempar `SecurityBoundaryError` (`SECURITY_BOUNDARY_VIOLATION`) seketika. Menangani path non-existent bersarang (`symlink/sub1/sub2/file.txt`) tanpa logic bypass.
  3. **Penyematan di Layer I/O Langsung**: Dipanggil secara konsisten di `resolveToolPath` (fondasi seluruh tool file di `tools.ts`), `writeWithDiff` (penulisan berkas), `delete_file` (penghapusan berkas), dan `readFileTool` di `src/agent/filetools.ts` (pembacaan berkas).
- **File yang dimodifikasi / dibuat:**
  - `src/agent/tools.ts` — Definisi `SecurityBoundaryError`, implementasi `assertPhysicalContainment()`, dan integrasi pada `resolveToolPath`, `writeWithDiff`, `delete_file`.
  - `src/agent/filetools.ts` — Import dan ekspor `assertPhysicalContainment`, penyematan pada `readFileTool`.
  - `src/tests/parent_symlink_escape.test.ts` (baru) — Suite uji regresi adversarial: lolos file normal, lolos file baru di subdirektori sah, tolak file non-existent dan existing di dalam parent symlink, tolak penulisan write_file tanpa menyentuh direktori luar, tolak readFileTool lewat parent symlink, tolak delete_file lewat parent symlink.
- **Rekonsiliasi test (sebelum/sesudah/delta):**
  - Sebelum: 1185 tests (1184 pass / 0 fail / 1 skip win32, 57 suites).
  - Sesudah: 1191 tests (1190 pass / 0 fail / 1 skip win32, 58 suites).
  - Delta: +6 test baru (1190 pass / 0 fail / 1 skip win32, 58 suites).
- **Next step:** Eksekusi Item 3 P0: implementasi `DANGEROUS_WORKSPACE_ENV_VARS` denylist di `loadDotenv()` untuk memblokir `NODE_OPTIONS`, `LD_PRELOAD`, `HTTP_PROXY`, `*_BASE_URL`, dsb. dari `.env` repo asing.


## 12. P0-3: Workspace Dotenv Denylist & RCE / SSRF Isolation (`DANGEROUS_WORKSPACE_ENV_VARS`) [status: DISETUJUI]
- **Objective:** Menutup celah RCE dan pencurian kredensial CVSS 9.1 (ADIT.md §1.2, UCUP.md §1.2) di mana repositori pihak ketiga (untrusted repo) menyuntikkan variabel lingkungan berbahaya (`NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`, `HTTP_PROXY`, `*_BASE_URL`) via berkas `.env` ke `process.env` global.
- **Keputusan teknis penting + alasan:**
  1. **Statuta Denylist `DANGEROUS_WORKSPACE_ENV_VARS` (`src/core/dotenv.ts`)**: Denylist statis mencakup variabel injeksi proses dan loader biner (`NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `NODE_V8_COVERAGE`, `NODE_PATH`, `NODE_DEBUG`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `PYTHONPATH`, `PERL5LIB`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`), pembajakan proxy (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `SOCKS_PROXY`, `NO_PROXY`), dan hook eksekusi shell (`BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `CDPATH`, `IFS`, `BASH_RCFILE`, `ZDOTDIR`, `SHELL`).
  2. **Pola Wildcard Dinamis (`isDangerousWorkspaceEnvVar`)**: Menolak mutlak seluruh variabel dengan awalan `DYLD_*` (menutup varian bypass macOS seperti `DYLD_FRAMEWORK_PATH`, `DYLD_FALLBACK_LIBRARY_PATH`), awalan `LD_*` (Linux loader injection), serta akhiran `*_BASE_URL` dan `*_API_BASE` (mencegah pembajakan endpoint LLM atau MCP registry ke server penyerang).
  3. **Penyaringan Fail-Closed di `loadDotenv()`**: Variabel yang masuk dalam denylist ditolak mentah-mentah (diabaikan) dan TIDAK PERNAH masuk ke `process.env` atau hasil balik `safeLoaded`, bahkan ketika flag `override: true` diberikan. Variabel aplikasi sah (seperti `PORT`, `APP_ENV`) tetap dimuat normal.
- **File yang dimodifikasi / dibuat:**
  - `src/core/dotenv.ts` — Definisi `DANGEROUS_WORKSPACE_ENV_VARS`, implementasi `isDangerousWorkspaceEnvVar()`, dan sanitasi denylist pada `loadDotenv()`.
  - `src/tests/dotenv_denylist.test.ts` (baru) — Suite uji regresi adversarial: deteksi variabel RCE/proxy/wildcard base URL/wildcard DYLD/LD, filtrasi loadDotenv pada payload berbahaya, perlindungan override: true.
- **Rekonsiliasi test (sebelum/sesudah/delta):**
  - Sebelum: 1191 tests (1190 pass / 0 fail / 1 skip win32, 58 suites).
  - Sesudah: 1194 tests (1193 pass / 0 fail / 1 skip win32, 59 suites).
  - Delta: +3 test baru di suite `dotenv_denylist.test.ts` (1193 pass / 0 fail / 1 skip win32, 59 suites).
- **Next step:** Selesai; dilanjutkan ke Subagent Scope Inheritance (Section 13).


## 13. Subagent Scope Inheritance & Confinement (`ScopeAmendmentManager` + `HostState`) [status: DISETUJUI]
- **Objective:** Menutup celah bypass sandbox di mana subagent yang didelegasikan oleh parent agent berjalan dalam konteks unconfined (tanpa batas subtree) atau dapat memicu micro-prompt terminal untuk memperluas cakupan direktori di luar izin parent agent (ADIT.md §3.3, UCUP.md §3.3).
- **Keputusan teknis penting + alasan:**
  1. **Pewarisan Instansi `ScopeAmendmentManager` & `HostState` (`src/agent/subagent.ts`)**: `SubagentDeps` menerima `hostState` dan `scopeAmendmentManager` opsional dari parent agent. Pada `runSubagent`, dependensi ini diikat langsung ke instance `subAgent` via `subAgent.setHostState(deps.hostState)` dan `subAgent.setScopeAmendmentManager(deps.scopeAmendmentManager)`. Hal ini menjamin subagent berbagi batas subtree fisik yang sama persis dengan parent agent tanpa isolasi semu tanpa proteksi.
  2. **Non-Interactive Confinement & Fail-Closed Hulu (`src/agent/tools.ts`)**: Pada `runToolCall`, `isInteractive` diset secara ketat: `(deps.subagentDepth ?? 0) === 0 && deps.confirm !== undefined`. Ketika `subagentDepth > 0`, subagent secara absolut beroperasi dalam mode non-interaktif. Jika subagent mencoba melakukan mutasi di luar subtree yang telah disetujui parent, `ScopeAmendmentManager.evaluateMutationTarget` mengembalikan `false` dan `DispatcherGate` seketika mengembalikan `SECURITY_DENIED: Target mutasi di luar scope yang diizinkan (...)` tanpa bisa memunculkan prompt interaktif `[Y/n]` untuk meloloskan diri.
  3. **Penerusan Otomatis pada Tool `delegate` (`src/agent/tools.ts`)**: Handler tool `delegate` meneruskan `hostState: deps.hostState` dan `scopeAmendmentManager: deps.scopeAmendmentManager` ke pemanggilan `runSubagent`, memastikan pendelegasian multi-tier tetap terikat pada boundary keamanan hulu.
  4. **Pewarisan Status Plan Mode**: Jika parent agent berada dalam Plan Mode (`hostState.mode === 'plan'`), subagent otomatis mewarisi mode tersebut dan ditolak dari segala bentuk mutasi file/shell.
- **File yang dimodifikasi / dibuat:**
  - `src/agent/subagent.ts` — Ekstensi `SubagentDeps` dan injeksi `hostState` serta `scopeAmendmentManager` ke subagent instance.
  - `src/agent/tools.ts` — Non-interactive enforcement saat `subagentDepth > 0` di `runToolCall`, dan penerusan dependensi di tool `delegate`.
  - `src/tests/subagent_scope_inheritance.test.ts` (baru) — Suite uji regresi adversarial: 1) Blokir mutasi subagent di luar subtree parent, 2) Izinkan mutasi subagent di dalam subtree parent, 3) Pewarisan Plan Mode memblokir seluruh mutasi subagent, 4) Pendelegasian tool `delegate` meneruskan boundary scope secara end-to-end.
- **Rekonsiliasi test (sebelum/sesudah/delta):**
  - Sebelum: 1194 tests (1193 pass / 0 fail / 1 skip win32, 59 suites).
  - Sesudah: 1198 tests (1197 pass / 0 fail / 1 skip win32, 60 suites).
  - Delta: +4 test baru di suite `subagent_scope_inheritance.test.ts` (1197 pass / 0 fail / 1 skip win32, 60 suites).
- **Next step:** Selesai; lanjut ke Fase C Boundary I/O & Network Guard (Section 14).


## 14. Fase C — PR-C1 TOCTOU-Safe File Reader & Network / Scope Boundary Hardening [status: SELESAI-nunggu review]
- **Objective:** Menutup kerentanan TOCTOU pada pembacaan berkas (PR-C1, Blueprint §2.4), mengamankan callback lookup DNS soket pada `hostFetch.ts` dari celah DNS rebinding bypass, melengkapi suite uji TC-NET-04 & TC-NET-05, serta memverifikasi penolakan collision direktori tetangga (sibling prefix) pada TC-SCM-04 (`feedback.txt`, `QA.md`).
- **Keputusan teknis penting + alasan:**
  1. **Modul Defensif `secureReadFile` (`src/core/tools/secureRead.ts`)**:
     - Memvalidasi null byte (`\0`) dan pemblokiran NTFS Alternate Data Streams (`:`) pada lingkungan Windows.
     - Pengecekan segmen berkas bertahap (`fs.lstat`) untuk memblokir symlink di tengah jalur dan tipe berkas tak aman (FIFO/socket).
     - Pembukaan file descriptor kernel atomik menggunakan flag `O_RDONLY | O_NOFOLLOW | O_CLOEXEC` (dengan graceful fallback di Windows).
     - Validasi File Descriptor via `handle.stat({ bigint: true })` memastikan `isFile() === true` dan ukuran berkas maksimal 5MB.
     - Post-open cross-check: resolusi `realpath` dan verifikasi integritas pasangan `stat.ino === realStat.ino` dan `stat.dev === realStat.dev` (anti-swap race).
     - Verifikasi post-read stat (`mtimeNs` dan `size`) mendeteksi mutasi berkas bersamaan selama proses baca.
  2. **Hardening Callback Lookup Soket & Deteksi Literal IPv4 Non-Standar (`src/core/network/hostFetch.ts`)**:
     - Callback opsi `lookup` pada `http(s).request` diubah menjadi fail-closed (`throw new SSRFError('Runtime DNS lookup diblokir...')`). Seluruh koneksi dipaksa terikat langsung ke `pinnedIP` yang telah diverifikasi pada hop pertama, menutup celah DNS rebinding kernel TOCTOU (feedback.txt item #3).
     - Penambahan deteksi literal IPv4 non-standar (format hex `0x...`, octal `0...`, dan integer dword) pada `isPrivateIP` untuk mencegah interpretasi ganda oleh resolver legacy OS `getaddrinfo` / `inet_aton` (TC-NET-04).
     - Verifikasi penolakan IPv6 loopback literal `[::1]` dan metadata link-local `169.254.169.254` / `fe80::1` (TC-NET-05).
  3. **Penolakan Sibling Prefix Collision (`src/core/approval/scopeAmendment.ts`)**:
     - Verifikasi uji adversarial `TC-SCM-04`: upaya mutasi pada direktori tetangga dengan awalan nama serupa (misal target `src-patch/evil.ts` vs scope `src`) ditolak otomatis secara fail-closed berkat validasi pemisah segmen `path.sep`.
  4. **Hasil Evaluasi Model Auditor (`alex.py` vs `py.py`)**:
     - `py.py` (DeepSeek v4.1 Flash via b.ai) memberikan analisis arsitektur terdalam, menangani corner-case NTFS ADS Windows, `FileHandle.stat({ bigint: true })`, bounded memory stream, dan `openat` runtime reality dengan presisi kode yang tinggi.
     - `alex.py` (Nemotron via OpenRouter) memberikan struktur ringkas tetapi terpotong token limit dan menggunakan API `require('node:fs').promises.fstat(fd)` yang tidak valid untuk `FileHandle`.
- **File yang dimodifikasi / dibuat:**
  - `src/core/tools/secureRead.ts` (baru) — Implementasi `secureReadFile`, `SecurityViolation`, dan `isInsideWorkspace`.
  - `src/core/network/hostFetch.ts` — Hardening socket `lookup` callback dan filtrasi IPv4 non-standar di `isPrivateIP`.
  - `src/tests/secureRead.test.ts` (baru) — 9 adversarial tests: TC-SEC-01, TC-SEC-02, TC-SEC-03, traversal, symlink segment, file size, not regular file, workspace containment.
  - `src/tests/fase1_hostFetch.test.ts` — Penambahan 2 tests: TC-NET-04 (IPv4 hex/octal/dword) dan TC-NET-05 (IPv6 loopback & link-local metadata).
  - `src/tests/fase2_scopeAmendment.test.ts` — Penambahan 1 test: TC-SCM-04 (sibling prefix collision).
- **Rekonsiliasi test (sebelum/sesudah/delta):**
  - Sebelum: 1198 tests (1197 pass / 0 fail / 1 skip win32, 60 suites).
  - Sesudah: 1210 tests (1209 pass / 0 fail / 1 skip win32, 61 suites).
  - Delta: +12 test baru (1209 pass / 0 fail / 1 skip win32, 61 suites).
## 15. UI Streaming Glitch Remediation, Subprocess Env Harmonization & E2E CLI Integration Harness [status: SELESAI-nunggu review]
- **Objective:** Menuntaskan sisa temuan audit ADIT.md/UCUP.md dan feedback.txt:
  1. Memperbaiki bug duplikasi teks (buffer ownership inversion) dan streaming freeze 5000 karakter pada `RevealFilter` (`src/core/ui.ts`, ADIT.md §2.1 & §2.2, feedback.txt #5) via pola non-destructive speculative parsing dan fast lookahead rollback yang dikonsultasikan dengan DeepSeek (`py.py`).
  2. Menyelaraskan pembersihan environment subprocess di `src/core/executor.ts` (ADIT.md §1.3, UCUP.md §1.3) agar `DANGEROUS_ENV_VARS` mencakup `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `NODE_PATH`, `NODE_V8_COVERAGE`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, dan `DYLD_*`.
  3. Membangun harness pengujian E2E integrasi CLI v2.0.0 di `src/tests/e2e_security_pipeline.test.ts` (ADIT.md §4.3, UCUP.md §4.3, feedback.txt #8) untuk memvalidasi siklus hidup startup biner, state sesi 0600 di `~/.ruko/sessions/`, penolakan mutasi Plan Mode di level DispatcherGate/Agent, dan fail-safe resume reset ke mode 'plan'.
- **Keputusan teknis penting + alasan:**
  1. **Non-Destructive Speculative Parsing (`RevealFilter` di `src/core/ui.ts`)**:
     - Menghapus pemotongan destruktif `this.buffer = this.buffer.slice(0, openBraceIdx)` yang sebelumnya menyebabkan prefix teks sebelum `{` di-sink dua kali (terduplikasi).
     - Menambahkan fast lookahead rollback: jika akumulasi teks melebihi 32 karakter dan tidak memuat pola kunci tool call (`"tool":`, `"action":`, `"name":`, dll.), buffer spekulatif seketika dialirkan ke terminal tanpa menunggu streaming berakhir atau mencapai 5000 karakter.
     - Membatasi batas maksimum penahanan incomplete JSON non-tool menjadi 256 karakter (eliminasi total streaming freeze).
  2. **Harmonisasi Sanitasi Subprocess (`src/core/executor.ts`)**:
     - Memperluas `DANGEROUS_ENV_VARS` dengan menyertakan variabel injeksi proses Node (`NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `NODE_PATH`, `NODE_V8_COVERAGE`) dan pembajak library loader (`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, serta awalan `DYLD_*`).
     - Menutup asimetri keamanan antara `resourceGovernor.ts` dan eksekutor shell umum.
  3. **E2E Integration Test Harness (`src/tests/e2e_security_pipeline.test.ts`)**:
     - Menguji biner kompilasi `dist/index.js` dengan `spawn` subprocess dan isolasi direktori `HOME` sementara.
     - Memvalidasi pembentukan direktori sesi, hak akses 0600 pada berkas kanonis `state.json`, inisiasi awal dalam Plan Mode, blokir mutasi disk oleh `DispatcherGate`, dan reset otomatis mode ke `plan` saat pemulihan sesi.
- **File yang dimodifikasi / dibuat:**
  - `src/core/ui.ts` — Perbaikan `RevealFilter` buffer ownership dan streaming lookahead.
  - `src/core/executor.ts` — Penambahan `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*` ke `DANGEROUS_ENV_VARS`.
  - `src/tests/reveal.test.ts` — 3 regression tests: TC-REV-01 (anti-duplikasi), TC-REV-02 (fast lookahead live streaming), TC-REV-03 (raw JSON tool suppression).
  - `src/tests/executor.test.ts` — 1 regression test: TC-ENV-01 (sanitasi environment subprocess).
  - `src/tests/e2e_security_pipeline.test.ts` (baru) — 3 E2E test cases: startup lifecycle 0600 state, Plan Mode mutation blocking, dan deterministic session resume reset.
- **Rekonsiliasi test (sebelum/sesudah/delta):**
  - Sebelum: 1210 tests (1209 pass / 0 fail / 1 skip win32, 61 suites).
  - Sesudah: 1217 tests (1216 pass / 0 fail / 1 skip win32, 61 suites).
  - Delta: +7 test baru (1216 pass / 0 fail / 1 skip win32, 61 suites).
- **Belum di-commit.**
- **Next step:** Menunggu review persetujuan dari pengguna sebelum commit.

## 16. Issue #31 — Residual Hardening Post-Audit: Hardlink Escape (`secureRead.ts`) & Env Interpreter Python/Perl/Ruby (`executor.ts`/`dotenv.ts`) [status: DISETUJUI]
- **Objective:** Mengeksekusi 2 residual hardening dari audit Qwen+Grok yang sudah di-cross-check terhadap kode asli (issue #31, `feedback.txt`): (1) deteksi hardlink pada `secureReadFile`, (2) perluasan denylist env subprocess/.env untuk Python, Perl, Ruby. Item lain di issue #31 (edge URL/redirect test, Guardian injection lewat isi command, SSE/TUI quality) **di luar scope** batch ini dan tetap backlog.
- **Keputusan teknis penting + alasan:**
  1. **Hardlink detection fail-closed pada `nlink > 1` (deviasi sadar dari spesifikasi literal):**
     - Spesifikasi meminta tolak bila `nlink > 1` **DAN** `st_dev` berbeda dari workspace root. Secara kernel, `link(2)` tidak bisa melintasi filesystem (`EXDEV`), jadi hardlink ke file sensitif di luar workspace **selalu** punya `st_dev` yang sama dengan workspace. Kondisi AND tersebut tidak akan pernah terpicu oleh serangan hardlink nyata, dan test adversarial (a) mustahil lulus dengan jujur.
     - Implementasi: tolak setiap `stat.nlink > 1n` dengan `SecurityViolation('HARDLINK_ESCAPE')`. Kebijakan ini superset ketat dari kondisi spesifikasi. `st_dev` tetap dibandingkan dengan workspace root dan dicantumkan di pesan error sebagai diagnostik.
     - Cek dilakukan pada **fstat FD yang sudah terbuka** (`handle.stat({ bigint: true })`), bukan pada path, sehingga konsisten dengan pola TOCTOU-safe yang sudah ada dan tidak bisa di-race. Posisinya setelah cross-check inode/dev realpath (langkah 5b), sebelum pembacaan data.
     - Hardlink tidak terdeteksi oleh `realpath`/`lstat`/`O_NOFOLLOW`/`assertPhysicalContainment` karena path-nya memang berada di dalam workspace. Hanya `st_nlink` yang memberi sinyal di level inode.
     - **Trade-off false positive:** file `nlink = 1` tidak terpengaruh, sesuai syarat. File yang sah tetapi ber-hardlink (mis. `node_modules` hasil pnpm store, backup `cp -al`) akan ditolak `read_file`. Agen masih bisa membacanya lewat `exec`, karena shell memang di luar boundary file sandbox.
     - `readFileTool` memetakan `HARDLINK_ESCAPE` ke pesan yang jelas dan bisa ditindaklanjuti agen, tanpa membocorkan isi file.
  2. **Env interpreter lintas bahasa:**
     - `DANGEROUS_ENV_VARS` (`src/core/executor.ts`) ditambah `PYTHONSTARTUP`, `PYTHONPATH`, `PYTHONWARNINGS`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `RUBYLIB`. Mekanismenya sama dengan Node/LD_*/Bash: di-strip dari `process.env` + `options.env` sebelum spawn.
     - `DANGEROUS_WORKSPACE_ENV_VARS` (`src/core/dotenv.ts`) ditambah `PYTHONSTARTUP`, `PYTHONWARNINGS`, `PERL5OPT`, `RUBYOPT` (`PYTHONPATH`/`PERL5LIB`/`RUBYLIB` sudah ada sebelumnya). Varian lowercase ikut diblokir lewat `isDangerousWorkspaceEnvVar`.
     - Pencocokan tetap nama-eksak, bukan prefix, sehingga env Python/Ruby yang benign (`PYTHONUNBUFFERED`, `PYTHONDONTWRITEBYTECODE`, `RUBY_GC_*`) tetap lolos.
     - `resourceGovernor.ts` tidak diubah: sudah berbasis allowlist, jadi ketujuh variabel itu otomatis tidak lolos.
     - **Trade-off:** `PYTHONPATH`/`PERL5LIB`/`RUBYLIB` milik user yang sah di shell induk juga tidak diteruskan ke `exec`. Perilaku ini sama dengan `NODE_PATH` yang sudah di-strip sejak §15.
  3. **Kualitas test:** test interpreter bersifat behavioral, dengan payload nyata (`sitecustomize.py`, `Evil.pm` via `-MEvil`, `evil.rb` via `-revil`) plus **positive control** yang membuktikan payload memang tereksekusi bila Ruko tidak men-strip env. Mutation check: dengan source di-revert (`git stash`), 12/13 test baru gagal. Satu-satunya yang lolos adalah test anti-false-positive `nlink = 1`, dan itu memang diharapkan.
- **File yang dimodifikasi / dibuat:**
  - `src/core/tools/secureRead.ts` — langkah 5b hardlink detection (`HARDLINK_ESCAPE`) + update docstring.
  - `src/agent/filetools.ts` — pemetaan pesan `HARDLINK_ESCAPE` di `readFileTool`.
  - `src/core/executor.ts` — +7 env interpreter di `DANGEROUS_ENV_VARS`.
  - `src/core/dotenv.ts` — +4 env interpreter di `DANGEROUS_WORKSPACE_ENV_VARS`.
  - `src/tests/residual_hardening_issue31.test.ts` (baru) — 13 tests / 2 suites:
    - (a) Hardlink (6): hardlink ke file sensitif di luar ditolak tanpa bocor isi; hardlink di subdir bersarang & path absolut; `read_file` end-to-end; hardlink sesama workspace ber-`st_dev` sama ikut ditolak (mengunci kebijakan); file reguler `nlink = 1` tetap terbaca; file kembali terbaca setelah `nlink` turun ke 1.
    - (b) Env (7): parity denylist executor↔dotenv (+ lowercase); strip dari `options.env` sementara env aplikasi normal & Python/Ruby benign lolos; strip dari `process.env` induk; behavioral Python/Perl/Ruby dengan positive control; `.env` workspace memblokir env interpreter dan tetap memuat variabel normal.
- **Rekonsiliasi test (sebelum/sesudah/delta):**
  - Angka terakhir terdokumentasi (§15): 1217 tests / 61 suites. Baseline aktual sebelum batch ini (HEAD `0e783eb`): **1232 tests (1231 pass / 0 fail / 1 skip win32, 65 suites)**. Gap +15 test / +4 suite berasal dari commit setelah `ff60213`: `plan_auto_execute.test.ts` +12 test / +4 suite (`describe`), `reasoning_fase2.test.ts` +2, `secureRead.test.ts` +1.
  - Sesudah: **1245 tests (1244 pass / 0 fail / 1 skip win32, 67 suites)**.
  - Delta: **+13 test / +2 suite**, semuanya dari `residual_hardening_issue31.test.ts`. Tidak ada test lama yang berubah status.
- **Review (disetujui pengguna):** kebijakan konservatif tolak semua `nlink > 1` disetujui. Strip `PYTHONPATH`/`PERL5LIB`/`RUBYLIB` dari `exec` user disetujui (konsisten dengan `NODE_PATH`). Seluruh test hardlink (a) **dipertahankan**: test tersebut lulus di bawah kebijakan konservatif dan menjadi regression coverage fix ini. Yang "mustahil lulus" hanya varian spesifikasi literal (AND `st_dev`), dan varian itu tidak diimplementasikan.
- **Status rilis:** di-commit & di-push ke `main`. Issue #31 diberi comment ringkasan fix, 3 item sisa (SSRF edge-case/redirect test, Guardian self-justifying injection, SSE/TUI quality) dipindah ke issue follow-up terpisah, lalu #31 ditutup.
- **Next step:** Follow-up 3 item sisa di issue baru.

