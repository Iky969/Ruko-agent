# Security Policy & Hardening Guidelines

## Supported Versions

| Versi | Didukung | Catatan |
|---|---:|---|
| 2.0.x | ✅ | Versi stabil aktif saat ini |
| 1.9.x | ⚠️ | Patch keamanan esensial |
| < 1.9.0 | ❌ | Tidak didukung, wajib upgrade ke 2.0.0 |

---

## Melaporkan Kerentanan

Kami menghargai laporan keamanan komunitas.

1. **Issue publik diperbolehkan** untuk diskusi, pertanyaan, bug, dan laporan non-sensitif.
2. Untuk **kerentanan keamanan** (terutama yang berisiko dieksploitasi sebelum ada patch):
   - Boleh dilapor lewat **Issue publik** jika kamu nyaman, **atau**
   - **Untuk perbaikan lebih cepat dan aman**: hubungi privat via **GitHub Security → Advisories → New draft advisory** di repo ini, atau lewat kontak maintainer di profil GitHub.
3. Respons target: **1×24 jam** untuk verifikasi awal.
4. Kredit reporter dicantumkan setelah patch rilis (jika diizinkan).

> Hindari menempel credential, secret, atau rantai exploit lengkap di Issue publik sebelum mitigasi tersedia.

---

## Kebijakan Keamanan Kredensial

### 1. Manajemen API Key

- **Larangan literal CLI**: `ruko --api-key sk-...` diblokir default (mencegah `ps aux`, `/proc/<PID>/cmdline`, `~/.bash_history`)
- **Metode resmi & aman**:
  - Env var: `RUKO_API_KEY="..." ruko`
  - File terproteksi: `ruko --api-key @/path/to/key.txt` (mode 0600)
  - Stdin isolated: `echo "$KEY" | ruko --api-key -`
  - Wizard interaktif `ruko` → simpan ke `.ruko/config.json` mode 0600
- **Redaction**: Semua key diredaksi di log, tray visual, error output, status display
  - Key <40 char → `[REDACTED]`
  - Key ≥40 char → `[REDACTED...xxxx]` (hanya 4 char terakhir)
- **Warning plaintext**: `loadConfig()` warning ke stderr jika `apiKey` plaintext di config tanpa env var aktif — ini awareness, bukan enkripsi at-rest

### 2. Workspace & Shell Boundaries

- **Path Traversal Protection**: `assertInsideWorkspace()` blokir akses luar workspace (`../../etc/passwd`, `~/.ssh`, symlink escape)
- **Sensitive Path Protection**: Blokir `.ruko/config.json`, `.ruko/undo/**`, `.env*`, `.git-credentials`, `id_rsa*`, `*.pem`, `*.key`, `.bashrc/.zshrc`, dll.
- **Destructive Command Blocking**: `rm -rf /`, `mkfs`, `dd > /dev/sd*`, fork bomb, `find -delete`, `truncate`, `shred` — BLOCKED mutlak bahkan dengan `--yes`/`YOLO`
- **Env Dump Prevention**: Blokir `printenv`, `env`, `export -p`, `node -e process.env`, `python3 -c os.environ`, `$API_KEY` expansion, `/proc/*/environ`, `awk ENVIRON`
- **Shell Sanitization**: Bersihkan `BASH_FUNC_*`, `BASH_ENV`, `ENV`, `PROMPT_COMMAND`, `CDPATH`, `BASH_RCFILE` sebelum exec
- **Unattended CI**: `DANGEROUS` high-risk butuh `--yes --allow-unsafe` eksplisit di non-TTY, `BLOCKED` tetap tolak

### 3. SSRF & Network Hardening

- **Native IP-Pinning**: Custom `http.Agent`/`https.Agent` yang pin socket TCP ke IP yang sudah divalidasi aman
- **Alternative IP Notation**: Blokir desimal integer (`2130706433`), oktal (`0177.0.0.1`), hex (`0x7f000001`), IPv4-mapped IPv6 (`::ffff:127.0.0.1`), IPv6 ULA `fc00::/7`, link-local `fe80::/10`
- **Redirect Hop Validation**: Setiap hop `Location` header divalidasi ulang via `checkSsrfSafety()`, max 5 hops, loop detection
- **Private Range Blocking**: Loopback `127.0.0.0/8`, private RFC1918 `10/8, 172.16/12, 192.168/16`, link-local `169.254/16`, metadata `169.254.169.254`

---

## Status Keamanan Repository (Bots Aktif)

> Diperbarui: 24 September 2026 — Audit v1.7.7

