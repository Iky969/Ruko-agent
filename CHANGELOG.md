# CHANGELOG — Log Sesi & Handoff Ruko

> Log status pengerjaan **Ruko — AI Coding Agent CLI** untuk handoff antar sesi/AI.
> Ini **bukan** changelog rilis — catatan rilis v2.x hanya ada di
> [CHANGELOGv2.md](CHANGELOGv2.md).

## Struktur dokumen (per 2026-11-22)

| Berkas | Isi |
|---|---|
| `CHANGELOGv2.md` | **Changelog rilis utama** (Keep a Changelog, v2.x). |
| `CHANGELOG.md` (berkas ini) | Log sesi singkat + status terkini. |
| `PROGRESS.md` | Status singkat + pelajaran keamanan penting. |
| `PROGRESS2.md` | Tracker implementasi v2.0 (beku, dirujuk komentar kode). |
| `docs/archive/CHANGELOG-session-log.md` | Log sesi lengkap sebelum perapian (beku). |
| `docs/archive/CHANGELOGS-feedback-batches.md` | Log batch feedback v2 (beku). |

## Status terkini — v2.2.0 (unreleased, 2026-11-22)

- **Versi source**: `2.2.0` (belum dirilis). `install.sh` tetap mem-pin tag `v2.1.0`
  sampai tag `v2.2.0` diterbitkan — keputusan rilis ada di Beverly.
- **PR #42 di-merge** ke main (`985adf6`): hardening approval git
  (klasifikasi dari subcommand sebenarnya, `git config`/`export GIT_*` sebagai
  injeksi). Keempat item **Issue #38** tertutup beserta tes regresinya.
- **PR #43 tidak di-merge**: bump `@types/node` 26.6.4 → 26.6.6 diadopsi di
  branch upgrade `muse/ruko-upgrade-2026-11-22` (diff identik); CI PR merah
  karena 2 kegagalan yang sudah ada di main, bukan akibat bump.
- **Verifikasi lokal** (Linux, Node v24.22.1): `npm run typecheck` lolos;
  `npm test` **1526 total / 1522 pass / 2 fail / 2 skip / 90 suites**.
  Kedua fail adalah artefak environment sandbox dan gagal identik di main.
- **Yang masih terbuka**: rilis/tag `v2.2.0` (butuh keputusan Beverly);
  wishlist Issue #29 (memory/skills, telemetry lokal, npm+Docker, MCP, cron).

## Pelajaran keamanan yang wajib diingat

- **libuv Windows mengabaikan `O_NOFOLLOW`** — jangan jadikan flag itu
  satu-satunya lapisan anti-symlink; selalu pasangkan `lstat` + `realpath` +
  assert containment eksplisit (temuan C1, PR #22, commit `134888d`).
- Detail lengkap: [PROGRESS.md](PROGRESS.md).
