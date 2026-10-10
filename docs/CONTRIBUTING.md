# Panduan Kontribusi

Terima kasih telah berkontribusi pada Ruko. Perubahan kecil, laporan bug, dokumentasi, dan test regresi sangat membantu.

## Sebelum mulai

1. Baca README dan [kebijakan keamanan](../.github/SECURITY.md) agar memahami batas sandbox, Plan Mode, approval, dan threat model.
2. Untuk bug atau perubahan besar, buat issue atau diskusikan terlebih dahulu supaya cakupan dan perilaku yang diharapkan jelas.
3. Kerentanan keamanan jangan dipublikasikan bersama detail exploit yang belum ditangani. Gunakan GitHub Security Advisory atau kanal privat maintainer.

## Siapkan lingkungan

- Node.js 18 atau lebih baru dan npm.
- Fork/clone repo, lalu buat branch kerja dari `main` dengan nama yang menjelaskan perubahan, misalnya `fix/scope-denial` atau `docs/contributing`.
- Instal dependency pengembangan dan jalankan pemeriksaan awal:

```bash
npm ci
npm run typecheck
npm test
```

Ruko tidak memakai dependency runtime. Jangan menambah dependency runtime tanpa diskusi dan alasan yang kuat.

## Membuat perubahan

- Ikuti gaya dan pola yang sudah ada; ubah hanya bagian yang terkait.
- Untuk bug, tambahkan test regresi yang membuktikan perilaku salah sebelum perbaikan dan lulus setelahnya.
- Pertahankan fail-closed: approval pengguna tidak boleh melewati Plan Mode, scope path, workspace containment, proteksi path sensitif, atau security core.
- Validasi path dan state pada batas otoritatif. Jangan mempercayai argumen tool dari model sebagai otorisasi pengguna.
- Jangan menaruh API key, token, kata sandi, data pengguna, atau file `.env` dalam commit, test fixture, screenshot, log, maupun issue.
- Jangan mengedit `dist/` secara manual; build TypeScript menghasilkannya.
- Perubahan perilaku pengguna perlu memperbarui dokumentasi dan changelog yang sesuai.

## Verifikasi

Sebelum membuat pull request, jalankan:

```bash
npm run typecheck
npm test
npm run test:e2e
npm run test:urls
```

Jika perubahan menyentuh approval, Plan/Act, scope, persistence, atau proteksi filesystem, jalankan juga test suite terkait secara terpisah. Catat hasil nyata dan platform/versi Node yang digunakan; jangan menyatakan test lulus jika belum dijalankan.

## Pull request

1. Commit perubahan pada branch fitur dengan pesan ringkas, misalnya `fix: report scope denial cause` atau `docs: add contribution guide`.
2. Push branch fitur ke fork/repo dan buka PR ke `main`.
3. PR menjelaskan masalah, solusi, risiko/perubahan kompatibilitas, dan test yang dijalankan. Sertakan issue terkait bila ada.
4. Tunggu CI dan review. Jangan push langsung ke `main`, force-push branch bersama, atau merge PR tanpa otorisasi maintainer.
5. Perubahan versi, tag, dan release dilakukan terpisah setelah versi serta tag immutable dipastikan siap.

## Gaya commit

Gunakan Conventional Commits bila sesuai:

- `feat:` fitur
- `fix:` perbaikan bug
- `docs:` dokumentasi
- `test:` test tanpa perubahan perilaku
- `refactor:` restrukturisasi tanpa perubahan perilaku
- `chore:` pemeliharaan

Jaga commit tetap fokus dan mudah ditinjau.
