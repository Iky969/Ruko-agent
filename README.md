# Ruko — AI Coding Agent CLI

[![Version](https://img.shields.io/badge/version-1.8.0-blue.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0%20runtime-success.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-901%20passed-brightgreen.svg)](src/tests/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Security](https://img.shields.io/badge/security-CodeQL%20%7C%20Secret%20Scanning%20%7C%20Dependabot-success.svg)](.github/SECURITY.md)

**Ruko** adalah AI Coding Agent CLI yang cepat, minimalis, dan *security-hardened*. Dibangun murni di atas **Node.js (ESM) + TypeScript tanpa runtime dependencies**, Ruko menghadirkan pair-programming yang andal langsung dari terminal.

### Install Cepat

```bash
curl -fsSL https://raw.githubusercontent.com/Iky969/Ruko-agent/main/install.sh | bash
cd /proyek-anda
ruko
```

---

## 📑 Daftar Isi

- [Sorotan](#-sorotan-utama)
- [Instalasi](#-instalasi--memulai-cepat)
- [Keamanan](#-arsitektur-keamanan)
- [Fitur](#-fitur-unggulan)
- [Tools](#-daftar-tool-terintegrasi)
- [Slash Commands](#-daftar-perintah-slash)
- [Konfigurasi](#-konfigurasi--profil)
- [Pengujian](#-pengujian--verifikasi)
- [Troubleshooting](#-troubleshooting)
- [Struktur](#-struktur-modul)
- [Lisensi](#-lisensi)

---

## 🌟 Sorotan Utama

- 🛡️ **Dual-Layer Approval Gate**: Regex instant (Layer 1) + Guardian LLM semantic (Layer 2) + audit log `.ruko/guardian-audit.log`
- 🤝 **Workspace Trust**: Konfirmasi `Apakah kamu mempercayai folder ini? y/n` saat pertama kali, disimpan di `.ruko/trusted`
- ⚡ **Zero Runtime Deps**: Hanya `node:fs`, `node:child_process`, `node:readline` — ringan, startup instan, bebas supply-chain attack
- 🔍 **Smart Code Tools**: `glob`, `code_search`, `read_file` paginated, `edit_file` dengan diff LCS, `patch_file` hemat token
- ⏪ **Snapshot Undo**: Backup otomatis ke `.ruko/undo/` (mode 0600), rollback via `/undo`
- 🎮 **Modern TUI**: Status box responsif (aman di Termux 40 cols), action log `├── `, live bottom tray, ambient input, Pac-Man thinking ticker
- 🔑 **Multi-Provider**: OpenAI, OpenRouter, DeepSeek, Groq, Together, Ollama, LM Studio, vLLM — kredensial mode 0600
- 🔒 **Security Bots Aktif**: Secret Scanning, Push Protection, Dependabot, CodeQL Analysis — lihat [.github/SECURITY.md](.github/SECURITY.md)

---

## 🚀 Instalasi & Memulai Cepat

**Kebutuhan**: Node.js >=18, Linux/macOS/WSL (termasuk Termux Android)

### 1. Kloning & Build Lokal

```bash
git clone https://github.com/Iky969/Ruko-agent.git
cd Ruko-agent
npm install
npm run build
```

### 2. Global Install

```bash
npm install -g .
# atau untuk dev:
npm link
```

Lalu di proyek mana pun:

```bash
cd /jalur/proyek-anda
ruko
```

Data terisolasi di `./.ruko/` (config, sessions, undo, memory).

### 3. Workspace Trust

Saat pertama kali di folder baru:

```
[Keamanan Workspace Ruko]
Folder aktif: /path/to/project
Apakah kamu mempercayai folder ini? (y/n):
```

Gunakan `--trust-folder` atau `RUKO_TRUST_FOLDER=1` untuk CI.

### 4. Wizard Konfigurasi

Jika tanpa kredensial, Ruko memandu:

1. **API Key** (input disamarkan `*`)
2. **Base URL** (`https://api.openai.com/v1`, `http://localhost:11434/v1`, dll.)
   - HTTP butuh konfirmasi eksplisit `y/n` untuk cegah cleartext leak
3. **Model Name** (`gpt-4o`, `deepseek-chat`, `qwen2.5-coder`, dll.)
4. Tes koneksi langsung — simpan ke `.ruko/config.json` mode 600

---

## 🛡️ Arsitektur Keamanan

Ruko menerapkan defense-in-depth:

```
[ Shell / Tool Exec ]
        ↓
[ Layer 1: Regex Risk Detector ]
  NONE → langsung | BLOCKED → tolak mutlak | DANGEROUS → Layer 2
        ↓
[ Layer 2: Guardian LLM (isolated, temp 0) ]
  SAFE → ✓ Guardian: aman | BLOCKED → tolak | DANGEROUS → konfirmasi y/N
        ↓
[ Audit Log .ruko/guardian-audit.log (0600) ]
```

**Proteksi Inti**:

1. **Workspace Sandbox**: `assertInsideWorkspace()` blokir `../../etc/passwd`, `~/.ssh`, symlink traversal
2. **Regex Gate**: Ratusan pola destruktif (`rm -rf /`, `mkfs`, `dd`, `find -delete`, `truncate`, `shred`, chain `&& ; ||`)
3. **Guardian LLM**: Analisis semantik untuk `DANGEROUS`, auto-allow jika aman (contoh `python3 -c "print(1+1)"`)
4. **Kredensial**: Blokir akses `.ruko/config.json`, `.env`, `id_rsa`, `*.pem`, `*.key` di semua tools + `exec` wildcard `cat .ruko/*`
5. **Env Dump Prevention**: Blokir `printenv`, `env`, `export -p`, `node -e process.env`, `$API_KEY` expansion
6. **Shell Sanitization**: Bersihkan `BASH_FUNC_*`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `CDPATH`
7. **SSRF Protection**: Native IP-pinning transport, blokir private IP, IPv4-mapped IPv6, desimal/oktal/hex notation, redirect hop validation
8. **Security Bots**: Secret Scanning enabled, Push Protection enabled, Dependabot enabled, CodeQL `security-extended` enabled, Branch Protection pada `main`

> Detail batasan & kebijakan: lihat [SECURITY.md](.github/SECURITY.md) dan bagian Security Boundaries di bawah.

---

## 💡 Fitur Unggulan

### Eksplorasi Kode
- `glob`: multi-pattern + brace `{a,b}`, ignore `node_modules/.git/dist/.ruko`
- `code_search`: keyword/regex + konteks baris, support filter extension array
- `web_fetch`: fetch publik 10s timeout, sanitasi HTML, max 5k chars, IP-pinning

### Modifikasi Aman
- `edit_file`/`write_file`: diff visual `+` hijau `-` merah
- `patch_file`: search-replace hemat token
- `delete_file`/`move_file`: konfirmasi `[Y/N]` + snapshot undo
- `/undo [path]`: rollback file spesifik atau global

### Efisiensi
- **Log Summarizer**: output >1000 char dipotong proporsional 40% head + 60% tail, highlight error
- **Context Compression**: rangkum percakapan lama saat mendekati limit, adjustable via `/setctx`, `/settoken`, `/context set`
- **Multi-Profil**: `.ruko/config.json` dengan alias `hemat`, `kuat`, `lokal` — ganti via `/profile`

---

## 🛠️ Daftar Tool Terintegrasi

<details>
<summary>Klik untuk melihat 24 tools lengkap</summary>

| Tool | Kategori | Deskripsi |
| :--- | :---: | :--- |
| `exec` | Eksekusi | Shell via approval gate 2 lapis, default 120s, support `timeoutMs` |
| `glob` | Inspeksi | Cari berkas multi-pattern, ignore build & biner |
| `list_dir` | Inspeksi | List isi direktori 1-level + ukuran B/KB/MB |
| `code_search` | Inspeksi | Cari keyword/regex + konteks |
| `read_file` | Baca | Paginated offset/limit + line numbers, binary-aware |
| `write_file` | Tulis | Buat file baru dalam workspace |
| `edit_file` | Tulis | Timpa file + diff visual |
| `patch_file` | Tulis | Search-replace presisi |
| `delete_file` | Manipulasi | Hapus aman + konfirmasi + undo |
| `move_file` | Manipulasi | Pindah/rename + konfirmasi + undo |
| `revert_file` | Manipulasi | Rollback snapshot `.ruko/undo/` atau `git checkout` |
| `web_fetch` | Jaringan | Fetch publik + SSRF IP-pinning |
| `remember` | Memori | Simpan fakta ke `.ruko/memory.md` lintas sesi |
| `search_sessions` | Pencarian | Cari lintas sesi (limit 5, snippet 150 char) |
| `load_skill` | Skill | Muat skill dari `.ruko/skills/` |
| `save_skill` | Skill | Simpan workflow sukses sebagai skill reusable |
| `delete_skill` | Skill | Hapus skill usang + preview + konfirmasi |
| `list_skills` | Skill | List nama & deskripsi skill |
| `delegate` | Delegasi | Subagent isolated, sekuensial 1 tool/turn (bukan concurrent/paralel), timeout 60s |
| `start_process` | Proses | Non-blocking background (max 3 aktif) |
| `read_process_logs` | Proses | Ring buffer 100 baris + redaksi kredensial |
| `get_status` | Proses | Status deterministik `running/exited/stale` |
| `stop_process` | Proses | Stop bertahap SIGTERM→SIGKILL |

</details>

---

## ⌨️ Daftar Perintah Slash

<details>
<summary>Klik untuk melihat 24+ slash commands</summary>

| Perintah | Fungsi |
| :--- | :--- |
| `/help` / `/?` | Panduan bantuan chip/badge highlight |
| `/exit` | Keluar (sesi auto-simpan) |
| `/login` | Wizard provider + tes koneksi |
| `/new` | Sesi baru (sesi lama tersimpan) |
| `/sessions` | List sesi tersimpan |
| `/search <kw>` | Cari lintas sesi + `/resume` |
| `/resume <id>` | Lanjut sesi |
| `/export [json\|md]` | Ekspor trajectory |
| `/clear` | Bersihkan memori percakapan |
| `/compact` | Paksa kompresi history |
| `/plan on\|off` | Mode rencana (blokir write/exec) |
| `/yolo on\|off` | Mode auto-approve |
| `/undo [path]` | Batalkan perubahan file |
| `/settings` | Dashboard terpadu (context, tokens, role, mode, approval) |
| `/role [nama]` | Ganti role AI |
| `/mode beginner\|pro` | Mode pengguna |
| `/profile [alias]` | Ganti profil LLM |
| `/exec <cmd>` | Shell langsung |
| `/history [n]` | n pesan terakhir |
| `/context [set <n>]` | Kapasitas memori / set limit |
| `/ctx` | Dashboard context budget |
| `/memory [clear]` | Lihat/reset persistent memory |
| `/usage` | Statistik token & waktu kerja agen |
| `/config [set <k> <v>\|setup]` | Lihat/update konfigurasi |
| `/model [nama]` | List/ganti model aktif |

</details>

---

## ⚙️ Konfigurasi & Profil

Config di `./.ruko/config.json` mode `0o600`:

```json
{
  "mode": "beginner",
  "defaultProfile": "utama",
  "profiles": {
    "utama": { "baseUrl": "https://api.openai.com/v1", "model": "gpt-4o", "apiKeyEnv": "OPENAI_API_KEY" },
    "lokal": { "baseUrl": "http://localhost:11434/v1", "model": "qwen2.5-coder" }
  },
  "guardianEnabled": true,
  "guardianTimeoutMs": 5000
}
```

**Env Vars**:

| Variabel | Deskripsi |
| :--- | :--- |
| `OPENAI_API_KEY` | API key default |
| `OPENAI_BASE_URL` | Endpoint OpenAI-compatible |
| `AGENT_MODEL` | Nama model |
| `RUKO_CONFIG` | Path config kustom |
| `RUKO_UNDO_DIR` | Path snapshot undo |
| `RUKO_YOLO_MODE=1` | Skip konfirmasi dangerous (blocked tetap aktif) |
| `RUKO_TRUST_FOLDER=1` | Auto-trust workspace |
| `NO_COLOR=1` | Nonaktifkan ANSI |

---

## 🧪 Pengujian & Verifikasi

```bash
npm run typecheck   # static type check
npm test            # 817 unit tests
npm run test:e2e    # 1 E2E test
```

Test mencakup: approval regex & Guardian adversarial, multi-format tool parser (markdown fence, DSML, XML), Immutable Security Core, sandbox traversal, SSRF + IP-pinning, SSE multi-provider, TUI rewinding, context compression, undo journal, memory/skills/delegation.

---

## 🛡️ Security Boundaries & Known Limitations

1. **Approval Gate bergantung user**: Jika user `Y` tanpa cek diff atau aktifkan `--yolo`, proteksi tidak efektif
2. **Redaksi kredensial best-effort**: Regex heuristik, bukan jaminan 100% anti-leak token arbitrer
3. **TOCTOU filesystem**: Micro-window antara `lstat`/`realpath` dan I/O kernel jika proses eksternal swap symlink
4. **Single-user trusted env**: Untuk multi-user/server publik, jalankan di Docker/VM non-root + egress filtering
5. **Prompt injection via read-only**: `web_fetch` atau file pihak ketiga bisa berisi instruksi terselubung — model tetap rentan terpengaruh analisis
6. **Memory & skills writable by design**: `.ruko/memory.md` & `.ruko/skills/` bisa ditulis agen — monitor via `/memory`
7. **Rekomendasi isolasi**: Untuk repo tak tepercaya/CI, gunakan container terisolasi
8. **API key plaintext awareness**: `apiKey` di config plaintext + 0600, warning jika env var tidak aktif. Rekomendasi: simpan di env var (`RUKO_API_KEY`) dan kosongkan field `apiKey`. Enkripsi at-rest tidak diimplementasikan (butuh key management terpisah)

---

## 📂 Struktur Modul

```
src/
├── index.ts              # CLI entry & arg routing
├── types.ts              # Interface & config schema
├── agent/
│   ├── agent.ts          # Orchestrator & tool loop + anti-loop tri-layer
│   ├── commands.ts       # Slash command registry
│   ├── filetools.ts      # glob, code_search, read_file, list_dir (sandboxed)
│   ├── llm.ts            # Multi-provider client & streaming parser
│   ├── roles.ts          # System prompt & roles
│   ├── subagent.ts       # Delegation isolated
│   ├── tools.ts          # Tool call protocol & security guards
│   └── webtools.ts       # web_fetch + SSRF IP-pinning
└── core/
    ├── approval.ts       # Dual-layer gate & Guardian LLM
    ├── compressor.ts     # Adaptive conversation compression
    ├── config.ts         # Config loader & sanitization
    ├── context.ts        # Context window management
    ├── diff.ts           # Git-style diff visualizer
    ├── dotenv.ts         # Zero-dep .env parser
    ├── executor.ts       # Safe shell execution
    ├── history.ts        # REPL history .ruko/history
    ├── loop.ts           # Interactive loop & TUI controller
    ├── memory.ts         # Persistent memory .ruko/memory.md
    ├── session.ts        # Session storage .ruko/sessions/
    ├── skills.ts         # Modular skills .ruko/skills/
    ├── splash.ts         # Banner & status
    ├── summarizer.ts     # Long log summarizer
    ├── tui.ts            # Raw-mode engine & live overlay
    ├── ui.ts             # ANSI formatting, box, Pac-Man animation
    └── undo.ts           # File snapshot journal
```

---

## 🔧 Troubleshooting

### Termux / Android — Permission Denied

```bash
chmod +x $PREFIX/bin/ruko
```

### Terminal Raw Mode Pasca-Crash / SIGKILL

Jika proses di-`kill -9` dan terminal tidak responsif (echo mati, karakter tak muncul):

```bash
reset          # opsi 1: reset penuh (disarankan)
stty sane      # opsi 2: kembalikan sane mode
tput cnorm     # opsi 3: jika kursor hilang
```

Ruko sudah punya `emergencyCleanup()` untuk kembalikan raw mode, tapi SIGKILL di level kernel tidak bisa di-trap — gunakan command di atas.

### Layar Sempit (Termux 40 cols)

- Status bar otomatis prioritas `ctx %` + badge penting, nama model dipotong proporsional
- Set `COLUMNS=40` untuk simulasi testing
- Gunakan `/ctx` untuk cek context budget jika terpotong

---

## 📄 Lisensi

MIT License — lihat [LICENSE](LICENSE)

---

## 🤝 Kontribusi & Keamanan

- **Security Policy**: [.github/SECURITY.md](.github/SECURITY.md) — Secret Scanning enabled, Push Protection enabled, Dependabot enabled, CodeQL enabled
- **Contributors**: [CONTRIBUTORS.md](CONTRIBUTORS.md)
- **Changelog**: [CHANGELOG.md](CHANGELOG.md) (ringkasan harian di [PROGRESS.md](PROGRESS.md))
- **Audit Report**: [AUDIT_REPORT.md](AUDIT_REPORT.md)

Laporkan kerentanan via GitHub Advisory (jangan buka Issue publik).
