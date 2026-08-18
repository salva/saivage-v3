import { randomUUID } from 'node:crypto';
import { canonicalValueSha256, type ConversationContinuation } from '../../../persistence/canonical-conversation-artifacts.js';
import {
  publishCompactedConversationSegment,
  readCurrentConversationSegment,
  type CompactionPublicationOptions,
  type CompactionSuccessorIdentity,
  type ConversationFileContext,
} from '../../../persistence/conversation-file.js';
import { compactedHistorySchema, coveredSourceGroupsSha256, accumulatedSummarySha256, foldDispositionCommitment, type AgentMessage, type CompactedHistory,
} from '../../../schemas/index.js';
import {
  deriveRequiredModelFacts,
  selectAtomicCoveredSourceGroups,
  validateCompactedHistorySuccessor,
  validateConversation,
  type CompactedGenesisSeed,
  type InheritedConversationActivation,
  type SourceRound,
  type ValidatedConversation,
} from '../../../contracts/conversation-validation.js';
import type { ProviderConversationProjection, ToolDefinition,
} from '../../../agents/llm-contracts.js';
import type { PreparedCompaction, PreparedLlmInvocationInput } from '../llm-invocation.js';
import { providerConversationProjection } from '../conversation-session.js';
import { assertEscalatedSuffixSubsets, computeSlidingCompactionBands, type SlidingBandPartitions, type SnapPolicy,
} from './bands.js';
import { classifyConversationRounds, estimateMessageTokens,
} from './round-classifier.js';
import { LocalExactAdmissionError } from '../../../agents/invocation-admission.js';
import { throwIfPublicationOutcomeUnknown } from '../../../contracts/index.js';
import { materializeAccumulatedSummary } from './summary-materializer.js';
import type { SummarizerProviderPort } from './summarizer.js';
import { versionFilename } from '../../../persistence/version-index.js';

export type AutonomousCompactionPolicy = {
  input_budget_tokens: number; trigger_fraction: number; completion_reserve_fraction: number;
  merge_line_fraction: number; summary_line_fraction: number; escalate_merge_line_fraction: number; escalate_summary_line_fraction: number;
  snap: SnapPolicy;
};

