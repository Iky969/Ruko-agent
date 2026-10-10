import { realpathSync } from 'node:fs';
import { containsShellOperators, detectRisk, isHighRiskDangerousCommand } from '../approval.js';
import { DEFAULT_CONFIG } from '../../types.js';

/** Host-supplied execution context, never taken from model approval flags. */
export interface ApprovalRequest {
  kind: 'exec' | 'start_process';
  cwd: string;
  command: string;
}

/** Exact command + operation + physical cwd grants; never persisted or prefix-matched. */
export class SessionApprovalAllowlist {
  private readonly entries = new Set<string>();

  private isDirectGitPush(command: string): boolean {
    const parts = command.trim().split(/\s+/);
    if ((parts[0].split('/').pop() ?? '').replace(/\.exe$/i, '').toLowerCase() !== 'git') return false;
    let index = 1;
    while (index < parts.length && parts[index].startsWith('-')) {
      const option = parts[index++];
      if (['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(option)) index += 1;
    }
    return parts[index]?.toLowerCase() === 'push';
  }

  private key(command: string, request?: ApprovalRequest): string | null {
    if (!request || !['exec', 'start_process'].includes(request.kind)) return null;
    const display = request.kind === 'start_process' ? `start_process ${request.command}` : request.command;
    if (command !== display) return null;
    const trimmed = request.command.trim();
    // Reject shell expansion, quoting, control characters and dynamic interpreters.
    // Complex commands remain available through one-shot approval, not "always".
    if (!trimmed || !/^[a-zA-Z0-9_./:@=,+ -]+$/.test(trimmed) || containsShellOperators(command)) return null;
    const executable = trimmed.split(/\s+/)[0].split('/').pop()!.replace(/\.exe$/i, '').toLowerCase();
    if (/^(?:sudo|doas|su|env|sh|bash|dash|zsh|ksh|fish|cmd|powershell|pwsh|node|python[\d.]*|perl|ruby|lua|php|eval|xargs)$/.test(executable)) return null;
    const risk = detectRisk(trimmed, { ...DEFAULT_CONFIG, approvalEnabled: true, approvalAllowlist: [] }).risk;
    if (risk === 'blocked' || (request.kind === 'exec' && risk !== 'dangerous')) return null;
    if (isHighRiskDangerousCommand(trimmed).isHighRisk) return null;
    if (/\b(?:rm|rmdir|del|erase|rd|ri|remove-item|clear-content|remove-content|stop-computer|restart-computer|clear-eventlog|invoke-expression|iex)\b/i.test(trimmed)) return null;
    if (this.isDirectGitPush(trimmed)) return null;
    try {
      return JSON.stringify([request.kind, realpathSync(request.cwd), request.command]);
    } catch {
      return null; // unresolved execution context cannot carry a reusable grant
    }
  }

  canRemember(command: string, request?: ApprovalRequest): boolean {
    return this.key(command, request) !== null;
  }

  allows(command: string, request?: ApprovalRequest): boolean {
    const key = this.key(command, request);
    return key !== null && this.entries.has(key);
  }

  remember(command: string, request?: ApprovalRequest): boolean {
    const key = this.key(command, request);
    if (key === null) return false;
    this.entries.add(key);
    return true;
  }
}
