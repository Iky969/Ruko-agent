/**
 * git_push_global_flags.test.ts
 *
 * `git push` polos sudah DANGEROUS (DANGEROUS_PATTERNS). Bentuk dengan global
 * flag git (`-C <path>`, `-c <k=v>`, `--git-dir=<path>`, ...) mengubah
 * repository kerja yang di-push, jadi verdict-nya harus sama.
 *
 * ZERO dependency - hanya `node:*`.
 */
import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectRisk } from '../core/approval.js';
import type { AgentConfig } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';

function cfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...DEFAULT_CONFIG, approvalEnabled: true, ...overrides };
}

describe('detectRisk: git push dengan global flag diperlakukan sama dengan "git push"', () => {
  const dangerous = [
    ['git push origin main', 'baseline polos'],
    ['git -C . push origin main', '-C <path>'],
    ['git -c user.name=x push origin main', '-c <k=v>'],
    ['git --git-dir=.git push origin main', '--git-dir=<path> (menempel)'],
    ['git --git-dir .git push origin main', '--git-dir <path> (terpisah)'],
    ['git --work-tree=/tmp/wt push origin main', '--work-tree=<path>'],
    ['git --namespace=ns push origin main', '--namespace=<ns>'],
    ['git --git-dir=/srv/gitdir push origin main', '--git-dir tanpa akhiran .git (bukan kecocokan kebetulan regex)'],
    ['echo ok && git -C . push origin main', 'di dalam rantai perintah'],
    ['git -C /tmp/other-repo push --force origin main', 'flag bercampur dan -C absolut'],
  ] as const;

  for (const [command, note] of dangerous) {
    test('DANGEROUS: ' + command + '  (' + note + ')', () => {
      const verdict = detectRisk(command, cfg());
      assert.equal(verdict.risk, 'dangerous', 'harus dangerous: ' + command);
      assert.equal(verdict.reason, 'git push (mengubah remote repository)');
    });
  }

  const stillNone = [
    'git status',
    'git -C . status',
    'git -c user.name=x log --oneline -1',
    'git --git-dir=.git rev-parse HEAD',
    'git config --get push.default',
    'git log --oneline push',
  ] as const;

  for (const command of stillNone) {
    test('NONE (kontrol, tidak boleh jadi dangerous): ' + command, () => {
      assert.equal(detectRisk(command, cfg()).risk, 'none', 'harus none: ' + command);
    });
  }
});

describe('detectRisk: tokenizer sadar-kutip untuk git push (kelas A1/A2/B1/C + kelas baru)', () => {
  const dangerous = [
    ['git -c "user.name=John Doe" push origin main', 'A1: nilai -c ber-spasi di dalam kutip'],
    ['git -C "/tmp/dir with space" push origin main', 'A2: path ber-spasi di dalam kutip'],
    ['git --config-env user.name=MY_ENV push origin main', 'B1: --config-env bentuk terpisah'],
    ['GIT_SSH_COMMAND="ssh -i key" git -C . push origin main', 'C: prefix assignment env ber-kutip'],
    ['FOO=1 BAR="two words" git -C "/tmp/my repo" -c "user.name=a b" --config-env user.email=E push origin main', 'kombinasi prefix + beberapa flag bernilai'],
    ['git "push" origin main', 'subcommand dikutip'],
    ['git -C . "push" origin main', 'subcommand dikutip setelah global flag'],
    ['git\\ push origin main', 'spasi di-escape backslash'],
    ["$'git' push origin main", 'ANSI-C quoting pada program'],
    ['git -c "a=b" -C . push origin main', 'dua flag bernilai berturut-turut'],
    ['nohup git -C . push origin main', 'prefix launcher + global flag bernilai'],
    ['git $(echo) push origin main', 'substitusi mengaburkan posisi subcommand (fail-safe)'],
  ] as const;

  for (const [command, note] of dangerous) {
    test('DANGEROUS: ' + command + '  (' + note + ')', () => {
      const verdict = detectRisk(command, cfg());
      assert.equal(verdict.risk, 'dangerous', 'harus dangerous: ' + command);
      assert.equal(verdict.reason, 'git push (mengubah remote repository)');
    });
  }

  const stillNone = [
    ['git -c "user.name=John Doe" status', 'A1-kontrol: bukan push'],
    ['git --config-env user.name=MY_ENV status', 'B1-kontrol: bukan push'],
    ['GIT_SSH_COMMAND="ssh -i key" git -C . status', 'C-kontrol: bukan push'],
    ['git "log" --oneline push', 'token push bukan di posisi subcommand'],
    ['git --no-pager log push', 'flag tanpa nilai lalu subcommand log'],
    ['git commit -m "$(cat msg)"', 'substitusi pada argumen subcommand bukan-push'],
  ] as const;

  for (const [command, note] of stillNone) {
    test('NONE (kontrol, tidak boleh jadi dangerous): ' + command + '  (' + note + ')', () => {
      assert.equal(detectRisk(command, cfg()).risk, 'none', 'harus none: ' + command);
    });
  }
});