export function prepareCompaction(config: AutonomousCompactionPolicy, systemPrompt: string, tools: readonly ToolDefinition[], requestedCompletionTokens?: number,
): PreparedCompaction {
  const B = config.input_budget_tokens;
  if (!Number.isInteger(B) || B <= 0) throw new Error('compaction.input_budget_tokens must be a positive integer.');
  if (!(config.completion_reserve_fraction > 0 && config.completion_reserve_fraction <= 1)) throw new Error('compaction.completion_reserve_fraction must be > 0 and <= 1.');
  if (!(0 <= config.merge_line_fraction && config.merge_line_fraction <= config.summary_line_fraction && config.summary_line_fraction <= config.trigger_fraction && config.trigger_fraction <= 1)) throw new Error('Compaction normal fractions must satisfy 0 <= merge <= summary <= trigger <= 1.',
    );
  if (!(0 <= config.escalate_merge_line_fraction && config.escalate_merge_line_fraction <= config.escalate_summary_line_fraction && config.escalate_summary_line_fraction <= config.trigger_fraction)) throw new Error('Compaction escalated fractions must satisfy 0 <= escalate_merge <= escalate_summary <= trigger.',
    );
  if (config.trigger_fraction + config.completion_reserve_fraction > 1) throw new Error('compaction trigger_fraction + completion_reserve_fraction must be <= 1.');
  const normalTailWidth = config.trigger_fraction - config.summary_line_fraction;
  const normalMiddleWidth = config.summary_line_fraction - config.merge_line_fraction;
  const escalatedTailWidth = config.trigger_fraction - config.escalate_summary_line_fraction;
  const escalatedMiddleWidth = config.escalate_summary_line_fraction - config.escalate_merge_line_fraction;
  if (escalatedTailWidth > normalTailWidth) throw new Error(`Escalated compaction tail width must be <= normal tail width (trigger - summary): escalated=${JSON.stringify(escalatedTailWidth)}, normal=${JSON.stringify(normalTailWidth)}.`,
    );
  if (escalatedMiddleWidth > normalMiddleWidth)
    throw new Error(
      `Escalated compaction middle width must be <= normal middle width (summary - merge): escalated=${JSON.stringify(escalatedMiddleWidth)}, normal=${JSON.stringify(normalMiddleWidth)}.`,
    );
  const reservedCompletionTokens = Math.floor(B * config.completion_reserve_fraction);
  if (reservedCompletionTokens < 1)
    throw new Error('compaction reservedCompletionTokens must be positive.');
  const requested = requestedCompletionTokens ?? reservedCompletionTokens;
  if (!Number.isInteger(requested) || requested < 1)
    throw new Error('compaction requestedCompletionTokens must be a positive integer.');
  if (requested > reservedCompletionTokens)
    throw new Error(
      `compaction requestedCompletionTokens (${requested}) must not exceed reservedCompletionTokens (${reservedCompletionTokens}).`,
    );
  const normalTailBudget = Math.floor(B * normalTailWidth);
  const normalMiddleBudget = Math.floor(B * normalMiddleWidth);
  const escalatedTailBudget = Math.floor(B * escalatedTailWidth);
  const escalatedMiddleBudget = Math.floor(B * escalatedMiddleWidth);
  const triggerLineTokens = Math.floor(B * config.trigger_fraction);
  const estimatedStaticTokens = estimateCanonicalStaticTokens(systemPrompt, tools);
  const triggerMessageThreshold = triggerLineTokens - estimatedStaticTokens;
  const canonicalMessageHardCeiling = B - estimatedStaticTokens - reservedCompletionTokens;
  if (
    !Number.isFinite(estimatedStaticTokens) ||
    estimatedStaticTokens < 0 ||
    triggerMessageThreshold <= 0 ||
    canonicalMessageHardCeiling <= 0 ||
    triggerMessageThreshold > canonicalMessageHardCeiling
  ) {
    throw new Error(
      `Prompt/tool surface does not fit the compaction budget (input_budget_tokens=${B}, estimated_static_tokens=${estimatedStaticTokens}, reserved_completion_tokens=${reservedCompletionTokens}, requested_completion_tokens=${requested}, trigger_message_threshold=${triggerMessageThreshold}, canonical_message_hard_ceiling=${canonicalMessageHardCeiling}). Raise compaction.input_budget_tokens or reduce the prompt/tool surface.`,
    );
  }
  return {
    inputBudgetTokens: B,
    reservedCompletionTokens,
    requestedCompletionTokens: requested,
    triggerLineTokens,
    estimatedStaticTokens,
    triggerMessageThreshold,
    canonicalMessageHardCeiling,
    normalTailBudget,
    normalMiddleBudget,
    escalatedTailBudget,
    escalatedMiddleBudget,
    triggerFraction: config.trigger_fraction,
    completionReserveFraction: config.completion_reserve_fraction,
    normalMergeLineFraction: config.merge_line_fraction,
    normalSummaryLineFraction: config.summary_line_fraction,
    escalatedMergeLineFraction: config.escalate_merge_line_fraction,
    escalatedSummaryLineFraction: config.escalate_summary_line_fraction,
    snap: config.snap,
  };
}

export function estimateCanonicalStaticTokens(
  systemPrompt: string,
  tools: readonly ToolDefinition[],
): number {
  return estimateTextTokens(systemPrompt) + estimateTextTokens(JSON.stringify(tools));
}

export function shouldCompact(input: PreparedLlmInvocationInput): boolean {
  const budget = input.preparedCompaction;
  const estimatedMessageTokens = input.providerConversation.messages.reduce(
    (sum, row) => sum + estimateMessageTokens(row),
    0,
  );
  return estimatedMessageTokens >= budget.triggerMessageThreshold;
}

