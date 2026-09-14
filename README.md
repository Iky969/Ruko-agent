# Ruko — AI Coding Agent CLI

[![Version](https://img.shields.io/badge/version-1.7.0-blue.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0%20runtime-success.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-381%20passed-brightgreen.svg)](src/tests/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Ruko** adalah AI Coding Agent berbasis CLI untuk lingkungan terminal yang cepat, minimalis, dan dirancang dengan standar keamanan tinggi (*security-hardened*). Dibangun murni di atas **Node.js (ESM) dan TypeScript tanpa *runtime dependencies* pihak ketiga**, Ruko menyediakan pengalaman pemrograman berpasangan (*pair-programming*) yang andal langsung dari direktori proyek Anda.

### Cara Cepat (One-liner Installer)

```bash
curl -fsSL https://raw.githubusercontent.com/Iky969/Ruko-agent/main/install.sh | bash
```
### Troubleshooting (Termux / Android)

Jika muncul pesan `bash: .../usr/bin/ruko: Permission denied` saat menjalankan perintah `ruko`, berikan izin eksekusi secara manual:

```bash
chmod +x $PREFIX/bin/ruko
```
---

## 📑 Daftar Isi

- [Sorotan Utama](#-sorotan-utama)
- [Instalasi & Memulai Cepat](#-instalasi--memulai-cepat)
- [Arsitektur Keamanan (Dual-Layer Gate & Sandbox)](#-arsitektur-keamanan)
- [Fitur Unggulan](#-fitur-unggulan)
- [Daftar Tool Terintegrasi](#-daftar-tool-terintegrasi)
- [Daftar Perintah Slash (Slash Commands)](#-daftar-perintah-slash)
- [Konfigurasi & Profil](#-konfigurasi--profil)
- [Pengujian & Verifikasi](#-pengujian--verifikasi)
- [Struktur Modul](#-struktur-modul)
- [Lisensi](#-lisensi)

---

## 🌟 Sorotan Utama

- 🛡️ **Dual-Layer Approval Gate & Workspace Sandboxing**:
  Perlindungan komprehensif dua lapis untuk eksekusi perintah shell. *Layer 1* (deteksi regex instan) dan *Layer 2* (**Guardian LLM** untuk analisis semantik cerdas). Seluruh tool filesystem dikunci oleh sandbox anti-*path traversal*.
- ⚡ **Zero Runtime Dependencies**:
  100% menggunakan API standar Node.js (`node:fs`, `node:child_process`, `node:readline`, dll.). Sangat ringan, waktu startup instan, dan bebas kerentanan rantai pasok (*supply chain attack*).
- 🔍 **Eksplorasi & Manipulasi Kode Cerdas**:
  Dilengkapi tool `glob`, `code_search`, `read_file` (berpaginasi dan sadar biner), `write_file`, `edit_file` (dengan visual diff LCS ala `git diff`), serta `patch_file` hemat token.
- ⏪ **Snapshot Undo Otomatis**:
  Setiap modifikasi berkas dicadangkan ke `.ruko/undo/` sebelum ditulis. Anda dapat membatalkan perubahan kapan saja lewat perintah `/undo` tanpa bergantung pada Git.
- 🎮 **Modern Terminal UX & Ambient Input**:
  REPL interaktif dengan status bar *real-time*, menu navigasi `/`, animasi Pac-Man *Thinking...* rata kiri, serta mode *ambient input* yang memungkinkan pengguna mengetik, mengantre, atau membatalkan instruksi saat AI sedang bekerja.
- 🔑 **Multi-Provider & Privasi Utama**:
  Wizard interaktif untuk konfigurasi mudah (dengan tes koneksi langsung). Mendukung model cloud (OpenAI, OpenRouter, DeepSeek, Groq, Together) maupun server lokal (Ollama, LM Studio, vLLM). Kredensial disimpan dengan izin berkas ketat `0600`.

---

## 🚀 Instalasi & Memulai Cepat

### Kebutuhan Sistem
- **Node.js**: versi `18.0.0` atau yang lebih baru.
- **Terminal**: mendukung emulasi VT100 / ANSI color.

### 1. Instalasi dari Sumber

```bash
# Clone repositori
git clone https://github.com/Iky969/Ruko-agent.git
cd Ruko-agent

# Install dependensi pengembangan (TypeScript & type definitions)
npm install

# Build TypeScript ke JavaScript ESM (dist/)
npm run build

# Jalankan Ruko
npm start
```

### 2. Instalasi Global (Perintah `ruko` di Mana Saja)

Agar perintah `ruko` dapat diakses langsung dari direktori proyek mana pun di komputer Anda:

```bash
npm install -g .
# atau gunakan npm link saat pengembangan lokal:
# npm link
```

Setelah itu, cukup masuk ke folder proyek Anda dan ketik:

```bash
cd /jalur/proyek-anda
ruko
```

Semua data (konfigurasi, riwayat percakapan, jurnal undo) akan otomatis terisolasi di folder `./.ruko/` di dalam direktori kerja aktif.

### 3. Wizard Konfigurasi Awal (First-Run Setup)

Saat pertama kali dijalankan tanpa kredensial, Ruko akan memandu Anda melalui **Interactive Setup Wizard**:
1. Masukkan **API Key** (input disamarkan `*` demi privasi).
2. Masukkan **Base URL** (contoh: `https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, atau `http://localhost:11434/v1`).
3. Masukkan **Model Name** (contoh: `gpt-4o`, `deepseek-chat`, `qwen2.5-coder`, dll.).
4. Ruko melakukan pengujian koneksi langsung (*live probe*). Jika berhasil, konfigurasi disimpan ke `.ruko/config.json` dengan izin berkas **600** (*owner read/write only*).

---

## 🛡️ Arsitektur Keamanan

Ruko dirancang dengan pertahanan mendalam (*defense-in-depth*) untuk memastikan agen otonom tidak membahayakan sistem operasi atau data proyek Anda:

```
                      [ Perintah Shell / Tool Exec ]
                                     │
                                     ▼
                   ┌───────────────────────────────────┐
                   │  Layer 1: Regex Risk Detector     │
                   └───────────────────────────────────┘
                                     │
         ┌───────────────────────────┼───────────────────────────┐
         ▼                           ▼                           ▼
      [ NONE ]                 [ BLOCKED ]                 [ DANGEROUS ]
  Eksekusi Langsung          Ditolak Mutlak                      │
                     (rm -rf /, forkbomb, mkfs, dll.)            │
                                                                 ▼
                                               ┌───────────────────────────────────┐
                                               │   Layer 2: Guardian LLM           │
                                               │   (Analisis Semantik Terisolasi)  │
                                               └───────────────────────────────────┘
                                                                 │
                                     ┌───────────────────────────┼───────────────────────────┐
                                     ▼                           ▼                           ▼
                                 [ SAFE ]                   [ BLOCKED ]                 [ DANGEROUS ]
                         Tampilkan Indikator Hijau        Tolak Otomatis              Minta Konfirmasi
                       ✓ Guardian: aman — <alasan>     (tanpa tanya user)                 Manual y/N
                                     │                                                       │
                                     └───────────────────────────┬───────────────────────────┘
                                                                 │
                                                                 ▼
                                                  ┌─────────────────────────────┐
                                                  │  Catat Audit Log            │
                                                  │  .ruko/guardian-audit.log   │
                                                  └─────────────────────────────┘
```

1. **Workspace Sandbox (Anti-Path-Traversal)**:
   Seluruh tool pembacaan dan modifikasi berkas (`read_file`, `write_file`, `edit_file`, `patch_file`, `delete_file`, `move_file`, `glob`, `code_search`) divalidasi ketat oleh fungsi `assertInsideWorkspace()`. Percobaan akses ke luar root direktori kerja (seperti `../../etc/passwd` atau `~/.ssh`) diblokir seketika.
2. **Deterministic Regex Gate (Layer 1)**:
   Mendeteksi ratusan pola perintah destruktif, rekursif, chain injection (`&&`, `;`, `||`), dan utilitas berbahaya (`find -delete`, `truncate`, `shred`, `wipefs`), termasuk seluruh bentuk `rm` (dengan atau tanpa flag). Perintah mutasi berkas dasar pada `exec` (`rm`, `mv`, `truncate`, redirect `>`) yang menargetkan berkas workspace ditolak dan dialihkan ke tool resmi ber-undo. Perintah berbahaya kategori `BLOCKED` ditolak mutlak bahkan jika mode persetujuan dinonaktifkan.
3. **Guardian LLM Semantic Assessment (Layer 2)**:
   Perintah berlabel `DANGEROUS` dianalisis semantiknya oleh Guardian LLM terisolasi (suhu 0, token terbatas). Jika perintah terbukti aman (misal kalkulasi inline `python3 -c "print(1+1)"`), sistem memberikan auto-allow dengan menampilkan indikator visual `✓ Guardian: aman — <alasan>`.
4. **Dedicated Audit Trail**:
   Setiap evaluasi Guardian LLM dicatat secara persisten ke berkas `.ruko/guardian-audit.log` dengan izin `0600` untuk keperluan audit keamanan.
5. **Perlindungan Kredensial & Berkas/Environment Sensitif**:
   - **Isolasi Berkas Sensitif**: Fungsi `assertNotSensitivePath()` memblokir akses ke berkas sensitif (`.ruko/config.json`, `.ruko/undo/**`, `.env`, `.env.*`, `id_rsa`, `id_ed25519`, `*.pem`, `*.key`) pada seluruh tool baca (`read_file`), pencarian (`glob`, `code_search`), manipulasi berkas, maupun `exec` (deteksi perintah eksplisit seperti `cat .ruko/config.json`).
   - **Pencegahan Dump Environment**: Fungsi `isSensitiveEnvCommand()` mendeteksi dan menolak upaya pembocoran kredensial via environment (`printenv`, `env`, ekspansi `$<NAMA>` atau `${<NAMA>}` yang cocok dengan pola token/secret/password/key), sembari tetap mengizinkan variabel biasa non-sensitif (`$PATH`, `$HOME`) untuk menghindari *overblocking*.
   - **Cakupan Universal Subagent**: Seluruh proteksi ditegakkan di level protokol eksekusi tool (`runToolCall`), menjamin subagent (`delegate`) tunduk pada kebijakan keamanan yang sama persis dengan agen utama tanpa celah isolasi.
   - Penolakan URL HTTP *cleartext* untuk server remote (mencegah eksfiltrasi token), penyamaran cerdas API key pada perintah `/config`, dan penegakan izin berkas `0o600` pada seluruh berkas konfigurasi dan sesi.
6. **Batasan Keamanan yang Diketahui (Known Security Limitations)**:
   - **Filesystem TOCTOU (Time-of-Check to Time-of-Use)**: Meskipun mutasi berkas menolak penulisan menembus symbolic link via `lstatSync().isSymbolicLink()` dan `assertInsideWorkspace()`, secara POSIX standar tetap terdapat *micro-window* teoretis jika ada proses konkuren eksternal di tingkat OS yang melakukan pertukaran berkas (*symlink swap*) persis di antara verifikasi boundary dan pemanggilan I/O kernel (`fs.writeFile`/`fs.readFile`).
   - **Eliminasi Celah DNS Rebinding**: Seluruh potensi eksploitasi DNS Rebinding TOCTOU telah ditutup tuntas dengan mengimplementasikan transport `node:http` & `node:https` berbasis **Native IP-Pinning** yang mengunci socket TCP ke IP yang telah divalidasi aman pada setiap hop redirect.

---

## 💡 Fitur Unggulan

### 1. Eksplorasi Kode Cepat & Efisien
- **`glob`**: Menemukan berkas berbasis pola pencocokan multi-pattern dan ekspansi kurung kurawal `{a,b}`. Secara otomatis mengabaikan direktori besar (`node_modules`, `.git`, `dist`, `.ruko`, `coverage`) dan berkas biner.
- **`code_search`**: Mencari teks atau ekspresi reguler (regex) di seluruh berkas proyek, menampilkan baris yang cocok beserta baris konteks di sekitarnya.
- **`web_fetch`**: Mengambil referensi dokumentasi web publik berbasis teks/HTML/JSON dengan timeout otomatis 10 detik, pembersihan tag HTML, dan pembatasan panjang konten (maks. 5.000 karakter).

### 2. Modifikasi Berkas dengan Diff Visual & Safety Net
- **`edit_file` / `write_file`**: Perubahan berkas ditampilkan dengan diff berwarna ala `git diff` (`+` hijau, `-` merah).
- **`patch_file`**: Operasi *search-and-replace* berbasis teks unik untuk menghemat konsumsi token LLM.
- **`delete_file` / `move_file`**: Penghapusan dan pemindahan berkas aman dengan konfirmasi persetujuan `[Y/N]` dan pencadangan otomatis ke `.ruko/undo/`.
- **Undo Journal**: Pembatalan perubahan instan lewat `/undo` tanpa perlu `git stash` atau `git checkout`.

### 3. Log Summarizer Pintar
Output terminal yang melebihi batas (default: 1.000 karakter) otomatis dipotong secara proporsional (kepala ~40% dan ekor ~60%) dengan highlight baris galat (*error/warning/exit code*), menjaga konteks percakapan tetap bersih.

### 4. Context Compression Adaptif
Ketika panjang percakapan mendekati batas memori, Ruko secara cerdas merangkum percakapan lama menjadi satu ringkasan padat tanpa menghilangkan instruksi penting dan giliran (*turns*) percakapan terakhir. Batas memori dapat disesuaikan secara dinamis via `/context set <jumlah>`.

### 5. Multi-Profil Provider
Simpan beberapa konfigurasi AI di `.ruko/config.json` dan beralih profil dengan cepat:
```bash
/profile hemat    # Menggunakan model ringan untuk tugas sederhana
/profile kuat     # Menggunakan model penalaran tinggi untuk arsitektur kompleks
/profile lokal    # Beralih ke Ollama lokal tanpa biaya API
```

---

## 🛠️ Daftar Tool Terintegrasi

Agen menggunakan protokol tool call terstruktur dalam blok kode:

| Tool | Kategori | Deskripsi & Kegunaan |
| :--- | :---: | :--- |
| `exec` | Eksekusi | Menjalankan perintah shell melalui filter *approval gate* dua lapis dan *log summarizer* (default 120s, mendukung `timeoutMs`). |
| `glob` | Inspeksi | Menemukan daftar berkas berdasarkan pola glob multi-pattern (mengabaikan folder build & biner). |
| `list_dir` | Inspeksi | Menampilkan isi langsung direktori (subfolder dan berkas beserta ukuran byte) tanpa glob traversal. |
| `code_search` | Inspeksi | Pencarian keyword atau regex di seluruh berkas teks dengan baris konteks (mendukung filter extension array / comma-separated). |
| `read_file` | Pembacaan | Membaca isi berkas teks berpaginasi (offset/limit) dan bernomor baris. |
| `write_file` | Penulisan | Membuat berkas baru di dalam batas workspace. |
| `edit_file` | Penulisan | Menimpa isi berkas yang sudah ada dengan menampilkan *diff* visual perubahan. |
| `patch_file` | Penulisan | Mengganti potongan teks unik secara presisi (*search-and-replace* hemat token). |
| `delete_file` | Manipulasi | Menghapus berkas tunggal secara aman (wajib konfirmasi `[Y/N]` dan snapshot undo otomatis). |
| `move_file` | Manipulasi | Memindahkan / mengganti nama berkas (wajib konfirmasi `[Y/N]` dan snapshot undo otomatis). |
| `revert_file` | Manipulasi | Mengembalikan berkas ke kondisi sebelumnya (snapshot `.ruko/undo/` atau fallback `git checkout`). |
| `web_fetch` | Jaringan | Mengambil konten web publik (HTML/JSON/Text) dengan timeout 10 detik dan sanitasi HTML. |
| `remember` | Memori | Menyimpan fakta proyek/preferensi ke `.ruko/memory.md` lintas sesi (dengan proteksi sanitasi prompt injection). |
| `search_sessions` | Pencarian | Pencarian percakapan lintas sesi tersimpan secara inkremental (default limit 5, cuplikan maks. 150 karakter). |
| `load_skill` | Skill | Memuat instruksi operasional skill proyek dari `.ruko/skills/`. |
| `save_skill` | Skill | Menyimpan alur kerja sukses sebagai skill baru yang reusable (hanya jika diminta / instruksi berulang). |
| `delete_skill` | Skill | Menghapus skill yang sudah usang dari `.ruko/skills/` (wajib konfirmasi `[Y/N]` dan menampilkan preview isi). |
| `list_skills` | Skill | Membaca dan menampilkan daftar seluruh nama dan deskripsi skill yang tersimpan. |
| `delegate` | Delegasi | Menjalankan subagent mandiri dengan context terisolasi. |
| `start_process` | Proses | Menjalankan perintah non-blocking / background (wajib konfirmasi `[Y/N]`, batas maks. 3 proses aktif). |
| `read_process_logs` | Proses | Membaca ring buffer log proses (maks. 100 baris) dengan redaksi kredensial otomatis. |
| `get_status` | Proses | Memeriksa status deterministik proses latar belakang (`running`, `exited`, `stale`). |
| `stop_process` | Proses | Menghentikan proses latar belakang secara bertahap (`SIGTERM` lalu `SIGKILL`) tanpa approval gate. |

---

## ⌨️ Daftar Perintah Slash

Ketik `/` di terminal untuk memunculkan menu interaktif, atau gunakan perintah berikut:

| Perintah | Fungsi |
| :--- | :--- |
| `/help` | Menampilkan panduan bantuan lengkap. |
| `/exit` | Keluar dari aplikasi (sesi otomatis tersimpan). |
| `/login` | Membuka wizard konfigurasi provider dan tes koneksi langsung. |
| `/new` | Menyimpan sesi saat ini lalu memulai sesi percakapan baru. |
| `/sessions` | Menampilkan daftar seluruh sesi yang tersimpan. |
| `/search <kata kunci>` | Mencari kata kunci percakapan lintas sesi tersimpan (beserta opsi `/resume`). |
| `/resume <id>` | Melanjutkan sesi percakapan sebelumnya. |
| `/export [json\|markdown]` | Ekspor log giliran percakapan dan jejak tool sesi aktif. |
| `/clear` | Membersihkan memori percakapan pada sesi saat ini. |
| `/compact` | Memaksa kompresi riwayat percakapan saat ini. |
| `/plan on \| off` | Mode rencana: mengunci tool penulisan dan eksekusi di level kode. |
| `/undo [path]` | Membatalkan perubahan berkas terakhir atau berkas spesifik dari jurnal `.ruko/undo/`. |
| `/role [nama]` | Mengganti peran sistem AI (`default`, `reviewer`, `teacher`, `minimal`). |
| `/mode beginner \| pro` | Mode pengguna: panduan mendalam (`beginner`) atau ringkas (`pro`). |
| `/anim [on\|off]` | Mengaktifkan/menonaktifkan animasi Pac-Man saat AI berpikir. |
| `/profile [alias]` | Beralih profil penyedia LLM (`hemat`, `kuat`, `lokal`). |
| `/exec <perintah>` | Menjalankan perintah shell langsung dari baris perintah Ruko. |
| `/history [n]` | Menampilkan *n* pesan riwayat percakapan terakhir. |
| `/context [set <n>]` | Menampilkan kapasitas memori aktif atau menyetel batas budget karakter baru. |
| `/memory [clear]` | Menampilkan isi memori persisten atau mereset (`.ruko/memory.md`). |
| `/usage` | Menampilkan statistik konsumsi karakter dan token sesi. |
| `/config [set <k> <v> \| setup]` | Menampilkan atau memperbarui konfigurasi sistem. |
| `/model [nama]` | Melihat daftar model yang tersedia atau beralih model aktif. |

---

## ⚙️ Konfigurasi & Profil

Berkas konfigurasi disimpan di `./.ruko/config.json` dengan hak akses `0o600`:

```json
{
  "mode": "beginner",
  "defaultProfile": "utama",
  "profiles": {
    "utama": {
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o",
      "apiKeyEnv": "OPENAI_API_KEY"
    },
    "lokal": {
      "baseUrl": "http://localhost:11434/v1",
      "model": "qwen2.5-coder"
    }
  },
  "guardianEnabled": true,
  "guardianTimeoutMs": 5000,
  "funAnimations": true
}
```

### Variabel Lingkungan (Environment Variables)

| Variabel | Deskripsi |
| :--- | :--- |
| `OPENAI_API_KEY` | API Key default jika tidak didefinisikan di config file. |
| `OPENAI_BASE_URL` | Base URL endpoint OpenAI-compatible. |
| `AGENT_MODEL` / `OPENAI_MODEL` | Nama model AI yang digunakan. |
| `RUKO_CONFIG` | Lokasi berkas konfigurasi kustom (default: `./.ruko/config.json`). |
| `RUKO_UNDO_DIR` | Lokasi penyimpanan snapshot undo (default: `./.ruko/undo`). |
| `RUKO_YOLO_MODE=1` | Melewati konfirmasi *dangerous* (peringatan level *blocked* tetap aktif). |
| `NO_COLOR=1` | Menonaktifkan seluruh warna ANSI di terminal. |

---

## 🧪 Pengujian & Verifikasi

Ruko diuji secara intensif menggunakan test runner bawaan Node.js (`node:test`) dan typechecker ketat TypeScript:

```bash
# Verifikasi tipe data statis
npm run typecheck

# Menjalankan 335 unit test anti-regresi
npm test

# Menjalankan end-to-end (E2E) integration test
npm run test:e2e
```

Test suite mencakup pengujian unit untuk:
- Deteksi risiko approval regex & skenario adversarial Guardian LLM.
- Sandboxing direktori dan pencegahan traversal path di seluruh tool.
- Parser streaming SSE LLM multi-provider (OpenAI, Anthropic, Gemini) dan penanganan kode status HTTP.
- Mekanisme TUI, status bar rewinding, dan input buffer wrapping.
- Kompresi konteks adaptif dan snapshot undo journal.
- Persistent memory, skill system, subagent delegation, dan trajectory export.

---

## 📂 Struktur Modul

```text
src/
├── index.ts              # CLI Entry point & routing argument
├── types.ts              # Definisi interface & skema konfigurasi
├── agent/
│   ├── agent.ts          # Orkestrator eksekusi & tool loop
│   ├── commands.ts       # Registry terpusat seluruh slash command
│   ├── filetools.ts      # Tool glob, code_search, dan read_file (sandboxed)
│   ├── llm.ts            # Client multi-provider (OpenAI, Anthropic, Gemini) & streaming parser
│   ├── roles.ts          # Manajemen system prompt berlapis & peran AI
│   ├── subagent.ts       # Orkestrasi subagent delegasi terisolasi
│   └── tools.ts          # Handler tool call protocol & pembatas output
└── core/
    ├── approval.ts       # Dual-Layer Approval Gate & Guardian LLM
    ├── compressor.ts     # Algoritma kompresi percakapan adaptif
    ├── config.ts         # Loader berkas konfigurasi & sanitasi skema
    ├── context.ts        # Pengelolaan memori jendela percakapan
    ├── diff.ts           # Visualizer git-style line diff
    ├── dotenv.ts         # Zero-dependency .env file parser & loader
    ├── executor.ts       # Eksekusi subproses shell aman
    ├── history.ts        # Persistensi input history terminal (.ruko/history)
    ├── loop.ts           # System loop interaktif & TUI controller
    ├── memory.ts         # Persistent memory sederhana (.ruko/memory.md)
    ├── session.ts        # Penyimpanan sesi percakapan (.ruko/sessions/)
    ├── skills.ts         # Sistem skill modular (.ruko/skills/)
    ├── splash.ts         # Tampilan pembuka & banner status
    ├── summarizer.ts     # Peringkas log terminal panjang (>1000 char)
    ├── tui.ts            # Terminal raw-mode engine & live overlay
    ├── ui.ts             # Formatting ANSI, box rendering, & animasi Pac-Man
    └── undo.ts           # Snapshot jurnal berkas sebelum modifikasi
```

---

## 📄 Lisensi

Proyek ini didistribusikan di bawah lisensi **MIT License**. Lihat berkas [LICENSE](LICENSE) untuk informasi lebih lanjut.
