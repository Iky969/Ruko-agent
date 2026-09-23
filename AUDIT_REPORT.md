# LAPORAN AUDIT KONSOLIDASI & RENCANA DESAIN FITUR RUKO AGENT

> **Status Dokumen**: Terkonsolidasi & Terverifikasi  
> **Tanggal Pembaruan**: September 2026  
> **Baseline Eksekusi**: `npm run typecheck` (0 error) & `npm test` (**546 tests passed**, 0 fail, 0 skipped)  
> **Prinsip Utama**: *Zero third-party runtime dependencies*, pertahanan keamanan berlapis, ketahanan TUI mobile.

---

## 📌 Ringkasan Konsolidasi Audit
Laporan ini menggabungkan dan menyaring hasil audit sebelumnya dari `AUDIT_SCORE.md` dan `CLI_AUDIT_REPORT.md`, ditambah hasil audit terarah terbaru (**Tugas 1: Sesi & Performa Tool** dan **Tugas 2: Install External Tools**).

> [!NOTE]
> Sesuai instruksi audit, **seluruh temuan dan bug yang telah berhasil diperbaiki telah dihapus dari daftar masalah aktif** di bawah ini (termasuk: perbaikan batas kaku `MAX_TOOL_ITERATIONS`, proteksi berkas `.ruko/trusted`, parser streaming multi-part Gemini, pembersihan dead import `ThoughtSlidingWindow`, optimasi log compact satu baris bebas karakter tree, I/O caching file read, loop interceptor, normalisasi urutan pesan OpenAI, serta implementasi fitur `/yolo`).

---

## 🏛️ 1. Ringkasan Status Arsitektur Saat Ini

