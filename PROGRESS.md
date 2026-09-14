# PROGRESS.md

> Dokumen status pengerjaan **Ruko — AI Coding Agent CLI**. Diperbarui di akhir setiap sesi kerja. Ini adalah sumber kebenaran (source of truth) dan checkpoint handoff untuk AI berikutnya.

---

### v1.7.1 (15 September 2026) — Context Window Slash Commands (/setctx, /settoken, /usage session tokens), Subagent Resource Deadlines, Terminal Injection Sanitization, & Known Bugs Resolution

#### Ditambahkan & Diperbarui
- **Dedicated Context Window & Session Token Commands (`src/agent/commands.ts`, `src/agent/agent.ts`, `README.md`)**:
  * Menambahkan pelacakan akumulasi token sesi (`SessionUsage`) pada kelas `Agent`, mencakup total prompt tokens, completion tokens, total tokens, dan total turn pada sesi aktif.
  * Memperkaya perintah `/usage` (alias: `/stats`, `/tokens`) untuk menampilkan akumulasi token sesi, estimasi karakter, statistik turn terakhir, serta sub-perintah `/usage clear` untuk mereset counter sesi.
  * Menambahkan perintah `/setctx [jumlah]` untuk melihat penggunaan memori konteks aktif atau memperbarui budget karakter (`50k`, `80000`, dsb.) dengan validasi angka positif dan batas minimum jumlah karakter aktif.
  * Menambahkan perintah `/settoken [token]` untuk mempermudah developer mengatur context window berbasis estimasi token (`8k`, `16k`, `32000`, dsb.) dengan rasio konversi standar industri LLM (1 token ≈ 4 karakter).
- **Subagent Cumulative Timeout & Resource Deadline (`src/agent/subagent.ts`, `src/agent/tools.ts`)**:
  * Menambahkan opsi `timeoutMs` (default: 60_000ms) pada `SubagentOptions` dan integrasi listener `AbortController` dengan `deps.signal`.
  * Memastikan subagent yang mengalami hanging atau menjalankan instruksi berat dihentikan secara bersih dengan status timeout terisolasi tanpa memblokir atau merusak proses giliran utama agen induk.
  * Memperluas `containsSensitiveFilePattern` untuk memblokir seluruh variasi SSH key (`id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`) dan sertifikat/kunci privat (`.pem`, `.key`).
  * Tool `delegate` secara otomatis meneruskan parameter `timeout_ms` atau `timeout` jika disediakan oleh LLM/pemanggil.
- **Sanitasi Terminal Injection & ANSI Escape Sequence (`src/core/ui.ts`, `src/core/executor.ts`)**:
  * Menambahkan fungsi `sanitizeTerminalOutput()` dengan pembersihan mendalam terhadap escape sequence berbahaya: Operating System Command (OSC), Device Control String (DCS), Application Program Command (APC), Privacy Message (PM), serta karakter bell (`\x07`) dan form feed (`\x0c`).
  * Mencegah terminal visual spoofing, hyperlink injection (OSC 8), dan modifikasi title/clipboard terminal tak diinginkan dari output proses eksternal.
  * Memperbarui `stripAnsi` agar membersihkan seluruh escape sequence berbahaya sekaligus kode warna ANSI standar.
- **Pencegahan Shell Function / Env Variable Hijacking & Dumps (`src/core/executor.ts`, `src/agent/tools.ts`)**:
  * Menyaring dan membuang key environment variable yang diawali `BASH_FUNC_*` saat proses dieksekusi melalui shell, mencegah eksekusi fungsi shell berbahaya warisan lingkungan induk.
  * Memperkuat `isSensitiveEnvCommand` untuk mendeteksi dan memblokir dump environment variabel via `declare -p`, `typeset -p`, dan bare `set`.
- **Penyelesaian Bug Teridentifikasi (Known Bugs Resolution) (`src/core/compressor.ts`, `src/core/executor.ts`)**:
  * **Known Bug #1 (Compression menyerah bila budget tak terjangkau)**: Mengimplementasikan *best-effort fallback compression* (`foldAllHead`) pada `compressHistory`. Jika budget target tidak dapat tercapai secara mutlak karena protected tail turn terlalu panjang, seluruh giliran riwayat lama tetap dikompresi ke ringkasan terpendek selama ukuran berkurang, mencegah ledakan konteks window.
  * **Known Bug #3 (Urutan stdout vs stderr sekuensial)**: Mengintegrasikan listener data real-time pada stream child process (`child.stdout.on('data')`, `child.stderr.on('data')`) ke dalam `interleavedChunks`, menjamin output gabungan mencatat urutan waktu kronologis yang akurat.
  * **Known Bug #8 (TOCTOU SSRF Web Fetch)**: Berhasil diatasi secara tuntas melalui implementasi Native IP-Pinning pada custom socket `http.Agent`/`https.Agent` di `src/agent/webtools.ts`.
- **Penyelesaian Temuan Audit Eksternal (Findings 1, 2, 3) (`src/agent/tools.ts`, `src/agent/subagent.ts`, `src/core/session.ts`)**:
  * **Finding 1 (Proteksi File Startup & Profile Shell)**: Menambahkan deteksi dan pencegahan akses/modifikasi terhadap berkas konfigurasi shell pengguna (`.bashrc`, `.bash_profile`, `.bash_login`, `.bash_logout`, `.zshrc`, `.zprofile`, `.zshenv`, `.zlogin`, `.zlogout`, `.profile`) pada `isSensitivePath` dan `containsSensitiveFilePattern`.
  * **Finding 2 (Batas Maksimum Ukuran Berkas 5MB)**: Menetapkan konstanta `MAX_FILE_WRITE_BYTES = 5 * 1024 * 1024` (5MB) dan memvalidasi `byteLength` payload di `writeWithDiff` dan `runToolCall` (`write_file`, `edit_file`, `patch_file`), mencegah memory exhaustion dan infinite text loop output.
  * **Finding 3 (Preservasi Timestamp Asli pada Ekspor Trajectory)**: Memperbarui `exportSessionTrajectory` di `src/core/session.ts` untuk memelihara timestamp pesan asli (`m.timestamp`) dan timestamp awal sesi pada nama berkas ekspor dan dokumen trajectory hasil export bukannya menimpa dengan waktu sistem saat ekspor.
- **Rangkaian Pengujian & Baseline Baru**:
  * Menambahkan test suite baru `src/tests/context_commands_v17.test.ts` (13 unit test) yang memvalidasi `/setctx`, `/settoken`, `/usage` session token stats, `sanitizeTerminalOutput`, best-effort compression fallback, subagent timeout, `declare -p`/bare `set` blocking, SSH/cert pattern detection, sequential interleaved stream output, shell startup file blocking, payload 5MB limit, dan trajectory timestamp preservation.
  * Total pengujian meningkat menjadi **446 passed** (100% lulus, 0 fail), E2E test lulus (1 passed), dan `npm run typecheck` bersih tanpa galat.

---

### Security Audit & Comprehensive Hardening (15 September 2026) — Centralized Sensitive Protection, Immutable Security Core, SSRF Transport Hardening & IP-Pinning, Symlink Broken-Write Prevention, Command Exec Bypass Neutralization

