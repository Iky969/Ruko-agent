# Laporan Audit Kode & Quality Assurance (QA) — Ruko Agent CLI

Dokumen ini mencatat temuan audit kode, arsitektur, keamanan defensif, antarmuka visual CLI, serta edge case pada proyek Ruko Agent CLI sesuai pedoman `feedback.txt`.

---

### [BUG LOGIKA] Stateful Global RegExp pada `codeSearchTool` Melewatkan Baris Kecocokan
- **File / Komponen:** `src/agent/filetools.ts:766-785`
- **Tingkat Keparahan:** Tinggi
- **Deskripsi:** Variabel `flags` diinisialisasi dengan `'g'` (`let flags = 'g'`) yang digunakan saat membuat `matcher = new RegExp(..., flags)`. Pada JavaScript/TypeScript, objek `RegExp` dengan flag global `'g'` memiliki sifat stateful ketika dipanggil dengan `RegExp.prototype.test()`, di mana properti `matcher.lastIndex` bergeser ke indeks tepat setelah kecocokan ditemukan. Saat `codeSearchTool` menguji baris-baris file (`matcher.test(lines[i])`) dalam perulangan, baris berikutnya akan mulai dicari dari posisi `lastIndex` baris sebelumnya. Jika kecocokan pada baris berikutnya berada pada indeks sebelum `lastIndex` atau panjang baris tersebut lebih pendek dari `lastIndex`, pemanggilan `matcher.test()` akan mengembalikan `false` dan me-reset `lastIndex` ke 0.
- **Dampak:** Tool `code_search` secara sporadis melewatkan baris-baris kode yang sebenarnya cocok (false negatives), terutama jika terdapat baris cocok yang berurutan atau berada pada offset awal baris.
- **Rekomendasi Perbaikan:** Hapus flag `'g'` dari `flags` di `codeSearchTool` (`let flags = ''`, hanya tambahkan `'i'` jika case-insensitive), karena pengujian baris per baris hanya memerlukan pemeriksaan boolean per baris dan tidak memerlukan pencarian token global berulang.

---

### [CELAH KEAMANAN] Potensi Path Traversal & Arbitrary File Deletion / Overwrite pada Snapshot Metadata `/undo`
- **File / Komponen:** `src/core/undo.ts:82-96, 138-160` dan `src/agent/commands.ts:240-277`
- **Tingkat Keparahan:** Tinggi
- **Deskripsi:** Fungsi `undoLast()` dan `revertFileSnapshot()` di `src/core/undo.ts` membaca path target (`last.abs`) langsung dari deserialisasi berkas `.ruko/undo/<id>.meta.json` tanpa memvalidasi apakah path tersebut berada di dalam batas workspace sandbox (`isPathInsideWorkspace`), bukan berkas sensitif (`isSensitivePath`), dan bukan berkas keamanan inti (`isSecurityCoreFile`). Jika suatu direktori atau repositori git yang tidak tepercaya memuat berkas metadata snapshot tiruan di `.ruko/undo/` dengan `abs` mengarah ke berkas sistem penting di luar workspace (misal `/etc/passwd` atau `~/.bashrc`), pemanggilan `/undo` akan menghapus (`rmSync`) atau menimpa berkas tersebut. Selain itu, pada handler perintah slash terminal `/undo <path>` di `src/agent/commands.ts`, validasi hanya memeriksa `assertInsideWorkspace` tanpa memverifikasi `assertNotSecurityCore` dan `assertNotSensitivePath`.
- **Dampak:** Risiko manipulasi atau penghapusan berkas di luar workspace (arbitrary file deletion/overwrite) melalui eksploitasi metadata snapshot undo yang tidak tervalidasi, serta kemampuan me-revert berkas sensitif atau berkas proteksi keamanan inti Ruko.
- **Rekomendasi Perbaikan:** Terapkan validasi batas workspace (`isPathInsideWorkspace`), berkas sensitif (`isSensitivePath`), dan berkas keamanan inti (`isSecurityCoreFile`) pada `undoLast()` dan `revertFileSnapshot()` di `undo.ts`. Pada `commands.ts`, panggil `assertNotSecurityCore` dan `assertNotSensitivePath` saat memproses argumen `/undo <path>`.

---

