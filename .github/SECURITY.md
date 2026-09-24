# Security Policy & Hardening Guidelines

## Supported Versions

| Versi | Didukung | Catatan |
|---|---:|---|
| 1.7.x | ✅ | Aktif, patch keamanan reguler |
| < 1.7.0 | ❌ | Tidak didukung, upgrade ke 1.7.7 |

---

## Melaporkan Kerentanan

Kami menghargai laporan keamanan komunitas.

1. **JANGAN** buka GitHub Issue publik untuk vulnerability
2. Laporkan privat via **GitHub Security > Advisories > New draft advisory** di repo ini
3. Atau email maintainer via GitHub profile
4. Respons: 1x24 jam untuk verifikasi
5. Kredit reporter dicantumkan setelah patch rilis (jika diizinkan)

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
| **Branch Protection (main)** | ✅ Enabled | Require PR, require status checks (Node 18.x, 20.x, CodeQL), no bypass |
| **CI Multi-Version** | ✅ Enabled | `.github/workflows/ci.yml` — Node 18.x & 20.x, typecheck, unit, e2e |

### Workflow Details

- **CI**: `actions/checkout@v4`, `actions/setup-node@v4`, `npm ci`, `npm run typecheck`, `npm test` (817 tests), `npm run test:e2e`
- **CodeQL**: `github/codeql-action/init@v3` & `analyze@v3`, config `.github/codeql/codeql-config.yml` (exclude `dist/**`, `src/tests/**`, `js/file-access-to-http`, `js/file-system-race`)
- **Dependabot**: `.github/dependabot.yml` — npm weekly, github-actions weekly, limit 10 PRs

### Verifikasi Lokal

```bash
npm run typecheck   # 0 error
npm test            # 817 passed
npm run test:e2e    # 1 passed
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
   - Require status checks: `Test on Node 18.x`, `Test on Node 20.x`, `Analyze (JavaScript/TypeScript)`
   - Do not allow bypass

---

## Security Boundaries & Known Limitations

Lihat README bagian **Security Boundaries** (8 poin) untuk batasan inheren: approval gate bergantung user, redaksi best-effort, TOCTOU micro-window, single-user trusted env, prompt injection via read-only, memory/skills writable by design, rekomendasi container isolasi, dan API key plaintext awareness.

---

## Audit Trail

- Guardian LLM evaluations: `.ruko/guardian-audit.log` (0600)
- Undo snapshots: `.ruko/undo/` (0700 dir, 0600 files)
- Config: `.ruko/config.json` (0600)
- Session: `.ruko/sessions/` (0600)

Semua file sensitif dilindungi `isSensitivePath()` & `assertNotSensitivePath()` di level tool dispatcher.
