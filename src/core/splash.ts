/**
 * splash.ts — Banner maskot Ruki (v1.9.0). Pengganti aquarium/fish animation.
 *
 * PERUBAHAN v1.9.0:
 *  - Animasi ikan (aquarium loop, ikan `><>`, text sweep, hide/show cursor)
 *    DIHAPUS TOTAL. Tidak ada lagi loop frame / delay bertingkat; CLI langsung
 *    tampil bersih. Karena tidak ada timer sama sekali, tidak ada setInterval
 *    yang bisa tertinggal menggantung (memory leak impossible by design).
 *  - Banner baru: maskot Ruki di kiri (`> _ <`, `/// ///`, `RUKO-AGENT`) +
 *    panel info di kanan (model/provider/mode/env/status), digambar sekali
 *    sebagai box unicode `╭─╮│╰─╯` dan langsung commit ke scrollback.
 *
 * Aturan render (sesuai konvensi existing):
 *  - Lebar >= 48 kolom  → banner penuh (maskot + panel info).
 *  - Lebar < 48 kolom   → versi ringkas TANPA maskot (Termux 40 kolom aman,
 *    tidak wrap). Deteksi lebar sama dengan konvensi status bar Fase B.
 *  - isInteractiveTTY === false (piped/CI/non-interaktif, dari EnvProfile
 *    Fase A/B) → versi teks polos SATU BARIS saja, tanpa box ASCII penuh.
 *  - RUKO_NO_ANIM=1     → tetap banner statis (tidak ada animasi sejak v1.9.0);
 *  - NO_COLOR           → warna otomatis hilang (konvensi ui.ts `colorsEnabled`).
 */

import { colorsEnabled, dim, green, cyan, stripAnsi, terminalWidth, truncateVisible, visibleLength, padVisible } from './ui.js';
import { getEnvProfile } from './env.js';

export interface SplashInfo {
  /** Header line, e.g. `Ruko-agent 0.6.0`. */
  title: string;
  /** Right-aligned header text, e.g. `version 0.6.0`. */
  version: string;
  /** Centre tagline (dipakai di versi sempit). */
  tagline: string;
  /** Model name or formatted line, e.g. `claude-3-5-sonnet-20241022`. */
  model?: string;
  /** Provider name, e.g. `anthropic`. */
  provider?: string;
  /** Legacy single-line format: `model: x ──── provider: y`. */
  modelLine?: string;
  /** Footer hint line. */
  hint: string;
}

/**
 * Total box width (incl. borders): clamped to `terminalWidth() - 1`. A box
 * exactly as wide as the terminal triggers the pending-wrap glitch (borders
 * pile up as separate rows) — the recurring splash bug this clamp prevents.
 */
export function splashWidth(): number {
  return Math.max(20, Math.min(56, terminalWidth() - 1));
}

/** True when the (static) full banner may use colours; kept for tests/compat. */
export function splashAnimatable(): boolean {
  return colorsEnabled() && !!process.stdout.isTTY && !!process.stdin.isTTY && process.env.RUKO_NO_ANIM !== '1';
}

/** Maskot Ruki — baris-baris ASCII murni (tanpa warna). */
const RUKI_ART: readonly string[] = [
  '     ●      ',
  '     │      ',
  ' ╭───┴────╮ ',
  ' │  > _ < │ ',
  ' │ /// ///│ ',
  ' │RUKO-AGENT',
  ' ╰────────╯ ',
];

/**
 * Panel info banner: pasangan label→nilai (sudah diformat).
 * Export untuk pengujian.
 */
export function buildRukiInfoRows(info: SplashInfo): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  let model = info.model;
  let provider = info.provider;
  // Legacy format kompatibel: `model: x ──── provider: y` dipecah jadi dua baris
  // (perilaku sama dengan renderer splash lama).
  if (!model && !provider && info.modelLine) {
    const splitMatch = info.modelLine.match(/^(.*?)\s+[─\-—]{2,}\s+(.*?)$/i);
    if (splitMatch) {
      model = splitMatch[1].trim();
      provider = splitMatch[2].trim();
    } else {
      model = info.modelLine;
    }
  }
  // Nilai TANPA prefix label (label 'Model'/'Provider' sudah membawa makna).
  if (model) rows.push({ label: 'Model', value: model.replace(/^model:\s*/i, '') });
  if (provider) rows.push({ label: 'Provider', value: provider.replace(/^provider:\s*/i, '') });
  rows.push({ label: 'Env', value: envSummary() });
  rows.push({ label: 'Status', value: '● Safe at Local' });
  return rows;
}

/** Ringkasan lingkungan dari EnvProfile (Fase A/B) — satu sumber kebenaran. */
function envSummary(): string {
  const env = getEnvProfile();
  const flavor = env.flavor !== 'none' ? `${env.flavor} ` : '';
  return `${flavor}${env.isInteractiveTTY ? '(interactive)' : '(non-interactive)'}`.trim() || 'local';
}

/**
 * Baris header box `╭─ Title ──── version ─╮` dengan panjang pas `inner + 2`.
 * Header di-share dua renderer agar lebar border selalu konsisten.
 */
