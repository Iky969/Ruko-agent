import { SummaryResult } from '../types.js';

/** Default threshold: logs longer than this get summarized (spec requirement). */
export const DEFAULT_MAX_LOG_CHARS = 1_000;

/**
 * Regex for "interesting" lines that should survive summarization as highlights:
 * errors, failures, warnings, exit codes, build results, etc.
 */
const HIGHLIGHT_PATTERN =
  /(error|fatal|exception|fail|warning|warn|traceback|panic|exit code|exit status|\b✓\b|\b✔\b|\b✗\b|success|compiled|built|finished|done)/i;

/**
 * Log Summarizer — prevents huge terminal logs from flooding the agent's context.
 *
 * Strategy for logs longer than `maxChars`:
 *  - keep the first ~40% (head) and the last ~60% (tail) of the log,
 *    rounded to whole lines;
 *  - insert a marker line describing how much was removed;
 *  - append up to `maxHighlights` lines that look important (errors/warnings/...).
 */
export function summarizeLog(
  log: string,
  maxChars: number = DEFAULT_MAX_LOG_CHARS,
  maxHighlights = 8,
): SummaryResult {
  const originalLength = log.length;

  if (log.length <= maxChars) {
    return { originalLength, truncated: false, summary: log };
  }

  const headRatio = 0.4;
  const headChars = Math.floor(maxChars * headRatio);
  const tailChars = maxChars - headChars;

  // Round head to the nearest line boundary so lines are never cut mid-way.
  const headRaw = log.slice(0, headChars);
  const headBreak = headRaw.lastIndexOf('\n');
  const head = headBreak === -1 ? headRaw : headRaw.slice(0, headBreak);

  // Round tail to start at a line boundary.
  const tailRaw = log.slice(log.length - tailChars);
  const tailStart = tailRaw.indexOf('\n');
  const tail = tailStart === -1 ? tailRaw : tailRaw.slice(tailStart + 1);

  const removedChars = originalLength - head.length - tail.length;
  const removedLines = countLines(log) - countLines(head) - countLines(tail);

  const marker = [
    '',
    `[... TRUNCATED by Log Summarizer: removed ${removedChars} chars / ~${removedLines} lines ...]`,
    '',
  ].join('\n');

  const highlights = extractHighlights(log, maxHighlights);

  const summary =
    highlights.length > 0
      ? `${head}${marker}${tail}\n\n[Highlights]\n${highlights.join('\n')}`
      : `${head}${marker}${tail}`;

  return { originalLength, truncated: true, summary };
}

/** Collects up to `maxLines` lines that look important (errors, warnings, ...). */
export function extractHighlights(log: string, maxLines = 8): string[] {
  const hits: string[] = [];
  for (const rawLine of log.split('\n')) {
    if (hits.length >= maxLines) break;
    const line = rawLine.trim();
    if (line.length > 0 && HIGHLIGHT_PATTERN.test(line)) {
      hits.push(line.length > 300 ? `${line.slice(0, 300)}…` : line);
    }
  }
  return hits;
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}