| Fitur Keamanan | Status | Konfigurasi |
| :--- | :--- | :--- |
| **Secret Scanning** | ✅ Enabled | Deteksi token/API key di commit |
| **Push Protection** | ✅ Enabled | Blokir push jika secret terdeteksi |
| **Dependabot Alerts** | ✅ Enabled | Weekly scan npm & GitHub Actions |
| **Dependabot Security Updates** | ✅ Enabled | Auto-PR untuk CVE |
| **CodeQL Analysis** | ✅ Enabled | Workflow `.github/workflows/codeql.yml`, queries `security-extended,security-and-quality` |
| **Branch Protection (main)** | ✅ Enabled | Require PR, require status checks (CI matrix + CodeQL), no bypass |
| **CI Multi-OS** | ✅ Enabled | `.github/workflows/ci.yml` — Linux + Windows + macOS × Node 18.x/20.x (+22.x di Linux), typecheck, unit, e2e |

### Workflow Details

- **CI** (`.github/workflows/ci.yml`): matriks `os: [ubuntu-latest, windows-latest, macos-latest]` × `node: [18.x, 20.x]` (+ `22.x` di Linux), `fail-fast: false`, `actions/checkout@v4`, `actions/setup-node@v4` (cache npm), `npm ci`, `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run test:urls`
  - Runner test cross-platform `scripts/run-tests.mjs` (zero-dep, enumerasi berkas lalu `node --test <argv…>`) — tidak bergantung ekspansi glob shell (cmd.exe/PowerShell tidak meng-expand glob) maupun directory-mode `node --test` yang berubah antar generasi Node.
  - Step `Diagnostics` (`if: failure()` → `scripts/ci-diagnostics.mjs`) mencetak platform, `os.tmpdir()`, bentuk file URL CLI, dan daftar kunci env (bukan nilainya) untuk melokalisasi kegagalan khas Windows.
  - Guard `src/tests/zero_dependency_guard.test.ts` menegakkan kontrak zero runtime dependency di setiap OS (package.json, lockfile, seluruh import `src/**` dan `dist/**`).
- **CodeQL**: `github/codeql-action/init@v3` & `analyze@v3`, config `.github/codeql/codeql-config.yml` (exclude `dist/**`, `src/tests/**`, `js/file-access-to-http`, `js/file-system-race`)
- **Dependabot**: `.github/dependabot.yml` — npm weekly, github-actions weekly, limit 10 PRs

### Verifikasi Lokal

```bash
npm run typecheck   # 0 error
npm test            # 1064 tests — 1063 passed, 1 skipped (khusus Windows)
npm run test:e2e    # 1 passed
npm run test:urls   # regresi file URL lintas platform
```

---

## Rekomendasi Konfigurasi Tambahan

Untuk fork atau self-hosted runner, aktifkan di **Settings > Code security and analysis**:

1. Secret Scanning → Enabled
2. Push Protection → Enabled
3. Dependabot Alerts → Enabled
4. Dependabot Security Updates → Enabled
5. CodeQL → Default setup atau workflow custom
6. Branch Protection `main`:
   - Require PR before merging
   - Require status checks (nama job matriks CI): `Test (ubuntu-latest, Node 18.x)`, `Test (ubuntu-latest, Node 20.x)`, `Test (ubuntu-latest, Node 22.x)`, `Test (windows-latest, Node 18.x)`, `Test (windows-latest, Node 20.x)`, `Test (macos-latest, Node 18.x)`, `Test (macos-latest, Node 20.x)`, `Analyze (JavaScript/TypeScript)`
   - Do not allow bypass

---

## Model Ancaman & Keterbatasan Keamanan (Threat Model & Realistic Limitations)

Ruko dirancang secara spesifik sebagai **Deterministic Local Policy Enforcer** untuk membantu melindungi workstation lokal milik pengembang (*single-user developer workstation*) dari repositori pihak ketiga yang beritikad jahat (*untrusted workspace*) dan serangan *Indirect Prompt Injection* (IPI).

Keamanan sistem ini memiliki batasan arsitektur nyata yang harus dipahami oleh pengguna apa adanya:

1. **Bukan Isolasi Tingkat Kernel atau Hipervisor (Bukan Multi-Tenant SaaS):**
   - Ruko berjalan murni sebagai proses aplikasi Node.js di ruang pengguna (*user-space*) dengan hak akses sistem (UID/GID) pengguna yang menjalankannya di OS.
   - Ruko **tidak menyediakan** isolasi tingkat perangkat keras (seperti MicroVM AWS Firecracker), virtualisasi kernel (gVisor/Kata), ataupun cgroups/chroot namespace bawaan.
   - Segala operasi yang dieksekusi atau disetujui oleh pengguna akan berjalan dengan hak akses penuh akun pengguna tersebut di sistem operasi host.

