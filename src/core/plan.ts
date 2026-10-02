/**
 * Plan Mode Helper Utilities: Numbered Menu Parsing and Auto-Execution Detection.
 * Addresses Issue #27: Auto-executes chosen numbered options and exits plan mode.
 */

export interface PlanOption {
  number: number;
  text: string;
}

export interface PlanSelectionResult {
  selectedNumber: number;
  optionText: string;
  allOptions: PlanOption[];
  augmentedInstruction: string;
}

/**
 * Parses numbered option items (e.g. "1. Kerjakan ABCD", "2) Lihat struktur", "[1] opsi")
 * from an assistant's plan mode response.
 */
export function parseNumberedOptions(content: string): PlanOption[] {
  if (!content || !content.trim()) return [];

  const lines = content.split('\n');
  const options: PlanOption[] = [];
  const seenNumbers = new Set<number>();

  // Match lines like:
  // "1. kerjakan ABCD"
  // "1) kerjakan ABCD"
  // "[1] kerjakan ABCD"
  // "- 1. kerjakan ABCD"
  // "Opsi 1: kerjakan ABCD"
  const optionRegex = /^\s*(?:[-*]\s*)?(?:(?:opsi|option|pilihan|nomor|no\.?)\s*)?(?:\[(\d+)\]|(\d+)[\.\)\:\-]|(\d+)\s*[-:])\s*(.+)$/i;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(optionRegex);
    if (match) {
      const rawNum = match[1] || match[2] || match[3];
      const num = parseInt(rawNum, 10);
      const text = match[4].trim();

      // Only valid positive numbers with non-empty descriptions
      if (!Number.isNaN(num) && num > 0 && text.length > 0 && !seenNumbers.has(num)) {
        seenNumbers.add(num);
        options.push({ number: num, text });
      }
    }
  }

  // Sort by option number ascending
  return options.sort((a, b) => a.number - b.number);
}

/**
 * Detects if the user input is an unambiguous selection referring to one of
 * the numbered options presented in the last assistant response.
 *
 * Requirements from Issue #27:
 * - Only triggers on unambiguous selection matching a valid offered option number.
 * - Does not trigger on ambiguous, random, or conversational inputs.
 */
export function detectPlanOptionSelection(
  lastAssistantContent: string | null | undefined,
  input: string,
): PlanSelectionResult | null {
  if (!lastAssistantContent || !input) return null;

  const trimmed = input.trim();
  if (!trimmed) return null;

  // Match clear selection patterns:
  // "1", "2", "#1", "1."
  // "opsi 1", "pilihan 2", "nomor 3", "option 1", "no 2"
  // "pilih 1", "pilih opsi 2", "ambil opsi 1"
  // "jalankan 1", "eksekusi 2", "kerjakan opsi 1", "run 1"
  const selectionRegex = /^(?:(?:pilih|ambil|jalankan|kerjakan|eksekusi|run|execute)\s+)?(?:opsi|option|pilihan|nomor|no\.?)?\s*#?([1-9]\d*)[\.\)]?$/i;

  const match = trimmed.match(selectionRegex);
  if (!match) return null;

  const choiceNum = parseInt(match[1], 10);
  if (Number.isNaN(choiceNum)) return null;

  const allOptions = parseNumberedOptions(lastAssistantContent);
  if (allOptions.length === 0) return null;

  const chosen = allOptions.find((opt) => opt.number === choiceNum);
  if (!chosen) return null;

  return {
    selectedNumber: choiceNum,
    optionText: chosen.text,
    allOptions,
    augmentedInstruction: `User memilih opsi ${choiceNum}: "${chosen.text}". Plan mode telah dinonaktifkan otomatis. Jalankan dan eksekusi opsi ini sekarang menggunakan tool yang tersedia.`,
  };
}
