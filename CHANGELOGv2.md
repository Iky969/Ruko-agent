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