2. **Eksekusi Shell Arbitrer Tidak Dapat Dijamin Kebal 100%:**
   - Perintah shell (`exec`) dijalankan oleh shell sistem host (`/bin/sh` di POSIX atau `cmd.exe`/`PowerShell` di Windows).
   - Ruko menyaring variabel environment berbahaya (`NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_*`, hook startup shell) dan memblokir pola perintah destruktif yang dikenal.
   - Namun, shell adalah lingkungan *Turing-complete*. Pola perintah yang disamarkan (*obfuscated*), di-encode secara dinamis (misalnya via base64 runtime), atau dievaluasi tidak langsung tidak dapat diproteksi secara absolut hanya dengan inspeksi pola string. Jika pengguna menyetujui eksekusi perintah shell berbahaya, proses tersebut akan berjalan di komputer host.

3. **Penyimpanan Kredensial & State Tanpa Enkripsi Saat Diam (At-Rest):**
   - Berkas konfigurasi (`.ruko/config.json`) dan direktori sesi otoritatif (`~/.ruko/sessions/`) diamankan dengan izin sistem berkas POSIX `0600` (hanya dapat dibaca/ditulis oleh pemilik akun).
   - Izin berkas `0600` ini **bukan enkripsi**. Kunci API dan riwayat percakapan tersimpan dalam format teks biasa (*plaintext*).
   - Berkas ini tetap rentan terekspos jika pengguna membuat cadangan (*backup*) disk yang tidak terenkripsi, memindahkan snapshot kontainer, atau jika komputer telah terinfeksi proses berbahaya lain yang berjalan di bawah pengguna yang sama.

4. **Keterbatasan Semantik Filesystem Lintas Platform:**
   - **Windows (Win32):** Flag kernel anti-symlink `O_NOFOLLOW` tidak didukung oleh kernel Windows. Ruko menerapkan verifikasi segmen direktori bertahap (`fs.lstat`) dan resolusi `fs.realpathSync` pasca-buka di lapisan aplikasi, tetapi tidak memiliki jaminan atomik setara kernel POSIX.
   - **Filesystem Tertentu (OverlayFS / FAT32 / Network Mounts):** Operasi `fsync` pada direktori induk tidak didukung oleh driver filesystem tertentu. Ruko menangani kegagalan ini secara *graceful fallback* (`EINVAL`), sehingga ketahanan pemulihan setelah pemadaman listrik mendadak bergantung pada karakteristik filesystem host.

5. **Luaran LLM Selalu Berstatus Data Tidak Tepercaya (Tainted Data):**
   - Prompt engineering **bukan** batas keamanan (*security boundary*). Model AI dapat mengalami halusinasi, salah membaca konteks, atau terpengaruh oleh injeksi teks tersembunyi (*Indirect Prompt Injection*) di dalam file kode sumber yang sedang dibaca.
   - Oleh karena itu, Ruko mengandalkan aturan deterministik di hulu (seperti penolakan mutasi disk secara mekanis saat Plan Mode aktif dan penguncian boundary subtree). Namun kecerdasan buatan itu sendiri tidak dapat menjamin ketiadaan kesalahan logika.

6. **Keputusan Akhir Berada pada Pengguna (Human-in-the-Loop):**
   - Dialog amandemen cakupan (`[Y/n]`) dan persetujuan eksekusi bergantung pada ketelitian pengguna. Jika pengguna secara keliru menyetujui permintaan amandemen path ke direktori di luar proyek atau mengaktifkan flag bypass (`--yes` / YOLO), sistem akan mematuhi persetujuan pengguna tersebut.

7. **Rekomendasi Lingkungan Terisolasi untuk Kode Tidak Dikenal:**
   - Untuk menguji, mengaudit, atau menjalankan kode dari repositori pihak ketiga yang sama sekali tidak Anda percayai, Anda **tidak boleh** hanya mengandalkan proteksi level proses Ruko. Anda disarankan menjalankan Ruko di dalam lingkungan terisolasi penuh (seperti Docker Container tanpa bind-mount folder pribadi, DevContainer terisolasi, atau Virtual Machine).

---

## Audit Trail & State Isolation

- State sesi otoritatif: `~/.ruko/sessions/<sessionId>/state.json` (0600) — terisolasi dari workspace.
- Proyeksi rencana workspace: `.ruko/plan.json` — murni proyeksi baca (read-only).
- Guardian LLM evaluations: `.ruko/guardian-audit.log` (0600).
- Undo snapshots: `.ruko/undo/` (0700 dir, 0600 files).
- Config: `.ruko/config.json` (0600).

Semua file sensitif dan state kanonis dilindungi oleh `isSensitivePath()`, `assertNotSensitivePath()`, `assertPhysicalContainment()`, dan `DispatcherGate` di level tool dispatcher.
