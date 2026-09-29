import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Agent } from '../agent/agent.js';
import { Context } from '../core/context.js';
import {
  CORE_IDENTITY,
  TOOL_RULES,
  buildSystemPrompt,
  formatEnvironmentContext,
  getBuiltInRole,
} from '../agent/roles.js';
import { DEFAULT_CONFIG } from '../types.js';
import type { LLMProvider } from '../agent/llm.js';

/**
 * Task 4 — Injeksi konteks OS/shell ke system prompt.
 *
 * Tujuan: model (DeepSeek dkk.) tidak lagi mengirim perintah Bash
 * (`grep`, `ls -la`, `rm -rf`, `$VAR`, `a; b`) di lingkungan Windows, dan tidak
 * mengirim perintah cmd/PowerShell di Linux/macOS.
 *
 * Test ini murni (tanpa mock `process.platform`) sehingga hasilnya identik di
 * Linux, Windows, dan macOS — perilaku win32/posix diuji dengan input eksplisit.
 */

const linuxProfile = { platform: 'linux', shellFamily: 'posix', shellBinary: '/bin/sh', pathSeparator: '/' };
const winCmdProfile = { platform: 'win32', shellFamily: 'cmd', shellBinary: 'C:\\Windows\\system32\\cmd.exe', pathSeparator: '\\' };
const winPwshProfile = { platform: 'win32', shellFamily: 'powershell', shellBinary: 'powershell.exe', pathSeparator: '\\' };

