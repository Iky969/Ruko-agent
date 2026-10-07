/**
 * WP-05 (v2.1.0) — Parser HTML Tumpukan Tag
 *
 * DoD: "penutup tag `<script></style>` tidak membocorkan muatan tersembunyi."
 *
 * Pencacah integer lama mengurangi kedalaman pada tag penutup yang SALAH
 * PASANG, sehingga muatan tersembunyi lolos ke output. Implementasi baru
 * memakai tumpukan tag (hanya penutup yang cocok dengan tag teratas yang
 * menutup blok) — fail-closed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeHtml, stripDangerousBlocks } from '../agent/webtools.js';

test('WP-05: penutup tag salah pasang tidak membocorkan muatan tersembunyi', () => {
  const out = sanitizeHtml('<script>RAHASIA_JAHAT</style>TERLIHAT_JUGA');
  assert.equal(out.includes('RAHASIA_JAHAT'), false, 'muatan blok berbahaya tidak boleh lolos');
  assert.equal(out.includes('TERLIHAT_JUGA'), false, 'teks setelah penutup salah pasang tetap tersembunyi');
});

test('WP-05: tag stack tetap menyisihkan blok berpasangan yang benar', () => {
  assert.equal(stripDangerousBlocks('<script>evil()</script>teks'), 'teks');
  assert.equal(stripDangerousBlocks('sebelum<script>payload</script>sesudah'), 'sebelumsesudah');
  assert.equal(stripDangerousBlocks('<style>x</style><b>ok</b>'), '<b>ok</b>');
  assert.equal(stripDangerousBlocks('<noscript><p>enable js</p></noscript>Visible'), 'Visible');
  assert.equal(stripDangerousBlocks('<script src="x.js"></script>Setelah'), 'Setelah');
  assert.equal(stripDangerousBlocks('<script src="x.js"/>Setelah'), 'Setelah');
});

test('WP-05: penutup milik tag lain yang berada di bawah tumpukan tidak menurunkan kedalaman', () => {
  // `</script>` tidak cocok dengan tag teratas (style) → diabaikan (fail-closed).
  const out = stripDangerousBlocks('<script><style></script>X</style>Y');
  assert.equal(out.includes('X'), false);
  assert.equal(out.includes('Y'), false);
  assert.equal(out, '');
});

test('WP-05: teks normal di luar blok berbahaya tidak terpengaruh', () => {
  const out = sanitizeHtml('<p>sebelum</p><script>evil()</script><p>sesudah</p>');
  assert.match(out, /sebelum/);
  assert.match(out, /sesudah/);
  assert.equal(out.includes('evil()'), false);
});