#### Ditambahkan & Diperbarui
- **Proteksi Terpusat Berkas Sensitif (`src/agent/tools.ts`, `src/agent/filetools.ts`, `src/agent/subagent.ts`)**:
  * `isSensitivePath` diperkuat dengan dukungan URL-decoding (`%2e%65%6e%76` -> `.env`), bash backslash unescaping (`.ru\\ko/con\\fig.json`), tilde expansion (`~/.ssh/id_rsa`), case-insensitivity (`.RUKO/CONFIG.JSON`), serta penambahan proteksi `.git-credentials`.
  * Seluruh tool pembacaan berkas (`readFileTool`, `globTool`, `codeSearchTool`, `listDirTool`) menerapkan inspeksi kanonikal `realpath` terhadap symlink dan memblokir kebocoran file sensitif.
  * Interseptor delegasi subagent (`runSubagent` & `containsSensitiveFilePattern`) menolak tugas subagent yang berupaya mengakses atau membocorkan kredensial konfigurasi, file `.env`, file kredensial git, atau kunci privat SSH.
- **Immutable Security Core (`src/agent/tools.ts`, `src/agent/filetools.ts`)**:
  * Menetapkan 6 berkas inti keamanan Ruko (`src/core/approval.ts`, `src/core/executor.ts`, `src/agent/tools.ts`, `src/agent/filetools.ts`, `src/agent/subagent.ts`, `src/agent/webtools.ts`) sebagai berkas yang tidak dapat dimodifikasi atau dihapus oleh agent.
  * `assertNotSecurityCore` diterapkan di seluruh mutating tools: `write_file`, `edit_file` (`writeWithDiff`), `patch_file`, `delete_file`, `move_file` (sumber maupun target), dan `revert_file`.
- **Transport Layer SSRF Hardening & Native IP-Pinning (`src/agent/webtools.ts`)**:
  * Implementasi `parseAlternativeIPv4` untuk normalisasi notasi IP alternatif: integer desimal 32-bit (misal `2130706433` -> `127.0.0.1`, `2852039166` -> `169.254.169.254`), oktal (`0177.0.0.1`), heksadesimal (`0x7f000001`, `0xa9fea9fe`), shorthand dotted (`127.1`), serta IPv4-mapped IPv6 (`::ffff:127.0.0.1`, `::ffff:7f00:1`).
  * Penegakan Native IP-Pinning soket TCP pada setiap hop rantai redirect HTTP (`301`, `302`, `303`, `307`, `308`), mencegah serangan open redirect menuju cloud instance metadata atau intranet privat.
  * Pengecekan resolusi ganda (*double-check*) DNS untuk mendeteksi anomali TTL=0 DNS rebinding secara aktif.
- **Konsistensi Symlink & Penutupan Celah Broken-Symlink Write-Through (`src/agent/tools.ts`)**:
  * Mengatasi kerentanan TOCTOU di mana symlink rusak (*broken symlink*) yang mengarah ke luar workspace dapat ditulis sebelum targetnya eksis. `assertInsideWorkspace` kini memanggil `lstatSync` tanpa dependensi pada `existsSync`, dan memvalidasi `readlinkSync` target jika symlink belum terbentuk.
  * Menolak operasi penulisan atau modifikasi melalui symbolic link pada `writeWithDiff`.
- **Netralisasi Encoding Bypass pada Filter Command Exec (`src/core/approval.ts`, `src/agent/tools.ts`)**:
  * Ekstraksi subshell `$()` dan backtick ``` ` ``` di `chainedSegments` dan `extractSubshells`.
  * Pembersihan (*unescaping*) karakter backslash bash (`r\m -rf /` -> `rm -rf /`, `cat .e\nv` -> `cat .env`).
  * Pelacakan variabel shell bash sederhana di `isSensitiveEnvCommand` dan `detectSensitiveFileAccessInExec` (`V=.env; cat $V`, `V=RUKO_API_KEY; printenv $V`).
- **Dokumentasi Resmi `README.md`**:
  * Menambahkan section resmi `## 🛡️ Security Boundaries & Known Limitations` (7 butir faktual) dan memperbarui Daftar Isi (Table of Contents).
- **Pengujian Komprehensif & Nol Regresi (`src/tests/sensitive_protection.test.ts`)**:
  * Menambahkan suite uji Bagian D (Security Core), Bagian E (SSRF alternative IP & redirect hop), Bagian F (Encoding bypass & exec variable tracking), dan Bagian G (Symlink consistency & broken symlink write escape).
  * Seluruh suite pengujian berjalan 100% sukses: **433 tests passed** (0 fail, 0 errors), dan `npm run typecheck` bersih tanpa galat.

### v1.7.0 (14 September 2026) — Universal Tool Security Hardening, Symlink Sandboxing, SSRF Redirect Defense, Subagent Recursion Guard, & UI Step Enrichment

#### Ditambahkan & Diperbarui
- **Hardening Keamanan Tool `start_process` (`src/agent/tools.ts`)**:
  * Menyelaraskan seluruh filter keamanan `start_process` dengan standar `exec`:
    1. Memblokir perintah berisiko tinggi (*blocked commands* seperti fork bomb `:(){ :|:& };:`, `rm -rf /`, `mkfs`, writing directly to `/dev/sd*`) menggunakan `detectRisk()`.
    2. Menolak eksfiltrasi kredensial environment variable (`isSensitiveEnvCommand()`) seperti `printenv` dan `echo $RUKO_API_KEY`.
    3. Menolak inspeksi file sensitif (`detectSensitiveFileAccessInExec()`) seperti `cat .ruko/config.json`, `cat .env`, dan kunci privat.
    4. Menolak mutasi berkas dasar tanpa tool resmi (`detectWorkspaceMutationInExec()`).
- **Mitigasi SSRF via HTTP Redirect di `web_fetch` (`src/agent/webtools.ts`)**:
  * Mengubah opsi fetch native menjadi `redirect: 'manual'`.
  * Mengimplementasikan safe redirect-following loop (maksimal 5 hop, deteksi loop) di mana setiap header `Location` divalidasi ulang lewat `checkSsrfSafety()` sebelum diikuti.
  * Mencegah eksfiltrasi data cloud instance metadata (169.254.169.254) dan port intranet lokal melalui open redirect eksternal.
- **Symlink Traversal Sandboxing Seluruh File Tools (`src/agent/tools.ts`, `src/agent/filetools.ts`)**:
  * `assertInsideWorkspace` & `assertNotSensitivePath`: Menambahkan resolusi kanonikal (`realpathSync`) untuk memastikan symlink tidak melompat keluar dari batas workspace maupun menargetkan file sensitif.
  * Menambahkan proteksi file `.git/config` pada `isSensitivePath` untuk mencegah pencurian token repositori git / embedded credentials.
  * `walkDirectory` (`globTool` & `codeSearchTool`): Memfilter dan mengabaikan symlink yang targetnya berada di luar direktori kerja proyek (`isPathInsideWorkspace(real, cwd)`).
- **Sanitasi Path Traversal di Skills System & Session Persistence (`src/core/skills.ts`, `src/core/session.ts`)**:
  * `readSkill` & `deleteSkill`: Sanitasi nama skill menggunakan `sanitizeSkillName` serta verifikasi boundary kanonikal direktori `.ruko/skills/`.
  * `saveSession`, `loadSession`, & `exportSessionTrajectory`: Penegakan validasi ketat ID sesi berbasis regex `^[a-zA-Z0-9_-]+$` dan verifikasi boundary folder kanonikal. Upaya injeksi path traversal (`../../../etc/passwd`) ditolak mutlak dengan error eksplisit alih-alih disanitasi menjadi file baru.
- **Native IP-Pinning Transport Layer & Eliminasi Total DNS Rebinding (`src/agent/webtools.ts`)**:
  * Menggantikan transport native `fetch` pada `webFetchTool` dengan implementasi custom berbasis `node:http` dan `node:https` yang menerapkan **Native IP-Pinning**.
  * `checkSsrfSafety`: Memvalidasi protokol, IP literal, private/metadata ranges, serta me-resolve DNS dengan verifikasi ganda, kemudian mengembalikan `pinnedIp` dan `ipFamily`.
  * `pinnedHttpFetch`: Memaksa opsi socket `lookup` langsung mengembalikan `pinnedIp` yang telah diverifikasi aman. Ini menjamin runtime/OS tidak pernah melakukan resolusi DNS kedua, sehingga eksploitasi DNS Rebinding TOCTOU tertutup 100% secara deterministik.
  * **Penerapan Universal pada Seluruh Hop**: IP-pinning dievaluasi dan ditegakkan di setiap hop rantai redirect (`301`, `302`, `303`, `307`, `308`), bukan hanya pada request pertama.