### [BUG LOGIKA & PERSISTENSI] `sanitizeConfigFile` Menghilangkan `maxOutputTokens` dan `provider` Saat Simpan/Muat
- **File / Komponen:** `src/core/config.ts:17-36, 61-138` dan `src/agent/commands.ts:1033-1133`
- **Tingkat Keparahan:** Sedang
- **Deskripsi:** Antarmuka `RukoConfigFile` dan fungsi `sanitizeConfigFile()` di `src/core/config.ts` belum mendaftarkan properti `maxOutputTokens` dan `provider`. Meskipun `/settings max-tokens <nilai>` atau konfigurasi provider berhasil disimpan ke `.ruko/config.json`, saat Ruko dijalankan ulang, fungsi `loadConfig()` memanggil `sanitizeConfigFile()` yang menyaring dan menghapus kedua properti tersebut karena tidak ada dalam daftar whitelist sanitasi. Akibatnya, nilai `maxOutputTokens` selalu kembali ke default (4096). Selain itu, fungsi `applyConfigPatch` di `commands.ts` belum menangani key `maxOutputTokens` dan menggunakan `parseInt(value, 10)` yang keliru mengubah input bernotasi unit seperti `100k` menjadi `100` alih-alih `100000`.
- **Dampak:** Pengaturan `maxOutputTokens` dan `provider` tidak persisten antar-sesi; pengaturan `maxContextChars` berpotensi rusak drastis jika dimasukkan dengan format unit `k` melalui `/config set`.
- **Rekomendasi Perbaikan:** Tambahkan `maxOutputTokens` dan `provider` ke dalam `RukoConfigFile` dan `sanitizeConfigFile()`. Perbarui `applyConfigPatch` di `commands.ts` agar mengenali `maxOutputTokens`, menangani notasi `k`/`m` pada nilai numerik, memvalidasi batas bawah karakter konteks aktif, dan tampilkan field tersebut pada output `/config`.

---

