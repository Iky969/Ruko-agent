# Security Policy & Hardening Guidelines

## Supported Versions

Proyek **Ruko** secara aktif memelihara dan memberikan patch keamanan pada versi berikut:

| Versi | Didukung |
|---|---|
| 1.7.x | :white_check_mark: |
| < 1.7.0 | :x: |

---

## Melaporkan Kerentanan Keamanan (Reporting a Vulnerability)

Kami sangat menghargai komunitas yang membantu menjaga keamanan Ruko. Jika Anda menemukan celah keamanan (*security vulnerability*):

1. **JANGAN membuka GitHub Issue publik.**
2. Laporkan secara privat melalui fitur **GitHub Advisory / Report a vulnerability** di repository ini:
   - Masuk ke tab **Security** > **Advisories** > **New draft advisory**.
3. Tim pengembang akan merespons dalam waktu 1x24 jam untuk memverifikasi temuan dan mempersiapkan perbaikan (*patch*).
4. Setelah patch dirilis, kredit penemu (*reporter acknowledgement*) akan dicantumkan secara resmi.

---

## Standar & Kebijakan Keamanan Kredensial

### 1. Manajemen API Key & Kredensial
- **Larangan Literal CLI Key:** Penggunaan kunci API mentah langsung melalui argumen baris perintah (`--api-key sk-...`) diblokir secara bawaan untuk mencegah eksposur ke `ps aux`, `/proc/<PID>/cmdline`, dan riwayat shell (`~/.bash_history`).
- **Metode Resmi:**
  - Environment variable (`RUKO_API_KEY="..." ruko`).
  - Pembacaan file dengan izin terproteksi (`ruko --api-key @/path/to/key.txt`).
  - Stdin stream terisolasi (`echo "$KEY" | ruko --api-key -`).
  - Wizard interaktif (`ruko`) yang menyimpan konfigurasi dengan izin `0600` (`chmod 600`).
- **Redaction Otomatis:** Seluruh kunci API diredaksi dalam log, tray visual, output error, dan status display.

### 2. Workspace & Shell Execution Boundaries
- **Path Traversal Protection:** Larangan penulisan atau mutasi berkas di luar batas workspace aktif.
- **Destructive Command Blocking:** Perintah berkategori destruktif/katastropik (`rm -rf /`, `mkfs`, `dd`, `fork bomb`) diblokir secara permanen di tingkat kernel regex/parser approval gate.
- **Unattended / CI Execution:** Perintah `DANGEROUS` berisiko tinggi mewajibkan flag eksplisit `--yes --allow-unsafe` jika dijalankan dalam mode non-interaktif (`!process.stdin.isTTY`).

---

## Rekomendasi Konfigurasi Keamanan Repository GitHub

Untuk mempertahankan standar keamanan supply-chain dan perlindungan kebocoran kredensial, repository GitHub Ruko direkomendasikan untuk mengaktifkan pengaturan berikut pada **Settings > Code security and analysis**:

1. **Secret Scanning:** Aktifkan (*Enabled*).
2. **Push Protection:** Aktifkan (*Enabled*) untuk mencegah commit yang tidak sengaja memuat token atau API key tertolak sebelum masuk ke Git history.
3. **Dependabot Alerts & Dependabot Security Updates:** Aktifkan (*Enabled*).
4. **CodeQL Analysis:** Menggunakan workflow otomatis di `.github/workflows/codeql.yml`.
5. **Branch Protection (`main`):**
   - *Require a pull request before merging*.
   - *Require status checks to pass before merging* (workflow `CI / Test on Node 18.x` & `20.x`).
   - *Do not allow bypassing the above settings*.