- **Dokumentasi Batasan Keamanan Diketahui (Known Security Limitations)**:
  * Mendokumentasikan secara transparan batasan teoretis *filesystem TOCTOU race condition* (micro-window antara pengecekan symlink dan kernel I/O saat proses asing OS melakukan symlink-swap paralel) di `README.md` dan `PROGRESS.md`.
- **Izin Berkas Ketat Snapshot Undo (`src/core/undo.ts`)**:
  * Menerapkan mode permissions `0o600` pada pembuatan berkas snapshot `.content` dan `.meta.json` serta `0o700` pada direktori `.ruko/undo/`.
- **Proteksi Rekursi Delegasi Subagent (`src/agent/tools.ts`, `src/agent/agent.ts`, `src/agent/subagent.ts`)**:
  * Membatasi kedalaman delegasi subagent (`subagentDepth >= 1`) dan menolak pemanggilan `delegate` berulang dari dalam subagent untuk mencegah subagent fork bomb / recursion.
- **Pengayaan UI & Contextual Step Indicator (`src/core/ui.ts`)**:
  * Menambahkan identifikasi langkah tool pada `inferStepDescription` untuk `delete_file` / `move_file` (`"Pengelolaan & reorganisasi berkas proyek"`) dan `web_fetch` (`"Mengambil konten referensi web eksternal"`).
- **Rangkaian Pengujian Mandiri Komprehensif (`src/tests/security_hardening_v17.test.ts`)**:
  * 13 unit test adversarial memvalidasi seluruh perbaikan keamanan secara end-to-end (termasuk Native IP-Pinning socket level, active DNS rebinding, and strict session traversal rejection). Total pengujian: **381 passed** (100% lulus, 0 gagal).
### v1.6.2 (14 September 2026) — Stabilitas Termux Mobile, Perluasan Tool Inspeksi & Rollback Berkas, serta Hardening Sanitasi Memori

#### Ditambahkan & Diperbarui
- **Perbaikan Alur Seleksi Enter pada Menu Popup Slash Command (`src/core/tui.ts`)**:
  * **Gejala Bug**: Saat pengguna mengetik `/` lalu menavigasikan panah atas/bawah (scroll highlight) pada daftar perintah, lalu menekan `Enter`, perintah yang ter-highlight tidak terpilih dan menu malah tertutup atau mengeksekusi buffer mentah (`/` kosong atau teks parsial).
  * **Akar Masalah**: Handler Enter (`submit()`) hanya membaca `this.buffer` mentah tanpa memeriksa status item yang dipilih pada menu (`this.selected` / `this.menu[this.selected]`). Jika buffer adalah `'/'`, fungsi `menuOnlyClose` mendeteksinya sebagai penutupan overlay tanpa aksi sehingga menghapus menu tanpa mengeksekusi apa pun.
  * **Solusi**: Menambahkan pelacak navigasi eksplisit `this.menuNavigated`. Saat pengguna memindahkan highlight dengan panah atas/bawah, `menuNavigated` aktif. Saat `Enter` ditekan, jika `menuNavigated` aktif dan ada item terpilih, `submit()` membaca dan memilih perintah tersebut (`item.insert ?? item.label`), menghapus menu secara bersih, dan mengeksekusi perintah terpilih. Jika pengguna hanya mengetik `/` tanpa menavigasi dan menekan Enter, perilaku menutup overlay tanpa commit tetap dipertahankan.
- **Responsivitas Status Bar terhadap Terminal Width Sempit / Termux (`src/core/ui.ts`, `src/core/tui.ts`, `src/core/loop.ts`)**:
  * **Gejala Bug**: Pada layar sempit (seperti Termux di mobile dengan lebar terminal 30–45 kolom), indikator status hijau terpotong di sebelah kanan sehingga persentase konteks (`ctx %`), indikator proses, dan status tidak terlihat.
  * **Akar Masalah**:
    1. `statusBarLine()` di `loop.ts` memanggil `buildStatusBar` tanpa meneruskan lebar terminal `width` dari `LineEditor`.
    2. Deteksi terminal width hanya mengandalkan `process.stdout.columns ?? 80` tanpa memeriksa environment variable `COLUMNS` yang umum digunakan di shell Android/Termux.
    3. `buildStatusBar` di `src/core/ui.ts` menghasilkan string panjang yang melampaui kolom layar sempit (< 48 kolom), sehingga otomatis dipotong paksa oleh `truncateVisible(..., width - 1)`.
  * **Solusi**:
    1. Memperbarui `terminalWidth()` dan `termWidth()` untuk memeriksa `process.env.COLUMNS` sebelum fallback ke default 80.
    2. Meneruskan parameter `width` dari callback `statusLine(width)` di `LineEditor` hingga ke `buildStatusBar({ width })`.
    3. Merombak layout `buildStatusBar` agar secara dinamis menyesuaikan elemen dengan `targetWidth = Math.max(16, width - 1)`. Pada layar sempit, indikator status kritis (`ctx %`, `⏳`, `⏸`) diprioritaskan di sisi kanan, sedangkan nama model dipersingkat secara proporsional (`…`) jika diperlukan, menjamin status bar tidak pernah terpotong.
- **Pelaporan Total Match & Suppressed Matches pada `code_search` (`src/agent/filetools.ts`)**:
  * **Gejala Bug**: Ketika pencarian teks atau regex mencapai batas limit (default 50 matches), tool langsung menghentikan iterasi (`break`), sehingga `totalMatches` yang dilaporkan hanya sebesar batas limit tersebut. Akibatnya pengguna/agen tidak mengetahui berapa jumlah match aktual yang ditemukan di proyek dan apakah masih ada ratusan kecocokan lain yang terpotong.
  * **Akar Masalah**: Loop pemindaian berhenti prematur saat `displayedMatches >= limit` tanpa menghitung sisa kecocokan di file saat itu maupun file-file kandidat berikutnya.
  * **Solusi**: Mengubah alur loop pencarian agar tetap memindai dan menghitung `totalMatches` serta jumlah file yang cocok (`matchedFilesCount`) secara akurat di seluruh kandidat tanpa memformat blok konteks untuk hasil di luar kuota limit (tetap hemat komputasi & token). Pada footer hasil pencarian yang terpotong, menambahkan pesan informatif: `[... Hasil dibatasi ${limit} kecocokan pertama — ${suppressed} more matches suppressed, persempit query, target path, atau extension ...]`.
