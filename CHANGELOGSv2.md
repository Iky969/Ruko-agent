# Changelog Ruko-agent v2 — Feedback Batches

Berkas ini mencatat batch implementasi feedback sesuai permintaan pengguna. Riwayat rilis sebelumnya tetap berada di `CHANGELOGv2.md`; file tersebut tidak diganti atau diubah oleh batch ini.

## [Unreleased] — 2026-10-10

### Batch 1 — PR-A, dua task selesai

#### Fixed
- Bootstrap kontrak path ketika user memasuki ACT melalui `/plan off`/toggle atau pemilihan rencana bernomor di Agent maupun REPL. Scope default `.` hanya dibuat jika kontrak belum ada; scope sempit yang sudah disetujui tetap dipertahankan.
- Sinkronisasi `Agent.planMode` dengan mode host melalui `Agent.setPlanMode()`, dengan persist atomik yang ditunggu sebelum menjalankan tool berikutnya. Transisi gagal tetap fail-closed; `/plan on` mencabut scope.
- Pembaruan scope menggunakan lock sesi milik pipeline dengan validasi nonce, tanpa deadlock acquire ulang. Amandemen/kontraksi/reset menjaga identitas HostState bersama agar tidak meninggalkan izin live yang usang.
- Persetujuan hasil prompt memeriksa ulang mode/hash rencana sebelum persist; izin live tidak diperluas ketika penyimpanan gagal.

#### Added
- `/scope allow <path>` untuk memberi izin file/subtree dalam workspace, termasuk path baru yang diresolusikan lewat ancestor yang eksis.
- `/scope status` (alias bentuk kosong `/scope`) untuk melihat mode dan scope tanpa mengubah state.
- `/scope reset` untuk mencabut seluruh kontrak path sesi tanpa mengganti Plan/Act. Perintah baru tersedia di help/autocomplete.
- `src/tests/feedback_scope_bootstrap.test.ts`: 17 test regresi/integrasi, termasuk CLI biner, write file nyata, kedua auto-off, resume, scope sempit, reset setelah amandemen, traversal/symlink escape, lock hilang, perubahan hash rencana, serta gagal persist.

#### Security policy
- Opsi A+C: hanya perintah/seleksi user yang meminta ACT membuat seed default. Perintah eksplisit ini berlaku juga pada non-TTY; startup/resume tetap PLAN, null scope tanpa otorisasi dan mutasi luar subtree pada non-TTY tetap ditolak.
- Gate Plan Mode, workspace containment, path sensitif/security core, dan approval shell tetap berlaku. YOLO tidak melewati gate tersebut.
- Untuk scope sempit: `/scope allow src` saat PLAN, lalu `/plan off`. Jika scope sudah `.`, `/scope reset` terlebih dahulu lalu allow path yang diinginkan; allow menambah izin, bukan mempersempit kontrak lama.

#### Documentation
- `feedback.txt`: hanya dua item implementasi pertama PR-A ditandai selesai; checkpoint hasil batch ditambahkan. Checklist lain tidak ditutup pada batch ini.
- `PROGRESS2.md`: fokus aktif dan §17 mencatat keputusan, batas batch, serta hasil verifikasi.
- `README.md`: panduan bootstrap scope dan perintah allow/status/reset.
- `feedback.txt` di-ignore oleh `.gitignore:14`; checklist diperbarui lokal tanpa mengubah aturan ignore.

#### Verification
- Lingkungan: Linux, Node v24.21.0.
- `npm run test`: 1268 tests, 1267 pass, 0 fail, 1 skip, 68 suites.
- Baseline: 1251 tests, 1250 pass, 0 fail, 1 skip, 67 suites; delta +17 tests / +1 suite.
- `npm run typecheck`, `npm run build`, `git diff --check`: lulus; guard zero runtime dependency lulus.
- Static/self-review dan test dilakukan; review independen belum dilakukan (tool delegasi/CLI reviewer tidak tersedia di sesi ini).

#### Remaining
- STOP setelah dua task. Checklist PR-A lainnya serta PR-B/PR-C/PR-D/PR-E belum dilanjutkan; validasi argumen `/plan` dan kebijakan YOLO tetap backlog.
- Batch ini dicatat dalam commit lokal atas permintaan pengguna; belum push, perubahan versi package, atau tag release.
