# PROGRESS — Ruko AI Coding Agent CLI

> Ringkasan status pengerjaan & checkpoint handoff untuk AI berikutnya.
> Detail sesi lengkap (beku): [docs/archive/CHANGELOG-session-log.md](docs/archive/CHANGELOG-session-log.md).
> Changelog rilis: [CHANGELOGv2.md](CHANGELOGv2.md).

## Status saat ini — v2.2.0 (unreleased, 2026-11-22)

- **Versi source**: `2.2.0` (belum dirilis). `install.sh` tetap mem-pin tag
  `v2.1.0` sampai tag `v2.2.0` diterbitkan — keputusan rilis ada di Beverly.
- **Tests**: 1526 total — 1522 pass, 2 fail artefak env sandbox lokal
  (gagal identik di main), 2 skip. Typecheck lolos. Zero runtime deps.
- **CI**: matriks Linux/Windows/macOS × Node 18/20 (+ 22 di Linux), 7 job.
- **Terbaru**: PR #42 di-merge ke main (`985adf6`) — Issue #38 tertutup
  (symlink containment fisik, alias `revert_file.target`, launcher `nohup`,
  kontrak `sessionLock`); bump `@types/node` 26.6.6 diadopsi dari PR #43.
- **Terbuka**: rilis/tag `v2.2.0`; wishlist Issue #29 (memory/skills,
  telemetry lokal, npm+Docker, MCP, cron).

## ⚠️ Keamanan — pelajaran yang wajib diingat

1. **libuv Windows mengabaikan `O_NOFOLLOW`** (C1, PR #22, commit
   `134888d`, TERTUTUP): `edit_file` lewat symlink file yang menunjuk keluar
   workspace pernah BERHASIL MENULIS di luar sandbox. Fix: guard eksplisit
   `lstat` symlink → `assertInsideWorkspace(realpath)` + deny-by-default.
   **Jangan pernah jadikan `O_NOFOLLOW` satu-satunya lapisan anti-symlink
   lintas platform.**
2. **Perilaku Windows lain yang sudah difix**: `PSModulePath` machine-wide
   bukan sinyal sesi PowerShell; `cmd /d /s /c` melepas kutip luar (bungkus
   kutip tambahan); `spawn detached+unref` + pipe = stdout tak sampai ke
   parent (detached hanya POSIX); `fs.realpath` async vs `realpathSync`
   (long-name vs 8.3 `RUNNER~1`) — containment membandingkan SEMUA bentuk
   workspace via `workspacePathForms()`.
3. **Follow-up terbuka (non-blocking)**: `workspaceRoot` di system prompt
   (`roles.ts`) belum disanitasi dari newline/control chars — sanjung saat
   refactor prompt berikutnya.
