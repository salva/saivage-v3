import type { ParsedRoundId, TimelineRoundKind } from './types';

const ROUND_RE = /^r-(pre|user|assistant|compacted)-[0-9a-f]{32}$/;
const ROUND_PARSE_RE = /^r-(pre|user|assistant|compacted)-([0-9a-f]{32})$/;
const TIERS: Record<TimelineRoundKind, number> = { pre: 0, user: 1, assistant: 2, compacted: 3 };

export function isRoundId(roundId: unknown): roundId is string {
  return typeof roundId === 'string' && ROUND_RE.test(roundId);
}

export function parseRoundId(roundId: string): ParsedRoundId {
  const match = ROUND_PARSE_RE.exec(roundId);
  if (!match) throw new Error(`Invalid round id: ${roundId}`);
  const kind = match[1] as TimelineRoundKind;
  return { kind, tier: TIERS[kind] };
}

export function roundIdSortKey(roundId: string): [number, string] {
  const parsed = parseRoundId(roundId);
  return [parsed.tier, roundId];
}