function headerLine(title: string, version: string, inner: number): string {
  const versionText = stripAnsi(version).trim();
  const reserved = visibleLength(versionText) + 6; // '─ ' + ' ' + dashes(≥1) + ' ' + ' ─'
  const titleText = truncateVisible(stripAnsi(title), Math.max(4, inner - reserved));
  const dashCount = Math.max(1, inner - visibleLength(titleText) - visibleLength(versionText) - 6);
  return `╭─ ${titleText} ${'─'.repeat(dashCount)} ${versionText} ─╮`;
}

/**
 * Banner maskot Ruki penuh (>= 48 kolom). Semua baris di-clamp ke `width`
 * sehingga tidak pernah melebihi terminal.
 */
export function renderRukiBannerLines(info: SplashInfo, width = splashWidth()): string[] {
  const inner = Math.max(10, width - 2);
  const top = headerLine(info.title, info.version, inner);
  const blank = `│${' '.repeat(inner)}│`;
  const row = (text: string): string => {
    const t = truncateVisible(text, inner);
    return `│ ${padVisible(t, inner - 2)} │`;
  };

  // Panel info kanan: label rata kiri + nilai.
  const infoRows = buildRukiInfoRows(info).map((r) => `${r.label.padEnd(9)}: ${r.value}`);
  const artLines = RUKI_ART.map((l) => l.padEnd(13));

  const lines: string[] = [top, blank];
  const rows = Math.max(RUKI_ART.length, infoRows.length);
  for (let i = 0; i < rows; i++) {
    const art = artLines[i] ?? ' '.repeat(13);
    const info = infoRows[i] ?? '';
    const left = green(art);
    const right = info
      ? `${dim((info.split(':')[0] ?? '').padEnd(10))}${cyan(info.slice(info.indexOf(':') + 1).trim())}`
      : '';
    lines.push(row(`${left}  ${right}`));
  }
  lines.push(blank);
  lines.push(row(` ${dim(info.hint)}`));
  lines.push(`╰${'─'.repeat(inner)}╯`);

  // Clamp defensif: semua baris tidak boleh melebihi `width`.
  return lines.map((l) => truncateVisible(l, width));
}

/**
 * Versi ringkas (< 48 kolom): tanpa maskot, hint ringkas, tetap box unicode
 * kecil supaya tetap khas Ruko tapi aman di Termux 40 kolom.
 */
export function renderRukiCompactLines(info: SplashInfo, width = splashWidth()): string[] {
  const inner = Math.max(10, width - 2);
  const top = headerLine(info.title, info.version, inner);
  const row = (text: string): string => {
    const t = truncateVisible(text, inner);
    const pad = Math.max(0, inner - 2 - visibleLength(t));
    return `│ ${t}${' '.repeat(pad)} │`;
  };

  const infoRows = buildRukiInfoRows(info);
  const lines: string[] = [top];
  for (const r of infoRows) {
    lines.push(row(`${r.label}: ${r.value}`));
  }
  // Hint ringkas (konvensi responsive hint splash lama).
  let hintText = info.hint;
  if (inner < 40) hintText = 'Ketik / untuk bantuan';
  else if (inner < 45) hintText = hintText.replace('Ctrl+C untuk keluar', 'Ctrl+C keluar');
  lines.push(row(hintText));
  lines.push(`╰${'─'.repeat(inner)}╯`);
  return lines.map((l) => truncateVisible(l, width));
}

/** Satu baris teks polos untuk piped/CI/non-interaktif (isInteractiveTTY=false). */
export function renderRukiPlainLine(info: SplashInfo): string {
  const parts: string[] = [stripAnsi(info.title)];
  if (info.model) parts.push(`model=${info.model}`);
  if (info.provider) parts.push(`provider=${info.provider}`);
  parts.push(`env=${envSummary()}`);
  return parts.join(' · ');
}

/**
 * Menampilkan banner pembuka. TANPA animasi — semuanya statis & sinkron dari
 * sisi rendering (fungsi async dipertahankan demi kompatibilitas pemanggil).
 *
 * Aturan (urutan prioritas):
 *   1. isInteractiveTTY === false (EnvProfile) → satu baris teks polos.
 *   2. lebar terminal < 48 kolom               → versi ringkas tanpa maskot.
 *   3. selain itu                              → banner maskot Ruki penuh.
 * NO_COLOR / RUKO_NO_ANIM memengaruhi warna (konvensi ui.ts) — animasi tidak
 * ada lagi sejak v1.9.0.
 */
export async function playSplash(info: SplashInfo): Promise<string[]> {
  const env = getEnvProfile();

  // 1. Piped / CI / non-interaktif → teks polos satu baris (tanpa box penuh).
  if (!env.isInteractiveTTY) {
    const line = renderRukiPlainLine(info);
    console.log(line);
    return [line];
  }

  // 2/3. Banner statis: penuh pada terminal lega, ringkas pada sempit.
  const width = splashWidth();
  const isNarrow = width < 48; // konvensi status bar Fase B (isNarrow boundary)
  const lines = isNarrow ? renderRukiCompactLines(info, width) : renderRukiBannerLines(info, width);
  console.log(lines.join('\n'));
  return lines;
}
