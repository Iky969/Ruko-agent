import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlanOptionSelection, parseNumberedOptions } from '../core/plan.js';
import { renderPlanAutoExecuteBox, renderPlanGateBox, stripAnsi } from '../core/ui.js';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import { DEFAULT_CONFIG } from '../types.js';
import { LLMProvider, ChatOptions } from '../agent/llm.js';
import { ContextMessage } from '../types.js';

class MockLlmProvider implements LLMProvider {
  readonly name = 'mock';
  readonly isConfigured = true;
  model = 'mock-model';
  calls: ContextMessage[][] = [];
  nextResponse = 'Mock response';

  setModel(model: string): void {
    this.model = model;
  }

  async chat(messages: ContextMessage[], _options?: ChatOptions): Promise<string> {
    this.calls.push([...messages]);
    return this.nextResponse;
  }
}

describe('Issue #27: parseNumberedOptions', () => {
  test('parses standard numbered lists', () => {
    const text = [
      'Berikut rencana pengerjaan:',
      '1. Kerjakan ABCD',
      '2. Kerjakan EFGH',
      '3. Kerjakan ZYCX',
      '',
      'Apa yang kamu pilih?',
    ].join('\n');

    const options = parseNumberedOptions(text);
    assert.equal(options.length, 3);
    assert.deepEqual(options[0], { number: 1, text: 'Kerjakan ABCD' });
    assert.deepEqual(options[1], { number: 2, text: 'Kerjakan EFGH' });
    assert.deepEqual(options[2], { number: 3, text: 'Kerjakan ZYCX' });
  });

  test('parses various list formats (parenthesis, brackets, bullet prefixes, bold)', () => {
    const text = [
      '1) Opsi pertama',
      '- 2. Opsi kedua dengan dash',
      '* 3. **Opsi ketiga bold**',
      '[4] Opsi keempat bracket',
      'Opsi 5: Opsi kelima label',
    ].join('\n');

    const options = parseNumberedOptions(text);
    assert.equal(options.length, 5);
    assert.equal(options[0].number, 1);
    assert.equal(options[0].text, 'Opsi pertama');
    assert.equal(options[1].number, 2);
    assert.equal(options[1].text, 'Opsi kedua dengan dash');
    assert.equal(options[2].number, 3);
    assert.equal(options[2].text, '**Opsi ketiga bold**');
    assert.equal(options[3].number, 4);
    assert.equal(options[3].text, 'Opsi keempat bracket');
    assert.equal(options[4].number, 5);
    assert.equal(options[4].text, 'Opsi kelima label');
  });

  test('returns empty array when no numbered options exist', () => {
    assert.deepEqual(parseNumberedOptions(''), []);
    assert.deepEqual(parseNumberedOptions('Hanya teks biasa tanpa angka list.'), []);
    assert.deepEqual(parseNumberedOptions('Ada angka 2026 di teks tapi bukan list.'), []);
  });
});

describe('Issue #27: detectPlanOptionSelection', () => {
  const assistantMenu = [
    'Rencana tindakan:',
    '1. perbaiki bug temperature',
    '2. perbaiki UX plan mode',
    '3. jalankan testing lengkap',
    '',
    'Apa yang kamu pilih?',
  ].join('\n');

  test('detects pure digits, hashes, and dots', () => {
    const res1 = detectPlanOptionSelection(assistantMenu, '1');
    assert.ok(res1);
    assert.equal(res1.selectedNumber, 1);
    assert.equal(res1.optionText, 'perbaiki bug temperature');
    assert.ok(res1.augmentedInstruction.includes('User memilih opsi 1'));

    const res2 = detectPlanOptionSelection(assistantMenu, '#2');
    assert.ok(res2);
    assert.equal(res2.selectedNumber, 2);

    const res3 = detectPlanOptionSelection(assistantMenu, '3.');
    assert.ok(res3);
    assert.equal(res3.selectedNumber, 3);
  });

  test('detects verbal selections (opsi, pilihan, pilih, jalankan, eksekusi)', () => {
    const cases = [
      ['opsi 1', 1],
      ['Opsi 2', 2],
      ['pilihan 3', 3],
      ['pilih 1', 1],
      ['pilih opsi 2', 2],
      ['jalankan 3', 3],
      ['eksekusi opsi 1', 1],
      ['kerjakan 2', 2],
      ['run 1', 1],
      ['nomor 2', 2],
      ['no 3', 3],
    ] as const;

    for (const [input, expectedNum] of cases) {
      const res = detectPlanOptionSelection(assistantMenu, input);
      assert.ok(res, `Harus cocok untuk: "${input}"`);
      assert.equal(res.selectedNumber, expectedNum, `Cocok nomor ${expectedNum}`);
    }
  });

  test('rejects numbers outside the offered option range', () => {
    // Menu hanya punya opsi 1, 2, 3
    const res4 = detectPlanOptionSelection(assistantMenu, '4');
    assert.equal(res4, null, 'Opsi 4 tidak ditawarkan');

    const res99 = detectPlanOptionSelection(assistantMenu, '99');
    assert.equal(res99, null);
  });

  test('rejects ambiguous or conversational text', () => {
    const ambiguousInputs = [
      '1 hari yang lalu apa yang terjadi?',
      'kenapa opsi 1 begitu?',
      'bagaimana kalau opsi 2 diubah?',
      '1 dan 2 dijalankan bersama',
      'tidak ada yang cocok',
      'halo ruko',
      'apakah opsi 1 aman?',
    ];

    for (const input of ambiguousInputs) {
      const res = detectPlanOptionSelection(assistantMenu, input);
      assert.equal(res, null, `Input ambigu tidak boleh trigger auto-off: "${input}"`);
    }
  });

  test('returns null if lastAssistantContent is empty or null', () => {
    assert.equal(detectPlanOptionSelection(null, '1'), null);
    assert.equal(detectPlanOptionSelection('', '1'), null);
  });
});