### 1.1. Tool Runner & Execution Lifecycle
* **Orkestrator Utama Turn**: [`src/core/loop.ts:runTurn`](file:///workspaces/Ruko/src/core/loop.ts#L334)
  * Menangani siklus giliran interaktif: menerima input pengguna via TUI/ambient line editor ([`src/core/tui.ts`](file:///workspaces/Ruko/src/core/tui.ts)), menambahkan pesan ke [`Context`](file:///workspaces/Ruko/src/core/context.ts), dan mendelegasikan pemrosesan ke agen AI.
  * Mengaktifkan input ambient selama model berpikir, sehingga pengguna tetap bisa mengetik atau membatalkan turn via `Ctrl+C` tanpa memutus sesi CLI.
* **Turn & Tool Execution Loop**: [`src/agent/agent.ts:runWithLlm`](file:///workspaces/Ruko/src/agent/agent.ts#L254)
  * Mengatur iterasi LLM hingga batas dinamis (`config.maxToolIterations`, default 30).
  * Menjalankan deteksi loop repetitif (`consecutiveRepeatCount`), menekan I/O ganda pada panggilan identik berturut-turut, dan menginterupsi paksa jika panggilan melebihi batas repetisi.
  * Menjalankan tool call melalui [`runToolCall`](file:///workspaces/Ruko/src/agent/tools.ts#L1277) di [`src/agent/tools.ts`](file:///workspaces/Ruko/src/agent/tools.ts).
* **Eksekusi Perintah Shell**: [`src/core/approval.ts:guardedExecute`](file:///workspaces/Ruko/src/core/approval.ts#L544) & [`src/core/executor.ts:execute`](file:///workspaces/Ruko/src/core/executor.ts#L37)
  * Pertahanan dual-layer: Deterministic Regex + Guardian LLM semantik.
  * Eksekusi proses riil dilakukan oleh `executor.ts` via `node:child_process.spawn` dengan interleaved stdout/stderr streaming, timeout otomatis, dan pemangkas log.

### 1.2. Timer & Duration Tracking Saat Ini
* **Durasi Turn Aktif**: Dilacak di [`src/agent/agent.ts:175-192`](file:///workspaces/Ruko/src/agent/agent.ts#L175-L192) menggunakan `startTime = Date.now()`. Di blok `finally`, durasi turn dicatat ke `this.sessionUsage.lastTurnDurationMs` dan `this.lastUsage.durationMs`.
* **Durasi Akumulatif Sesi**: Diakumulasikan ke `this.sessionUsage.activeWorkingMs += elapsed` dan dilaporkan secara komprehensif melalui perintah `/usage` ([`src/agent/commands.ts:892-915`](file:///workspaces/Ruko/src/agent/commands.ts#L892-L915)) dengan rincian total waktu kerja dan rata-rata waktu per turn.
* **Helper Durasi**: [`formatDuration(ms)`](file:///workspaces/Ruko/src/core/ui.ts#L270) di `src/core/ui.ts` memformat milidetik menjadi representasi manusiawi (`120ms`, `2.1s`, `1m 5s`).

### 1.3. Command Registry
* **Pusat Registrasi**: Terpusat di array `COMMANDS` pada [`src/agent/commands.ts:56`](file:///workspaces/Ruko/src/agent/commands.ts#L56).
* **Fungsi Penyedia**:
  * `listCommands()`: Mengembalikan metadata seluruh command untuk generator `/help` dan status tampilan.
  * `matchCommands(prefix)`: Menyaring command secara live untuk autocompletion di baris input TUI.
  * `handleCommand(input, env)`: Dispatcher eksekusi slash command (`/login`, `/model`, `/yolo`, `/plan`, `/settings`, dll.).

---

## ⏱️ 2. Analisis Usulan Timer & Log Durasi Tool (TUGAS 1)

### 2.1. Temuan & Limitasi Saat Ini
1. **Tool Execution Logging Saat Ini**:
   * Di [`src/agent/tools.ts`](file:///workspaces/Ruko/src/agent/tools.ts), pemanggilan `deps.onLog?.(...)` dipanggil **sebelum** operasi I/O asinkron selesai (misal `Bash`, `Read`, `Search`, `Glob`).
   * Log yang masuk ke [`WorkflowTree`](file:///workspaces/Ruko/src/core/ui.ts#L1304) langsung dicetak ke stdout tanpa menyertakan informasi durasi eksekusi, sehingga pengguna di terminal tidak dapat melihat secara visual apakah tool berjalan cepat, lambat, atau sedang hang/stuck.
2. **Pelacakan Durasi Turn vs Sesi**:
   * Durasi turn dan total sesi sudah dicatat di objek `sessionUsage`, namun belum ditampilkan secara langsung di status bar turn akhir atau status live bar.

### 2.2. Rencana Desain & Langkah Implementasi
1. **Pengukuran Waktu per Tool Call**:
   * Di [`src/agent/agent.ts:runWithLlm`](file:///workspaces/Ruko/src/agent/agent.ts#L488), bungkus pemanggilan `runToolCall`:
     ```typescript
     const toolStart = Date.now();
     const result = await runToolCall(call, { ... });
     const toolElapsedMs = Date.now() - toolStart;
     ```
2. **Format Output Logger yang Diusulkan**:
   * Format compact log satu baris ([`src/core/ui.ts:formatCompactToolLog`](file:///workspaces/Ruko/src/core/ui.ts#L1277)) ditambahkan suffix durasi:
     * `[1] 📖 Read package.json · 18ms`
     * `[2] 🔎 Mencari src/ · 320ms`
     * `[3] 🟢 npm test · 4.8s`
     * `[4] ✏️ Edit src/agent/tools.ts · 45ms`
   * Menggunakan helper [`formatDuration(ms)`](file:///workspaces/Ruko/src/core/ui.ts#L270).
3. **Tampilan Durasi Turn di Akhir Giliran**:
   * Saat turn selesai, durasi turn aktif dapat disematkan ke dalam prompt divider atau ringkasan status bar:
     `⚡ [model] | ctx 24% · 4.2s | / perintah`
4. **Estimasi Dampak ke Test Suite**:
   * **Rendah**: Test suite yang memeriksa string log eksak (misal `compact_ui.test.ts`) hanya perlu menyesuaikan regex untuk menerima suffix waktu opsional:
     `assert.match(output, /\[\d+\]\s*📖\s*Read\s+package\.json(?:\s*·\s*[\d.]+[a-z]+)?/);`

---

## 🧩 3. Analisis Usulan Fitur "Install External Tools" (TUGAS 2)

### 3.1. Audit Kelayakan Arsitektur Saat Ini
* **Struktur Tool Saat Ini**:
  * Definisi OpenAI tools bersifat statis di `TOOL_DEFINITIONS` ([`src/agent/tools.ts:188`](file:///workspaces/Ruko/src/agent/tools.ts#L188)).
  * Dispatcher eksekusi menggunakan blok `switch (call.tool)` monolitik di `runToolCall()`.
* **Kelayakan Dynamic Registration**:
  * **Sangat Layak**: `TOOL_DEFINITIONS` dapat diubah menjadi instance `ToolRegistry` dinamis tanpa merusak sistem typing TypeScript.
  * Skema OpenAI function calling kompatibel murni dengan JSON Schema standar (`name`, `description`, `parameters: { type: "object", properties, required }`).

### 3.2. Analisis Risiko Keamanan & Isolasi (Security Sandbox)
* **Risiko Fatal (Critical RCE)**:
  * Mengunduh dan mengeksekusi kode JavaScript/TypeScript eksternal secara in-process (`import()`, `eval()`, `vm`) memberi akses penuh terhadap `process.env` (membocorkan `API_KEY`), filesystem sistem, dan socket jaringan.
* **Arsitektur Isolasi yang Direkomendasikan (Process-Boundary Isolation)**:
  1. **IPC / Subprocess Runner (Zero-Dependency)**:
     * Tool eksternal **TIDAK PERNAH** dimuat ke dalam runtime utama Node.js Ruko.
     * Tool eksternal dieksekusi sebagai child process terpisah (`node:child_process.spawn`) yang berkomunikasi melalui format **JSON-RPC over standard I/O (stdio)**, mengadopsi prinsip dasar MCP (Model Context Protocol).
  2. **Credential Sanitization**:
     * Variabel lingkungan sensitif (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, SSH agent) dihapus secara eksplisit dari `env` child process tool eksternal.
  3. **Permission Gate Saat Instalasi**:
     * Setiap tool eksternal yang diinstal (misal via `/tools install <path|repo>`) diverifikasi manifestnya dan membutuhkan persetujuan eksplisit dari pengguna.

### 3.3. Kompatibilitas "Zero Third-Party Dependencies"
* **Manifest Deklarasi Tool**: Format JSON murni (`tool.json` atau `plugin.json`):
  ```json
  {
    "name": "git_blame",
    "description": "Melihat git blame pada baris tertentu",
    "command": "git",
    "args": ["blame", "-L", "{{start}},{{end}}", "{{file}}"],
    "parameters": {
      "type": "object",
      "properties": {
        "file": { "type": "string" },
        "start": { "type": "number" },
        "end": { "type": "number" }
      },
      "required": ["file"]
    }
  }
  ```
* Parsing dilakukan 100% menggunakan `JSON.parse()` bawaan Node.js tanpa pustaka pihak ketiga.
* Eksekusi tool berbasis script JS menggunakan binary `node` lokal pengguna, atau CLI binary bawaan OS (`git`, `docker`, `curl`).

---

## 🔍 4. Sisa Temuan Audit yang Belum Teratasi (Active Open Issues)

Berikut adalah ringkasan temuan audit dari `AUDIT_SCORE.md` dan `CLI_AUDIT_REPORT.md` yang **masih terbuka (belum diperbaiki)** dan perlu diagendakan:

| No | Modul | Deskripsi Masalah | Tingkat Dampak |
| :---: | :--- | :--- | :---: |
| **1** | `src/core/approval.ts` & `ui.ts` | **Line-wrap Pertanyaan Approval di Layar Ultra-Sempit (<36 Kolom)**<br>String `"Apakah kamu mengizinkan perintah ini? (y/n): "` (44 karakter) membungkus ke baris baru pada terminal potret Termux Android (<36 cols), sedikit menggeser bingkai kotak box approval. | Minor (UX) |
| **2** | `src/core/wizard.ts` & `src/index.ts` | **Setup Wizard Multi-Provider Probe**<br>Pengujian koneksi awal saat setup wizard (`promptSetup`) melakukan probe HTTP POST khusus ke skema OpenAI (`/chat/completions`). Pengguna kunci Anthropic atau Gemini gagal melewati live probe verifikasi awal. | Sedang |
| **3** | `README.md` | **Sinkronisasi Dokumentasi & Badge Test**<br>`README.md` baris 379 menyebutkan tool `web_search` padahal yang tersedia adalah `web_fetch`. Badge test di `README.md` masih tertulis 493, sementara test lulus saat ini telah mencapai **529 tests**. | Minor (Dokumentasi) |
| **4** | `src/core/context.ts` & `src/core/loop.ts` | **Preservasi Intermediate Tool Messages di Context untuk Export**<br>`Context` saat ini hanya menyimpan riwayat percakapan `user` dan respon akhir `assistant`. Pemanggilan tool intermediate dan hasil tool tidak dipersistensikan ke `Context`, sehingga perintah `/export` belum mencakup jejak tool call lengkap. | Sedang (Fitur) |
| **5** | `src/agent/tools.ts` | **Feedback Jelas pada Malformed Tool Call JSON**<br>Jika model menghasilkan blok tool dengan JSON tidak valid (misal trailing commas atau invalid quotes), blok `catch` menelan error secara diam-diam tanpa mengembalikan feedback koreksi ke model. | Sedang |
| **6** | `src/agent/tools.ts`, `commands.ts`, `ui.ts` | **Modularisasi God-Files**<br>`src/agent/tools.ts` (>2.100 baris), `src/agent/commands.ts` (>1.500 baris), dan `src/core/ui.ts` (>1.390 baris) masih monolitik dan perlu dipecah secara bertahap menjadi sub-modul terpisah. | Rendah (Maintenance) |
| **7** | `src/tests/` | **Unit Test Khusus untuk CLI Arg Parser & REPL Loop**<br>`parseCliArgs()` di `src/index.ts` dan siklus interaktif di `src/core/loop.ts` belum memiliki file test mandiri khusus (meski fungsionalitasnya telah teruji via integrasi). | Rendah (Coverage) |

---

## 📋 5. Rekomendasi Prioritas & Action Plan

### Tahap 1: Polish & Quick Wins (Prioritas Tinggi)
1. **Sinkronisasi Dokumentasi `README.md`**:
   * Perbarui badge test menjadi `529 passed`.
   * Klarifikasi deskripsi `web_fetch` (hapus klaim phantom `web_search`).
2. **Koreksi Prompt Approval Terminal Sempit**:
   * Format prompt pertanyaan approval agar ringkas pada layar sempit: `Izinkan? (y/n): ` (16 karakter).
3. **Feedback Malformed JSON Tool Call**:
   * Kembalikan pesan `role: 'tool'` atau hint perbaikan format JSON ke model ketika `JSON.parse` tool call gagal.

### Tahap 2: Peningkatan Observabilitas Sesi (Prioritas Sedang)
1. **Implementasi Tool Execution Timing**:
   * Tambahkan pelacakan durasi eksekusi per tool di `agent.ts`.
   * Tampilkan durasi aksi di `formatCompactToolLog` (`🔎 Search · 150ms`).
2. **Setup Wizard Multi-Provider**:
   * Tambahkan selector jenis provider saat wizard berjalan, dan arahkan probe koneksi ke provider yang sesuai (Anthropic, Gemini, OpenAI).

### Tahap 3: Arsitektur Eksternal Tools & Refactoring (Prioritas Jangka Panjang)
1. **Refactoring ke Dynamic `ToolRegistry`**:
   * Abstraksikan tool statis menjadi modular registry class.
2. **Implementasi External Tool Runner**:
   * Buat loader manifest JSON dan subprocess runner terisolasi berbasis stdin/stdout JSON-RPC.
3. **Preservasi Trajectory Tool di `Context`**:
   * Izinkan intermediate tool calls disimpan di riwayat context untuk keperluan `/export` sesi lengkap.
