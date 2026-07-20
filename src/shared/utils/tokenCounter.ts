// ═══════════════════════════════════════════════════════════════
// Token Counter — Rough token estimation for context budgeting
// ═══════════════════════════════════════════════════════════════

/**
 * Estimate token count for a given text string.
 *
 * Uses a ~4 chars/token heuristic which is roughly accurate for
 * English text and code with most LLMs. For production accuracy,
 * we could integrate tiktoken, but this avoids the WASM dependency
 * for the MVP.
 *
 * @param text - Input text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Rough heuristic: ~4 characters per token for code
  return Math.ceil(text.length / 4);
}

/**
 * Truncate text to fit within a token budget.
 * Tries to break at the last newline before the limit.
 *
 * @param text - Input text
 * @param maxTokens - Maximum token budget
 * @returns Truncated text
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;

  const truncated = text.substring(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');

  if (lastNewline > maxChars * 0.8) {
    return truncated.substring(0, lastNewline) + '\n// ... truncated';
  }

  return truncated + '\n// ... truncated';
}

/**
 * Check if adding more content would exceed the token budget.
 */
export function wouldExceedBudget(
  currentTokens: number,
  additionalText: string,
  maxTokens: number,
): boolean {
  return currentTokens + estimateTokens(additionalText) > maxTokens;
}
