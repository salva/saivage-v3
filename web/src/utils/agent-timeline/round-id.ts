import type { ParsedRoundId, TimelineRoundKind } from './types';

const ROUND_PARSE_RE = /^r-(pre|user|assistant|compacted)-([0-9a-f]{32})$/;

export function parseRoundId(roundId: string): ParsedRoundId {
  const match = ROUND_PARSE_RE.exec(roundId);
  if (!match) throw new Error(`Invalid round id: ${roundId}`);
  return { kind: match[1] as TimelineRoundKind };
}