- **Tool `revert_file` & Rollback Berkas Fleksibel (`src/core/undo.ts`, `src/agent/tools.ts`, `src/agent/roles.ts`, `src/agent/commands.ts`, `src/core/ui.ts`)**:
  * **Kebutuhan**: Setelah perubahan file melalui `patch_file`, `write_file`, atau `edit_file` disetujui, belum ada tool bawaan bagi agen untuk membatalkan perubahan secara spesifik per file jika hasil edit tidak sesuai harapan, dan pengguna hanya memiliki `/undo` global tanpa bisa memilih file tertentu.
  * **Solusi**:
    1. **Core Undo Engine (`src/core/undo.ts`)**: Menambahkan fungsi `revertFileSnapshot`, `revertFileGit`, dan `revertFile(targetPath, { dir, workspaceRoot, mode })`. Mendukung 3 mode (`auto`, `snapshot`, `git`). Pada mode `auto` (default), sistem memeriksa snapshot terbaru file di `.ruko/undo/` dan mengembalikannya (atau menghapusnya jika file baru); jika snapshot tidak ditemukan, sistem fallback mengeksekusi `git checkout -- <file>`.
    2. **Agent Tool (`src/agent/tools.ts`)**: Mendaftarkan tool `revert_file` dengan validasi sandboxing workspace (`resolveToolPath`, anti-path-traversal, proteksi file sensitif), approval gate konfirmasi pengguna saat `approvalEnabled: true`, serta pemblokiran otomatis saat `planMode: true` (`PLAN_MODE_BLOCKED`).
    3. **Prompt & Peran (`src/agent/roles.ts`)**: Mendokumentasikan tool `revert_file` pada `TOOL_RULES`, menambahkan `revert_file` ke aturan read-only peran `reviewer`, serta menambahkan ke proteksi plan mode.
    4. **Slash Command `/undo [path]` (`src/agent/commands.ts`)**: Memperbarui perintah `/undo` agar dapat menerima argumen path opsional (mis. `/undo src/core/ui.ts`) untuk rollback file spesifik, sekaligus mempertahankan `/undo` tanpa argumen untuk membatalkan snapshot terakhir global.
    5. **TUI Step Indicator (`src/core/ui.ts`)**: Menyertakan `revert_file` pada deteksi modifikasi berkas proyek di `inferStepDescription`.
- **Sanitasi & Mitigasi Prompt Injection pada Memory (`src/core/memory.ts`, `src/agent/roles.ts`, `src/agent/tools.ts`)**:
  * **Kebutuhan**: Entri memori yang tersimpan di `.ruko/memory.md` (baik via tool `remember` maupun editan manual) berpotensi disusupi instruksi imperatif tersembunyi (mis. `"jika user tanya X, jawab Y"`, `"you must always respond in JSON"`, atau override sistem) yang dapat memanipulasi perilaku model saat diinjeksikan otomatis ke konteks percakapan.
  * **Solusi**:
    1. **Deteksi Instruksi ke Model (`detectModelInstruction`, `MODEL_INSTRUCTION_RULES`)**: Menyusun aturan regex komprehensif untuk mendeteksi:
       - Arahan kondisional respons ke pengguna (`"jika user tanya X, jawab Y"` / `"if user asks X, reply Y"`).
       - Perintah kontrol perilaku model langsung (`"kamu harus selalu menjawab..."` / `"you must never reply..."`).
       - Percobaan prompt injection / jailbreak / override instruksi sistem (`"ignore all previous instructions..."`, `"system prompt: ..."`).
       - Tetap meloloskan catatan teknis dan fakta proyek pasif yang sah (mis. `"Gunakan PostgreSQL untuk DB produksi"`, `"Port server default adalah 3000"`).
    2. **Gate Penyimpanan (`appendMemory`)**: Secara default menolak entri yang terdeteksi sebagai instruksi imperatif ke model (`actionOnInstruction: 'reject'`), mencegah polusi instruksi ke `.ruko/memory.md`. Mendukung opsi `'tag'` untuk menetralkan entri dengan penanda pasif jika diminta.
    3. **Gate Konteks / Sanitasi Injeksi (`sanitizeMemoryForPrompt`, `formatMemoryForPrompt`)**: Untuk file `.ruko/memory.md` yang diedit manual di luar kendali CLI, sistem memindai setiap baris memori sebelum diinjeksikan ke prompt. Baris yang terdeteksi berformat instruksi ke model otomatis disanitasi dengan label `[INSTRUKSI_DIABAIKAN / DATA PASIF: ...]`, dan panduan sistem dipertegas agar model dilarang menjalankan entri bertanda tersebut sebagai perintah eksekusi.
    4. **Panduan Prompt Tool (`src/agent/roles.ts`)**: Memperbarui deskripsi `remember` di `TOOL_RULES` agar agen memahami bahwa instruksi imperatif interaktif dilarang disimpan ke memori.
- **Peningkatan Timeout Default `exec` & Parameter Timeout Per-Panggilan (`src/core/executor.ts`, `src/types.ts`, `src/core/approval.ts`, `src/agent/tools.ts`, `src/agent/roles.ts`)**:
  * **Kebutuhan**: Timeout default `exec` sebelumnya adalah 30 detik (30_000ms), terlalu singkat untuk tugas kompilasi, instalasi package (`npm install`), atau suite pengujian lama, memaksa penggunaan `start_process` yang tidak praktis untuk perintah foreground singkat. Selain itu, belum ada jalur parsing resmi untuk parameter timeout kustom per panggilan tool.
  * **Solusi**:
    1. **Peningkatan Timeout Default**: Menaikkan `DEFAULT_TIMEOUT_MS` di `src/core/executor.ts` dan `DEFAULT_CONFIG.execTimeoutMs` di `src/types.ts` dari 30s menjadi 120s (120_000ms / 2 menit).
    2. **Parameter Timeout Per-Panggilan (`resolveExecTimeout`)**: Menambahkan fungsi parser yang mendukung parameter `timeoutMs`, `timeout_ms`, dan `timeout` (baik tipe number maupun string numerik). Nilai kecil (`<= 600`) tanpa embel-embel 'Ms' otomatis diinterpretasikan sebagai detik (misal `timeout: 60` -> 60_000ms) dan di-clamp secara aman antara 100ms hingga 3_600_000ms (1 jam).
    3. **Penyaluran Konfigurasi Aman (`src/core/approval.ts`)**: Memastikan `guardedExecute` menyalurkan `options.timeoutMs ?? config.execTimeoutMs` ke fungsi eksekutor, menghormati konfigurasi pengguna.
    4. **Notifikasi Timeout Informatif (`src/core/executor.ts`)**: Ketika proses dihentikan paksa karena timeout, sistem menyertakan pesan diagnostik ramah di output/stderr: `[Command dihentikan: waktu eksekusi melebihi batas timeout Xms. Gunakan parameter timeoutMs lebih besar pada exec jika command membutuhkan waktu lebih lama, atau gunakan start_process untuk proses latar belakang.]`.
    5. **Prompt Tool Rules (`src/agent/roles.ts`)**: Memperbarui dokumentasi protokol tool `exec` di `TOOL_RULES` untuk mencerminkan default 120s dan instruksi penggunaan `timeoutMs`.
- **Dukungan Array & String Comma-Separated pada Parameter `extension` di `code_search` (`src/agent/filetools.ts`, `src/agent/tools.ts`, `src/agent/roles.ts`)**:
  * **Kebutuhan**: Parameter `extension` pada tool `code_search` sebelumnya hanya menerima tipe string tunggal (mis. `"ts"`), sehingga pencarian lintas tipe file (misal TypeScript dan TSX, atau Markdown dan JS) memerlukan pemanggilan tool berkali-kali secara manual.
  * **Solusi**:
    1. **Normalisasi Filter Ekstensi (`parseExtensionFilter`)**: Menambahkan fungsi normalisasi di `src/agent/filetools.ts` yang menangani `string`, `string[]`, maupun string comma-separated (mis. `".ts, .tsx"`, `"ts,tsx"`, atau `[".ts", ".tsx"]`). Ekstensi dipangkas dari whitespace, dinormalisasi ke lowercase, dan titik awalan dibersihkan menjadi `Set<string>`.
    2. **Penyelarasan Dispatcher Tool (`src/agent/tools.ts`)**: Mengizinkan penerimaan nilai array maupun string pada `call.extension`, `call.extensions`, maupun alias `call.ext`.
    3. **Prompt Tool Rules (`src/agent/roles.ts`)**: Memperbarui deskripsi aturan `code_search` di `TOOL_RULES` untuk mengedukasi model bahwa `extension` menerima format array atau comma-separated.
