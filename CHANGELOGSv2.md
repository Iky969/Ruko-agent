# Changelog Ruko-agent v2 — Feedback Batches

Berkas ini mencatat batch implementasi feedback sesuai permintaan pengguna. Riwayat rilis sebelumnya tetap berada di `CHANGELOGv2.md`; file tersebut tidak diganti atau diubah oleh batch ini.

## [Unreleased] — 2026-10-10

### Batch 3 — Task 5–8 & audit referensi mode

#### Fixed
- Penolakan scope kini membawa kode penyebab dan petunjuk pemulihan dari manager ke dispatcher: scope kosong, hash rencana berubah, path luar workspace, containment fisik gagal, luar subtree, prompt tidak disetujui, circuit breaker, dan PLAN aktif kembali saat menunggu prompt. Mode/scope/target ditampilkan dalam pesan error, bukan perubahan status bar. API boolean lama tetap kompatibel; izin tidak dilonggarkan.
- `/plan` menolak argumen invalid sebelum transisi/persist. Bentuk `on`, `off`, kosong/toggle, serta normalisasi huruf/spasi existing tetap berlaku; input invalid tidak mengubah mode/scope/config/state disk.

#### Tests
- Regresi PLAN diperkuat dengan payload valid untuk semua 11 tool mutasi/subprocess, readback file/state, tanpa side effect atau confirmer. Test baru memastikan kontrak scope yang ada tidak melewati PLAN dan read-only tetap berjalan.
- Test pesan per penyebab, pemulihan kontrak hash baru, penolakan prompt/circuit breaker, perubahan mode saat prompt, validasi `/plan` dari PLAN/ACT, dan bentuk command valid.
- Test mode memakai `/mode code` serta memeriksa state sesi/output sukses/tidak ada persist config. UiMode `beginner|pro` tetap diuji terpisah sesuai API `/settings mode`, dari nilai awal berbeda agar tidak lulus kebetulan karena default. `roles.ts` sudah memakai `/mode` generik sebelum batch; ditambah guard prompt tanpa edit produksi yang tidak perlu.
- Scan seluruh `src/`: tidak ada literal `mode pro` atau `mode beginner`. Satu assertion wiring yang bergantung copy error generik diperbarui menjadi pemeriksaan kode penyebab + scope/target/hint; tidak melonggarkan test menjadi sekadar error umum.

#### Verification
- Baseline working tree termasuk staged batch 2: **1273 tests / 1272 pass / 0 fail / 1 skip / 68 suites**.
- Final `npm run test -- --test-reporter=tap`: **1283 tests / 1282 pass / 0 fail / 1 skip / 68 suites**. Delta **+10 tests / +0 suite** (9 scope/plan, 1 prompt); satu test settings di-rename/diperkuat, tidak dihapus. Skip existing khusus Windows.
- Run penuh pertama mengungkap 1 assertion copy lama; setelah perbaikan assertion, full suite ulang lulus. Suite relevan final **81/81 pass**; scope/dispatcher/symlink task 7 **57/57 pass**. Typecheck/build/diff-check lulus; test bug baru diamati RED→GREEN.
- Empat guard zero runtime dependency lulus dan `npm ls --omit=dev --all` kosong; package/lockfile tidak berubah. Verifikasi pada Linux / Node v24.21.0 / npm 11.19.0. Static/self-review dilakukan; belum ada review independen.

#### Documentation & boundary
- `feedback.txt`: task 5–8 selesai + checkpoint batch 3 (tetap file lokal di-ignore); `PROGRESS2.md`: fokus aktif dan §19; changelog ini ditambah tanpa mengubah arsip batch sebelumnya.
- Tujuh file staged awal dipertahankan dengan index identik. Tidak mengaktifkan YOLO runtime, mengubah approval global, menambah dependency, atau mengedit `dist/` manual.
- STOP untuk review; task 9–12 dan task berikutnya tidak dikerjakan. Tidak staging/commit/push/tag/release.

### Batch 2 — PR-A task 3–4, dua task selesai

#### Fixed
- Seed scope workspace default-deny tanpa otorisasi host eksplisit. `Agent.setPlanMode(false)` tidak lagi dapat membuat scope implisit; penolakan `SCOPE_BOOTSTRAP_DENIED` mempertahankan mode, scope live, dan state disk.
- Handler `/plan` dan pilihan rencana bernomor di Agent/REPL meneruskan `userAuthorized: true` hanya melalui opsi host, bukan argumen tool. Scope sempit yang sudah ada tetap dipertahankan; tidak ada toggle/config baru.

#### Added
- Empat test fail-closed: transisi non-TTY tanpa otorisasi, seed manager langsung, scope dicabut + YOLO/konfirmasi/flag tool, serta penolakan ekspansi subtree non-TTY tanpa membaca input/prompt. Positive control membuktikan write dalam subtree sah tetap berhasil.
- E2E CLI non-TTY dari sesi baru → `/plan off` → `write_file` file workspace: verifikasi startup PLAN tanpa scope, persist ACT + scope `.` sebelum request, tool-result provider, readback isi file nyata, final state disk, dan exit 0. Provider adalah fixture HTTP lokal pada port ephemeral, tanpa API eksternal/kredensial riil.
- Suite existing `feedback_scope_bootstrap.test.ts` bertambah dari 17 menjadi 22 tests; test command/pipeline write yang sudah ada tidak dihapus.

#### Documentation
- `feedback.txt`: hanya checkbox task 3–4 ditutup pada batch ini beserta checkpoint; task 5–6 dan PR berikutnya tetap terbuka. Berkas tetap di-ignore dan diperbarui lokal.
- `PROGRESS2.md`: fokus aktif §3 dan laporan batch 2 di §18, termasuk kebijakan, hasil test, batas scope, serta catatan verifikasi.
- `CHANGELOGv2.md`, README, package/lockfile, dan `.gitignore` tidak diubah.

#### Verification
- Linux / Node v24.21.0 / npm 11.19.0; suite scope: **22 tests / 22 pass / 0 fail**.
- Baseline HEAD `1502dd7` di arsip terisolasi: **1268 tests / 1267 pass / 0 fail / 1 skip / 68 suites**.
- Final `npm run test -- --test-reporter=tap`: **1273 tests / 1272 pass / 0 fail / 1 skip / 68 suites**; delta **+5 tests / +0 suite**. Skip existing khusus Windows. Guard zero runtime dependency dan test Plan Mode existing tetap lulus sebagai regresi, tanpa menutup task 5–6.
- `npm run typecheck`, `npm run build`, `git diff --check`: lulus. Test seed implisit diamati RED sebelum implementasi lalu GREEN.
- Percobaan awal runner default terhenti watchdog idle; baseline/final penuh memakai reporter TAP, tanpa mengubah runner/timeout.
- Static/self-review dilakukan; credential placeholder fixture bukan secret riil. Review independen belum dilakukan (tool delegasi/CLI reviewer tidak tersedia).

#### Remaining
- STOP setelah task 3–4. Task 5–6 PR-A dan PR-B/PR-C/PR-D/PR-E tidak dilanjutkan; validasi argumen `/plan`, status/messaging, approval UX, dan persist YOLO tetap backlog.
- Perubahan batch 2 belum di-commit; tidak staging, push, perubahan versi package, tag, atau release.

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
