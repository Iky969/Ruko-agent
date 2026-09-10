# Ruko — AI Coding Agent CLI

Ruko adalah CLI agent untuk pekerjaan coding berbasis **Node.js / TypeScript** (zero runtime dependency). Ia menjalankan *system loop* interaktif yang menerima instruksi, memotong log terminal yang panjang agar tidak memenuhi konteks, dan mengeksekusi perintah shell dengan pengamanan persetujuan (approval gate).

Mulai cepat: `npm install && npm run build && npm start` — sisanya ada di bagian *Cara Kerja*.

---

## Fitur

### System Loop
REPL interaktif (`ruko> `) yang menerima instruksi dari user secara serial: setiap baris diproses tuntas (termasuk eksekusi shell atau round-trip LLM) sebelum baris berikutnya. Mendukung slash commands dan input bebas.

### Log Summarizer
Output perintah yang panjang otomatis dipotong saat melebihi ambang (default **1000 karakter**):

- Kepala (head) ~40% + ekor (tail) ~60%, dibulatkan ke batas baris agar tidak ada baris terpotong di tengah.
- Marker `[... TRUNCATED ...]` berisi jumlah karakter/baris yang dibuang.
- Baris-baris penting (error, warning, exception, exit code, build result) dikumpulkan sebagai *Highlights*.

### Eksekusi Shell Bawaan
Menjalankan perintah apa pun lewat shell dengan timeout default 30 detik, capture stdout/stderr, exit code, dan durasi. Semua output lewat Log Summarizer secara default.

### Tool `read_file`
Agen bisa membaca berkas teks langsung (tanpa `cat`/`head`), dengan hasil bernomor baris dan berhalaman:

```tool
{"tool": "read_file", "path": "src/index.ts", "offset": 1, "limit": 200}
```

- Default 200 baris per panggilan, hard cap 2.000 baris — satu bacaan tidak bisa membanjiri konteks.
- Header hasil melaporkan total baris + rentang yang ditampilkan; ada `nextOffset` saat file terpotong sehingga agen tinggal melanjutkan dengan `offset`.
- Aman: menolak direktori, file non-reguler, dan konten biner (deteksi NUL/control-char); baris super panjang dipotong ke 2.000 char.

### Approval Gate
Perintah berisiko diklasifikasikan sebelum dijalankan:

| Level | Contoh | Tindakan |
| --- | --- | --- |
| `dangerous` | `rm -rf`, `sudo`, `git push`, `git reset --hard`, `curl \| sh`, `kill -9` | Minta konfirmasi `y/N` ke user |
| `blocked` | `rm -rf /`, `mkfs`, `dd of=/dev/...`, fork bomb | Selalu ditolak, tidak bisa di-bypass |

Bypass sah: `--yes` (untuk `--exec`), `RUKO_YOLO_MODE=1`, atau allowlist di config. Tanpa terminal interaktif (non-TTY), perintah `dangerous` otomatis ditolak demi keamanan.

### Context Compression
Saat konteks melebihi budget (default 30.000 karakter), turn-turn tertua **dikompres** menjadi satu pesan ringkas (`[compressed history ...]`) — bukan dibuang mentah. N turn terakhir selalu dilindungi utuh. Jika budget belum tercapai, ukuran ekscerpt diperkecil bertahap (200 → 100 → 50 → 25 → 12 karakter) sampai muat.

### Session Persistence
Setiap percakapan tersimpan otomatis ke `.ruko/sessions/<id>.json` (setelah tiap instruksi dan saat keluar). Sesi bisa dilanjutkan kapan pun: `/sessions` untuk daftar, `/resume <id>` untuk melanjutkan, `/new` untuk memulai baru.

### Konfigurasi Berkas
Pengaturan tersimpan di `.ruko/config.json` (atau path dari env `RUKO_CONFIG`): budget konteks, ambang summarizer, timeout eksekusi, approval (aktif/allowlist), dan model LLM default. Lihat/ubah lewat `/config` (mis. `/config set maxLogChars 2500`).

### Dua Mode Agen
- **Manual mode** — tanpa API key: prefix `run <cmd>` langsung dieksekusi; input lain dicatat sebagai konteks.
- **LLM mode** — dengan `OPENAI_API_KEY` (backend OpenAI-compatible, bisa diarahkan ke Ollama/LM Studio lewat `OPENAI_BASE_URL`): instruksi dikirim ke model beserta riwayat konteks, agen menjalankan *tool loop* sampai jawaban final. Model bisa diganti runtime dengan `/model <nama>`.

