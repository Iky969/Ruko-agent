Tambahkan dukungan cancel (ESC) saat step/tool call sedang berjalan (in-flight),
bukan cuma saat idle menunggu input. Saat ini ESC tidak merespons ketika ada
operasi aktif (misal streaming respons LLM atau eksekusi tool berjalan).

Spesifikasi:
- ESC saat step berjalan: kirim abort signal (AbortController) ke request LLM
  yang sedang streaming DAN ke tool call yang sedang dieksekusi (exec, start_process,
  web_fetch, dll yang punya durasi).
- Untuk proses yang sudah didaftarkan via start_process, ESC tidak boleh mematikan
  proses background-nya (server dev tetap harus jalan) — cukup batalkan giliran
  agent yang sedang menunggu/menganalisis, bukan proses child yang sudah di-spawn.
- Tampilkan feedback jelas ke user saat cancel berhasil, mis: "Dibatalkan oleh
  pengguna" — bukan diam-diam berhenti tanpa pesan.
- Tambahkan unit test: ESC saat streaming LLM aktif → aborted, ESC saat tool
  exec durasi lama aktif → aborted, ESC saat start_process baru saja dipanggil
  → proses child TETAP hidup, hanya giliran agent yang dibatalkan.
