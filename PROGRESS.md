# PROGRESS — Ruko AI Coding Agent CLI

> Ringkasan status pengerjaan & checkpoint handoff untuk AI berikutnya.  
> Histori lengkap dipindahkan ke [CHANGELOG.md](CHANGELOG.md).

## Status Saat Ini — v1.7.7 (23 Sep 2026)

- **Versi**: 1.7.7 (stable)
- **Tests**: 817 passed, 0 failed
- **E2E**: 1 passed
- **Typecheck**: clean
- **Node**: >=18.0.0, tested on 18.x & 20.x
- **Dependencies**: 0 runtime (zero-dep)

### Apa yang Baru di v1.7.7

- **UI Revamp**: inline duration `(11ms)`, framed reasoning box `┌─ Reasoning ─`, smart path truncation `truncatePath()`
- **Anti-Loop Tri-Layer**: in-turn idempotent cache, stream-level dedup, N-gram cycle detection (3-1-2)
- **Security**: ReDoS fix, clear-text logging fix, TOCTOU fix (open + O_NOFOLLOW), CodeQL 0 alerts
- **Installer**: immutable SHA pinning `v1.7.7`, atomic swap, rollback otomatis
- **Terminal**: `COLUMNS` priority, SIGKILL recovery guide (`reset`/`stty sane`)

### 2 Rilis Terakhir (Ringkas)

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
npm test            # harus 817 passed
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