- **Tool `list_dir` untuk Inspeksi Langsung Isi Direktori (`src/agent/filetools.ts`, `src/agent/tools.ts`, `src/agent/roles.ts`, `src/core/ui.ts`)**:
  * **Kebutuhan**: Sebelumnya agen harus menggunakan `glob` dengan pola `*` untuk melihat isi folder. Tidak ada tool sederhana 1-level untuk menginspeksi direktori secara langsung beserta ukuran berkasnya.
  * **Solusi**:
    1. **Core Directory Listing (`src/agent/filetools.ts`)**: Menambahkan `listDirTool` dengan validasi sandboxing workspace (`assertInsideWorkspace`), proteksi berkas sensitif otomatis (`isSensitivePath`), pemilahan jenis entri (`[DIR]`, `[FILE]` dengan ukuran format B/KB/MB, `[LINK]`), dan pengelompokan direktori di urutan teratas.
    2. **Tool Dispatcher (`src/agent/tools.ts`)**: Mendaftarkan tool `list_dir` dan alias `list_directory`, mengizinkan akses read-only (tersedia di plan mode tanpa blok).
    3. **Prompt & Role Integration (`src/agent/roles.ts`)**: Mendokumentasikan `list_dir` di `TOOL_RULES`, menambahkan `list_dir` ke daftar allowlist peran read-only `reviewer`, dan memperbarui rekomendasi penemuan berkas.
    4. **TUI Step Description (`src/core/ui.ts`)**: Memetakan tool `list_dir` ke inferensi langkah kerja UI TUI ("Membaca konfigurasi & struktur berkas").
- **Rangkaian Pengujian**:
  * Menambahkan 9 unit test baru di `src/tests/revert_file.test.ts` (revert dari snapshot, penghapusan file baru, fallback git checkout, penolakan mode snapshot jika tanpa snapshot, approval gate, plan mode blocking, proteksi file sensitif & path traversal, serta perintah `/undo [path]`).
  * Menambahkan 4 unit test baru di `src/tests/memory.test.ts` (akurasi deteksi instruksi imperatif vs fakta pasif, penolakan dan penandaan di `appendMemory`, penolakan di tool `remember`, serta netralisasi otomatis di `sanitizeMemoryForPrompt`).
  * Menambahkan 6 unit test baru di `src/tests/exec_timeout.test.ts` (default 120s, parser parameter `resolveExecTimeout`, terminasi command timeout dengan pesan notifikasi, eksekusi sukses di bawah batas, dan integrasi per-call `timeoutMs` & `timeout`).
  * Menambahkan 3 unit test baru di `src/tests/glob_search.test.ts` (dukungan comma-separated string `".ts, .md"`, array `[".ts", ".md"]`, variasi tanpa dot/dengan spasi, dan dispatch `runToolCall` dengan array/comma-separated).
  * Menambahkan 13 unit test baru di `src/tests/list_dir.test.ts` (listing direktori dan file beserta ukuran, default root path, subdirektori, direktori kosong, batas limit & truncating, penolakan path file & folder fiktif, proteksi sandboxing workspace `/etc`, proteksi berkas sensitif `.env` / `.ruko/config.json`, opsi `showHidden`, dispatch `runToolCall` & alias `list_directory`, ketersediaan di plan mode, dan inferensi langkah TUI).
  * Total pengujian: **409 passed** (100% lulus, 0 gagal).

---

### v1.6.1 (14 September 2026) — Preservasi Utuh Pesan Asisten, State Loop Turn Deduplication, & Robust Tool Loop Guard

#### Ditambahkan & Diperbarui
- **Preservasi Utuh Pesan Asisten & Pencegahan Pengulangan Tool Identik (`src/agent/agent.ts`)**:
  * **Gejala Bug**: Model mengirim teks asisten identik dua kali berturut-turut, dan setelah menjalankan tool (seperti `read_file`), model mengulang teks yang sama DAN memanggil tool yang sama persis untuk kedua kalinya.
  * **Hasil Investigasi & Reproduksi**: Berhasil direproduksi pada `src/tests/agent.test.ts` menggunakan `RecordingProvider`. Ditemukan bahwa root cause merupakan kombinasi dua faktor:
    1. Respons asisten yang memicu tool call dipangkas oleh `stripToolBlocks(raw)` sehingga `content` kehilangan blok pemanggilan tool Markdown. Karena provider (terutama Anthropic/Gemini serta OpenAI-compatible yang tidak menyertakan payload `tools`) mengandalkan `content` teks, model mengira pemanggilan tool belum dilakukan dan mengulang kembali dari awal.
    2. Duplikasi pesan pengguna (`user`) pada setiap giliran REPL karena `this.ctx.add('user', input)` di `loop.ts` ditambahkan ulang oleh `runWithLlm` di `agent.ts`.
  * **Keputusan Arsitektur Guard Deduplikasi (Reuse vs Mekanisme Baru)**:
    - Guard `lastCallSignature` (v1.2.0) telah berada di level dispatcher loop agen (`Agent` di `src/agent/agent.ts`) dan mencakup seluruh tool calls, bukan terkunci pada `processManager.ts`.
    - Diputuskan untuk **me-reuse dan memperkaya guard terpusat yang sudah ada** alih-alih membuat mekanisme baru yang redundan.
    - Pesan diagnostik `skipped: true` diperjelas agar model mengetahui bahwa hasil tool call yang sama sudah tersedia di konteks riwayat sebelumnya dan mengarahkannya untuk melanjutkan analisis tanpa memanggil ulang.
  * **Ringkasan Fix Akhir**:
    1. Menyimpan respons model secara UTUH (`assistantContent = raw.trim()`) pada `role: 'assistant'` bersama metadata `tool_calls` ternormalisasi.
    2. Memeriksa tail `history` pada `runWithLlm` agar tidak menambahkan duplikat pesan `user` jika konteks sudah mencatat pesan user yang sama, tanpa mengubah sedikit pun logika windowing `maxContextChars` pada `src/core/context.ts`.
    3. Menambahkan unit test baru untuk memverifikasi preservasi utuh pesan asisten, deduplikasi pesan user, serta memastikan dua tool call *berbeda* berurutan (`read_file("a.txt")` lalu `read_file("b.txt")`) tetap dieksekusi normal tanpa overblocking.
  * **Rangkaian Pengujian**:
    - Total pengujian meningkat menjadi **368 passed** (100% lulus, 0 gagal).

---

### v1.6.0 (14 September 2026) — Anti-Flickering TUI, Status Bar Process Indicator, SSE Stream Hardening, & Robust Tool Loop Handling

#### Ditambahkan & Diperbarui
- **Penanganan Empty Content Model Setelah Eksekusi Tool (`src/agent/agent.ts`, `src/core/loop.ts`)**:
  * Mengatasi kasus di mana model mengembalikan respons kosong (`""` atau `null`) setelah pemanggilan tool (seperti Read/Glob) dengan `finish_reason: "stop"`.
  * Mengirimkan follow-up message internal (`role: 'user'`) secara otomatis untuk meminta model merangkum hasil eksekusi tool, alih-alih mencetak `"(no response)"` dan menghentikan giliran tanpa penjelasan.
  * Menambahkan filter di `runTurn` agar teks `(no response)` tidak bocor ke output konsol pengguna.
