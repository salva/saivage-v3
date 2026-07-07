export type RoundKind = 'pre' | 'user' | 'assistant' | 'compacted';

export const roundIdGrammar = /^r-(?:pre|user|assistant|compacted)-[0-9a-f]{32}$/;

export function assertRoundId(value: string): string {
  if (!roundIdGrammar.test(value)) {
    throw new Error(
      `Invalid round_id '${value}'. Expected r-{pre|user|assistant|compacted}-<32-hex>.`,
    );
  }
  return value;
}