export type CompactionStrategy = 'preventive' | 'authoritative_context_recovery' | 'local_exact_admission';
export type CompactionResult =
  | {
      kind: 'compacted';
      providerConversation: ProviderConversationProjection;
      estimatedProviderMessageTokens: number;
    }
  | {
      kind: 'no_smaller_projection';
      rejectedEstimatedProviderMessageTokens: number;
      smallestCandidateEstimatedProviderMessageTokens: number | null;
    };

export class CompactionSummaryConstructionError extends Error {
  constructor(cause: unknown) {
    super('Failed to construct compaction summary.', { cause });
    this.name = 'CompactionSummaryConstructionError';
  }
}

export class CompactionAppendError extends Error {
  constructor(cause: unknown) {
    super('Failed to append canonical context compaction.', { cause });
    this.name = 'CompactionAppendError';
  }
}

export type CompactArgs = {
  strategy: CompactionStrategy;
  conversations: ConversationFileContext;
  input: PreparedLlmInvocationInput;
  summarizerProvider: SummarizerProviderPort;
  signal: AbortSignal;
  publication?: CompactionPublicationOptions;
};
type Candidate = {
  history: CompactedHistory;
  cutoffSourceIndex: number;
  cutoffMessageId: string;
  providerConversation: ProviderConversationProjection;
  estimatedProviderMessageTokens: number;
  composedProviderConversationBytes: number;
};