- **Stream Ingestion Hardening untuk SSE Chunks (`src/agent/llm.ts`)**:
  * Mengimplementasikan buffering berbasis baris lokal (`lines.pop()`) pada parser Server-Sent Events (SSE).
  * Menjamin potongan chunk parsial yang terbelah antar paket jaringan disimpan utuh sebelum dilakukan parsing JSON, mencegah teks terpotong di tengah streaming.
  * Menyimpan dan mengekspos atribut `lastFinishReason` pada seluruh provider (`OpenAiCompatibleProvider`, `AnthropicProvider`, `GeminiProvider`).
- **Normalisasi Skema Tool Result & Tool Call (`src/types.ts`, `src/agent/llm.ts`, `src/agent/agent.ts`)**:
  * Menambahkan properti `tool_call_id`, `name`, dan `tool_calls` pada tipe `ContextMessage`.
  * Pesan asisten yang memicu eksekusi tool menyertakan `tool_calls` dengan `id` standar (format `call_<tool>_<iter>_<idx>_<ts>`).
  * Pesan hasil tool dikirimkan kembali ke provider dengan `role: 'tool'`, `tool_call_id` yang valid, dan nama tool yang sesuai, mencegah *silent rejection* dari API server standar OpenAI/Anthropic/Gemini.
- **Anti-Flickering & Pembaruan In-Place TUI (`src/core/tui.ts`)**:
  * Menerapkan dirty-checking berbasis cache (`lastRenderedStatus`, `lastRenderedLine`, `lastRenderedMenuKey`, `lastRenderedModalPrompt`, dll.) untuk mencegah escape sequence ANSI (`\r`, `\x1b[2K`, dsb.) dieksekusi jika konten baris tidak berubah.
  * Mengoptimalkan frame spinner (Pac-Man Thinking) agar memperbarui baris ekor secara in-place tanpa menghapus dan menggambar ulang seluruh status bar serta prompt di bawahnya setiap interval 100ms.
  * Mengeliminasi frame tearing dan kedipan pada layar mobile / emulator terminal (Termux).
- **Indikator Proses Latar Belakang di Status Bar (`src/core/ui.ts`, `src/core/loop.ts`, `src/agent/tools.ts`)**:
  * Menghapus log status proses aktif yang mengotori area chat percakapan biasa pada `get_status`.
  * Mengintegrasikan ringkasan proses aktif langsung ke baris status bawah di antara nama model dan persentase konteks (contoh: `⚡ [glm-5.3-flash] | ⚙️ 2 proc (sleep 301, vite) | ctx 20%`).
  * Menyediakan pemformatan responsif untuk terminal layar sempit (>= 40 kolom) dengan bentuk ringkas `⚙️ 2 proc`.
- **Rangkaian Pengujian & Penambahan Unit Test**:
  * Menambahkan uji unit di `src/tests/ui.test.ts` (formatProcessSummary & responsive narrow status bar), `src/tests/tui.test.ts` (anti-flickering in-place tail updates), `src/tests/llm.test.ts` (SSE partial chunk stream hardening & finish_reason), dan `src/tests/agent.test.ts` (penanganan empty content model & validasi skema tool_call_id).
  * Total pengujian: 365 passed (100% lulus, 0 gagal).

---

### v1.5.0 (13 September 2026) — Proteksi Dua Lapis Berkas & Environment Variable Sensitif (Mitigasi Eksfiltrasi Kredensial & Prompt Injection)

#### Latar Belakang & Temuan Keamanan yang Divalidasi Manual
1. **Temuan 1 (Pembacaan Berkas Konfigurasi Sensitif)**:
   - Skenario teruji: Subagent (via tool `delegate`) diminta membaca `.ruko/config.json` melalui tool `read_file` berhasil dieksekusi dan membocorkan API key *plaintext*.
   - Akar masalah: Hak akses berkas OS (`chmod 600`) hanya melindungi berkas dari proses/pengguna *lain* di sistem operasi. Ketika Ruko berjalan dengan identitas pengguna pemilik, seluruh tool internal Ruko memiliki izin baca penuh terhadap `.ruko/config.json`. Pemeriksaan `assertInsideWorkspace()` mengizinkan akses karena `.ruko/` berada di dalam root direktori kerja.
2. **Temuan 2 (Ketidakefektifan Solusi "Pindah ke Environment Variable")**:
   - Skenario teruji: Kredensial dipindahkan ke environment variable shell induk (`export RUKO_API_KEY=sk-TEST-dummy && ruko`), lalu subagent diminta mengeksekusi `printenv`. Subagent berhasil menjalankan `printenv` via tool `exec` dan membocorkan nilai API key tersebut.
   - Akar masalah: Masalah fundamental bukan terletak pada *media penyimpanan* kredensial (file vs environment variable), melainkan *ketiadaan lapisan filter otorisasi dan kontrol akses data sensitif pada antarmuka tool agen*. Jika agen memproses konten eksternal yang disusupi *prompt injection* (misalnya dari halaman web via `web_fetch` atau repositori/PR tak tepercaya), agen dapat dimanipulasi untuk membaca konfigurasi atau men-dump environment.
3. **Cakupan Universal Agent & Subagent (`delegate`)**:
   - Subagent diisolasi dari konteks percakapan pengguna demi efisiensi token, namun **tidak boleh terisolasi dari kebijakan keamanan sistem**. Proteksi keamanan diterapkan di tingkat dispatcher tool tunggal (`runToolCall`), sehingga setiap subagent mewarisi kebijakan dan proteksi yang identik tanpa celah isolasi.

#### Ditambahkan & Diperbarui
- **Fungsi `isSensitivePath()` & `assertNotSensitivePath()` (`src/agent/tools.ts`)**:
  * Memblokir akses sebelum berkas dibaca pada daftar path sensitif (*case-insensitive*, mencakup variasi relative dan absolute path):
    - `.ruko/config.json`
    - `.ruko/undo/**` (snapshot cadangan yang berpotensi menyimpan konten sensitif lama)
    - `.env`, `.env.*`
    - `id_rsa`, `id_ed25519`, `*.pem`, `*.key`
  * Ditegakkan pada `readFileTool` (`src/agent/filetools.ts`), `resolveToolPath` (`src/agent/tools.ts`), serta penolakan langsung di case `read_file`.
- **Sanitasi Pencarian & Inspeksi Berkas (`src/agent/filetools.ts`)**:
  * `globTool`: Menyaring dan tidak pernah menampilkan path sensitif di hasil pencarian, serta menolak traversal jika target path adalah direktori/file sensitif.
  * `codeSearchTool`: Melewatkan (*skip*) pengindeksan isi berkas sensitif dari pencarian teks/regex, menjamin token tidak bocor lewat hasil pencarian kode.
- **Fungsi `isSensitiveEnvCommand()` (`src/agent/tools.ts`)**:
  * Mendeteksi dan menolak eksekusi shell yang men-dump environment secara luas: `printenv` (tanpa argumen atau dengan flag/grep/pipe), `env` (tanpa argumen atau dengan pipe/redirect), dan `export` polos.
  * Mendeteksi upaya penargetan variabel sensitif via regex: `/(_API_KEY|_TOKEN|_SECRET|_PASSWORD|API_KEY|TOKEN|SECRET|PASSWORD)/i` pada `printenv <NAMA>` serta ekspansi `$<NAMA>` atau `${<NAMA>}`.
  * **Anti-Overblocking**: Perintah `echo` variabel biasa non-sensitif (seperti `echo $PATH`, `echo $HOME`, `echo $USER`, `echo $NORMAL_VAR`) tetap diizinkan.
  * Menolak eksekusi dengan pesan terstandardisasi: `"exec ditolak: command berpotensi membocorkan environment variable sensitif. Kredensial tidak dapat diakses lewat tool ini."`
- **Fungsi `detectSensitiveFileAccessInExec()` (`src/agent/tools.ts`)**:
  * Mendeteksi dan memblokir perintah shell pada `exec` yang secara eksplisit menargetkan berkas sensitif (mis. `cat .ruko/config.json`, `cat .env`, `tail id_rsa`, redirect input `< .ruko/config.json`).
