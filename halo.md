[x]1. 🔴 Paling kritis — Windows tsc.cmd spoofing (BELUM diimplementasi)
Ini yang paling berbahaya: resolveTscBinary() masih manggil node_modules/.bin/tsc.cmd di Windows. Kalau ada repo jahat nyisipin tsc.cmd palsu, itu bisa tereksekusi langsung pas Ruko verifikasi compiler di Plan Mode. Solusinya udah jelas: panggil tsc.js langsung lewat process.execPath, skip wrapper shell sepenuhnya.
[x]2. 🔴 FileLock split-brain (BELUM diimplementasi)
Pola fs.mkdir + auto-eviction berbasis mtime masih rentan race condition kalau dua proses bareng-bareng nganggep lock "stale". Solusinya butuh migrasi ke fs.openSync('wx') + cek PID hidup, bukan auto-evict buta.
[x]3. 🟡 State corruption ditangani diam-diam (BELUM diimplementasi)
Kalau state file korup (disk penuh, crash), sekarang sistem diam-diam bikin state baru alih-alih kasih tau user ada desinkronisasi. Perlu CorruptedStateError yang eksplisit halt, bukan silent replace.
[]4. 🟡 Nggak ada circuit-breaker anti-DoS (BELUM diimplementasi)
Nggak ada batas berapa kali AI boleh minta akses yang sama berulang — resiko "approval fatigue" dari prompt injection yang terus nagih sampai user nggak sadar approve.
[]5. ⚪ TC-SCM-03 — soal penempatan & commit
Udah fixed, tapi perlu kamu putusin: masuk Fase 2 atau didorong ke Fase 3? Terus commit-nya perlu dirapihin.
[]6. ⚪ 9 test ID tercatat di QA.md tapi belum ada file testnya sama sekali (TC-NET-04/05, TC-GOV-03/04, TC-STA-01/02, TC-SCM-04/05, TC-FSM-01)
