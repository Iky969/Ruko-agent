# Temuan Investigasi Kode Sumber (Out-of-Scope Investigation)

Dokumen ini mencatat daftar temuan teknis yang teridentifikasi selama investigasi kode sumber Ruko CLI Agent (terkait perbaikan Item 1 & 2 pada `feedback.txt`), namun **TIDAK dieksekusi** pada iterasi ini demi mematuhi klausul integritas: *"DILARANG mengubah kode di luar 2 item ini — kalau nemu hal lain, laporkan terpisah, jangan dieksekusi tanpa izin"*.

---

### 1. Penanganan Tag `<tool>` Self-Closing pada `XML_TOOL_SIMPLE_RE`
* **Lokasi Berkas:** [`src/agent/tools.ts:195-218`](file:///workspaces/Ruko/src/agent/tools.ts#L195-L218)
* **Deskripsi:**
  Parser generic XML `<tool(?:[^>]*)>\s*([\s\S]*?)\s*(?:<\/tool>|$)/gi` mengasumsikan bahwa konten di dalam tag selalu berupa JSON string di `match[1]`. Ketika model menghasilkan tag berformat *self-closing* dengan atribut seperti:
  ```xml
  <tool name="read_file" path="package.json" />
  ```
  maka `match[1]` menghasilkan string kosong `""`.
* **Akar Masalah:**
  Blok `JSON.parse(match[1].trim())` melempar *SyntaxError: Unexpected end of JSON input*, yang kemudian ditangkap oleh blok `catch` dan mengeksekusi `malformedBlocks.push(match[1].trim())`. Hal ini menyebabkan string kosong `""` masuk ke dalam array `malformedBlocks` alih-alih seluruh representasi tag mentah `match[0].trim()`.
* **Potensi Dampak:**
  Array `malformedBlocks` dapat berisi elemen string kosong, dan pesan format error yang dikembalikan ke model tidak dapat menyertakan cuplikan tag mentah yang keliru.
* **Rekomendasi Perbaikan:**
  Pada blok `catch`, gunakan fallback `malformedBlocks.push(match[1].trim() || match[0].trim())`.

---

### 2. Duplikasi Konsep dan Fragmentasi Perintah `/context` vs `/ctx`
* **Lokasi Berkas:** [`src/agent/commands.ts:471`](file:///workspaces/Ruko/src/agent/commands.ts#L471) & [`src/agent/commands.ts:798`](file:///workspaces/Ruko/src/agent/commands.ts#L798)
* **Deskripsi:**
  Terdapat dua perintah terpisah yang mengelola konsep context budget:
  - `/context`: Menampilkan statistik sederhana atau mengubah limit via `/context set <jumlah>`.
  - `/ctx` (dengan alias `/budget` dan `/status`): Menampilkan dashboard panel responsif lengkap berisi limit aktif, token budget, max output tokens, dan persentase penggunaan saat ini.
* **Akar Masalah:**
  Perintah `/context` adalah implementasi lama (*legacy*), sedangkan perintah `/ctx` ditambahkan untuk memenuhi kebutuhan visualisasi budget ringkas dan responsif.
* **Potensi Dampak:**
  Pengguna dapat mengalami ambiguitas antara `/context` dan `/ctx`. Selain itu, `/context set` dan `/setctx` merupakan cara berbeda untuk tujuan yang sama.
* **Rekomendasi Perbaikan:**
  Konsolidasikan perintah ini pada rilis berikutnya: jadikan `/context` sebagai alias resmi dari `/ctx`, dan arahkan sub-perintah `set` ke fungsi setter yang terpadu dengan `/setctx`.

---

### 3. Prioritas Resolusi Kolom Terminal pada `terminalWidth()`
* **Lokasi Berkas:** [`src/core/ui.ts:120-125`](file:///workspaces/Ruko/src/core/ui.ts#L120-L125)
* **Deskripsi:**
  Fungsi pembantu `terminalWidth()` membaca lebar kolom terminal dengan urutan:
  ```ts
  const envCols = process.env.COLUMNS ? parseInt(process.env.COLUMNS, 10) : NaN;
  const cols = process.stdout.columns ?? (Number.isFinite(envCols) && envCols > 0 ? envCols : undefined) ?? 80;
  return Math.max(20, cols);
  ```
* **Akar Masalah:**
  Operator nullish coalescing (`??`) memprioritaskan `process.stdout.columns` sebelum `process.env.COLUMNS`. Jika Ruko dijalankan di terminal nyata (TTY), `process.stdout.columns` hampir selalu terdefinisi (misal 80 atau 120).
* **Potensi Dampak:**
  Saat pengembang atau test suite ingin mensimulasikan layar sempit Termux (misal `COLUMNS=40 npm start`), variabel lingkungan `COLUMNS` diabaikan karena `process.stdout.columns` sudah ada nilainya.
* **Rekomendasi Perbaikan:**
  Prioritaskan `envCols` jika eksplisit ditentukan oleh pengguna/skrip pengujian:
  ```ts
  const cols = (Number.isFinite(envCols) && envCols > 0 ? envCols : undefined) ?? process.stdout.columns ?? 80;
  ```

---

### 4. Sintesis Tool Result pada Invariant Pesan OpenAI-Compatible
* **Lokasi Berkas:** [`src/agent/llm.ts:203-211`](file:///workspaces/Ruko/src/agent/llm.ts#L203-L211)
* **Deskripsi:**
  Fungsi `validateOpenAiMessages` memastikan bahwa setiap `tool_call_id` dari pesan asisten memiliki pesan `role: 'tool'` pasangannya. Jika ada ID yang terlewat, fungsi ini membuat pesan sintetis pengganti:
  ```ts
  result.push({
    role: 'tool',
    tool_call_id: id,
    content: `[Hasil tool "${tc.function?.name ?? id}" tidak ditemukan atau terlewat]`,
    name: tc.function?.name,
  });
  ```
* **Akar Masalah:**
  Fungsi ini hanya memvalidasi ada/tidaknya pasangan ID, tetapi belum memeriksa integritas isi pesan role `tool` yang sudah ada (misalnya apakah isinya terpotong di tengah kalimat akibat pemutusan koneksi SSE sebelum completion selesai).
* **Potensi Dampak:**
  Jika pesan `tool` yang ada di riwayat terputus secara tidak wajar (*truncated payload*), model completions pada giliran berikutnya dapat mengalami kebingungan sintaks atau menghasilkan token bleed.
* **Rekomendasi Perbaikan:**
  Tambahkan sanitasi integritas payload dasar pada pesan role `tool` sebelum dikirimkan ke endpoint completions.