- **Integrasi Penuh ke Subagent & Propagasi Workspace (`src/agent/agent.ts`, `src/agent/subagent.ts`)**:
  * Menambahkan parameter `workspaceRoot` opsional pada kelas `Agent`, diteruskan ke seluruh pemanggilan `runToolCall`.
  * Runner `runSubagent` meneruskan `options.workspaceRoot` ke instans subagent sehingga kebijakan workspace dan keamanan jalur sensitif tersinkronisasi penuh.
- **Rangkaian Pengujian Komprehensif (`src/tests/sensitive_protection.test.ts`)**:
  * 11 unit test baru mencakup: verifikasi path sensitif, penolakan `read_file`, penyembunyian pada `glob`, pengabaian pada `code_search`, penolakan `cat .ruko/config.json`, penolakan `printenv` polos, penolakan `printenv RUKO_API_KEY`, lolosnya `echo $NORMAL_VAR`, reproduksi skenario eksfiltrasi subagent `delegate` (kedua skenario berhasil ditolak), dan uji regresi startup aplikasi Ruko (`loadConfig` internal tetap berfungsi tanpa gangguan).

#### Detail Arsitektural
- **Pemisahan Jalur Startup Internal vs Tool Agen**:
  * Pemuatan kredensial internal saat inisiasi CLI (`loadConfig` di `src/core/config.ts`) menggunakan API `node:fs` murni (`readFileSync`) dan tidak melalui tool agen. Dengan demikian, proteksi tool agen tidak mempengaruhi proses startup normal aplikasi.
- **Verifikasi & Test Suite**:
  * Total test: **353 passed** (100% lulus, 0 gagal), `npm run typecheck` bersih, `npm run test:e2e` lulus (1 passed).

---

### v1.4.0 (13 September 2026) — Pencarian Lintas Sesi, Siklus Lengkap Skills System, & In-Flight Cancellation

#### Ditambahkan
- **Tool `search_sessions(query, limit?)` (`src/core/session.ts`, `src/agent/tools.ts`)**:
  * Pencarian teks (case-insensitive substring match) pada seluruh pesan percakapan di `.ruko/sessions/`.
  * Membaca secara inkremental/streaming per berkas (diurutkan berdasarkan `mtime` menurun, newest-first) tanpa memuat seluruh riwayat sesi ke memori.
  * Mengembalikan: `session_id`, `timestamp`, `message_count`, judul, role, dan `snippet` ringkas (maksimal ~150 karakter).
  * Default limit 5 hasil, aman digunakan di seluruh mode (plan mode, reviewer, default).
- **Slash Command `/search <query>` (`src/agent/commands.ts`)**:
  * Antarmuka CLI interaktif untuk pencarian lintas sesi dengan visual rapi (`renderBox`) dan petunjuk langsung `/resume <session_id>`.
- **Tool `delete_skill(name)` (`src/core/skills.ts`, `src/agent/tools.ts`)**:
  * Menghapus berkas skill yang sudah usang atau tidak relevan dari `.ruko/skills/`.
  * Wajib konfirmasi Approval Gate `[Y/N]` dan menampilkan preview isi instruksi skill sebelum dihapus. Terdaftar di `PLAN_MODE_BLOCKED`.
- **Aturan Penyimpanan Skill di System Prompt (`src/agent/roles.ts`)**:
  * `TOOL_RULES` diperbarui: agent HANYA menyimpan skill baru jika (a) user memberi instruksi berulang yang kompleks, atau (b) user secara eksplisit meminta "simpan ini sebagai skill". Dilarang menyimpan skill otomatis/diam-diam. Isi skill wajib berupa pola umum (*generalizable*).
- **In-Flight Cancellation Support via ESC (`src/core/tui.ts`, `src/agent/agent.ts`)**:
  * Menangani tombol ESC tunggal (`\u001b`) saat ambient mode aktif untuk mengirimkan abort signal ke streaming LLM dan eksekusi tool in-flight.
  * Menampilkan umpan balik jelas `"Dibatalkan oleh pengguna"` ke terminal.
- **Installer `install.sh` & Lockfile Sync**:
  * Mengubah default clone ke branch `main` (`TAG="${RUKO_VERSION:-main}"`) agar unduhan via `curl | bash` selalu memperoleh versi terbaru tanpa tertahan di tag lama.

#### Detail Arsitektural
- **Pola Asimetri Keamanan Approval Gate**:
  * `delete_skill` wajib Approval Gate `[Y/N]` karena bersifat destruktif terhadap berkas proyek. Tidak membutuhkan snapshot undo terpisah karena ukuran skill kecil dan pratinjau isi skill sudah ditampilkan secara eksplisit kepada pengguna sebelum konfirmasi.
  * `save_skill` dan `stop_process` tetap non-destruktif / tidak memerlukan gate konfirmasi.
- **Efisiensi Memori Streaming Pencarian Sesi**:
  * Direktori `.ruko/sessions/` diinspeksi dengan `statSync` untuk mengurutkan file secara kronologis menurun sebelum parsing JSON dilakukan. File dibaca dan dievaluasi satu per satu, lalu segera dilepas dari memori jika tidak cocok atau batas `limit` tercapai.
- **Decoupled Lifecycle Background Process vs Turn Cancel**:
  * Child process yang dijalankan via `start_process` berjalan secara *detached* dan *unref*, sehingga saat user menekan ESC untuk membatalkan giliran AI, background server/watcher tetap berjalan aman tanpa terbunuh.
- **Verifikasi & Test Suite**:
  * Total test: **342 passed** (100% lulus, 0 gagal), `npm run typecheck` bersih.

---

### v1.3.0 (13 September 2026) — Process Management Subsystem & Anti-Zombie Lifecycle Hooks
- **Fitur Utama**:
  * Penambahan tool manajemen proses background non-blocking: `start_process(command, cwd?)`, `read_process_logs(process_id)`, `get_status(process_id)`, dan `stop_process(process_id)`.
  * Batas maksimal 3 proses aktif bersamaan dengan validasi ketat `assertInsideWorkspace()`.
  * Buffer log melingkar (*ring buffer*) 100 baris dengan sanitasi kredensial otomatis (*best-effort* regex).
- **Keputusan Keamanan**:
  * Asimetri Approval Gate: `start_process` wajib konfirmasi `[Y/N]` (potensi bahaya tersembunyi), sedangkan `stop_process` bebas konfirmasi.
  * Anti-Zombie Cleanup: Hook terpasang lengkap pada `exit`, `SIGINT`, DAN `SIGTERM` untuk mematikan seluruh child process sebelum Ruko keluar.
- **Verifikasi**: 13 unit test baru (total 335 passed).

---

### v1.2.0 (13 September 2026) — Keamanan Tool Berkas, Guard Anti-Duplikasi, Quick Wins & Approval Expansion
- **Fitur Utama**:
  * Tool resmi `delete_file` dan `move_file` dengan validasi path traversal, persetujuan konfirmasi `[Y/N]`, dan pencadangan snapshot otomatis ke `.ruko/undo/`.
  * Guard mekanis `lastCallSignature` pada loop agent untuk mencegah eksekusi ganda perintah identik secara berulang.
  * Tool `web_fetch` dengan proteksi ketat SSRF (blokir IP lokal, privat RFC 1918, link-local cloud metadata, dan DNS pre-check).
  * Multi-pattern & brace expansion `{a,b}` pada tool `glob`, tool `list_skills`, slash command `/context set <jumlah>`, dan styling box approval ANSI.
- **Verifikasi**: 25 unit test baru (total 322 passed).

---