export async function compact(args: CompactArgs): Promise<CompactionResult> {
  const projectRoot = args.conversations.projectRoot;
  const sessionId = args.input.sessionId;
  const budget = args.input.preparedCompaction;
  const segment = readCurrentConversationSegment(projectRoot, sessionId);
  const rejectedEstimatedProviderMessageTokens = estimateProviderConversationTokens(
    args.input.providerConversation,
  );
  const rejectedComposedProviderConversationBytes = composedProviderConversationBytes(args.input.providerConversation);
  if (!segment) {
    if (args.strategy === 'preventive')
      throw new Error(`Conversation '${sessionId}' has no current segment to compact.`);
    return { kind: 'no_smaller_projection', rejectedEstimatedProviderMessageTokens, smallestCandidateEstimatedProviderMessageTokens: null };
  }
  const conversation = segment.conversation;
  assertFreshCompactionProjection(args.input, conversation);
  const sourceRows = conversation.sourceRows;
  const sourceGenesis: CompactedGenesisSeed | null = segment.genesis.kind === 'compacted_segment_genesis'
    ? { id: segment.genesis.id, timestamp: segment.genesis.timestamp, history: segment.genesis.compaction, sourceVersion: segment.genesis.source.version }
    : null;
  const sourceVersion = segment.entry.version;
  const inheritedHistory = sourceGenesis?.history ?? null;
  const classified = classifyConversationRounds(conversation);
  const successorIdentity = allocateSuccessorIdentity(segment.entry.version);
  let smallestCandidateEstimatedProviderMessageTokens: number | null = null;
  const computedNormal = computeSlidingCompactionBands(classified.rounds, {
    tail_budget_tokens: budget.normalTailBudget,
    middle_budget_tokens: budget.normalMiddleBudget,
    snap: budget.snap,
  });
  const computedEscalated = computeSlidingCompactionBands(classified.rounds, {
    tail_budget_tokens: budget.escalatedTailBudget,
    middle_budget_tokens: budget.escalatedMiddleBudget,
    snap: budget.snap,
  });
  assertEscalatedSuffixSubsets(computedNormal, computedEscalated);

  const accepted = (estimated: number): boolean =>
    args.strategy === 'preventive'
      ? estimated <= budget.triggerMessageThreshold
      : estimated < rejectedEstimatedProviderMessageTokens;

  const candidateFor = async (coveredRows: readonly AgentMessage[]): Promise<Candidate | null> => {
    if (coveredRows.length === 0) return null;
    const summaryText = await constructAccumulatedSummary(args, inheritedHistory, coveredRows, conversation);
    args.signal.throwIfAborted();
    const successor = buildSuccessorHistory({ conversation, sessionId, sourceVersion, sourceGenesis, coveredRows, summaryText });
    validateCompactedHistorySuccessor({ source: conversation, sourceGenesis, sourceVersion, successor, coveredRows });
    const cutoffSourceIndex = coveredRows.length - 1;
    const tail = sourceRows.slice(coveredRows.length);
    const seed: CompactedGenesisSeed = { id: successorIdentity.genesisId, timestamp: successorIdentity.timestamp, history: successor, sourceVersion };
    const { inherited } = successorContinuation(conversation, coveredRows);
    const prospective = validateConversation(sessionId, tail, inherited, seed);
    const providerConversation = providerConversationProjection(prospective);
    const estimatedProviderMessageTokens = estimateProviderConversationTokens(providerConversation);
    smallestCandidateEstimatedProviderMessageTokens =
      smallestCandidateEstimatedProviderMessageTokens === null
        ? estimatedProviderMessageTokens
        : Math.min(smallestCandidateEstimatedProviderMessageTokens, estimatedProviderMessageTokens);
    return {
      history: successor,
      cutoffSourceIndex,
      cutoffMessageId: coveredRows[cutoffSourceIndex]!.id,
      providerConversation,
      estimatedProviderMessageTokens,
      composedProviderConversationBytes: composedProviderConversationBytes(providerConversation),
    };
  };

  const partitionBaseRows = (partition: SlidingBandPartitions): readonly AgentMessage[] => [
    ...classified.preamble.map((row) => row.message),
    ...partition.merge_rounds.flatMap(rawRoundRows),
    ...partition.summary_rounds.flatMap(rawRoundRows),
  ];

  const evaluatePartition = async (partition: SlidingBandPartitions, mode: 'bounded' | 'all'): Promise<Candidate[]> => {
    const baseRows = partitionBaseRows(partition);
    const base = await candidateFor(baseRows);
    if (mode === 'bounded' && base && accepted(base.estimatedProviderMessageTokens)) return [base];
    const evaluated: Candidate[] = base ? [base] : [];
    for (const cutoff of safeFallbackCutoffs(conversation, baseRows.length)) {
      args.signal.throwIfAborted();
      const candidate = await candidateFor(conversation.sourceRows.slice(0, cutoff));
      if (candidate) evaluated.push(candidate);
    }
    if (mode === 'bounded') {
      const acceptedCandidates = evaluated.filter((entry) => accepted(entry.estimatedProviderMessageTokens));
      return acceptedCandidates.length > 0 ? [acceptedCandidates[acceptedCandidates.length - 1]!] : [];
    }
    return evaluated;
  };

  let candidate: Candidate | null = null;
  if (args.strategy === 'preventive') {
    candidate = (await evaluatePartition(computedNormal, 'bounded')).at(-1) ?? null;
    if (!candidate) candidate = (await evaluatePartition(computedEscalated, 'bounded')).at(-1) ?? null;
    if (!candidate)
      throw new Error(
        'Compaction could not fit the residual context below the trigger threshold without splitting an indivisible provider bundle. Raise compaction.input_budget_tokens or reduce the prompt/tool surface.',
      );
  } else if (args.strategy === 'authoritative_context_recovery') {
    candidate = (await evaluatePartition(computedEscalated, 'bounded')).at(-1) ?? null;
    if (!candidate) {
      return {
        kind: 'no_smaller_projection',
        rejectedEstimatedProviderMessageTokens,
        smallestCandidateEstimatedProviderMessageTokens,
      };
    }
  } else {
    const evaluated = await evaluatePartition(computedEscalated, 'all');
    const selected = evaluated
      .filter((entry) => entry.composedProviderConversationBytes < rejectedComposedProviderConversationBytes)
      .reduce<Candidate | null>(
        (best, entry) =>
          best === null ||
          entry.composedProviderConversationBytes < best.composedProviderConversationBytes ||
          (entry.composedProviderConversationBytes === best.composedProviderConversationBytes && entry.cutoffSourceIndex > best.cutoffSourceIndex)
            ? entry
            : best,
        null,
      );
    if (!selected) {
      return {
        kind: 'no_smaller_projection',
        rejectedEstimatedProviderMessageTokens,
        smallestCandidateEstimatedProviderMessageTokens,
      };
    }
    candidate = selected;
  }
  args.signal.throwIfAborted();
  let published: ValidatedConversation;
  try {
    published = publishCompactedConversationSegment(args.conversations, sessionId, {
      identity: successorIdentity,
      history: candidate.history,
      cutoffSourceIndex: candidate.cutoffSourceIndex,
      cutoffMessageId: candidate.cutoffMessageId,
      continuation: successorContinuation(conversation, sourceRows.slice(0, candidate.cutoffSourceIndex + 1)).continuation,
    }, args.publication);
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    throw new CompactionAppendError(error);
  }
  const providerConversation = providerConversationProjection(published);
  return {
    kind: 'compacted',
    providerConversation,
    estimatedProviderMessageTokens: estimateProviderConversationTokens(providerConversation),
  };
}