### Slash Commands
`/help`, `/exit` `/quit`, `/new` `/reset`, `/resume <id>`, `/sessions`, `/clear`, `/exec <cmd>`, `/history [n]`, `/context`, `/config [set k v]`, `/model [nama]`.

---

## Cara Kerja

### 1. Alur input

```
User input
   │
   ▼
SystemLoop (src/core/loop.ts)            ← REPL readline, diproses serial
   │
   ├─ slash command?  →  commands.ts      ← /exec, /model, /sessions, ...
   │
   └─ instruksi biasa →  Context.add() → Agent
                            │
   Agent (src/agent/agent.ts)            ← manual mode ATAU LLM tool loop
                            │
   ▼
Executor (src/core/executor.ts)          ← child_process (timeout, maxBuffer)
   │
   ▼
Log Summarizer (src/core/summarizer.ts)  ← potong output > ambang
   │
   ▼
Hasil → balas user → Context.compress() (jika over budget)
      → saveSession() ke .ruko/sessions/ → prompt berikutnya
```

### 2. Approval flow

```
Perintah mau dieksekusi
   │
   ▼
detectRisk(command, config)   ← regex dangerous/blocked + allowlist + yolo
   │
   ├─ none      → eksekusi langsung
   ├─ dangerous → prompt user y/N (non-TTY = otomatis tolak)
   │               ├─ ya  → eksekusi
   │               └─ tidak → hasil sintetis [Persetujuan ditolak: <alasan>]
   └─ blocked   → selalu tolak [BLOCKED oleh Ruko: <alasan>]
```

### 3. LLM tool loop (mode LLM)

1. Instruksi + riwayat konteks dikirim ke model (system prompt berisi aturan penggunaan tool).
2. Jika ingin memakai tool, model membalas blok (default: `exec` dan `read_file`):

   ````text
   ```tool
   {"tool": "exec", "command": "ls -la", "cwd": null, "timeoutMs": 30000}
   ```
   ````

   ````text
   ```tool
   {"tool": "read_file", "path": "src/index.ts", "offset": 1, "limit": 200}
   ```
   ````

3. Blok dieksekusi (`exec` lewat approval gate + summarizer; `read_file` lewat pembacaan berhalaman di `src/agent/filetools.ts`), hasilnya dikirim balik sebagai pesan `tool`.
4. Diulang sampai model menjawab tanpa blok tool (maksimal 6 iterasi per instruksi).

### 4. Compression flow

```
Konteks > budget (default 30.000 char)?
   │
   ▼
Lindungi N turn terakhir (default 6, utuh)
   │
   ▼
Fold turn tertua → ekscerpt satu baris [role] teks
   │
   ▼
Hitung proyeksi: digest + sisa verbatim + tail ≤ budget?
   ├─ ya  → stop fold, sisipkan pesan [compressed history ...]
   └─ tidak → perkecil ekscerpt (200→100→50→25→12) lalu ulangi
        └─ tetap tidak muat / tidak ada penghematan → serah (history dibiarkan)
```

### 5. Persistensi

- **Sesi**: JSON di `.ruko/sessions/` — `{id, title (dari pesan user pertama), createdAt, updatedAt, messages[]}`. Auto-save setelah tiap instruksi & saat `/exit`.
- **Config**: `.ruko/config.json` dimuat saat start; `/model` dan `/config set` menulis ulang berkasnya.

### 6. Modul & tanggung jawab

| Modul | Peran |
| --- | --- |
| `src/core/loop.ts` | System loop, confirmer approval, auto-save, kompresi |
| `src/core/executor.ts` | Eksekusi shell (`child_process`) |
| `src/core/summarizer.ts` | Log Summarizer (>1000 char) |
| `src/core/approval.ts` | Deteksi risiko + guarded execute |
| `src/core/compressor.ts` | Kompresi history (adaptif) |
| `src/core/context.ts` | Memori percakapan (window, compress) |
| `src/core/session.ts` | Simpan/list/load sesi |
| `src/core/config.ts` | Load/save `.ruko/config.json` |
| `src/agent/agent.ts` | Orkestrasi manual/LLM |
| `src/agent/llm.ts` | Provider OpenAI-compatible (+ setModel) |
| `src/agent/tools.ts` | Protocol tool-call (`exec`, `read_file`) |
| `src/agent/filetools.ts` | Tool `read_file` (bernomor, berhalaman, deteksi biner) |
| `src/agent/commands.ts` | Slash commands |
| `src/index.ts` | Entry point (--exec, --summarize, --help, --version) |
| `src/tests/` | Unit test (`node:test`, 35 test) |

---

Status pengerjaan, daftar tugas, ide selanjutnya, dan catatan handoff untuk AI berikutnya ada di **`PROGRESS.md`**.