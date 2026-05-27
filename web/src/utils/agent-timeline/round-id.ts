import type { ParsedRoundId, TimelineRoundKind } from './types';

const ROUND_RE = /^r-(pre|user|assistant|diagnostic|compacted)-(\d+)$/;
const TIERS: Record<TimelineRoundKind, number> = { pre: 0, user: 1, assistant: 2, diagnostic: 2, compacted: 3 };

export function parseRoundId(roundId: string): ParsedRoundId {
  const match = ROUND_RE.exec(roundId);
  if (!match) throw new Error(`Invalid round id: ${roundId}`);
  const kind = match[1] as TimelineRoundKind;
  return { kind, ordinal: Number(match[2]), tier: TIERS[kind] };
}

export function roundIdSortKey(roundId: string): [number, number, string] {
  const parsed = parseRoundId(roundId);
  return [parsed.ordinal, parsed.tier, roundId];
}
