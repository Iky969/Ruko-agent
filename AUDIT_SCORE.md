# AUDIT SCORE & LAPORAN INSPEKSI KETAT KODE RUKO AGENT

> **Status Audit**: Selesai Dilakukan  
> **Auditor**: Kode Inspektur & Auditor Ketat  
> **Target Verifikasi**: Repositori Ruko (v1.7.4+)  
> **Baseline Eksekusi**: `npm run typecheck` (0 error) & `npm test` (**498 tests passed**, 0 fail, 0 skipped)  
> **Aturan Evaluasi**: Penelusuran menyeluruh read-only tanpa modifikasi kode implementasi.

---

## 📊 1. Ringkasan Skor per Kategori (Skala 1–10)

| Kategori | Skor | Status Singkat |
| :--- | :---: | :--- |
| **Keamanan (Security)** | **8.5 / 10** | Dual-layer approval gate, IP-pinning SSRF, dan immutable core sangat solid. Ada celah minor pada `.ruko/trusted` yang belum masuk daftar file sensitif terproteksi. |
| **Penanganan Error (Error Handling)** | **7.0 / 10** | Error sanitasi kredensial dan retry backoff HTTP baik. Namun parsing JSON tool call dan frame SSE banyak menelan galat secara diam-diam (*silent swallowing*). |
| **Performa / Bottleneck** | **6.5 / 10** | Scan filesystem berulang pada `systemPrompt()` setiap turn, pencarian sekuensial pada ribuan berkas di `code_search`, dan `MAX_TOOL_ITERATIONS = 6` yang terlalu kaku menghambat alur kerja. |
| **UX Terminal Sempit (< 40 Kolom)** | **6.0 / 10** | Status bar responsif pada <=40 kolom, namun animasi Pac-Man dan `ThoughtSlidingWindow` mengalami overflow/wrapping dan merusak baris in-place rewinding saat kolom sangat sempit. |
| **Konsistensi Multi-Provider** | **6.0 / 10** | `OpenAiCompatibleProvider` lengkap (tool_calls delta streaming & reasoning_content). Namun `GeminiProvider` hanya membaca `parts[0]` (kehilangan part lain), tidak mendukung thought token streaming, dan wizard `/login` hanya menguji endpoint OpenAI. |
| **Cakupan Test (Test Coverage)** | **8.5 / 10** | 498 unit test mencakup mayoritas skenario core, security, dan parsing. Namun modul interaktif `loop.ts` dan integrasi CLI argument `index.ts` minim/tanpa test langsung. |
| **Maintainability Kode** | **8.0 / 10** | Struktur modul rapi, tipe TypeScript ketat (strict ESM), tanpa dependensi runtime pihak ketiga. Beberapa file (`tools.ts` >2.100 baris, `ui.ts` >1.200 baris, `commands.ts` >1.400 baris) mulai menjadi *god-file* monolitik. |

**Rata-rata Skor Keseluruhan**: **7.2 / 10**

---

## 🔍 2. Rincian Evaluasi & Justifikasi Skor per Kategori

### 2.1. Keamanan (Security) — Skor: 8.5 / 10