function allocateSuccessorIdentity(sourceVersion: number): CompactionSuccessorIdentity {
  const segmentVersion = sourceVersion + 1;
  return {
    genesisId: randomUUID(),
    segmentVersion,
    entryId: randomUUID(),
    timestamp: new Date().toISOString(),
    filename: versionFilename(segmentVersion, randomUUID(), 'jsonl'),
  };
}

function safeFallbackCutoffs(conversation: ValidatedConversation, baseCount: number): number[] {
  const ordinals = new Map(conversation.sourceRows.map((row, index) => [row.id, index] as const));
  const safeEnds = new Set(conversation.safeSourcePrefixEnds);
  const cutoffs: number[] = [];
  for (const round of conversation.rounds) {
    const roundStart = ordinals.get(round.rows[0]!.id);
    if (roundStart === undefined) throw new Error(`Compaction round '${round.label}' does not identify a source row.`);
    const roundEnd = roundStart + round.rows.length;
    if (roundEnd <= baseCount) continue;
    if (round.state === 'open') {
      for (const safeEnd of conversation.safeSourcePrefixEnds)
        if (safeEnd > Math.max(roundStart, baseCount) && safeEnd <= roundEnd) cutoffs.push(safeEnd);
    } else if (safeEnds.has(roundEnd)) {
      cutoffs.push(roundEnd);
    }
  }
  return cutoffs;
}

function assertFreshCompactionProjection(input: PreparedLlmInvocationInput, conversation: ValidatedConversation): void {
  const fresh = providerConversationProjection(conversation);
  if (providerConversationFingerprint(fresh) !== providerConversationFingerprint(input.providerConversation))
    throw new Error(
      `Compaction rejected provider projection is stale: it is not the exact effective projection of the freshly read conversation '${conversation.sourceSessionId}'.`,
    );
}

function providerConversationFingerprint(projection: ProviderConversationProjection): string {
  return JSON.stringify([
    projection.sourceSessionId,
    projection.messages.map((row) => [row.id, row.role, row.kind, row.content, row.tool ?? null, row.tool_call_id ?? null]),
  ]);
}

function composedProviderConversationBytes(projection: ProviderConversationProjection): number {
  return Buffer.byteLength(JSON.stringify(projection.messages.map((row) => [row.id, row.role, row.kind, row.content])), 'utf8');
}

