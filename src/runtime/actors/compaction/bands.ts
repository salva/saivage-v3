import type { ClassifiedRound, PositionedMessage } from './round-classifier.js';

export type SnapPolicy = 'keep_straddler_verbatim' | 'compact_straddler';

export type BandConfig = {
  buffer_tokens: number;
  merge_line_fraction: number;
  summary_line_fraction: number;
  trigger_fraction: number;
  snap: SnapPolicy;
};

export type BandPartitions = {
  raw_boundaries: { merge_line: number; summary_line: number; trigger: number };
  snapped_boundaries: { merge_line: number; summary_line: number; trigger: number };
  already_compacted_history: PositionedMessage[];
  merge_rounds: ClassifiedRound[];
  summary_rounds: ClassifiedRound[];
  tail_rounds: ClassifiedRound[];
};

export function computeCompactionBands(args: {
  total_estimated_tokens: number;
  rounds: ClassifiedRound[];
  already_compacted_history?: PositionedMessage[];
  config: BandConfig;
}): BandPartitions {
  validateConfig(args.config);
  const raw = {
    merge_line: Math.min(args.total_estimated_tokens, Math.floor(args.config.buffer_tokens * args.config.merge_line_fraction)),
    summary_line: Math.min(args.total_estimated_tokens, Math.floor(args.config.buffer_tokens * args.config.summary_line_fraction)),
    trigger: Math.min(args.total_estimated_tokens, Math.floor(args.config.buffer_tokens * args.config.trigger_fraction)),
  };
  const snapped = {
    merge_line: snapBoundary(raw.merge_line, args.rounds, args.config.snap),
    summary_line: snapBoundary(raw.summary_line, args.rounds, args.config.snap),
    trigger: snapBoundary(raw.trigger, args.rounds, args.config.snap),
  };

  const mergeRounds: ClassifiedRound[] = [];
  const summaryRounds: ClassifiedRound[] = [];
  const tailRounds: ClassifiedRound[] = [];
  for (const round of args.rounds) {
    if (round.end_token <= snapped.merge_line) mergeRounds.push(round);
    else if (round.end_token <= snapped.summary_line) summaryRounds.push(round);
    else tailRounds.push(round);
  }

  return {
    raw_boundaries: raw,
    snapped_boundaries: snapped,
    already_compacted_history: args.already_compacted_history ?? [],
    merge_rounds: mergeRounds,
    summary_rounds: summaryRounds,
    tail_rounds: tailRounds,
  };
}

function snapBoundary(rawBoundary: number, rounds: ClassifiedRound[], policy: SnapPolicy): number {
  const straddler = rounds.find((round) => round.start_token < rawBoundary && rawBoundary < round.end_token);
  if (!straddler) return rawBoundary;
  return policy === 'keep_straddler_verbatim' ? straddler.start_token : straddler.end_token;
}

function validateConfig(config: BandConfig): void {
  if (config.buffer_tokens <= 0) throw new Error('Compaction buffer_tokens must be positive.');
  if (!(config.merge_line_fraction >= 0 && config.merge_line_fraction <= config.summary_line_fraction)) throw new Error('Compaction merge_line_fraction must be <= summary_line_fraction.');
  if (!(config.summary_line_fraction <= config.trigger_fraction && config.trigger_fraction <= 1)) throw new Error('Compaction summary_line_fraction must be <= trigger_fraction <= 1.');
}
