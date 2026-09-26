# PROGRESS — Ruko AI Coding Agent CLI

> Ringkasan status pengerjaan & checkpoint handoff untuk AI berikutnya.  
> Histori lengkap dipindahkan ke [CHANGELOG.md](CHANGELOG.md).

## Status Saat Ini — v1.8.0 (26 Sep 2026)

- **Versi**: 1.8.0 (stable)
- **Tests**: 901 passed, 0 failed
- **E2E**: 1 passed
- **Typecheck**: clean
- **Node**: >=18.0.0, tested on 18.x & 20.x
- **Dependencies**: 0 runtime (zero-dep)

### Apa yang Baru di v1.8.0 — UI Overhaul 6 Fase + Fix Loop Detector

- **Fase 1 — `/mode`**: popup selector (Default/Research/Code/Build), state per-sesi in-memory; efek ke loop detector via parameter injection (`loopThreshold`, `readOnlyRelaxed`, `buildPhase: explore→mutate` permanen saat tool mutating pertama) — algoritma inti deteksi tidak disentuh
- **Fase 2 — `/reasoning` + wiring provider**: High/XHigh/Max/Extreme (default XHigh); param native per provider (`reasoning_effort` / `thinking.budget_tokens` / `thinkingConfig.thinkingBudget`) + fallback prompt injection otomatis saat endpoint menolak — request tidak pernah gagal
- **Fase 3 — Panel Reasoning terpisah**: box `─ Reasoning (collapsed) ▼`, ringkasan `Thought for Xs (Y tokens)` (Y hanya jika tersedia dari usage), toggle `Ctrl+R`, buffer streaming per-baris + throttle 100ms
- **Fase 4 — Diff ringkas**: `✍️ <tool> <file>   +N -M   Xs` untuk write/edit/patch_file; detail diff default collapsed, toggle `Ctrl+D`; N/M dihitung algoritma LCS yang sama dengan renderer → selalu cocok dengan diff aktual
- **Fase 5 — Status bar dipisah**: info model & task background tidak menumpuk kotak Terminal; hint tray `-- N more, ctrl+o to expand` hanya saat task aktif >= 2 (Ctrl+O tetap); indikator `mode:<aktif>  reasoning:<level>` responsif
- **Fase 6 — Placeholder & lokalisasi**: `"/? untuk bantuan, tanya apa saja..."` (dim), hilang total saat mengetik, muncul kembali saat buffer kosong
- **Fix loop detector**: dedup tool call duplikat within-batch kini berlaku juga di jalur non-streaming (deteksi siklus N-gram tidak diubah)

### Rilis Sebelumnya (Ringkas)

#### v1.7.7 — UI Revamp, Anti-Loop Tri-Layer (3-1-2), Security Hardening
- Inline duration `(11ms)`, framed reasoning box `┌─ Reasoning ─`, smart path truncation `truncatePath()`
- Tri-layer anti-loop: in-turn idempotent cache, stream-level dedup, N-gram cycle detection
- Security: ReDoS fix, clear-text logging fix, TOCTOU fix (O_NOFOLLOW), CodeQL 0 alerts
- Installer: immutable SHA pinning, atomic swap, rollback otomatis

#### v1.7.6 — Universal Fallback Parser & Visual Polish
- Parser universal: XML `<tool>`, DeepSeek DSML `<|DSML|invoke>`, markdown ```tool
- Visual spacing polish, `/yolo` integration

#### v1.7.5 — DeepSeek DSML Fix
- Fix double-pipe `||` / full-width `｜｜` + spasi wrapper `<... calls>`
- RevealFilter 100% no-leak streaming

> Detail lengkap semua versi: lihat [CHANGELOG.md](CHANGELOG.md)

## Roadmap Status

- [x] File tools (read, write, edit, patch, delete, move, glob, code_search, list_dir, revert)
- [x] Multi-provider (OpenAI, Anthropic, Gemini) + profiles
- [x] Subagent delegation + timeout guard
- [x] Skills system (load/save/list/delete)
- [x] Approval dual-layer + Guardian LLM audit
- [x] Search sessions & trajectory export
- [x] Process manager (start/read/get/stop)
- [x] TUI polish (raw-mode, ambient input, ESC cancel, activity tray, responsive 40 cols)
- [x] Security hardening (SSRF IP-pinning, symlink sandbox, sensitive protection)
- [ ] Cron / gateway messaging (ditunda)
- [ ] Plugin / MCP support (future)
- [ ] npm publish & Docker image (future)

## Known Bugs / Limitations (Ringkas)

1. **Obfuscation eval/base64** — tidak bisa 100% regex, ditangani Guardian LLM Layer 2
2. **Redaksi kredensial** — best-effort regex, bukan jaminan mutlak
3. **TOCTOU filesystem** — micro-window symlink swap (mitigasi: O_NOFOLLOW, lstat, atomic wx)
4. **Single-user trusted env** — rekomendasikan Docker/VM untuk repo tak tepercaya

> Detail 8 poin batasan: lihat README bagian Security Boundaries

## Verifikasi Baseline (Wajib Sebelum Coding)

```bash
npm run typecheck   # harus 0 error
npm test            # harus 901 passed
npm run test:e2e    # harus 1 passed
```

## Struktur Direktori

- `src/core/`: loop, approval, executor, ui, config, undo, session, skills, etc.
- `src/agent/`: agent, llm, tools, filetools, webtools, subagent, commands, roles
- `src/tests/`: unit & e2e tests (node:test)
- `.github/`: CI, CodeQL, dependabot, SECURITY.md

## Konvensi Pengembangan

- Zero runtime dependencies
- TypeScript strict + ESM (`.js` extension di import)
- Bahasa CLI & docs: Indonesia
- Jangan buat git tag baru tanpa instruksi user
- Simpan snapshot undo di `.ruko/undo/` dengan mode 0600

## Handoff Checklist untuk AI Berikutnya

1. Baca README.md & SECURITY.md terbaru
2. Jalankan baseline tests
3. Cek CHANGELOG.md untuk konteks histori jika perlu detail
4. Fokus pada file pendek & modular, hindari menambah panjang PROGRESS.md
5. Selalu validasi security: approval gate, workspace sandbox, sensitive path