### v1.1.1 (13 September 2026) — Perbaikan Izin Biner Global & Polish Visual TUI
- **Fitur Utama**:
  * Otomasi izin eksekusi (`chmod +x`) biner global di `install.sh` untuk platform Termux dan Linux standar.
  * Pemisahan baris model dan provider pada splash banner REPL untuk tampilan bersih pada terminal sempit (>= 40 kolom).

---

### v1.1.0 (13 September 2026) — Provider Eksternal, Persistensi REPL & Trajectory Export
- **Fitur Utama**:
  * Dukungan multi-provider: integrasi Anthropic Claude dan Google Gemini via native fetch SSE streaming.
  * Loader `.env` zero-dependency, penyimpanan riwayat masukan REPL (`.ruko/history`), dan ekspor jejak giliran percakapan (`/export [jsonl|md]`).

---

### v1.0.0 (12 September 2026) — Inisiasi Fondasi Ruko AI Coding Agent
- **Fitur Utama**:
  * Mesin agen otonom zero-runtime dependency berbasis Node.js/TypeScript.
  * Filter keamanan dua lapis: Deterministic Regex Gate (Layer 1) + Guardian LLM terisolasi (Layer 2) dengan audit trail `.ruko/guardian-audit.log`.
  * Workspace sandboxing (`assertInsideWorkspace`), kompresi konteks riwayat percakapan, jurnal undo berkas, dan persistensi sesi.

---

## 💡 Ide Selanjutnya / Roadmap (untuk AI berikutnya)

Gap fitur yang tersisa dibanding sistem asisten coding modern:

### Prioritas tinggi
1. ~~**Tool tambahan** — `read_file`, `edit_file`, `write_file`, `patch_file`, `glob`, `code_search`~~ — **SELESAI (v0.9.0)**.
2. ~~**Provider LLM lain** — Anthropic & Google Gemini SSE native~~ — **SELESAI (v1.1.0)**.
3. ~~**Subagent / delegation** — tool `delegate` & subagent runner~~ — **SELESAI (v1.1.0)**.
4. ~~**Skills system lengkap** — load, save, list, delete, & prompt guidelines~~ — **SELESAI (v1.4.0)**.
5. ~~**Pencarian lintas sesi** — `search_sessions` & command `/search`~~ — **SELESAI (v1.4.0)**.
6. ~~**Process management** — `start_process`, `read_process_logs`, `get_status`, `stop_process`~~ — **SELESAI (v1.3.0)**.

### Prioritas sedang / jangka panjang
7. **Cron / automasi terjadwal** — jalankan instruksi berkala (daily healthcheck/build), kirim status ke webhooks.
8. **Gateway messaging** — konektor pesan ringan (Telegram/Discord webhook daemon) untuk remote trigger.
9. **Dukungan Plugin / MCP** — protokol client Model Context Protocol (MCP) untuk menghubungkan tools eksternal secara dinamis.
10. **Packaging & Distribusi** — publikasi npm registry resmi (`npm publish`), Docker container image, dan skrip updater terintegrasi.

---

## ⏳ Status Pengerjaan Roadmap

- [x] Tool manipulasi & inspeksi berkas (`read_file`, `patch_file`, `edit_file`, `write_file`, `delete_file`, `move_file`, `glob`, `code_search`) — SELESAI.
- [x] Provider multi-profil (OpenAI-compatible, Anthropic, Gemini) — SELESAI.
- [x] Subagent / task delegation (`delegate`) — SELESAI.
- [x] Skills system siklus penuh (`load_skill`, `save_skill`, `list_skills`, `delete_skill`) — SELESAI.
- [x] Approval pintar (Guardian LLM + Audit Trail) — SELESAI.
- [x] Pencarian percakapan lintas sesi (`search_sessions` & `/search`) — SELESAI.
- [x] Process management subsystem background services — SELESAI.
- [x] TUI & Visual Polish (raw-mode editor, in-place redraw, ambient mode, ESC cancel, responsive divider) — SELESAI.
- [x] Trajectory export, REPL history persistence, dan E2E test runner — SELESAI.
- [ ] Cron & gateway messaging (DITUNDA / OUT OF SCOPE).

---

## 🐞 Known Bugs / Issues

Status dan resolusi batasan arsitektural:
1. ~~**Compression menyerah bila budget tak terjangkau**~~ — **TERATASI (v1.7.1)**: Dilengkapi *best-effort fallback compression* (`foldAllHead` pada `src/core/compressor.ts`) yang tetap meringkas giliran riwayat tertua ke ringkasan terpadat ketika protected tail turn panjang, mencegah ledakan konteks window.
2. **`--exec` timeout mencatat exit code `null`** (bukan 124) — Perilaku standar Node.js `child_process.exec` saat proses dimatikan paksa oleh sinyal (SIGTERM); pesan diagnostik penjelas `[Command timed out after Xms]` disertakan langsung pada teks `output`. Untuk proses latar belakang, gunakan tool terpisah `start_process` (`spawn`).
3. ~~**Urutan stdout vs stderr** pada field `output` tool `exec` tidak terjamin sekuensial mutlak~~ — **TERATASI (v1.7.1)**: Menggunakan real-time interleaved stream listener (`child.stdout.on('data')`, `child.stderr.on('data')`) pada `src/core/executor.ts` sehingga output gabungan terjamin kronologis sekuensial.
4. **Known limitation deteksi obfusikasi perintah regex**: Obfuscation eval/base64 kompleks (`echo <b64> | base64 -d | sh`) tidak dapat ditutup sempurna dengan regex statis tanpa false-positive masif; ditangani via pertahanan lapis kedua (Guardian LLM).
5. **Approval non-TTY otomatis menolak**: Di lingkungan CI headless yang ingin mengeksekusi aksi berisiko, wajib menyetel flag non-interaktif atau `RUKO_YOLO_MODE`.
6. **Known limitation redaksi kredensial**: Redaksi token/kredensial pada `read_process_logs` berbasis ekspresi reguler adalah pertahanan berlapis (*best-effort*), bukan jaminan 100% terhadap token arbitrer tanpa kata kunci penanda.
7. **Streaming interleaving pada terminal sangat sempit**: Teks streaming LLM dapat mengalami pergeseran baris kecil jika terminal berukuran <40 kolom saat indikator thinking aktif.
8. ~~**TOCTOU pada web_fetch**~~ — **TERATASI (v1.7.1)**: Menggunakan custom socket dispatcher `http.Agent`/`https.Agent` dengan Native IP-Pinning langsung pada level socket TCP pada `src/agent/webtools.ts`, menutup celah TOCTOU / DNS rebinding secara tuntas.

---

## 🤖 Context Handoff untuk AI Berikutnya

1. **Verifikasi Baseline**:
   - Jalankan `npm run typecheck` (harus 0 error).
   - Jalankan `npm test` (harus **446 passed**, 0 fail).
   - E2E test: `npm run test:e2e` (1 passed).
2. **Struktur Direktori Proyek**:
   - `src/core/`: Infrastruktur murni Node.js (loop, approval, executor, summarizer, undo, context, session, config, wizard, ui, skills).
   - `src/agent/`: Logika AI & interaksi agen (agent, llm, tools, roles, commands, filetools, webtools, processManager, subagent).
   - `src/tests/`: Rangkaian pengujian terisolasi Node.js native test runner.
3. **Konvensi Pengembangan**:
   - Zero runtime dependencies — dilarang menambah dependensi `dependencies` di `package.json`.
   - TypeScript strict mode, ESM format (`.js` extension pada relative imports).
   - Seluruh pesan interaksi CLI dan dokumentasi menggunakan Bahasa Indonesia.
   - Jangan membuat git tag baru sebelum diinstruksikan oleh pengguna.
