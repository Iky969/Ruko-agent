# Ruko Agent — Laporan Bug, Evaluasi UX & Usulan Approval Config

**Revisi v2** — menggabungkan verifikasi independen terhadap kode di `main` (Kimi, 2026-10-10).

| Field | Nilai |
|--------|--------|
| **Proyek** | [Iky969/Ruko-agent](https://github.com/Iky969/Ruko-agent) |
| **Branch / tip** | `main` @ ~`7b214369` |
| **Versi package** | `2.1.0` |
| **Installer pin** | `install.sh` → `TAG=v2.1.0` |
| **Tanggal v1** | 2026-10-10 |
| **Tanggal v2 (revisi)** | 2026-10-10 |
| **Status** | Laporan operasional — klaim diverifikasi terhadap source |

### Riwayat revisi

| Ver | Perubahan |
|-----|-----------|
| v1 | Evaluasi awal: BUG-01…06, UX-07, usulan `/config` + `[a/y/n]` |
| **v2** | Koreksi faktual BUG-03/04; **NEW-01…06**; P0 diperkeras (dead-end universal, bukan hanya resume); checklist PR diperbarui |

---

## 1. Ringkasan eksekutif

Hardening keamanan (WP-01…WP-05, trust boundary, shell gate, plan/act host state) **kuat dan CI hijau**. Pengalaman pakai agent sehari-hari tetap **rusak di jalur ACT**:

1. **Tidak ada satu pun jalur di main flow yang pernah membuat `approvalScope`.** Setiap masuk mode ACT dengan scope `null` → semua mutasi file ditolak (`SECURITY_DENIED`) **tanpa** micro-prompt pemulihan. Ini berlaku untuk sesi baru, auto-off rencana bernomor, `/plan off`, dan resume — **bukan** edge case resume saja.
2. Model sering **salah diagnosis** (role READ-ONLY / `/mode agent`).
3. Approval **biner**: YOLO terlalu longgar dan **bisa persist lintas sesi**; mode biasa banjir Y/N; belum ada “always for this pattern”.
4. Scope / profil approval **tidak** terlihat di status UI; beberapa pesan error digabung menjadi satu string generik.

**Kesimpulan:** keamanan menang; **bootstrap scope + frekuensi approval** kalah. Perbaikan P0 tidak melemahkan fail-closed — justru membuat fail-closed bisa dipulihkan lewat kontrak path yang sah.

---

## 2. Konteks arsitektur

### 2.1 Tiga gate mutasi (urut)

```
Tool call (write_file / edit_file / exec / …)
        │
        ▼
┌───────────────────────────┐
│ 1. Plan Mode              │  hostState.mode === 'plan'
│    (dispatcherGate)       │  → tolak mekanis; YOLO tidak bypass
└───────────┬───────────────┘
            │ act
            ▼
┌───────────────────────────┐
│ 2. ScopeAmendment         │  approvalScope + allowedPaths
│    evaluateMutationTarget │  → false jika null / luar scope / …
└───────────┬───────────────┘
            │ allowed
            ▼
┌───────────────────────────┐
│ 3. Path / shell sandbox   │  sensitive path, safeExecPrecheck, …
└───────────────────────────┘
```

File kunci: `dispatcherGate.ts`, `scopeAmendment.ts`, `hostState.ts`, `tools.ts`, `commands.ts`, `agent.ts`, `loop.ts`.

### 2.2 Konsep yang sering tertukar

| Konsep | Perintah | Mengontrol |
|--------|----------|------------|
| **Plan / Act** | `/plan on\|off` | Boleh tool mutasi/subprocess |
| **AgentMode** | `/mode` | `default \| research \| code \| build` saja |
| **Role** | `/role` | Prompt (`default`, `reviewer`, …) — **bukan** gate dispatcher |
| **UiMode** | settings | `beginner \| pro` |
| **Approval** | Y/N, `/yolo`, allowlist | Konfirmasi eksekusi |
| **Scope** | `approvalScope` | Path mana yang boleh dimutasi |

### 2.3 Invarian host state

- Resume: `act` → selalu `plan` + `approvalScope = null`.
- Sesi baru: `mode: 'plan'`, scope kosong.
- `/plan on`: `approvalScope = null`.
- **v2 (NEW-01):** Tidak ditemukan kode di pipeline utama (`bootstrapSecurityPipeline`, `plan.ts` auto-off, `/plan off`) yang **mengisi** `approvalScope`. Kontrak path praktis tidak pernah lahir di happy path.

---

## 3. Status verifikasi temuan

### 3.1 Temuan v1 — status setelah cek kode

| ID | Status v2 | Keterangan |
|----|-----------|------------|
| **BUG-01** | ✅ **Terkonfirmasi + diperkeras** | `if (!this.state.approvalScope) return false` di awal `evaluateMutationTarget`, sebelum prompt. Reset resume & `/plan on` sesuai laporan. **NEW-01:** tidak ada jalur yang *membuat* scope → dead-end **universal** ke ACT. |
| **BUG-02** | ✅ Terkonfirmasi | Mode valid hanya `default\|research\|code\|build`. Role tidak dicek dispatcher. |
| **BUG-03** | ⚠️ **Dikoreksi sebagian** | `planMode` (dan `yoloMode`) **sudah di-pass** ke status bar dari `loop.ts`. Yang **pasti belum ada**: ringkasan scope & profil approval. Klaim “PLAN tidak pernah tampil” diturunkan sampai render `ui.ts` diverifikasi di terminal; klaim “scope tidak terlihat” **tetap valid**. |
| **BUG-04** | ⚠️ **Dikoreksi** | `ruko --version` / `-v` **sudah ada** (`index.ts`, cetak `ruko v2.1.0`). Yang belum: **`--update`**. `install.sh` pin `v2.1.0` + tolak branch mutable tanpa `RUKO_ALLOW_MUTABLE=1` — terkonfirmasi. |
| **BUG-05** | ✅ Terkonfirmasi | Setter `planMode`: `catch (() => {})`. **+2 cabang** pola sama (auto-off plan di `agent.ts` & `loop.ts`). |
| **BUG-06** | ✅ Terkonfirmasi | `safeExecPrecheck` = analisis regex statis; inline interpreter / nested quotes di luar jangkauan. |
| **UX-07** | ✅ Terkonfirmasi | Confirmer biner `[Y/N]`. `approvalAllowlist` ada di config / tampilan `/config`; integrasi penuh ke `guardedExecute` perlu dicek lanjut di `approval.ts` saat implementasi PR-C. |

### 3.2 Temuan baru (NEW) — dari verifikasi kode

| ID | Prioritas | Temuan |
|----|-----------|--------|
| **NEW-01** | **P0/P1** (memperkuat BUG-01) | **Tidak ada jalur yang membuat `approvalScope`.** Bootstrap pipeline, auto-off rencana bernomor, dan `/plan off` hanya set `mode='act'` tanpa seed scope. Happy path (pilih “1” dari rencana) ikut dead-end. |
| **NEW-02** | **P1** | **`/yolo on` persist** ke config via `updateConfig` → `saveConfig()`. Restart tetap YOLO. Cabang OFF tidak simetris (hapus env var yang tidak di-set ON). User frustrasi Y/N bisa membuka YOLO permanen tanpa sadar. |
| **NEW-03** | **P2** | **`/plan <argumen-sampah>`** (`/plan xyz`) → `on = false` → plan **mati tanpa error**. Harus reject argumen invalid. |
| **NEW-04** | **P2** | **`yoloMode` di `DispatcherGateOptions` mati** — diisi pemanggil, tidak dibaca `evaluateDispatcherGate`. Menyesatkan kontributor. |
| **NEW-05** | **P2** | **Minimal 3 alasan tolak scope** (null / planHash mismatch / luar workspace) → **satu** pesan generik `SECURITY_DENIED: Target mutasi di luar scope…`. User & model tidak bisa bedakan bootstrap vs rencana berubah vs path ilegal. |
| **NEW-06** | **P3** | **Save ganda** di `/plan`: setter sudah persist (senyap) + handler `saveHostState` ber-log. Konsolidasi saat perbaiki BUG-05. |

---

## 4. Detail temuan prioritas tinggi

### BUG-01 + NEW-01 — Dead-end universal ACT tanpa scope (P0)

**Kode:**

```ts
// scopeAmendment.ts — evaluateMutationTarget
if (!this.state.approvalScope) return false;
```

**Alur yang gagal (semua):**

| Jalur ke ACT | Scope setelahnya | Mutasi file |
|--------------|------------------|-------------|
| Sesi baru → `/plan off` | `null` | Ditolak |
| Rencana bernomor → auto-off → `act` | `null` | Ditolak |
| Resume → `/plan off` | `null` | Ditolak |
| `/plan on` lalu `/plan off` | `null` (dikosongkan saat on) | Ditolak |

**Repro minimal (disederhanakan v2):**

```text
1. ruko di workspace (sesi baru)
2. /plan off
3. Minta agent edit/write file di dalam workspace
→ SECURITY_DENIED (tanpa prompt bootstrap)
```

**Perilaku diharapkan:**

- Transisi ke ACT men-**seed** `approvalScope` (mis. `allowedPaths: [workspaceRoot]` atau `.`), **atau**
- Jika null + TTY: **satu** prompt bootstrap sebelum reject permanen; non-TTY tetap fail-closed.

**Arah perbaikan (keputusan maintainer):**

| Opsi | Isi |
|------|-----|
| **A** | Seed otomatis saat setiap transisi ke ACT |
| **B** | Prompt bootstrap jika null + TTY |
| **C** | Hanya slash `/scope allow\|status\|reset` |
| **A+C (disarankan)** | Seed default + kontrol eksplisit `/scope` |

Seed harus dipasang di **semua** titik: `/plan off`, auto-off di `agent.ts` & `loop.ts`, dan jalur set `mode='act'` lain jika ada.

---

### NEW-02 — YOLO persist lintas sesi (P1)

- `/yolo on` → `approvalEnabled: false` → `saveConfig()` → file config.
- Restart agent: tetap tanpa approval prompt (kecuali gate plan/scope/path).
- Risiko: user mengatasi BUG-01/Y/N dengan YOLO, lalu lupa.

**Perbaikan usulan:**

- Default: YOLO **session-only**; atau
- Persist hanya setelah konfirmasi kedua; dan
- Banner tiap start jika `approvalEnabled === false`.

---

### BUG-02 — Model salah diagnosis (P1 messaging)

Diperparah NEW-05 (pesan generik). Perbaiki copy error + hint perintah; jangan andalkan model menebak gate.

---

### BUG-03 (revisi) — Status bar (P1)

| Item | Status |
|------|--------|
| Indikator plan mode | Param sudah di-pass; verifikasi visual di `ui.ts` / terminal |
| Ringkasan **scope** | **Belum** di-pass / dirender |
| Profil **approval** | **Belum** |

Target UI contoh: `ACT · scope: . · approval: balanced` atau `ACT · scope: (none)`.

---

### BUG-04 (revisi) — Distribusi (P1)

| Item | Status |
|------|--------|
| `ruko --version` | Ada |
| `ruko --update` | **Tidak ada** |
| Pin installer | `v2.1.0`; tip main bisa lebih maju tanpa tag baru |

---

### UX-07 + usulan approval (P1 fitur)

Lihat §6. Bergantung **PR-A** selesai agar allowlist berguna (scope null tetap memblokir sebelum approval shell).

---

## 5. Matriks prioritas (v2)

| ID | Judul | Prioritas |
|----|--------|-----------|
| BUG-01 + NEW-01 | Scope null / tidak pernah di-seed → dead-end ACT | **P0** |
| NEW-02 | YOLO persist tanpa peringatan | **P1** |
| BUG-02 + NEW-05 | Messaging error / diagnosis | **P1** |
| BUG-03 | Scope (dan approval) di status bar | **P1** |
| BUG-04 | `--update` + tag/pin release | **P1** |
| UX-07 | `[a/y/n]` + `/config approval` | **P1** |
| BUG-05 + NEW-06 | Silent / double saveHostState | **P2** |
| NEW-03 | `/plan` argumen invalid = off diam-diam | **P2** |
| NEW-04 | `yoloMode` param mati di dispatcher | **P2** |
| BUG-06 | Known limits shell static analysis | **P2** (docs) |

---

## 6. Usulan desain approval & `/config`

*(Tidak berubah substansi dari v1; diselaraskan dengan NEW-02.)*

### 6.1 Prompt `[a/y/n]`

```text
⚠ exec: git status
   [a] always untuk pola ini   [y] sekali   [n] tolak
```

- **a** → allowlist sesi (dan opsional persist).
- Pola sempit; denylist destructive **tidak** bisa di-`a`.
- Plan / scope / path sensitif **tetap di atas** allowlist.

### 6.2 Profil approval

| Mode | Perilaku |
|------|----------|
| **strict** | Hampir semua mutasi + exec → prompt |
| **balanced** | Allowlist bawaan (git read, test, build); sisanya prompt; **a** memperluas |
| **trusted** | Lebih longgar; tetap blok destructive |
| **yolo** | Minim prompt; **tidak** bypass plan/scope/security core; **jangan persist default** (NEW-02) |

### 6.3 Slash `/config` (subcommand)

```text
/config
/config approval [mode|allow|deny|list|reset] ...
/config reasoning <low|medium|high|custom:VALUE>
/config loop <n>
```

Plan & scope tetap slash terpisah: `/plan`, `/scope`.

### 6.4 Fase implementasi

1. `[a/y/n]` + allowlist memori sesi  
2. `/config approval` + kebijakan persist YOLO  
3. Reasoning custom + loop  
4. Default balanced + docs  

---

## 7. Pesan error yang disarankan (NEW-05)

Bedakan penyebab:

**Scope null (bootstrap):**

```text
SECURITY_DENIED: approvalScope kosong (belum ada kontrak path).
  Mode: ACT · Scope: (none)
  Perlu: seed otomatis saat /plan off, atau /scope allow .
```

**Plan hash mismatch:**

```text
SECURITY_DENIED: rencana aktif berubah; izin scope dibatalkan.
  Jalankan ulang persetujuan rencana / /scope allow …
```

**Di luar workspace / containment:**

```text
SECURITY_DENIED: target di luar workspace (atau lolos symlink).
  Target: …
```

**Di luar subtree (scope ada):**

```text
SECURITY_DENIED: path di luar scope disetujui.
  Scope: src/ · Target: docs/x.md
  Setujui prompt amandemen atau /scope allow docs
```

---

## 8. Checklist PR (v2)

### PR-A — P0 Scope bootstrap

- [ ] Seed `approvalScope` di **semua** transisi ke ACT: `/plan off`, auto-off rencana (`agent.ts`, `loop.ts`)
- [ ] Opsional: `/scope allow|status|reset`
- [ ] Non-TTY: fail-closed jika kebijakan menolak seed implisit
- [ ] Test: sesi baru → `/plan off` → write path workspace → sukses (atau satu prompt lalu sukses)
- [ ] Test: plan on tetap memblokir mutasi
- [ ] Zero runtime dependency tetap

### PR-B — P1 Messaging, `/plan`, persist log, status

- [ ] Pesan error scope per penyebab (§7)
- [ ] `/plan` hanya `on` \| `off` \| kosong; argumen lain → error
- [ ] Log gagal `saveHostState` (hapus silent catch di 3 cabang); konsolidasi save ganda `/plan`
- [ ] Status bar: pastikan PLAN; **tambah** ringkasan scope (dan nanti approval)
- [ ] Deprecate/hapus pembacaan semu `yoloMode` di gate options (NEW-04) atau document + assert unused

### PR-C — P1 Approval UX

- [ ] Confirmer `[a/y/n]` + allowlist
- [ ] `/config approval …`
- [ ] YOLO: session-only **atau** warn + confirm sebelum persist + banner on start (NEW-02)
- [ ] Verifikasi `approvalAllowlist` benar-benar dihormati `guardedExecute`

### PR-D — Distribusi

- [ ] Tag release (mis. v2.2.0) setelah PR-A (+ idealnya B)
- [ ] `install.sh` pin tag baru
- [ ] Docs/`ruko --update` atau prosedur update eksplisit

### PR-E — P2 Docs & residual

- [ ] SECURITY.md: known limits shell analysis
- [ ] Docs user: tabel Plan / Mode / Role / Scope / Approval

**Urutan wajib:** PR-A sebelum PR-C. Allowlist tidak menolong jika scope null tetap early-return.

---

## 9. DoD P0

1. Sesi baru + `/plan off` + edit file workspace **tidak** berakhir dead-end `SECURITY_DENIED` tanpa jalan keluar.  
2. Auto-off pilihan rencana bernomor sama-sama bisa mutasi path dalam scope.  
3. Plan Mode on tetap memblokir seluruh tool mutasi (no regression).  
4. Path di luar scope tetap amend/deny sesuai kebijakan.  
5. Test suite existing hijau + test repro BUG-01/NEW-01.  
6. Zero runtime dependency tegak.

---

## 10. Keputusan maintainer

1. **Bootstrap scope:** A / B / C / **A+C (rekomendasi)**?  
2. **YOLO persist:** session-only vs persist + banner + confirm?  
3. **Release v2.2.0:** PR-A + PR-B minimal, approval config menyusul?

---

## 11. Lampiran kode (referensi)

```ts
// scopeAmendment.ts
if (!this.state.approvalScope) return false;
```

```ts
// hostState.ts — resume
if (opts.resume !== false && state.mode === 'act') {
  state.mode = 'plan';
  state.approvalScope = null;
  await saveHostState(state);
}
```

```ts
// commands.ts — /plan on
if (on) {
  hostState.approvalScope = null;
}
// Argumen: on = arg === 'on' || (arg === '' && !planMode)
// → argumen sampah ⇒ off (NEW-03)
```

```ts
// agent.ts — planMode setter
void saveHostState(this.hostState).catch(() => {});  // BUG-05
```

---

## 12. Referensi

- PR #35 — Security Hardening WP-01…WP-05  
- Laporan v1 (evaluasi awal)  
- Verifikasi kode independen (Kimi) terhadap `main`: `scopeAmendment.ts`, `hostState.ts`, `dispatcherGate.ts`, `commands.ts`, `tools.ts`, `agent.ts`, `loop.ts`, `securityPipeline.ts`, `plan.ts`, `index.ts`, `package.json`, `install.sh`  
- Observasi runtime: resume / `/plan off` / `SECURITY_DENIED` pada edit `src/index.ts`

---

*Pecah ke issue GitHub per ID (BUG-01, NEW-02, …) agar bisa di-commit dan di-review satu per satu. Jangan merge fitur approval besar sebelum PR-A hijau.*