#### Kekuatan:
1. **Immutable Security Core**: Mencegah modifikasi atau penghapusan berkas pelindung (`src/core/approval.ts`, `src/core/executor.ts`, `src/agent/tools.ts`, `src/agent/filetools.ts`, `src/agent/subagent.ts`, `src/agent/webtools.ts`) di [`src/agent/tools.ts:314-321`](file:///workspaces/Ruko/src/agent/tools.ts#L314-L321).
2. **SSRF Transport Hardening**: Implementasi Native IP-Pinning langsung pada level socket TCP di [`src/agent/webtools.ts:114-177`](file:///workspaces/Ruko/src/agent/webtools.ts#L114-L177), memvalidasi IP pada setiap hop redirect untuk menolak loopback, private IPv4/IPv6, dan cloud metadata (`169.254.169.254`).
3. **Dual-Layer Gate & Shell Variable Resolution**: Evaluasi regex Layer 1 memperluas variabel shell (`extractAndResolveShellVariables`) sebelum pencocokan destruktif di [`src/core/approval.ts:229-265`](file:///workspaces/Ruko/src/core/approval.ts#L229-L265), mencegah bypass pola `$DIR` atau `$TARGET`.
4. **Proteksi Kredensial & Kunci SSH**: Fungsi `assertNotSensitivePath()` di [`src/agent/tools.ts:539-543`](file:///workspaces/Ruko/src/agent/tools.ts#L539-L543) mengisolasi `.ruko/config.json`, `.ruko/undo/**`, `.env*`, `id_rsa*`, `id_ed25519*`, `*.pem`, `*.key`, dan shell rc files.

#### Celah & Kelemahan Konkret:
1. **Celah Otorisasi Mandiri `.ruko/trusted`** ([`src/agent/tools.ts:443-462`](file:///workspaces/Ruko/src/agent/tools.ts#L443-L462)):
   Fungsi `isSensitivePath()` memblokir `.ruko/config.json` dan `.ruko/undo/**`, namun **TIDAK** memblokir berkas `.ruko/trusted`. Akibatnya, agen AI dapat memanggil tool `write_file` dengan path `.ruko/trusted`, sehingga secara sepihak mem-bypass prompt keamanan workspace trust pada sesi berikutnya tanpa konfirmasi eksplisit dari pengguna.
2. **Berkas Inti Keamanan Belum Menyeluruh** ([`src/agent/tools.ts:314-321`](file:///workspaces/Ruko/src/agent/tools.ts#L314-L321)):
   `SECURITY_CORE_FILES` belum mencakup `src/core/trust.ts`, `src/core/undo.ts`, `src/core/config.ts`, atau `src/index.ts`. Jika agen diminta mengedit file tersebut, proteksi trust dan jurnal snapshot dapat dimanipulasi di tingkat source code.

---

### 2.2. Penanganan Error (Error Handling) — Skor: 7.0 / 10

#### Kekuatan:
1. **Penerjemahan Galat Ramah Pengguna**: `explainProviderError()` di [`src/agent/llm.ts:139-165`](file:///workspaces/Ruko/src/agent/llm.ts#L139-L165) memetakan kode status HTTP (400, 401, 403, 404, 429, 500, 502, 503) menjadi penjelasan dan arahan perbaikan yang konkret.
2. **Sanitasi Kredensial pada Error Message & Stack Trace**: `sanitizeError()` di [`src/agent/llm.ts:119-133`](file:///workspaces/Ruko/src/agent/llm.ts#L119-L133) menyamarkan API key dari teks pesan error dan stack trace sebelum dilempar ke atas.

#### Celah & Kelemahan Konkret:
1. **Silent Swallowing pada Tool Call Parsing** ([`src/agent/tools.ts:97-99`](file:///workspaces/Ruko/src/agent/tools.ts#L97-L99)):
   Jika model menghasilkan blok ```` ```tool ```` dengan JSON malformed (misalnya trailing comma atau unquoted keys), blok `catch` mengabaikan error tanpa logging atau feedback:
   ```typescript
   try {
     const parsed = JSON.parse(match[1].trim()) as ToolCall;
     // ...
   } catch {
     // Malformed block — ignore it, the model may still have answered in text.
   }
   ```
   Hal ini menyebabkan tool tidak dieksekusi, dan pengguna/agen tidak tahu mengapa aksinya diabaikan.
2. **Silent Swallowing pada Streaming Frame Parsing** ([`src/agent/llm.ts:459-461`](file:///workspaces/Ruko/src/agent/llm.ts#L459-L461) & [`src/agent/llm.ts:982-984`](file:///workspaces/Ruko/src/agent/llm.ts#L982-L984)):
   Parsing JSON payload SSE diabaikan di dalam blok `catch {}` kosong. Bila API provider mengembalikan format frame yang sedikit bergeser atau error payload non-standar, teks token terputus tanpa ada pesan diagnostik.
3. **Ketidakpastian Penanganan Malformed Tool Argumen**:
   Di [`src/agent/llm.ts:393`](file:///workspaces/Ruko/src/agent/llm.ts#L393) dan [`src/agent/llm.ts:483`](file:///workspaces/Ruko/src/agent/llm.ts#L483), kegagalan parsing argumen streaming ditelan (`catch { // fallback }`) menghasilkan objek kosong `{}` tanpa peringatan bahwa argumen gagal direkonstruksi.

---

### 2.3. Performa & Bottleneck — Skor: 6.5 / 10

#### Kekuatan:
1. **LCS Diff Pruning**: Algoritma LCS di [`src/core/diff.ts:27-46`](file:///workspaces/Ruko/src/core/diff.ts#L27-L46) memotong common prefix & suffix, serta memberlakukan batas `LCS_CELL_LIMIT = 400 * 400` untuk mencegah ledakan memori matriks DP.
2. **Log Summarizer Efisien**: [`src/core/summarizer.ts:22-64`](file:///workspaces/Ruko/src/core/summarizer.ts#L22-L64) memangkas log besar (>1000 karakter) dengan rasio kepala-ekor dan pengekstrakan highlight galat.

#### Celah & Kelemahan Konkret:
1. **`MAX_TOOL_ITERATIONS = 6` Terlalu Rendah untuk Task Eksploratif** ([`src/agent/agent.ts:34`](file:///workspaces/Ruko/src/agent/agent.ts#L34)):
   Batas iterasi tool per instruksi dikunci mati pada `const MAX_TOOL_ITERATIONS = 6;`. Untuk pekerjaan eksploratif (misal: mencari file via `glob`, membaca modul, menganalisis struktur, mencari referensi dengan `code_search`, menjalankan test, dan menerapkan perbaikan), 6 iterasi habis dengan sangat cepat sehingga agen berhenti mendadak dengan pesan:
   `[agent] reached max tool iterations without a final answer; stopping.`
   Nilai ini tidak dapat dikonfigurasi melalui config, environment variable, maupun command `/settings`.
2. **I/O Disk Sinkron Berulang di `systemPrompt()` Setiap Giliran** ([`src/agent/agent.ts:149-165`](file:///workspaces/Ruko/src/agent/agent.ts#L149-L165)):
   Pada setiap giliran perbincangan, `systemPrompt()` memanggil `initDefaultSkills()`, `scanSkills()`, `readMemorySafe()`, dan `readAgentDocSafe()`. Seluruh pemanggilan ini melakukan operasi filesystem sinkron (`existsSync`, `readdirSync`, `readFileSync`, `writeFileSync`) ke disk secara berulang-ulang tanpa caching in-memory.
3. **Pencarian Sekuensial Berkas pada `codeSearchTool`** ([`src/agent/filetools.ts:855-885`](file:///workspaces/Ruko/src/agent/filetools.ts#L855-L885)):
   `code_search` membaca isi berkas satu per satu secara sekuensial menggunakan `fs.readFile()` untuk ribuan kandidat berkas dalam workspace besar, menimbulkan lag I/O yang dapat dioptimasi dengan batch asynchronous / worker pool.

---

### 2.4. UX Layar Terminal Sempit (< 40 Kolom) — Skor: 6.0 / 10

#### Kekuatan:
1. **Layout Status Bar Responsif Termux** ([`src/core/ui.ts:381-443`](file:///workspaces/Ruko/src/core/ui.ts#L381-L443)):
   Status bar pada lebar < 60 dan < 40 kolom secara cerdas memprioritaskan indikator `ctx %` di sisi kanan, memotong nama model dengan ellipsis, serta menonaktifkan teks pelengkap agar tidak melebihi lebar layar.
2. **Kalkulasi Lebar Sel East-Asian & Emoji (wcwidth)** ([`src/core/ui.ts:59-105`](file:///workspaces/Ruko/src/core/ui.ts#L59-L105)):
   Fungsi `charWidth` memperhitungkan emoji 2-kolom (`⚡`, `⏳`, `🟢`) agar tidak merusak perhitungan rewind terminal.

#### Celah & Kelemahan Konkret:
1. **Line Wrap & Broken Rewind pada `ThoughtSlidingWindow`** ([`src/core/ui.ts:718-723`](file:///workspaces/Ruko/src/core/ui.ts#L718-L723)):
   Method `render()` mengeluarkan string `[berpikir] ...` dengan 12 kata tanpa pembatasan lebar terminal (`truncateVisible`). Pada terminal sempit (30–38 kolom), 12 kata menghasilkan panjang >50 karakter yang otomatis membungkus (*wrap*) ke baris kedua. Akibatnya, escape code `\r\u001b[2K` pada iterasi berikutnya hanya membersihkan baris kedua, meninggalkan baris pertama menumpuk sebagai artefak (*ghost lines*) di scrollback.
2. **Line Wrapping pada Pembersihan Spinner Pac-Man** ([`src/core/ui.ts:524`](file:///workspaces/Ruko/src/core/ui.ts#L524) & [`src/core/ui.ts:579`](file:///workspaces/Ruko/src/core/ui.ts#L579)):
   Pada `createSpinner`, `maxCleared` dihitung dari `Math.max(width, text.length + 16)` (bisa mencapai 50+ karakter ketika label status thinking memuat waktu dan token). Ketika spinner dihentikan via `stop()`, perintah menuliskan `' '.repeat(maxCleared)`. Pada terminal 30–35 kolom, penulisan 50 spasi menyebabkan baris melompat ke baris baru dan meninggalkan baris kosong tak diinginkan.
3. **Overflow pada Kotak Konfirmasi Approval & Prompt** ([`src/core/ui.ts:214-220`](file:///workspaces/Ruko/src/core/ui.ts#L214-L220) & [`src/core/approval.ts:546`](file:///workspaces/Ruko/src/core/approval.ts#L546)):
   Pertanyaan konfirmasi `"Apakah kamu mengizinkan perintah ini? (y/n): "` memiliki panjang 44 karakter. Pada terminal <40 kolom (misal Android Termux di layar portrait 36 kolom), pertanyaan ini membungkus ke baris kedua dan merusak tata letak visual approval box.
4. **Indikasi Step `WorkflowTree` Membungkus ke Baris Baru** ([`src/core/ui.ts:1196`](file:///workspaces/Ruko/src/core/ui.ts#L1196)):
   Format `┌─ ● [Langkah X] <deskripsi>` rata-rata membutuhkan 50–60 karakter. Di layar <40 kolom, header langkah terpotong atau terlipat sehingga garis vertikal konektor `│` tampak patah.

---

### 2.5. Konsistensi Multi-Provider — Skor: 6.0 / 10

#### Kekuatan:
1. **Arsitektur Provider Mandiri Zero-Dependency**:
   Implementasi native fetch tanpa SDK eksternal untuk OpenAI-Compatible, Anthropic Claude, dan Google Gemini.
2. **Normalisasi Schema Tool Message**:
   `OpenAiCompatibleProvider` menormalisasi pesan hasil tool execution dengan `tool_call_id` valid di [`src/agent/llm.ts:321-339`](file:///workspaces/Ruko/src/agent/llm.ts#L321-L339).

#### Celah & Kelemahan Konkret:
1. **Kehilangan Data Chunk Multi-Part pada `GeminiProvider`** ([`src/agent/llm.ts:948`](file:///workspaces/Ruko/src/agent/llm.ts#L948) & [`src/agent/llm.ts:977`](file:///workspaces/Ruko/src/agent/llm.ts#L977)):
   Pada penanganan respons streaming dan non-streaming Google Gemini, parser hanya membaca indeks pertama:
   ```typescript
   const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
   ```
   Jika model Gemini mengembalikan lebih dari satu part (misalnya `parts[0]` berupa thought/reasoning dan `parts[1]` berupa text output, atau pemisahan part kode), seluruh part selain `parts[0]` **dibuang sepenuhnya** (data loss).
2. **Ketiadaan Dukungan Thought/Reasoning pada `GeminiProvider`** ([`src/agent/llm.ts:776-783`](file:///workspaces/Ruko/src/agent/llm.ts#L776-L783)):
   `GeminiProvider` tidak memiliki properti `lastReasoning` dan tidak memicu callback `options.onThought()`, berbeda dengan `OpenAiCompatibleProvider` (yang mendukung `reasoning_content`) dan `AnthropicProvider` (yang mendukung `thinking_delta`).
3. **Inkonsistensi Parsing Native Tool Calling Antar Provider**:
   - `OpenAiCompatibleProvider` merekonstruksi streaming delta `tool_calls` menjadi blok ```` ```tool ```` di [`src/agent/llm.ts:449-489`](file:///workspaces/Ruko/src/agent/llm.ts#L449-L489).
   - `AnthropicProvider` dan `GeminiProvider` **sama sekali tidak mendeklarasikan schema tool** dan tidak mem-parsing blok `tool_use` / `functionCall` native. Keduanya sepenuhnya bergantung pada prompting teks markdown. Jika Claude atau Gemini memilih mengeluarkan struktur tool call native, respons tersebut diabaikan atau gagal diproses.
4. **Wizard Setup Hanya Menguji Endpoint OpenAI-Compatible** ([`src/index.ts:481-483`](file:///workspaces/Ruko/src/index.ts#L481-L483)):
   Saat menjalankan setup wizard via `ruko` atau `/login`, probe koneksi dipaksa menggunakan `OpenAiCompatibleProvider`:
   ```typescript
   const setup = await runSetupWizard(async (r) =>
     new OpenAiCompatibleProvider({ apiKey: r.apiKey, baseUrl: r.baseUrl, model: r.model }).testConnection(),
   );
   ```
   Jika pengguna memasukkan kunci atau model Anthropic/Gemini, pengujian koneksi akan memanggil `${baseUrl}/chat/completions` dan langsung gagal.

---

### 2.6. Cakupan Test (Test Coverage) — Skor: 8.5 / 10

#### Kekuatan:
1. **Total Test Anti-Regresi Tinggi**: Terdapat **498 tests passed** (100% lulus, 0 fail) pada test suite native Node.js.
2. **Pengujian Keamanan Komprehensif**: Pengujian ekstensif pada `sensitive_protection.test.ts`, `file_security.test.ts`, `security_hardening_v17.test.ts`, dan `trust.test.ts`.
3. **Verifikasi Visual ANSI & TUI**: Pengujian akurat pada `tui.test.ts`, `ui.test.ts`, dan `tui_workflow.test.ts`.

#### Celah & Area yang Belum Teruji (Test Gaps):
1. **Ketiadaan Test untuk `src/core/loop.ts`**:
   Tidak ada file pengujian `loop.test.ts`. Alur integrasi REPL utama, penanganan antrean ambient modal saat AI bekerja, serta siklus hidup turn tidak diuji secara unit test mandiri.
2. **Ketiadaan Test Argument CLI `src/index.ts`**:
   Parsing parameter baris perintah (`--exec`, `--summarize`, `--trust-folder`, `--yes`, `--env-file`, dll.) tidak memiliki suite pengujian otomatis khusus.
3. **Test Parsing Provider Anthropic & Gemini Terbatas**:
   Pengujian pada `providers.test.ts` dan `llm.test.ts` sebagian besar menguji `OpenAiCompatibleProvider`. Skenario kegagalan transport, multi-part payload, dan rate-limit Anthropic/Gemini masih minim.

---

### 2.7. Maintainability Kode — Skor: 8.0 / 10

#### Kekuatan:
1. **Zero Runtime Dependencies**: 100% API standar Node.js (`node:fs`, `node:child_process`, `node:readline`, `node:http`), bebas dari kerentanan supply-chain.
2. **TypeScript Strict Mode & ESM Native**: Standarisasi ekstensi `.js` pada relative import, penataan tipe yang jelas di `src/types.ts`.
3. **Dokumentasi Kode Terstruktur**: Mayoritas modul memiliki JSDoc yang mendeskripsikan tujuan arsitektur.

#### Celah & Beban Pemeliharaan (Code Smells):
1. **Kecenderungan God-File Monolitik**:
   - `src/agent/tools.ts`: **2.110 baris kode** (menggabungkan protokol tool, regex sensitif, approval filter, audit trail, sandboxing path traversal, dan implementasi lusinan tool).
   - `src/agent/commands.ts`: **1.403 baris kode** (menggabungkan registrasi command, formatting tampilan badge, konfigurasi patcher, dan logika eksekusi).
   - `src/core/ui.ts`: **1.235 baris kode** (menggabungkan kode warna ANSI, wcwidth, box rendering, spinner animasi, format markdown, dan stream parser).
2. **Duplikasi Logika Validasi Path Traversal**:
   Logika verifikasi `cwd`, symlink `realpathSync`, dan pengecekan prefix terduplikasi di beberapa tempat (`tools.ts`, `filetools.ts`, `undo.ts`, `session.ts`, `skills.ts`).

---

## 💥 3. Temuan yang KONTRADIKTIF dengan Dokumentasi

Bagian ini membeberkan ketidaksesuaian nyata antara klaim di `PROGRESS.md` / `README.md` dengan implementasi kode aktual:

| No | Klaim Dokumentasi (PROGRESS.md / README.md) | Kondisi Kode Aktual | Dampak / Keterangan |
| :---: | :--- | :--- | :--- |
| **1** | **`ThoughtSlidingWindow` Aktif di `agent.ts`**<br>`PROGRESS.md` baris 51 mengklaim implementasi live reasoning sliding window (`src/core/ui.ts`, `src/agent/agent.ts`) menampilkan buffer kata FIFO redup di terminal saat model berpikir. | `ThoughtSlidingWindow` hanya di-import di [`src/agent/agent.ts:13`](file:///workspaces/Ruko/src/agent/agent.ts#L13) dan **TIDAK PERNAH DIINSTANSIASI ATAU DIGUNAKAN** di dalam `runWithLlm`. | Kode mati (*dead import*). Tampilan thinking di `agent.ts:283` murni menggunakan `spinner.update()` teks status biasa. |
| **2** | **Tool `web_search` Tersedia**<br>`README.md` baris 379 mendeskripsikan `webtools.ts` sebagai: *"Tool web_fetch & web_search dengan SSRF Native IP Pinning"*. | Tool atau fungsi `web_search` **TIDAK ADA SAMA SEKALI** di seluruh repositori (hanya ada `web_fetch`). | Ketidaksesuaian dokumen. Model atau pengguna yang mengharapkan `web_search` akan mendapati tool tidak terdaftar. |
| **3** | **Export Jejak Tool Sesi**<br>`README.md` baris 251 menyatakan perintah `/export [json\|markdown]` berfungsi: *"Ekspor log giliran percakapan dan jejak tool sesi aktif"*. | `Context` di [`src/core/context.ts`](file:///workspaces/Ruko/src/core/context.ts) dan [`src/core/loop.ts:354`](file:///workspaces/Ruko/src/core/loop.ts#L354) **hanya menyimpan pesan `user` dan teks akhir `assistant`**. Panggilan tool dan hasil eksekusi tool di intermediate loop tidak pernah disimpan ke `Context`. | Berkas trajectory hasil `/export` hanya memuat percakapan teks biasa tanpa ada jejak eksekusi tool sama sekali. |
| **4** | **Batas Iterasi Tool Terlalu Rendah & Kaku**<br>Dokumentasi mengklaim Ruko tangguh menyelesaikan tugas multi-langkah (*multi-step task*). | `MAX_TOOL_ITERATIONS` dikunci mati sebesar **6** di [`src/agent/agent.ts:34`](file:///workspaces/Ruko/src/agent/agent.ts#L34) tanpa konfigurasi dinamis. | **Sesuai catatan feedback.txt**: Batas 6 iterasi membuat tugas analisis/eksplorasi kode terhenti prematur sebelum selesai. |
| **5** | **Jumlah Test Suite Berbeda**<br>`README.md` baris 7 menyatakan badge `493 passed`, dan `PROGRESS.md` menyebut `486/493 passed`. | Hasil eksekusi `npm test` aktual meluluskan **498 tests passed**. | Dokumentasi belum diperbarui mencerminkan penambahan test terbaru pada modul skills dan provider. |
| **6** | **Opsi `maxIterations` pada Subagent adalah Phantom**<br>Antarmuka `SubagentOptions` mendefinisikan `maxIterations?: number;` di [`src/agent/subagent.ts:17`](file:///workspaces/Ruko/src/agent/subagent.ts#L17). | Parameter `options.maxIterations` **tidak pernah diteruskan atau digunakan** saat membuat instansiasi `Agent` di `runSubagent()`. | Subagent tetap terkunci pada limit default `MAX_TOOL_ITERATIONS = 6` milik agen utama. |
| **7** | **Wizard Setup Multi-Provider**<br>`README.md` mengiklankan dukungan native OpenAI, Anthropic, dan Gemini. | `runSetupWizard` di [`src/index.ts:481`](file:///workspaces/Ruko/src/index.ts#L481) melakukan hardcoded probe hanya ke `OpenAiCompatibleProvider`. | Pengguna provider Anthropic / Gemini gagal melakukan verifikasi live koneksi saat wizard pertama kali dijalankan. |
| **8** | **Status Evaluasi "Known Bugs / Issues" di PROGRESS.md**: | | |
| 8.1 | *Bug 1: Compression menyerah bila budget tak terjangkau* (Klaim: TERATASI). | **TERVERIFIKASI TERATASI**: `foldAllHead` aktif di [`src/core/compressor.ts:50-57`](file:///workspaces/Ruko/src/core/compressor.ts#L50-L57). | Sesuai kode. |
| 8.2 | *Bug 2: `--exec` timeout mencatat exit code null* (Klaim: Keterbatasan standar). | **TERVERIFIKASI**: Masih berstatus `null` dengan pesan penjelasan di [`src/core/executor.ts:59-76`](file:///workspaces/Ruko/src/core/executor.ts#L59-L76). | Sesuai kode. |
| 8.3 | *Bug 3: Urutan stdout vs stderr pada exec* (Klaim: TERATASI). | **TERVERIFIKASI TERATASI**: Interleaved stream chunk listener aktif di [`src/core/executor.ts:45, 110-115`](file:///workspaces/Ruko/src/core/executor.ts#L45). | Sesuai kode. |
| 8.4 | *Bug 7: Streaming interleaving pada terminal sempit (<40 kolom)* (Klaim: Catatan batasan). | **MASIH TERBUKA & BERMASALAH**: `ThoughtSlidingWindow` dan `createSpinner` (`maxCleared`) masih menyebabkan wrapping dan polusi scrollback di layar <40 kolom. | Perlu penanganan pemotongan lebar aktif. |
| 8.5 | *Bug 8: TOCTOU pada web_fetch* (Klaim: TERATASI). | **TERVERIFIKASI TERATASI**: Native IP-pinning socket agent aktif di [`src/agent/webtools.ts:114-177`](file:///workspaces/Ruko/src/agent/webtools.ts#L114-L177). | Sesuai kode. |

---

## 🏛️ 4. Analisis Menyeluruh per Modul

### 4.1. Modul `src/agent/`

- **`agent.ts`**:
  - Orkestrator utama alur giliran agen.
  - Memiliki guard anti-stuck loop ganda (`seenRepeat`) dan anti-premature halt (`isActionTask` nudge).
  - *Temuan Kritis*: Konstanta `MAX_TOOL_ITERATIONS = 6` terlalu rendah untuk pekerjaan coding non-trivial. Import `ThoughtSlidingWindow` tidak pernah dipanggil dalam alur eksekusi token.
- **`commands.ts`**:
  - Registry command `/` bergaya chip/badge highlight yang rapi.
  - *Temuan*: Fungsi `/export` hanya mengekspor pesan `user` dan `assistant` tanpa riwayat tool call. File sangat panjang (>1.400 baris) karena menyatukan UI rendering help dan parsing argumen perintah.
- **`filetools.ts`**:
  - Menyediakan `glob`, `list_dir`, `code_search`, dan `read_file` dengan paginasi serta deteksi biner.
  - *Temuan*: `code_search` melakukan traversal dan pembacaan berkas secara sekuensial satu demi satu, berpotensi menjadi bottleneck pada proyek dengan ribuan berkas.
- **`llm.ts`**:
  - Menyediakan abstraksi multi-provider (`OpenAiCompatibleProvider`, `AnthropicProvider`, `GeminiProvider`).
  - *Temuan*: `GeminiProvider` mengalami potensi kehilangan data pada candidate multi-part (hanya mengambil `parts[0]`), serta ketiadaan parsing tool native pada Anthropic & Gemini.
- **`processManager.ts`**:
  - Sangat solid: dilengkapi Anti-Zombie Lifecycle Hooks (`SIGINT`, `SIGTERM`, `exit`), pembatasan 3 proses paralel, dan redaksi kredensial regex pada log stream.
- **`roles.ts`**:
  - System prompt terstruktur berlapis dengan kontrak penalaran `<thought>`. Instruksi peran dan aturan protokol tool sangat jelas dan byte-stabil untuk prompt caching.
- **`subagent.ts`**:
  - Beroperasi dalam konteks terisolasi dan memiliki security interceptor terhadap pola path sensitif.
  - *Temuan*: Opsi `maxIterations` pada `SubagentOptions` tidak terhubung ke agen (`phantom parameter`).
- **`tools.ts`**:
  - Inti protokol eksekusi tool. Mengintegrasikan diff LCS visual, snapshot undo otomatis, dan sandboxing `assertInsideWorkspace`.
  - *Temuan*: Merupakan file terbesar (>2.100 baris). Penanganan error parsing JSON tool call ditelan secara diam-diam. Berkas `.ruko/trusted` terlewat dari daftar `isSensitivePath`.
- **`webtools.ts`**:
  - Sangat aman: menerapkan SSRF Native IP-Pinning pada level socket TCP.
  - *Temuan*: Dokumentasi `README.md` menyebutkan adanya `web_search`, padahal modul ini hanya mengimplementasikan `web_fetch`.

---

### 4.2. Modul `src/core/`

- **`approval.ts`**:
  - Pertahanan dua lapis (Deterministic Regex + Semantic Guardian LLM). Mampu mengevaluasi resolusi variabel shell bash sebelum evaluasi bahaya.
- **`compressor.ts`**:
  - Algoritma kompresi adaptif bertingkat dengan fallback `foldAllHead`. Berhasil mencegah kegagalan pemangkasan konteks saat giliran terlindungi berukuran panjang.
- **`config.ts` & `dotenv.ts`**:
  - Loader konfigurasi dan parser `.env` mandiri zero-dependency yang bersih. Menegakkan izin berkas `0o600` pada saat penyimpanan.
- **`context.ts`**:
  - Mengelola sliding window percakapan.
  - *Temuan*: Hanya mengelola riwayat `user` dan `assistant`. Struktur penyimpanan pesan tidak menyimpan log jejak tool per-turn sehingga riwayat tool hilang setelah instruksi selesai.
- **`diff.ts`**:
  - LCS diff visualizer bergaya `git diff`. Memiliki batas sel kuadratik untuk mengantisipasi berkas raksasa.
- **`executor.ts`**:
  - Menjalankan perintah subproses shell dengan interleaved streaming stdout/stderr kronologis, pembatasan buffer, dan summarizer.
- **`history.ts` & `session.ts`**:
  - Persistensi riwayat masukan terminal dan sesi percakapan dengan perlindungan traversal path.
- **`loop.ts`**:
  - Controller REPL interaktif dengan ambient input mode. Mengizinkan pengetikan saat AI bekerja dan interupsi terisolasi tombol ESC / Ctrl+C.
- **`memory.ts`**:
  - Persistent memory Markdown dengan deteksi instruksi imperatif untuk memitigasi prompt injection tidak langsung.
- **`skills.ts`**:
  - Sistem manajemen workflow modular (`.ruko/skills/`). Dilengkapi guardrail default `anti-slop` dan `anti-hallucination` serta budget limit string.
- **`splash.ts` & `summarizer.ts`**:
  - Tampilan pembuka animasi akuarium dan pemangkas log panjang yang andal dan teruji.
- **`trust.ts`**:
  - Konfirmasi kepercayaan workspace sebelum agen mengeksekusi tool.
- **`tui.ts` & `ui.ts`**:
  - Raw-mode engine yang kompleks dan kaya fitur.
  - *Temuan*: `ThoughtSlidingWindow` dan pembersihan spinner Pac-Man belum membatasi panjang teks terhadap `terminalWidth()`, memicu line-wrap di terminal sempit (<40 kolom).
- **`undo.ts`**:
  - Snapshot rollback berkas otomatis sebelum mutasi dilakukan. Mengisolasi penyimpanan ke `.ruko/undo/` dengan izin `0o600`.
- **`wizard.ts`**:
  - Panduan interaktif konfigurasi awal dengan masking kata sandi. Hanya memfasilitasi endpoint format OpenAI.

---

### 4.3. Modul Root (`src/index.ts` & `src/types.ts`)

- **`src/types.ts`**:
  - Definisi interface bersih, modular, dan terstruktur dengan baik.
- **`src/index.ts`**:
  - Entry point CLI yang menangani argumen baris perintah dan delegasi ke `SystemLoop`.
  - *Temuan*: Pengujian koneksi saat `needsSetup` terkunci pada `OpenAiCompatibleProvider`.

---

## 📋 5. Action Items (Daftar Tugas Terurut Prioritas & Estimasi Effort)

Berikut adalah daftar rekomendasi perbaikan terurut dari prioritas tertinggi (kritis) hingga terendah:

### 🔴 Prioritas 1: Kritis (Segera Diperbaiki)
- [ ] **1. Tingkatkan & Konfigurasikan Batas Iterasi Tool (`MAX_TOOL_ITERATIONS`)**  
  *Deskripsi*: Ubah nilai hardcoded `MAX_TOOL_ITERATIONS = 6` di [`src/agent/agent.ts:34`](file:///workspaces/Ruko/src/agent/agent.ts#L34) menjadi konfigurabel melalui `AgentConfig` (default minimal 25–30 untuk task eksploratif) dan dukung override via flag/command `/settings iterations <n>`. Hubungkan juga ke `options.maxIterations` di `subagent.ts`.  
  *Estimasi Effort*: **Kecil** (~15 menit)

- [ ] **2. Kunci Keamanan `.ruko/trusted` dari Akses Mutasi Tool Agen**  
  *Deskripsi*: Tambahkan `.ruko/trusted` ke dalam filter `isSensitivePath()` di [`src/agent/tools.ts:444-462`](file:///workspaces/Ruko/src/agent/tools.ts#L444-L462) agar agen tidak dapat menuliskan file otorisasi trust secara sepihak via tool `write_file`.  
  *Estimasi Effort*: **Kecil** (~10 menit)

- [ ] **3. Perbaiki Parser Multi-Part Streaming `GeminiProvider`**  
  *Deskripsi*: Perbarui parsing payload Gemini di [`src/agent/llm.ts:948, 977`](file:///workspaces/Ruko/src/agent/llm.ts#L948) agar mengiterasi seluruh elemen array `parts` (`for (const part of parts)`) alih-alih hanya mengambil `parts[0]`. Tambahkan ekstraksi `part.thought` untuk diteruskan ke `onThought`.  
  *Estimasi Effort*: **Sedang** (~30 menit)

- [ ] **4. Aktifkan `ThoughtSlidingWindow` atau Sinkronkan Implementasi di `agent.ts`**  
  *Deskripsi*: Hubungkan instansiasi `ThoughtSlidingWindow` di [`src/agent/agent.ts`](file:///workspaces/Ruko/src/agent/agent.ts) dengan callback `handleThoughtChunk`, atau hapus klaim di `PROGRESS.md` jika representasi status cukup menggunakan `createSpinner`.  
  *Estimasi Effort*: **Sedang** (~30 menit)

---

### 🟡 Prioritas 2: Sedang (Stabilitas, UX & Dokumentasi)
- [ ] **5. Mitigasi Line-Wrap Layar Sempit (<40 Kolom) pada `ui.ts`**  
  *Deskripsi*:
  - Bungkus keluaran `ThoughtSlidingWindow.render()` dengan `truncateVisible(..., terminalWidth() - 1)`.
  - Batasi `maxCleared` pada `createSpinner.stop()` agar tidak melebihi `terminalWidth() - 1`.
  - Pangkas/format ulang teks pertanyaan approval di `approval.ts:546` agar muat dalam 1 baris pada layar sempit.  
  *Estimasi Effort*: **Sedang** (~45 menit)

- [ ] **6. Dukung Multi-Provider pada Setup Wizard (`wizard.ts` & `index.ts`)**  
  *Deskripsi*: Tambahkan pilihan provider (OpenAI-compatible, Anthropic, Gemini) pada setup wizard, dan gunakan provider yang sesuai saat melakukan probe konektivitas di [`src/index.ts:481-483`](file:///workspaces/Ruko/src/index.ts#L481-L483).  
  *Estimasi Effort*: **Sedang** (~45 menit)

- [ ] **7. Sinkronisasi Dokumentasi vs Kode (`README.md` & `PROGRESS.md`)**  
  *Deskripsi*:
  - Hapus referensi `web_search` dari `README.md:379` (atau implementasikan tool pencarian web sesungguhnya).
  - Perbarui badge jumlah test di `README.md` dari `493 passed` menjadi `498 passed`.
  - Perjelas deskripsi `/export` di `README.md:251` mengenai cakupan riwayat pesan vs jejak tool.  
  *Estimasi Effort*: **Kecil** (~15 menit)

- [ ] **8. Berikan Feedback Jelas pada Malformed Tool Call JSON**  
  *Deskripsi*: Pada [`src/agent/tools.ts:97-99`](file:///workspaces/Ruko/src/agent/tools.ts#L97-L99), alih-alih menelan `catch` tanpa aksi, simpan indikasi format galat dan kembalikan feedback instruksi perbaikan JSON ke LLM agar tidak stuck tanpa respon.  
  *Estimasi Effort*: **Kecil** (~20 menit)

---

### 🟢 Prioritas 3: Rendah / Jangka Panjang (Performa & Refactoring)
- [ ] **9. Preservasi Riwayat Tool Call ke dalam `Context` untuk Trajectory Export Penuh**  
  *Deskripsi*: Izinkan `Context` menyimpan pesan `role: 'tool'` dan `tool_calls` per turn (dengan opsi pemangkasan saat kompresi) agar ekspor trajectory `/export` menghasilkan jejak investigasi tool yang utuh.  
  *Estimasi Effort*: **Besar** (~1–2 jam)

- [ ] **10. Optimasi Cache Filesystem pada `systemPrompt()`**  
  *Deskripsi*: Buat cache in-memory untuk skill scanning, memory file, dan `AGENT.md` dengan invalidasi berbasis timestamp `mtime` file, menghindari I/O disk sinkron berulang pada setiap turn percakapan.  
  *Estimasi Effort*: **Sedang** (~45 menit)

- [ ] **11. Modularisasi File Raksasa (*God-Files*)**  
  *Deskripsi*: Pecah `src/agent/tools.ts` (>2.100 baris) menjadi modul-modul terpisah (misal: `tools/registry.ts`, `tools/security.ts`, `tools/mutations.ts`) demi kemudahan pemeliharaan jangka panjang.  
  *Estimasi Effort*: **Besar** (~2–3 jam)

- [ ] **12. Tambahkan Rangkaian Unit Test untuk `src/core/loop.ts` dan Argumen CLI `src/index.ts`**  
  *Deskripsi*: Buat pengujian otomatis untuk menguji lifecycle REPL, ambient queue modal, dan flag CLI satu-per-satu.  
  *Estimasi Effort*: **Sedang** (~1 jam)

---

## 🎯 Kesimpulan Auditor

Ruko Agent adalah CLI coding agent yang **sangat impresif, bersih, dan berstandar keamanan tinggi** untuk proyek murni berbasis Node.js ESM tanpa runtime dependencies. Rangkaian 498 unit test yang seluruhnya lulus, pertahanan dual-layer regex + Guardian LLM, snapshot undo otomatis, dan SSRF Native IP-Pinning menunjukkan kehati-hatian arsitektur yang luar biasa.

Namun, efektivitas agen dalam menyelesaikan tugas otonom saat ini **terhambat oleh batas `MAX_TOOL_ITERATIONS = 6` yang terlalu kaku**, ketidaksinkronan antara dokumentasi dan kode pada beberapa komponen (fitur `web_search`, koneksi `ThoughtSlidingWindow`, dan wizard multi-provider), serta potensi glitch baris pada terminal sempit (<40 kolom).

Dengan menyelesaikan Action Items Prioritas 1 dan 2 di atas, Ruko akan mencapai kematangan penuh sebagai coding agent yang tidak hanya aman (*secure*), tetapi juga tangguh (*resilient*) dan transparan (*well-documented*).
