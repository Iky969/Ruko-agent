/**
 * Minimal zero-dependency line diff (LCS based) with git-style colored
 * rendering — used by the Visual File Diff feature of the Edit/Write tools.
 */
import { dim, green, red } from './ui.js';

export type DiffOpType = 'eq' | 'add' | 'del';

export interface DiffOp {
  type: DiffOpType;
  line: string;
}

/** Max middle-section size handled by the exact LCS DP (prefix/suffix trimmed). */
const LCS_CELL_LIMIT = 400 * 400;

/** Splits text into lines, dropping the artifact empty line of a trailing \n. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level diff between two arrays of lines. */
export function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  // Trim common prefix and suffix so the DP only sees the real changes.
  let head = 0;
  while (
    head < oldLines.length &&
    head < newLines.length &&
    oldLines[head] === newLines[head]
  ) {
    head += 1;
  }
  let tailOld = oldLines.length;
  let tailNew = newLines.length;
  while (
    tailOld > head &&
    tailNew > head &&
    oldLines[tailOld - 1] === newLines[tailNew - 1]
  ) {
    tailOld -= 1;
    tailNew -= 1;
  }

  const a = oldLines.slice(head, tailOld);
  const b = newLines.slice(head, tailNew);
  const ops: DiffOp[] = [];
  for (let i = 0; i < head; i += 1) ops.push({ type: 'eq', line: oldLines[i] });
  ops.push(...lcsDiff(a, b));
  for (let i = tailOld; i < oldLines.length; i += 1) ops.push({ type: 'eq', line: oldLines[i] });
  return ops;
}

function lcsDiff(a: string[], b: string[]): DiffOp[] {
  if (a.length === 0) return b.map((line) => ({ type: 'add' as const, line }));
  if (b.length === 0) return a.map((line) => ({ type: 'del' as const, line }));
  if (a.length * b.length > LCS_CELL_LIMIT) {
    // Fallback for very large changes: wholesale replace (still correct, just noisy).
    return [
      ...a.map((line) => ({ type: 'del' as const, line })),
      ...b.map((line) => ({ type: 'add' as const, line })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'eq', line: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', line: b[j] });
      j += 1;
    }
  }
  while (i < n) ops.push({ type: 'del', line: a[i++] });
  while (j < m) ops.push({ type: 'add', line: b[j++] });
  return ops;
}

export interface RenderDiffOptions {
  /** Unchanged context lines kept around each hunk. */
  context?: number;
  /** Hard cap on rendered lines. */
  maxLines?: number;
}

/**
 * Git-style rendered diff: removed lines red with `-`, added lines green
 * with `+`, unchanged lines dim. Long unchanged stretches are collapsed.
 */
export function renderFileDiff(
  pathLabel: string,
  oldText: string,
  newText: string,
  opts: RenderDiffOptions = {},
): string {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 160;
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const ops = diffLines(oldLines, newLines);

  // Mark which eq lines are kept (within `context` of a change).
  const keep = new Array<boolean>(ops.length).fill(false);
  let lastChange = -Infinity;
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i].type !== 'eq') {
      for (let k = Math.max(0, i - context); k <= i; k += 1) keep[k] = true;
      lastChange = i;
    } else if (i - lastChange <= context) {
      keep[i] = true;
    }
  }

  const out: string[] = [];
  out.push(dim(`  diff ${pathLabel}`));
  let skipped = 0;
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    if (op.type === 'eq' && !keep[i]) {
      skipped += 1;
      continue;
    }
    if (skipped > 0) {
      out.push(dim(`  … ${skipped} baris tidak berubah …`));
      skipped = 0;
    }
    if (op.type === 'del') out.push(red(`- ${op.line}`));
    else if (op.type === 'add') out.push(green(`+ ${op.line}`));
    else out.push(dim(`  ${op.line}`));
  }
  if (skipped > 0) out.push(dim(`  … ${skipped} baris tidak berubah …`));
  if (out.length === 1) out.push(dim('  (tidak ada perubahan baris)'));
  if (out.length > maxLines) {
    return [...out.slice(0, maxLines), dim('  … (diff dipotong) …')].join('\n');
  }
  return out.join('\n');
}
