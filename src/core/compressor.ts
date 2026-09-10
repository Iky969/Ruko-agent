import { ContextMessage } from '../types.js';

/**
 * History compression — instead of dropping the oldest messages outright, the
 * oldest turns are folded into one compact digest message, while the most
 * recent turns (and their tool results) are always protected.
 *
 * Strategy (mirrors trajectory-compression practice):
 *  - keep the last `keepLast` messages verbatim;
 *  - from the older messages, fold as many as needed (oldest first) into
 *    one-line excerpts until the whole history fits `targetChars`;
 *  - if the primary excerpt budget cannot reach the target, retry with shorter
 *    excerpts; give up only when folding cannot save any space.
 */

export interface CompressOptions {
  targetChars: number;
  /** Number of most-recent messages to keep verbatim. */
  keepLast: number;
  /** Primary max chars of each folded turn's excerpt. */
  maxPerMessageChars: number;
}

/** Progressive excerpt budgets tried until the history fits the target. */
const EXCERPT_BUDGETS = [200, 100, 50, 25, 12];

/** Approx. overhead of the digest header line, used in budget projections. */
const DIGEST_HEADER_EST = 60;

export function compressHistory(
  messages: ContextMessage[],
  options: CompressOptions,
): ContextMessage[] {
  const { targetChars, keepLast } = options;

  if (messages.length <= keepLast + 1) return messages;

  const tail = messages.slice(-keepLast);
  const head = messages.slice(0, -keepLast);
  const tailChars = verbatimChars(tail);

  if (verbatimChars(head) + tailChars <= targetChars) return messages;

  const budgets = [...new Set([options.maxPerMessageChars, ...EXCERPT_BUDGETS])];
  for (const excerpt of budgets) {
    const folded = tryFold(head, tail, tailChars, targetChars, excerpt);
    if (folded) return folded;
  }
  return messages; // cannot compress without losing fidelity entirely
}

/** Attempts to fold old turns with the given excerpt size; null when impossible. */
function tryFold(
  head: ContextMessage[],
  tail: ContextMessage[],
  tailChars: number,
  targetChars: number,
  maxPerMessageChars: number,
): ContextMessage[] | null {
  const compact = (m: ContextMessage): string => {
    const content =
      m.content.length > maxPerMessageChars
        ? `${m.content.slice(0, maxPerMessageChars)}…`
        : m.content;
    return `[${m.role}] ${content}`;
  };

  const compacts = head.map(compact);

  // Find the largest i (number of oldest turns folded) whose projected total
  // still fits the target: digest(0..i) + verbatim(i..) + tail. The digest
  // header estimate is included so the fold guarantee holds in practice.
  let bestI = -1;
  let prefixChars = 0;
  for (let i = 0; i <= head.length; i += 1) {
    const headerChars = i > 0 ? DIGEST_HEADER_EST : 0;
    if (prefixChars + headerChars + verbatimChars(head.slice(i)) + tailChars <= targetChars) {
      bestI = i;
    }
    if (i < head.length) prefixChars += compacts[i].length + 1;
  }
  if (bestI <= 0) return null;

  const foldedParts = compacts.slice(0, bestI);
  const header = `[compressed history — ${foldedParts.length} turn(s) lama diringkas]`;
  const digestMessage: ContextMessage = {
    role: 'user',
    content: `${header}\n${foldedParts.join('\n')}`,
    timestamp: head[0].timestamp,
  };

  return [digestMessage, ...head.slice(bestI), ...tail];
}

function verbatimChars(messages: ContextMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.length + 1, 0);
}