function buildSuccessorHistory(args: {
  conversation: ValidatedConversation;
  sessionId: string;
  sourceVersion: number;
  sourceGenesis: CompactedGenesisSeed | null;
  coveredRows: readonly AgentMessage[];
  summaryText: string;
}): CompactedHistory {
  const selection = selectAtomicCoveredSourceGroups(args.conversation, args.coveredRows);
  return compactedHistorySchema.parse({
    summaryText: args.summaryText,
    source: args.sourceGenesis
      ? { kind: 'prior_genesis_plus_current_rows', priorGenesisId: args.sourceGenesis.id, priorHistoryHash: canonicalValueSha256(args.sourceGenesis.history), groups: selection.groups }
      : { kind: 'current_rows', groups: selection.groups },
    dispositionCommitment: foldDispositionCommitment(args.sourceGenesis?.history.dispositionCommitment ?? null, selection.dispositions),
    coverageCommitment: {
      sourceSessionId: args.sessionId,
      sourceVersion: args.sourceVersion,
      coveredThroughMessageId: args.coveredRows.at(-1)!.id,
      coveredSourceGroupsSha256: coveredSourceGroupsSha256(selection.groups),
      accumulatedSummarySha256: accumulatedSummarySha256(args.summaryText),
    },
    requiredModelFacts: deriveRequiredModelFacts({
      inherited: args.sourceGenesis?.history.requiredModelFacts ?? { latestRecovery: null, latestContentPolicyRefusal: null },
      coveredRows: args.coveredRows,
      source: args.conversation,
    }),
  });
}

async function constructAccumulatedSummary(
  args: CompactArgs,
  inheritedHistory: CompactedHistory | null,
  coveredRows: readonly AgentMessage[],
  conversation: ValidatedConversation,
): Promise<string> {
  try {
    return await materializeAccumulatedSummary({
      conversation,
      inheritedHistory,
      coveredRows,
      summarizerProvider: args.summarizerProvider,
      budget: {
        inputBudgetTokens: args.input.preparedCompaction.inputBudgetTokens,
        completionReserveTokens: args.input.preparedCompaction.reservedCompletionTokens,
      },
      signal: args.signal,
    });
  } catch (error) {
    if (error instanceof LocalExactAdmissionError) throw new CompactionSummaryConstructionError(error);
    throw error;
  }
}

function successorContinuation(
  conversation: ValidatedConversation,
  coveredRows: readonly AgentMessage[],
): { inherited: InheritedConversationActivation | undefined; continuation: ConversationContinuation } {
  const cutoffId = coveredRows.at(-1)!.id;
  const round = conversation.rounds.find((candidate) => candidate.rows.some((row) => row.id === cutoffId));
  if (!round) throw new Error('Compaction cutoff does not identify a validated canonical round.');
  const coveredIds = new Set(coveredRows.map((row) => row.id));
  const fullyCovered = round.rows.every((row) => coveredIds.has(row.id));
  if (fullyCovered && round.state === 'closed')
    return { inherited: undefined, continuation: { kind: 'between_rounds' } };
  const activation = round.activation.source === 'row'
    ? { marker_id: round.activation.message.id, input_id: JSON.parse(round.activation.message.content).input_id as string }
    : { marker_id: round.activation.marker_id, input_id: round.activation.input_id };
  const activeSegmentKind = coveredSegmentKinds(round, coveredIds).at(-1) ?? 'initial';
  return {
    inherited: { markerId: activation.marker_id, inputId: activation.input_id, activeSegmentKind, startOrdinal: 0 },
    continuation: { kind: 'inherited_open_round', activation, active_segment_kind: activeSegmentKind },
  };
}

function coveredSegmentKinds(round: SourceRound, coveredIds: ReadonlySet<string>): ('initial' | 'repair')[] {
  const kinds: ('initial' | 'repair')[] = [];
  for (const segment of round.segments) {
    if (segment.rows.some((row) => coveredIds.has(row.id))) kinds.push(segment.kind);
  }
  return kinds;
}

function rawRoundRows(round: { rows: readonly { message: AgentMessage }[] }): AgentMessage[] {
  return round.rows.map((row) => row.message);
}

function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function estimateProviderConversationTokens(projection: ProviderConversationProjection): number {
  return projection.messages.reduce((sum, row) => sum + estimateMessageTokens(row), 0);
}
