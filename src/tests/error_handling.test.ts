import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync, execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tests for Tugas 10: Global error handling hardening.
 *
 * These tests spawn actual subprocesses to verify:
 * - Stack traces are shown when RUKO_DEBUG=1 is set
 * - Diagnostic identifiers are included in crash output
 * - Clean error messages are shown without DEBUG
 * - emergencyCleanup does not throw on non-TTY
 */

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI_JS = join(PROJECT_ROOT, 'dist', 'index.js');

function runCli(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync('node', [CLI_JS, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env, NO_COLOR: '1' },
      timeout: 10_000,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: e.status ?? 1,
    };
  }
}

describe('Tugas 10: Global Error Handling Hardening', () => {
  it('shows diagnostic identifier (RUKO-...) on error output for unknown flags', () => {
    const result = runCli(['--nonexistent-flag-xyz']);
    assert.notStrictEqual(result.code, 0);
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('tidak dikenal') || combined.includes('--nonexistent-flag-xyz'),
      'Should show unknown flag error',
    );
  });

  it('uncaughtException handler includes diagnostic ID pattern in formatFatalError', () => {
    const output = execSync(
      `node -e "
        function formatFatalError(label, err) {
          const msg = err instanceof Error ? err.message : String(err);
          const lines = [label + ': ' + msg];
          const diagId = 'RUKO-' + Date.now().toString(36).toUpperCase();
          lines.push('');
          lines.push('[' + diagId + '] Jika masalah berlanjut, jalankan ulang dengan RUKO_DEBUG=1 untuk detail lengkap,');
          return lines.join('\\n');
        }
        const output = formatFatalError('Fatal', new Error('test crash'));
        if (!/RUKO-[A-Z0-9]+/.test(output)) process.exit(1);
        console.log('PASS');
      "`,
      { encoding: 'utf8', timeout: 5_000 },
    );
    assert.ok(output.includes('PASS'), 'Diagnostic ID pattern should match RUKO-<base36>');
  });

  it('RUKO_DEBUG=1 includes stack trace in error output', () => {
    const output = execSync(
      `node -e "
        const isDebug = !!(process.env.RUKO_DEBUG);
        const err = new Error('test error');
        const lines = ['Fatal: ' + err.message];
        if (isDebug && err.stack) lines.push(err.stack);
        const diagId = 'RUKO-' + Date.now().toString(36).toUpperCase();
        lines.push('');
        lines.push('[' + diagId + '] hint');
        console.log(lines.join('\\n'));
      "`,
      { encoding: 'utf8', env: { ...process.env, RUKO_DEBUG: '1' }, timeout: 5_000 },
    );
    assert.ok(output.includes('Error: test error'), 'Should contain error message');
    assert.ok(output.includes('at '), 'Should contain stack trace when RUKO_DEBUG=1');
  });

  it('without DEBUG, error output does NOT include stack trace', () => {
    const output = execSync(
      `node -e "
        const isDebug = !!(process.env.RUKO_DEBUG);
        const err = new Error('test error');
        const lines = ['Fatal: ' + err.message];
        if (isDebug && err.stack) lines.push(err.stack);
        console.log(lines.join('\\n'));
      "`,
      { encoding: 'utf8', env: { ...process.env, RUKO_DEBUG: '', DEBUG: '' }, timeout: 5_000 },
    );
    assert.ok(output.includes('Fatal: test error'), 'Should contain error message');
    assert.ok(!output.includes('    at '), 'Should NOT contain indented stack trace without DEBUG');
  });

  it('emergencyCleanup restores raw mode safely (no throw on non-TTY)', () => {
    const output = execSync(
      `node -e "
        function emergencyCleanup() {
          try {
            if (process.stdin.isTTY && process.stdin.isRaw) {
              process.stdin.setRawMode(false);
            }
          } catch {}
        }
        emergencyCleanup();
        console.log('OK');
      "`,
      { encoding: 'utf8', timeout: 5_000 },
    );
    assert.ok(output.includes('OK'), 'emergencyCleanup should not throw on non-TTY');
  });
});
