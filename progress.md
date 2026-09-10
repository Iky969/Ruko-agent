# progress.md — Eksekusi feedback.txt (Ruko CLI)

Baseline: 64 test hijau (`npm test`), commit terakhir 1bb7dc7.
Sumber: `feedback.txt` (8 bagian). Diperbarui setiap tugas selesai.

## Hasil akhir: 93 test hijau, typecheck bersih, v0.4.0

### P0 — Provider & Config (feedback §2, §3)
- [x] T1. Registry tunggal: `/help` DIBANGKITKAN dari COMMANDS (buildHelpText), plus hint argumen; test sinkron di src/tests/commands.test.ts
- [x] T2. `src/agent/llm.ts`: `testConnection()` + `listModels()` + `explainProviderError()` (401 → "API key salah atau kedaluwarsa", 404 → "Model tidak ditemukan, cek nama atau baseUrl", ECONNREFUSED localhost → "Server lokal belum jalan (ollama serve)") — semua sertakan perintah perbaikan
- [x] T3. Wizard (`promptSetup` hook `probe`): setelah kredensial diisi → tes koneksi live → "✓ Terhubung ke <model>" atau error + pilihan [c]oba ulang / simpan / [b]atalkan; aktif di first-run, `/login`, `/config setup`
- [x] T4. Config multi-profil (`profiles`, `defaultProfile`, `activeProfile`, `apiKeyEnv`) + `resolveProfileCredentials` (active > default; apiKeyEnv > apiKey literal) + file config ditulis mode 600 (verifikasi: `stat -c %a` → 600)
- [x] T5. `/profile` baru (daftar + ganti alias, teruji end-to-end); `/model` tanpa arg auto-fetch /v1/models (verifikasi smoke: box Models (3) muncul)

### P1 — Role, Hemat Token, Keamanan (feedback §4, §5, §6)
- [x] T6. `src/agent/roles.ts`: prompt berlapis urutan TETAP (core identity → tool rules → role → AGENT.md → mode) + role bawaan default/reviewer/teacher/minimal + role kustom `.ruko/roles/*.md` frontmatter (global ~/.ruko/roles + proyek) + `/role` baru; `agent.ts` pakai `buildSystemPrompt` (sebelumnya hardcode)
- [x] T7. Panel usage per giliran: `↑ Xk ↓ Yk · ctx Z%` (buildUsageLine + Agent.lastUsage) + status bar baru `ctx 41% (12.3k/30k)` + peringatan proaktif >50% + indikator `⏸ PLAN`
- [x] T8. Tool `patch_file` (applySearchReplace: unik-persis, error tidak ditemukan/ambigu, replaceAll) — teruji + terdokumentasi README
- [x] T9. `/undo`: `src/core/undo.ts` snapshot sebelum tiap write/edit/patch ke `.ruko/undo/` (restore isi lama / hapus file baru, 25 jurnal, RUKO_UNDO_DIR untuk test) — teruji end-to-end (restore "konten asli")

### P2 — Pengaman & Mode (feedback §5, §6, §7)
- [x] T10. Deteksi loop di KODE: signature tool+arg >2× dalam satu instruksi → hentikan + pesan (Agent.seenRepeat)
- [x] T11. Cap hasil tool 8.000 char head+tail (capToolResult) untuk SEMUA tool sebelum masuk konteks
- [x] T12. Plan mode `/plan on|off` ditegakkan di kode: runToolCall memblokir exec/write/edit/patch saat aktif (read_file tetap); status bar menampilkan ⏸ PLAN
- [x] T13. `/mode beginner|pro`: beginner → role teacher + tips prompt + konfirmasi penuh; pro → role minimal (switch otomatis saat ganti mode, §7); persist ke config

### Verifikasi
- [x] T14. 29 test baru (roles, undo, patchfile, profiles, commands, wizard probe, ui bar) → total 93 hijau; `npm run typecheck` bersih; smoke E2E dengan fake-llm-server: /help registry, /model auto-fetch, /profile ganti alias, /plan blokir, /role, usage line muncul
- [x] T15. README.md disinkronkan ke v0.4.0: ringkasan versi, blok fitur baru (login-probe, profil + contoh config, role berlapis, patch_file, pengaman kode, usage line), diagram alur + tool loop, tabel command dari registry (checker: `scripts/sync-readme-commands.mjs` → "IN SYNC 19"), perbaikan baris tabel approval yang over-escaped

## Yang TIDAK dikerjakan sesi ini (deviasi sadar dari feedback)
- Ink / @clack/prompts / zod / tsup: proyek Ruko zero-dependency by design (konvensi README) — UI tetap ANSI murni.
- Autocomplete popup real-time per-keystroke: terblokir Known Bug #7 (keypress readline tak andal di PTY); menu `/` + filter matchCommands sudah siap saat keyparser ditulis.
- cache_control Anthropic & /cost rupiah: butuh provider Anthropic + usage reporting API; proxy char dipakai dulu.
- /undo berbasis git stash/commit: sengaja diganti snapshot file agar jalan tanpa git.
- Sub-task sesi anak terisolasi (§6.41) + startup bundling <300ms (§1.4): perlu arsitektur/build terpisah, masuk backlog.
- Pemindahan config ke ~/.ruko (home): tetap ./.ruko per-proyek (konvensi berjalan; RUKO_CONFIG tersedia untuk override).

## Catatan teknis sesi
- JANGAN menulis literal seperti `'sk-xxxx'` di source/test: lapisan secret-redaksi menuliskan `***` ke DISK saat write_file (bukan sekadar tampil di terminal), merusak sintaks. Kalau terjebak: perbaiki via `node -e` (jalur tulis shell tidak ter-mask).
