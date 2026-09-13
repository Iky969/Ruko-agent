ROLE: Kamu adalah senior Node.js engineer yang mengerjakan Ruko-agent v1.3.0 →
v1.4.0. WAJIB baca PROGRESS.md dan README.md dulu untuk memahami konvensi
arsitektur yang sudah ada (pola tool registry di tools.ts, approval gate,
PLAN_MODE_BLOCKED, session storage di .ruko/sessions/) sebelum menulis kode.
Implementasi baru HARUS konsisten dengan pola yang sudah established.

TUGAS A — Pencarian Lintas Sesi (search_sessions):
Saat ini sesi lama hanya bisa diakses lewat /resume <id> yang butuh tahu ID
persis. User tidak punya cara mencari "sesi kapan aku pernah bahas X" tanpa
buka satu-satu. Ini menyebabkan efek "amnesia" tiap kali user lupa ID sesi
atau pindah proyek/direktori.

1. Tool search_sessions(query, limit?)
   - Baca semua file JSON di .ruko/sessions/, cari kecocokan teks sederhana
     (case-insensitive substring match, BUKAN full-text search engine/index
     kompleks — cukup baca isi pesan tiap sesi dan cocokkan query).
   - Kembalikan: session_id, timestamp, jumlah pesan, DAN snippet singkat
     (maks ~150 karakter) dari pesan yang match, supaya user bisa langsung
     tahu konteksnya tanpa perlu /resume dulu.
   - Default limit 5 hasil, urutkan dari paling baru.
   - Boleh dipanggil di semua mode (plan, reviewer, default) — read-only,
     tidak destruktif.
   - Performa: jangan load semua sesi ke memori sekaligus kalau jumlahnya
     besar — baca per file, evaluasi match, buang dari memori kalau tidak
     cocok (streaming/incremental, bukan load-all-then-filter).

2. Slash command /search <query>
   - Wrapper CLI ke tool search_sessions, tampilkan hasil dengan format rapi
     (mirip /sessions yang sudah ada) plus opsi langsung /resume dari hasil.

TUGAS B — Skills System (save_skill sudah ada, lengkapi siklus penuh):
save_skill dan load_skill sudah ada dari versi sebelumnya, tapi belum ada
mekanisme jelas KAPAN agent harus menyimpan skill baru.

1. Tool save_skill(name, description, content) — VERIFIKASI dulu apakah ini
   sudah ada dari implementasi sebelumnya (list_skills sudah baca direktori
   yang sama). Kalau sudah ada, JANGAN tulis ulang — cukup sambungkan ke
   poin 2 di bawah.

2. Update system prompt / TOOL_RULES di roles.ts:
   - Arahkan agent untuk menyimpan skill BARU HANYA ketika: (a) user secara
     eksplisit memberi instruksi berulang yang kompleks (bukan tugas
     sekali pakai), ATAU (b) user secara langsung minta "simpan ini sebagai
     skill". JANGAN membuat agent menyimpan skill secara otomatis/diam-diam
     dari setiap interaksi — itu berisiko membanjiri .ruko/skills/ dengan
     skill sampah yang tidak berguna.
   - Skill yang disimpan harus berisi langkah/pola yang GENERALIZABLE (bisa
     dipakai lagi di konteks berbeda), bukan detail spesifik satu tugas.

3. Tool delete_skill(name) — untuk membersihkan skill yang sudah tidak
   relevan. WAJIB approval gate [Y/N] sama seperti delete_file (konsisten
   dengan pola destruktif yang sudah ada), TIDAK perlu snapshot undo
   terpisah (skill files kecil, cukup tampilkan isi skill sebelum konfirmasi
   hapus supaya user tahu apa yang akan hilang).

KRITERIA VERIFIKASI:
- npm run typecheck lulus tanpa error.
- npm test 100% hijau TERMASUK seluruh test yang sudah ada sebelumnya
  (335 test saat ini) — tidak boleh ada regresi.
- Tambahkan unit test: search_sessions (match ditemukan, tidak ditemukan,
  limit dihormati, sesi kosong tidak crash), delete_skill (approval gate,
  penolakan konfirmasi, skill tidak ada/error jelas).
- Laporkan angka npm test PERSIS dari output command asli.

ATURAN WAJIB — Dokumentasi Incremental:
Update PROGRESS.md setelah masing-masing Tugas A dan Tugas B selesai
(jangan tunggu keduanya baru update sekali). Update README.md dengan
tool dan slash command baru, ikuti format tabel yang sudah ada.

TUGAS C — Konsolidasi PROGRESS.md (kerjakan PALING TERAKHIR, setelah A & B):
PROGRESS.md sudah menumpuk banyak detail dari beberapa rilis beruntun
(v1.1.0 - v1.4.0) dan mulai panjang/sulit dibaca ulang sebagai referensi
cepat. Restrukturisasi TANPA menghapus informasi penting:

1. Buat struktur baru dengan format changelog per versi:
   ## v1.4.0 (tanggal) - <ringkasan 1 baris>
   ### Ditambahkan
   - <poin ringkas>
   ### Detail Arsitektural
   - <keputusan desain penting yang perlu diingat, misal alasan asimetri
     approval gate start_process vs stop_process>

2. Versi lama (v1.0.0 - v1.3.0) DIRINGKAS jadi poin-poin singkat per rilis
   (bukan dihapus total) — cukup 3-5 baris per versi mencakup fitur utama
   dan keputusan keamanan penting, BUKAN detail implementasi baris-per-baris
   seperti yang ada sekarang.

3. PERTAHANKAN penuh: bagian "Known Bugs/Issues" (kalau masih ada item
   aktif), dan bagian Roadmap (update status item yang baru selesai:
   search_sessions dan skills system pindah dari "belum dikerjakan" ke
   "selesai").

4. JANGAN hapus riwayat kontribusi di CONTRIBUTORS.md — itu file terpisah,
   tidak perlu disentuh di tugas konsolidasi ini.

Setelah konsolidasi, PROGRESS.md harus tetap bisa berfungsi sebagai
"checkpoint" yang bisa dibaca cepat oleh sesi/akun AI baru untuk tahu
status proyek saat ini, tanpa harus scroll ratusan baris detail historis.