describe('Issue #27: UI Gate Box Rendering', () => {
  test('renderPlanGateBox renders properly formatted box with options and question', () => {
    const options = [
      { number: 1, text: 'kerjakan ABCD.' },
      { number: 2, text: 'kerjakan efgh.' },
      { number: 3, text: 'kerjakan zycx' },
    ];
    const box = renderPlanGateBox(options, 'Apa yang kamu pilih?');
    const plain = stripAnsi(box);

    assert.ok(plain.includes('PLAN'));
    assert.ok(plain.includes('1. kerjakan ABCD.'));
    assert.ok(plain.includes('2. kerjakan efgh.'));
    assert.ok(plain.includes('3. kerjakan zycx'));
    assert.ok(plain.includes('Apa yang kamu pilih?'));
    assert.ok(plain.startsWith('┌'));
    assert.ok(plain.endsWith('┘'));
  });

  test('renderPlanAutoExecuteBox renders auto-off notification and executed option', () => {
    const box = renderPlanAutoExecuteBox(1, 'kerjakan ABCD.');
    const plain = stripAnsi(box);

    assert.ok(plain.includes('PLAN: AUTO-EXECUTE'));
    assert.ok(plain.includes('Plan mode dinonaktifkan otomatis'));
    assert.ok(plain.includes('Menjalankan opsi 1: kerjakan ABCD.'));
  });
});

describe('Issue #27: Agent Auto-Execution in Plan Mode', () => {
  test('Agent automatically exits plan mode and executes chosen option when given a valid number', async () => {
    const config = { ...DEFAULT_CONFIG };
    const ctx = new Context(config);
    const mockLlm = new MockLlmProvider();
    const agent = new Agent(ctx, mockLlm, config);

    // Aktifkan plan mode
    agent.planMode = true;
    assert.equal(agent.planMode, true);

    // Simulasikan pesan asisten sebelumnya yang menawarkan rencana bernomor
    ctx.add(
      'assistant',
      [
        'Berikut rencana aksi:',
        '1. Implementasi modul core/plan.ts',
        '2. Update status bar dan ui.ts',
        '',
        'Apa yang kamu pilih?',
      ].join('\n'),
    );

    mockLlm.nextResponse = 'Selesai menjalankan modul core/plan.ts';

    // Pengguna menjawab dengan angka "1"
    const response = await agent.handleInstruction('1');

    // 1. Plan mode harus otomatis OFF
    assert.equal(agent.planMode, false, 'agent.planMode harus otomatis nonaktif');

    // 2. Instruksi yang dikirim ke LLM harus memuat arahan eksekusi opsi 1
    const lastCallMessages = mockLlm.calls[mockLlm.calls.length - 1];
    const userMsg = lastCallMessages.find(
      (m) => m.role === 'user' && m.content.includes('User memilih opsi 1'),
    );
    assert.ok(userMsg, 'Instruksi harus diarahkan untuk langsung mengeksekusi opsi 1');
    assert.ok(userMsg.content.includes('Implementasi modul core/plan.ts'));
    assert.equal(response, 'Selesai menjalankan modul core/plan.ts');
  });

  test('Agent remains in plan mode if user input is ambiguous or not matching an option', async () => {
    const config = { ...DEFAULT_CONFIG };
    const ctx = new Context(config);
    const mockLlm = new MockLlmProvider();
    const agent = new Agent(ctx, mockLlm, config);

    agent.planMode = true;

    ctx.add(
      'assistant',
      [
        '1. Opsi A',
        '2. Opsi B',
      ].join('\n'),
    );

    mockLlm.nextResponse = 'Menjawab pertanyaan user';

    // User bertanya, bukan memilih nomor
    await agent.handleInstruction('kenapa opsi A lebih baik dari B?');

    // Plan mode harus TETAP aktif
    assert.equal(agent.planMode, true, 'Plan mode harus tetap aktif untuk pertanyaan ambigu');
  });
});
