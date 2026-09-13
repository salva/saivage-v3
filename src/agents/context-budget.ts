export function usableInputTokens(
  contextWindowTokens: number,
  requestedCompletionTokens: number,
  contextUtilizationFraction: number,
): number {
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0)
    throw new Error('contextWindowTokens must be a positive integer.');
  if (!Number.isInteger(requestedCompletionTokens) || requestedCompletionTokens <= 0)
    throw new Error('requestedCompletionTokens must be a positive integer.');
  if (!Number.isFinite(contextUtilizationFraction) || contextUtilizationFraction <= 0 || contextUtilizationFraction > 1)
    throw new Error('contextUtilizationFraction must be finite, greater than zero, and no greater than one.');
  return Math.floor(contextUtilizationFraction * contextWindowTokens) - requestedCompletionTokens;
}
