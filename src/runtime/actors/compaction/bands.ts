import type { ClassifiedRound } from './round-classifier.js';

export type SnapPolicy = 'keep_straddler_verbatim' | 'compact_straddler';

type SlidingBandConfig = { tail_budget_tokens: number; middle_budget_tokens: number; snap: SnapPolicy };
export type SlidingBandPartitions = { merge_rounds: ClassifiedRound[]; summary_rounds: ClassifiedRound[]; tail_rounds: ClassifiedRound[] };

/** Partitions closed rounds backward from the newest closed round. Only the explicit open round and closed rounds above the budgets stay verbatim. */
export function computeSlidingCompactionBands(rounds: readonly ClassifiedRound[], config: SlidingBandConfig): SlidingBandPartitions {
  if (!Number.isInteger(config.tail_budget_tokens) || config.tail_budget_tokens < 0) throw new Error('Compaction tail budget must be a nonnegative integer.');
  if (!Number.isInteger(config.middle_budget_tokens) || config.middle_budget_tokens < 0) throw new Error('Compaction middle budget must be a nonnegative integer.');
  const openRounds = rounds.filter((round) => round.state === 'open');
  if (openRounds.length > 1) throw new Error('Conversation validation admits at most one logically open round.');
  const openRound = openRounds[0] ?? null;
  if (openRound && rounds.indexOf(openRound) !== rounds.length - 1) throw new Error('The logically open round must be the newest round.');
  const completed = rounds.filter((round) => round.state === 'closed');
  let cursor = completed.length - 1;
  const tailNewestFirst: ClassifiedRound[] = [];
  let used = 0;
  while (cursor >= 0) {
    const round = completed[cursor]!;
    const size = round.estimated_tokens;
    if (used + size <= config.tail_budget_tokens) { tailNewestFirst.push(round); used += size; cursor--; continue; }
    if (config.snap === 'keep_straddler_verbatim') { tailNewestFirst.push(round); cursor--; }
    break;
  }

  const middleNewestFirst: ClassifiedRound[] = [];
  used = 0;
  while (cursor >= 0) {
    const round = completed[cursor]!;
    const size = round.estimated_tokens;
    if (used + size <= config.middle_budget_tokens) { middleNewestFirst.push(round); used += size; cursor--; continue; }
    if (config.snap === 'keep_straddler_verbatim') { middleNewestFirst.push(round); cursor--; }
    break;
  }
  return { merge_rounds: completed.slice(0, cursor + 1), summary_rounds: middleNewestFirst.reverse(), tail_rounds: tailNewestFirst.reverse() };
}

export function assertEscalatedSuffixSubsets(normal: SlidingBandPartitions, escalated: SlidingBandPartitions): void {
  assertSuffix(normal.tail_rounds, escalated.tail_rounds, 'tail');
  assertSuffix([...normal.summary_rounds, ...normal.tail_rounds], [...escalated.summary_rounds, ...escalated.tail_rounds], 'middle + tail');
}

function assertSuffix(normal: readonly ClassifiedRound[], escalated: readonly ClassifiedRound[], label: string): void {
  const expected = normal.slice(normal.length - escalated.length).map((round) => round.round_id);
  const actual = escalated.map((round) => round.round_id);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Impossible compaction partition: escalated ${label} is not a suffix subset of normal ${label}.`);
}
