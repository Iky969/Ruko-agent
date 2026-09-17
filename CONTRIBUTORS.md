# Contributors

## AI Assistance

AI tools listed here assisted with development. Their inclusion does not imply endorsement or responsibility for the project.

## Gemini 3.8 Flash
- Kontribusi: Hardening keamanan (H1 workspace sandbox path traversal, H2 allowlist token match, H4 blocked commands protection)
- Tanggal: 2026-09-12
- Kontribusi: Penutupan gap H6 (destructive patterns), GAP-01 visual indicator, GAP-03 guardian audit log (.ruko/guardian-audit.log)
- Tanggal: 2026-09-12
- Kontribusi: Persistent memory (.ruko/memory.md, tool remember, command /memory, prompt injection boundary guard)
- Tanggal: 2026-09-13
- Kontribusi: UI/UX cosmetic polish (ANSI markdown formatter, WorkflowTree step indicator, clean TUI spacing)
- Tanggal: 2026-09-13
- Kontribusi: Provider Anthropic/Gemini, zero-dep .env loader, REPL history persistence (.ruko/history), trajectory export (/export), dan E2E test runner
- Tanggal: 2026-09-13
- Kontribusi: Release v1.1.0 — update installer script TAG, full repository version synchronization, dan test suite verification
- Tanggal: 2026-09-13
- Kontribusi: Security fix kredensial & URL GeminiProvider (header auth x-goog-api-key, baseUrl quotes sanitization, dan error masking)
- Tanggal: 2026-09-13
- Kontribusi: Pemisahan tampilan model dan provider 2 baris pada banner splash REPL & optimasi layar sempit (>= 40 kolom)
- Tanggal: 2026-09-13
- Kontribusi: Release v1.1.1 — sinkronisasi versi 1.1.1, update install.sh TAG v1.1.1, dan build release
- Tanggal: 2026-09-13
- Kontribusi: Keamanan tool berkas (delete_file/move_file), guard anti-duplikasi tool call, web_fetch dengan proteksi SSRF & sanitasi HTML, list_skills, multi-pattern glob, /context set, visual TUI polish, dan perluasan approval gate rm/exec
- Tanggal: 2026-09-13
- Kontribusi: Release v1.2.0 — sinkronisasi versi 1.2.0, update install.sh TAG v1.2.0, dan build release
- Tanggal: 2026-09-13
- Kontribusi: Proteksi dua lapis file sensitif (.ruko/config.json, .env, kunci privat) & environment variable sensitif di level tool (agent & subagent) untuk mitigasi eksfiltrasi kredensial prompt injection
- Tanggal: 2026-09-13
- Kontribusi: Anti-flickering TUI (dirty-checking & in-place tail updates), indikator proses latar belakang di status bar, stream ingestion hardening SSE, normalisasi skema tool result (tool_call_id), dan penanganan empty content model setelah eksekusi tool
- Tanggal: 2026-09-14
- Kontribusi: Release v1.6.1 — Preservasi utuh assistant message (teks + tool call), deduplikasi pesan user pada state loop, dan penyempurnaan guard anti-duplikasi tool call berurutan
- Tanggal: 2026-09-14
- Kontribusi: Release v1.7.0 — Universal Tool Security Hardening, Symlink Sandboxing, Native IP-Pinning Transport Layer & Eliminasi Total DNS Rebinding, Strict Session/Skills Traversal Guards, Undo Snapshot Permissions 0600, Subagent Recursion Guard, UI WorkflowTree Step Enrichment, and 13 Adversarial Test Cases
- Kontribusi: Perbaikan popup command "/" di Termux mobile (seleksi Enter saat scroll highlight & responsivitas status bar layar sempit)
- Tanggal: 2026-09-14
- Kontribusi: Pelaporan total match code_search saat terkena limit cap & pesan suppressed matches
- Tanggal: 2026-09-14
- Kontribusi: Tool revert_file & rollback berkas fleksibel (snapshot .ruko/undo & fallback git checkout), integrasi perintah /undo [path], dan guard plan mode
- Tanggal: 2026-09-14
- Kontribusi: Sanitasi & mitigasi prompt injection pada memory.md (deteksi instruksi imperatif ke model, penolakan saat disimpan, dan netralisasi otomatis ke konteks pasif)
- Tanggal: 2026-09-14
- Kontribusi: Peningkatan timeout default exec ke 120s, dukungan parameter timeout kustom per-panggilan tool, dan notifikasi timeout informatif
- Tanggal: 2026-09-14
- Kontribusi: Dukungan array dan string comma-separated untuk parameter extension pada code_search
- Tanggal: 2026-09-14
- Kontribusi: Tool list_dir untuk inspeksi langsung isi direktori tanpa glob traversal, proteksi berkas sensitif, dan integrasi peran reviewer
- Tanggal: 2026-09-14
- Kontribusi: Release v1.6.2 — Full repository version synchronization, rilis 7 perbaikan feedback.txt, dan verifikasi test suite (409 tests)
- Kontribusi: Security Audit & Comprehensive Hardening — Proteksi terpusat berkas sensitif (.ruko/config.json, .env*, .git-credentials, kunci SSH), proteksi mutlak 6 berkas Immutable Security Core, Transport-Layer SSRF hardening dengan dukungan notasi IP alternatif (desimal integer, oktal, hex, IPv4-mapped IPv6) & redirect hop IP-pinning, penutupan celah broken symlink TOCTOU escape, command filter exec encoding unescaping & shell variable tracking, serta penambahan dokumentasi resmi Security Boundaries & Known Limitations.
- Tanggal: 2026-09-15
- Kontribusi: Implementasi perintah slash `/setctx` & `/settoken` untuk manajemen dinamis context window (rasio standar 1 token ≈ 4 karakter), tenggat sumber daya subagent (`timeoutMs`), sanitasi injeksi terminal (OSC/APC/DCS/PM/bells), mitigasi pembajakan environment variable fungsi shell (`BASH_FUNC_*`), serta penyelesaian Known Bug #1 (best-effort history compression) dan Known Bug #3 (interleaved sequential stdout/stderr).
- Tanggal: 2026-09-15
- Kontribusi: Penyelesaian temuan keamanan & reliabilitas — Proteksi file startup shell pengguna (.bashrc, .bash_profile, .zshrc, .profile, dsb.) di `isSensitivePath` dan `containsSensitiveFilePattern`, penetapan batas maksimum ukuran berkas `MAX_FILE_WRITE_BYTES` (5MB) pada seluruh jalur mutasi berkas (`write_file`, `edit_file`, `patch_file`), dan preservasi timestamp asli pesan riwayat pada ekspor trajectory (`exportSessionTrajectory`).
- Tanggal: 2026-09-15
- Kontribusi: Release v1.7.1 — Resolusi 9 audit keamanan & perbaikan sistem feedback.txt (VULN-01 ekspansi variabel shell approval gate, VULN-02 wildcard exec, VULN-03 runtime env exfiltration, VULN-04 remote http baseUrl validation & LAN/localhost support, VULN-05 /undo path traversal, loop breaker, GeminiProvider apiKey nullish coalescing, Buffer typing), mitigasi eksfiltrasi env tidak langsung (/proc/*/environ, awk ENVIRON, command substitution subshells), fitur Workspace/Folder Trust di startup, dan konfirmasi trust protokol HTTP.
- Tanggal: 2026-09-15
- Kontribusi: Release v1.7.2 — Thought Stream live sliding window (FIFO 12-15 kata ANSI dim), kontrak penalaran system prompt (<thought>), parser tool-call DeepSeek DSML & XML (BUG A), multi-step task completion guard anti-premature halt (BUG B), command /ctx & /status inspeksi context budget (BUG C), responsive status bar layar sempit Termux (BUG D), default context window bebas (128k token / 512k chars), dashboard konfigurasi terpadu /settings (context, max-tokens, role, mode, approval, anim), pelacakan waktu kerja aktif agen & cache tokens pada /usage, placeholder prompt ' /? for help, ask anything...', dan alias /? untuk /help
- Tanggal: 2026-09-15
- Kontribusi: Comprehensive QA & Code Audit Remediation — Perbaikan stateful global RegExp lastIndex skip pada `codeSearchTool`, mitigasi path traversal & arbitrary file deletion/overwrite snapshot metadata `/undo` dengan validasi workspace sandboxing (`validateSnapshotPath`), restorasi persistensi `maxOutputTokens` & `provider` pada `sanitizeConfigFile` serta parsing multiplier `k`/`m` di `/config`, resolusi glitch visual responsive divider/approval header serta implementasi stateful `TerminalMarkdownFormatter` untuk streaming code blocks di `LineGate`, perbaikan seleksi menu "/" pada ambient mode di TUI, sanitasi quote stripping pada kredensial URL `OpenAiCompatibleProvider` & wizard, dan penambahan rangkaian unit test verifikasi (`audit_fixes.test.ts`).
- Tanggal: 2026-09-17

## Claude Opus 4.6
- Kontribusi: Audit keamanan pre-publish & inisiasi implementasi hardening
- Tanggal: 2026-09-12

## Gemini (Google DeepMind)
- Kontribusi: Implementasi Roadmap #1 (tool glob & code_search dengan deteksi biner), integrasi tool protocol, 22 unit test baru (v0.9.0)
- Tanggal: 2026-09-12
- Kontribusi: Subsistem Process Management (start_process, read_process_logs, get_status, stop_process), in-flight ESC cancel, pencarian lintas sesi (search_sessions, /search), dan siklus penuh skills system (delete_skill)
- Tanggal: 2026-09-13

## Claude (Anthropic)
- Kontribusi: Review dan cross-checking sesi pengembangan, prompt engineering, audit keamanan, strategi proyek
- Tanggal: 2026-09-12

## Chat AI (Deep Flow)
- Kontribusi: Eksperimen animasi terminal Pac-Man 'Thinking...' dan transisi streaming
- Tanggal: 2026-09-12

## Gemini (Advisory & Review)
- Kontribusi: Pendampingan teknis arsitektur, strategi eksekusi prompt/role, cross-check hasil audit keamanan & SSRF, rekonsiliasi pengujian, serta perumusan roadmap v1.3.0
- Tanggal: 2026-09-13

## GLM 5.3 Flash
- Kontribusi: Testing tools & feedback pengembang>
- Tanggal: 2026-09-13