### [GLITCH VISUAL & FORMATTING] Overflow Layout Divider & Kerusakan Code Block Streaming pada `formatTerminalMarkdown`
- **File / Komponen:** `src/core/ui.ts:197-229, 1022-1067` dan `src/agent/agent.ts:266-271`
- **Tingkat Keparahan:** Sedang
- **Deskripsi:**
  1. Fungsi `renderDivider` dan `renderApprovalBox` membaca `process.stdout.columns ?? 80` secara mentah alih-alih memanggil `terminalWidth()`. Pada environment di mana `process.stdout.columns` undefined tetapi `process.env.COLUMNS` terdefinisi (seperti Termux Android atau subshell tertentu), divider tetap memakai lebar 80 sehingga melipat (wrapping) menjadi dua baris dan merusak tampilan.
  2. Teks judul `alertHeader` pada `renderApprovalBox` tidak dibatasi dengan `fit()`, sehingga pada layar sempit (< 35 kolom), teks judul melebihi lebar box dan menyebabkan garis tepi kotak terbelah.
  3. `formatTerminalMarkdown` bersifat stateless per-panggilan. Ketika dipanggil per-baris oleh `LineGate` selama streaming token LLM di `agent.ts`, flag `inCodeBlock` selalu ter-reset ke `false` setiap baris baru. Akibatnya, baris kode di dalam blok ` ``` ` yang memuat tanda `**` atau backtick keliru diformat sebagai markdown biasa.
  4. Regex bold (`\*\*([^*]+)\*\*`) dijalankan sebelum inline code tanpa perlindungan token, sehingga inline code yang memuat asteris (misal `` `**/*.tmp` ``) ikut terpotong dan terformat salah.
- **Dampak:** Glitch visual pada terminal layar sempit/mobile, kotak approval berantakan, dan baris kode yang sedang di-stream menampilkan formatting markdown yang salah.
- **Rekomendasi Perbaikan:** Gunakan `terminalWidth()` pada `renderDivider` dan `renderApprovalBox`, terapkan `fit(alertHeader)` pada baris judul approval. Sediakan class `TerminalMarkdownFormatter` stateful untuk streaming `LineGate`, serta lindungi inline code dengan tokenisasi/placeholder sebelum memproses regex bold.

---

### [EDGE CASE INTERAKSI] Seleksi Menu Slash "/" Diabaikan pada Ambient Mode & URL Quoting Sanitization
- **File / Komponen:** `src/core/tui.ts:861-888`, `src/agent/llm.ts:190-192, 230-232`, dan `src/core/wizard.ts:107-115`
- **Tingkat Keparahan:** Rendah
- **Deskripsi:**
  1. Pada `src/core/tui.ts` di method `submit()`, percabangan ambient mode (`if (!this.pending && this.ambient)`) langsung mengirim `this.buffer` mentah tanpa mengecek `this.menuNavigated`. Jika pengguna membuka menu slash `/` dan menggulir ke salah satu opsi menggunakan tombol panah lalu menekan Enter saat AI sedang sibuk (ambient mode), teks yang diantrekan tetap karakter mentah yang diketik (misal `/`) bukan item menu yang disorot.
  2. Di `src/agent/llm.ts`, `OpenAiCompatibleProvider` tidak membersihkan tanda kutip (`"` atau `'`) pembungkus pada `baseUrl`, berbeda dengan `GeminiProvider` dan `AnthropicProvider`. Pada `wizard.ts`, jika pengguna menempelkan URL dengan tanda kutip, regex `http://` tidak cocok dan URL yang tersimpan menjadi invalid bagi pemanggilan `fetch()`.
- **Dampak:** Pengguna tidak dapat memilih menu slash command via tombol panah + Enter saat ambient mode; URL berkuotasi menyebabkan error parsing `fetch` saat startup atau eksekusi.
- **Rekomendasi Perbaikan:** Periksa `this.menuNavigated` sebelum submit pada ambient mode di `tui.ts`. Bersihkan tanda kutip pembungkus pada `baseUrl` di `OpenAiCompatibleProvider` dan `wizard.ts`.

---

## Status Remediasi & Verifikasi

Semua temuan di atas telah diperbaiki secara tuntas tanpa memperkenalkan dependensi eksternal baru (*zero-dependency*) dan tanpa regresi pada fungsionalitas yang ada:

1. **[BUG LOGIKA] Stateful Global RegExp pada `codeSearchTool`:**
   - **Perbaikan:** Menghapus flag `'g'` pada instansiasi regex di `src/agent/filetools.ts`.
   - **Status:** **TERSELESAIKAN (RESOLVED)** — Terverifikasi pada `src/tests/audit_fixes.test.ts`.

2. **[CELAH KEAMANAN] Path Traversal & Arbitrary File Deletion / Overwrite pada `/undo`:**
   - **Perbaikan:** Menambahkan `validateSnapshotPath()` di `src/core/undo.ts` untuk memblokir traversal ke luar workspace, symbolic link, berkas sensitif (`.ruko/config.json`, `.ruko/undo/**`, `.env*`, SSH keys, git credentials). Memperketat `undoLast()`, `revertFileSnapshot()`, dan `revertFile()`, serta menambahkan `assertNotSecurityCore` dan `assertNotSensitivePath` pada `/undo` di `src/agent/commands.ts`.
   - **Status:** **TERSELESAIKAN (RESOLVED)** — Terverifikasi pada `src/tests/audit_fixes.test.ts`.

3. **[BUG LOGIKA & PERSISTENSI] `sanitizeConfigFile` Menghilangkan `maxOutputTokens` dan `provider`:**
   - **Perbaikan:** Menambahkan `maxOutputTokens` dan `provider` ke antarmuka `RukoConfigFile` dan whitelist `sanitizeConfigFile()` di `src/core/config.ts`. Menambahkan fungsi `parseConfigNumber()` dengan dukungan unit `k`/`m` serta validasi batas memori konteks di `src/agent/commands.ts`.
   - **Status:** **TERSELESAIKAN (RESOLVED)** — Terverifikasi pada `src/tests/audit_fixes.test.ts`.

4. **[GLITCH VISUAL & FORMATTING] Overflow Divider & Kerusakan Code Block Streaming:**
   - **Perbaikan:** Mengganti `process.stdout.columns ?? 80` dengan `terminalWidth()` pada `renderDivider` dan `renderApprovalBox`, menambahkan `fit(alertHeader)` agar tidak overflow di terminal sempit. Mengimplementasikan class `TerminalMarkdownFormatter` stateful untuk streaming `LineGate` di `src/agent/agent.ts`, serta melindungi inline code dengan tokenisasi unik sebelum formatting bold di `src/core/ui.ts`.
   - **Status:** **TERSELESAIKAN (RESOLVED)** — Terverifikasi pada `src/tests/audit_fixes.test.ts`.

5. **[EDGE CASE INTERAKSI] Seleksi Menu Slash "/" pada Ambient Mode & URL Quoting Sanitization:**
   - **Perbaikan:** Menangani `this.menuNavigated` pada ambient submit di `src/core/tui.ts` agar memilih item menu yang sedang disorot. Membersihkan kutip pembungkus (`"` dan `'`) pada `apiKey`, `baseUrl`, dan `model` di `OpenAiCompatibleProvider` (`src/agent/llm.ts`) dan wizard interaktif (`src/core/wizard.ts`).
   - **Status:** **TERSELESAIKAN (RESOLVED)** — Terverifikasi pada `src/tests/audit_fixes.test.ts`.

### Hasil Pengujian
- `npm run typecheck`: **0 Error** (TypeScript kompilasi bersih).
- `npm test`: **493 Passed, 0 Failed** (486 pengujian eksisting + 7 pengujian audit baru).