describe('Task 4: konteks lingkungan otomatis di system prompt', () => {
  test('formatEnvironmentContext melaporkan OS, arch, shell, dan pemisah path', () => {
    const ctx = formatEnvironmentContext({ ...winCmdProfile, arch: 'x64', workspaceRoot: 'C:\\proyek\\app' });

    assert.ok(ctx.includes('win32'), 'harus memuat platform id');
    assert.ok(ctx.includes('Windows'), 'harus memuat label OS yang mudah dipahami model');
    assert.ok(ctx.includes('x64'), 'harus memuat arsitektur');
    assert.ok(ctx.includes('cmd'), 'harus memuat keluarga shell aktif');
    assert.ok(ctx.includes('C:\\proyek\\app'), 'harus memuat working directory');
    assert.ok(ctx.includes('Pemisah path'), 'harus menjelaskan pemisah path');
  });

  test('profil Windows memuat larangan perintah POSIX + padanan Windows-nya', () => {
    const ctx = formatEnvironmentContext(winCmdProfile);

    assert.ok(/JANGAN memakai perintah\/sintaks Unix/i.test(ctx), 'harus ada larangan eksplisit');
    for (const forbidden of ['grep', 'sed', 'awk', 'ls -la', 'rm -rf', '$VAR']) {
      assert.ok(ctx.includes(forbidden), `daftar larangan harus menyebut ${forbidden}`);
    }
    for (const replacement of ['dir', 'findstr', 'type', '%VAR%', 'Remove-Item', 'ping -n']) {
      assert.ok(ctx.includes(replacement), `harus menyebut padanan ${replacement}`);
    }
    assert.ok(ctx.includes('PowerShell') || ctx.includes('powershell'), 'harus menyarankan PowerShell untuk tugas kompleks');
    assert.ok(ctx.includes('&&'), 'harus menyebut pemisah perintah yang valid di cmd');
    assert.ok(!/Terminal adalah POSIX/.test(ctx), 'profil Windows tidak boleh memuat aturan POSIX');
  });

  test('profil POSIX memuat aturan Unix dan melarang perintah Windows', () => {
    const ctx = formatEnvironmentContext(linuxProfile);

    assert.ok(ctx.includes('POSIX'), 'harus menyebut shell POSIX');
    assert.ok(/JANGAN memakai perintah khusus Windows/i.test(ctx), 'harus melarang perintah Windows');
    for (const winOnly of ['dir, type, findstr, %VAR%, taskkill']) {
      assert.ok(ctx.includes(winOnly), `harus menyebut ${winOnly} sebagai terlarang`);
    }
    assert.ok(!/Terminal adalah Windows/.test(ctx), 'profil POSIX tidak boleh memuat aturan Windows');
  });

  test('shellFamily win32 terdeteksi sebagai Windows meski platform bukan win32 (WSL/pwsh lintas OS)', () => {
    const cmdOnLinux = formatEnvironmentContext({ platform: 'linux', shellFamily: 'cmd' });
    const pwshOnLinux = formatEnvironmentContext({ platform: 'linux', shellFamily: 'powershell' });
    const posixOnLinux = formatEnvironmentContext({ platform: 'linux', shellFamily: 'posix' });

    assert.ok(cmdOnLinux.includes('Terminal adalah Windows'), 'shellFamily cmd harus memakai aturan Windows');
    assert.ok(pwshOnLinux.includes('Terminal adalah Windows'), 'shellFamily powershell harus memakai aturan Windows');
    assert.ok(posixOnLinux.includes('Terminal adalah POSIX'), 'shellFamily posix harus memakai aturan POSIX');
  });

  test('flavor lingkungan (termux/wsl/colab) dilaporkan, "none" tidak', () => {
    assert.ok(formatEnvironmentContext({ ...linuxProfile, flavor: 'termux' }).includes('termux'));
    assert.ok(!formatEnvironmentContext({ ...linuxProfile, flavor: 'none' }).includes('Lingkungan terdeteksi'));
  });

  test('buildSystemPrompt menempatkan konteks lingkungan setelah role dan sebelum AGENT.md', () => {
    const envLayer = formatEnvironmentContext(winCmdProfile);
    const prompt = buildSystemPrompt({
      role: getBuiltInRole('default')!,
      planMode: false,
      mode: 'beginner',
      agentDoc: '# Project\nUse pnpm.',
      environment: envLayer,
    });

    assert.ok(prompt.includes('## Konteks lingkungan'), 'layer harus ikut terakit');
    const idxIdentity = prompt.indexOf(CORE_IDENTITY);
    const idxTools = prompt.indexOf(TOOL_RULES);
    const idxEnv = prompt.indexOf('## Konteks lingkungan');
    const idxAgentDoc = prompt.indexOf('Use pnpm.');

    assert.ok(idxIdentity < idxTools, 'urutan lama tetap: identity sebelum tool rules');
    assert.ok(idxTools < idxEnv, 'konteks lingkungan setelah tool rules');
    assert.ok(idxEnv < idxAgentDoc, 'konteks lingkungan sebelum AGENT.md');
  });

  test('layer dilewati saat environment null/undefined/kosong (tanpa regresi prompt lama)', () => {
    const base = { role: getBuiltInRole('default')!, planMode: false, mode: 'beginner' as const, agentDoc: null };
    const withoutField = buildSystemPrompt(base);
    const withNull = buildSystemPrompt({ ...base, environment: null });
    const withEmpty = buildSystemPrompt({ ...base, environment: '   ' });

    assert.ok(!withoutField.includes('## Konteks lingkungan'));
    assert.equal(withoutField, withNull);
    assert.equal(withoutField, withEmpty);
  });

  test('Agent.systemPrompt() menyuntikkan konteks lingkungan secara otomatis', () => {
    const config = { ...DEFAULT_CONFIG, apiKey: 'test', baseUrl: 'http://127.0.0.1:1' };
    // systemPrompt() tidak menyentuh provider — stub minimal cukup.
    const agent = new Agent(new Context(config), {} as LLMProvider, config);

    const prompt = agent.systemPrompt();
    assert.ok(prompt.includes('## Konteks lingkungan (otomatis'), 'Agent harus menyuntikkan layer ini sendiri');
    assert.ok(prompt.includes(process.platform), 'harus memuat process.platform nyata');
    // Konsistensi: aturan Windows/POSIX mengikuti platform nyata mesin test.
    if (process.platform === 'win32') {
      assert.ok(prompt.includes('Terminal adalah Windows'), 'di Windows prompt harus memuat aturan Windows');
    } else {
      assert.ok(prompt.includes('Terminal adalah POSIX'), 'di POSIX prompt harus memuat aturan POSIX');
    }
  });
});
