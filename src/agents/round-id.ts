export const roundIdGrammar = /^(?:r-(?:pre|user|assistant|diagnostic)-\d+|r-compacted-\d+)$/;

export function assertRoundId(value: string): string {
  if (!roundIdGrammar.test(value)) {
    throw new Error(`Invalid round_id '${value}'. Expected r-pre-N, r-user-N, r-assistant-N, r-diagnostic-N, or r-compacted-N.`);
  }
  return value;
}
