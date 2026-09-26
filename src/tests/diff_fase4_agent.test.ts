import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, after } from 'node:test';
import { setWorkspaceRoot } from '../agent/tools.js';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { DIFF_TOGGLE_HINT } from '../core/diffui.js';
import { stripAnsi } from '../core/ui.js';
import { ChatOptions, LLMProvider } from '../agent/llm.js';
import { ContextMessage, DEFAULT_CONFIG } from '../types.js';

// ============================================================================
// Fase 4 (integrasi Agent): toggle Ctrl+D me-render ulang block diff
// collapsed <-> expanded dari log mutasi turn yang sudah berjalan.
//
// CATATAN STRUKTUR: patch process.stdout.write / console.log yang membentang
// lintas `await` mengganggu collector event `node --test` (beberapa event
// subtest tidak pernah sampai ke runner). Karena itu: turn dijalankan TANPA
// capture; console.log hanya di-patch secara SINKRON di sekitar pemanggilan
// toggle (tidak ada await di dalam jendela patch).
// ============================================================================

const testWorkspace = mkdtempSync(join(tmpdir(), 'ruko-ws-df4a-'));
setWorkspaceRoot(testWorkspace);
after(() => {
  setWorkspaceRoot(null);
  rmSync(testWorkspace, { recursive: true, force: true });
});

/** Patch console.log sinkron — jalankan fn, kumpulkan output, pulihkan. */
function captureSync(fn: () => void): string[] {
  const out: string[] = [];
  const orig = console.log;
  console.log = ((...args: any[]) => {
    out.push(args.map(String).join(' '));
  }) as any;
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return out;
}

class MockFileEditProvider implements LLMProvider {
  readonly name = 'mock-fase4';
  readonly isConfigured = true;
  model = 'mock-model';
  lastFinishReason: string | null = 'stop';
  constructor(private readonly reply: string) {}
  setModel(model: string): void {
    this.model = model;
  }
  async chat(_messages: ContextMessage[], _options?: ChatOptions): Promise<string> {
    return this.reply;
  }
}

test('Agent: ringkasan ✍️ default COLLAPSED ter-buffer; toggle 2x -> expanded lalu collapsed lagi', async () => {
  const editCall =
    '```tool\n{"tool": "edit_file", "path": "df4-agent.txt", "content": "satu\\ndua\\ntiga\\n"}\n```';
  const provider = new MockFileEditProvider(`${editCall}\nSelesai mengedit berkas.`);
  const agent = new Agent(new Context({ ...DEFAULT_CONFIG }), provider, { ...DEFAULT_CONFIG });

  // Turn penuh TANPA patch lintas await — tool mutasi berjalan dan log ✍️
  // masuk mutationSummaryBuffer untuk toggle Ctrl+D.
  await agent.handleInstruction('edit file df4-agent.txt lalu jawab');
  assert.ok(!agent.isDiffDetailExpanded, 'default collapsed');

  // Toggle 1x: collapse -> expanded (sinkron).
  const expandedOut = captureSync(() => agent.toggleDiffDetailExpanded());
  assert.ok(agent.isDiffDetailExpanded, 'state expanded setelah toggle 1x');
  const expandedPlain = stripAnsi(expandedOut.join('\n'));
  assert.ok(expandedPlain.includes('✍️ edit_file df4-agent.txt'), 're-render memuat ringkasan ✍️');
  assert.ok(expandedPlain.includes('+3'), 'angka +3 (file baru 3 baris)');
  assert.ok(expandedPlain.includes('+ satu'), 'block expanded menampilkan isi diff (+)');

  // Toggle 2x: expanded -> collapsed (sinkron).
  const collapsedOut = captureSync(() => agent.toggleDiffDetailExpanded());
  assert.ok(!agent.isDiffDetailExpanded, 'kembali collapsed setelah toggle 2x');
  const collapsedPlain = stripAnsi(collapsedOut.join('\n'));
  assert.ok(collapsedPlain.includes('✍️ edit_file df4-agent.txt'), 're-render collapsed tetap memuat ringkasan');
  assert.ok(collapsedPlain.includes(DIFF_TOGGLE_HINT), 'hint ctrl+d tampil saat collapsed');
  assert.ok(!collapsedPlain.includes('+ satu'), 'isi diff TIDAK tampil saat collapsed');
});

test('Agent: toggle expanded hanya me-render ulang block, state tersimpan di agent', async () => {
  const editCall =
    '```tool\n{"tool": "edit_file", "path": "df4-agent2.txt", "content": "alpha\\nBETA\\n"}\n```';
  const provider = new MockFileEditProvider(`${editCall}\nSelesai.`);
  const agent = new Agent(new Context({ ...DEFAULT_CONFIG }), provider, { ...DEFAULT_CONFIG });

  await agent.handleInstruction('edit df4-agent2.txt');

  const out = captureSync(() => agent.toggleDiffDetailExpanded());
  assert.ok(agent.isDiffDetailExpanded, 'state expanded tersimpan di agent');
  const plain = stripAnsi(out.join('\n'));
  assert.ok(plain.includes('+ alpha'), 'baris diff (+) tampil saat expanded');
  assert.ok(plain.includes('- beta') || plain.includes('+ BETA'), 'baris diff (+/-) utuh tampil saat expanded');
});
