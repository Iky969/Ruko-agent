# Contributors

> Kontribusi AI tools tercatat di sini untuk transparansi. Penyertaan tidak berarti endorsement atau tanggung jawab penuh atas proyek.

## Ringkasan Kontributor

| Kontributor | Fokus Utama | Periode Aktif |
| :--- | :--- | :--- |
| **Gemini 3.8 Flash** | Security hardening, persistent memory, UI polish, provider setup | Sep 2026 |
| **Gemini (Google DeepMind)** | File tools, process manager, smart truncation, anti-loop engine | Sep 2026 |
| **Claude (Anthropic)** | Review, UI/TUI redesign, responsive layout, audit | Sep 2026 |
| **DeepSeek** | DSML/XML parser, reasoning box, inline duration | Sep 2026 |
| **Claude Opus 4.6** | Pre-publish security audit & hardening | Sep 2026 |
| **GLM 5.3 Flash** | Testing & developer feedback | Sep 2026 |
| **Chat AI (Deep Flow)** | Pac-Man animation & streaming transition | Sep 2026 |

## Detail Kontribusi per Model

### Gemini 3.8 Flash — Security & Core Systems
- **Security Hardening**: H1 sandbox path traversal, H2 allowlist token, H4 blocked commands, H6 destructive patterns
- **Audit & Logging**: GAP-01 visual indicator, GAP-03 guardian audit log `.ruko/guardian-audit.log`
- **Memory & Safety**: Persistent memory `.ruko/memory.md`, `remember` tool, `/memory` command, prompt injection guard
- **UI/UX**: ANSI markdown formatter, WorkflowTree indicator, TUI spacing, status bar responsive
- **Provider**: Anthropic/Gemini support, zero-dep `.env` loader, REPL history `.ruko/history`, `/export`, E2E runner
- **Release**: v1.1.0 – v1.2.0 installer TAG sync, version sync, test verification
- **Credential Security**: GeminiProvider header `x-goog-api-key`, baseUrl sanitization, error masking
- **File Tools**: `delete_file`/`move_file` guard, anti-duplication, `web_fetch` SSRF + HTML sanitization, multi-pattern glob, visual TUI polish
- **Sensitive Protection**: Dua lapis proteksi file sensitif & env var, anti-flickering TUI, SSE hardening, tool result normalization
- **v1.6.1 – v1.7.2**: Preservasi assistant message, deduplikasi user, hardening symlink, IP-pinning, undo permissions, subagent recursion guard, `/setctx`, `/settoken`, terminal sanitization, shell function hijack mitigation

### Gemini (Google DeepMind) — Tools & Infrastructure
- **v0.9.0**: Roadmap #1 — `glob` & `code_search` dengan deteksi biner, 22 unit tests
- **v1.3.0 – v1.4.0**: Process management (`start_process`, `read_process_logs`, `get_status`, `stop_process`), ESC cancel, `search_sessions`, `/search`, skills system lengkap (`delete_skill`)
- **v1.7.7**: Smart path truncation `truncatePath()`, `COLUMNS` priority di `terminalWidth()`, konsolidasi `/context` vs `/ctx`, panduan recovery raw mode pasca-SIGKILL, tri-layer anti-loop (cache, stream dedup, N-gram cycle detector), 773→800 tests

### Claude (Anthropic) — UI/UX & Audit
- Review & cross-check sesi pengembangan, prompt engineering, audit keamanan, strategi proyek
- Redesain arsitektur layout UI/TUI, WorkflowTree alignment, status panel responsif, spacing polish, mitigasi wrapping layar sempit Termux (40 cols)

### DeepSeek (DeepSeek AI) — Parser & UX
- Parser streaming tool protocol DSML & XML `<invoke>`/`<parameter>`, ekstraksi token reasoning `<thought>`
- Usulan format inline duration `(11ms)`, framed reasoning box `┌─ Reasoning ──` open-ended ala Hermes CLI

### Claude Opus 4.6 & Advisory
- Audit keamanan pre-publish & inisiasi hardening
- Pendampingan arsitektur, strategi eksekusi prompt/role, cross-check SSRF, rekonsiliasi pengujian, roadmap v1.3.0

### GLM 5.3 Flash & Chat AI
- Testing tools & developer feedback
- Eksperimen animasi terminal Pac-Man `Thinking...` & transisi streaming

## Statistik

- **Total Test**: 817 passed (100%)
- **Versi Saat Ini**: 1.7.7
- **Zero Runtime Dependencies**: 100% Node.js standard library
- **Security**: Dual-layer approval gate + Guardian LLM + workspace sandboxing

## Catatan

- Semua kontribusi AI telah diverifikasi manual via `npm test` & `npm run typecheck`
- File ini diringkas dari log harian untuk keterbacaan (detail penuh: lihat [CHANGELOG.md](CHANGELOG.md))
