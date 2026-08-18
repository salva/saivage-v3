import { randomUUID } from 'node:crypto';
import { canonicalValueSha256, type ConversationContinuation } from '../../../persistence/canonical-conversation-artifacts.js';
import { publishCompactedConversationSegment, readCurrentConversationSegment, type ConversationFileContext,
} from '../../../persistence/conversation-file.js';
import { canonicalJson, compactedHistorySchema, coveredSourceGroupsSha256, accumulatedSummarySha256, foldDispositionCommitment, type AgentMessage, type CompactedHistory,
} from '../../../schemas/index.js';
import {
  deriveRequiredModelFacts,
  isSafeValidatedSourcePrefix,
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
import { MODEL_RECOVERY_NOTICE_TEXT, contentPolicyRefusalProjectionText } from '../../../schemas/index.js';
import { assertEscalatedSuffixSubsets, computeSlidingCompactionBands, type SlidingBandPartitions, type SnapPolicy,
} from './bands.js';
import { classifyConversationRounds, estimateMessageTokens, type ClassifiedConversation, type ClassifiedRound,
} from './round-classifier.js';
import {
  buildSummarizerRoundInput,
  summarizeMerge, summarizeRound, SummaryResultValidationError, type MergeSummaryInput, type SummarizerProviderPort,
} from './summarizer.js';

const EMPTY_ROUND_SUMMARY = 'This round contained no provider-visible conversation content.';
const EMPTY_COVERAGE_SUMMARY = 'These rounds contained no provider-visible conversation content.';

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

// local_exact_admission maximal safe-prefix reduction/smallest-projection selection lands with the Unit 8 compactor rework; it currently shares the authoritative smaller-than-rejected path.
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
};
type Candidate = {
  history: CompactedHistory;
  cutoffSourceIndex: number;
  cutoffMessageId: string;
  providerConversation: ProviderConversationProjection;
  estimatedProviderMessageTokens: number;
};

export async function compact(args: CompactArgs): Promise<CompactionResult> {
  const projectRoot = args.conversations.projectRoot;
  const sessionId = args.input.sessionId;
  const budget = args.input.preparedCompaction;
  const segment = readCurrentConversationSegment(projectRoot, sessionId);
  const rejectedEstimatedProviderMessageTokens = estimateProviderConversationTokens(
    args.input.providerConversation,
  );
  if (!segment) {
    if (args.strategy === 'preventive')
      throw new Error(`Conversation '${sessionId}' has no current segment to compact.`);
    return { kind: 'no_smaller_projection', rejectedEstimatedProviderMessageTokens, smallestCandidateEstimatedProviderMessageTokens: null };
  }
  const conversation = segment.conversation;
  const sourceRows = conversation.sourceRows;
  const sourceGenesis: CompactedGenesisSeed | null = segment.genesis.kind === 'compacted_segment_genesis'
    ? { id: segment.genesis.id, timestamp: segment.genesis.timestamp, history: segment.genesis.compaction, sourceVersion: segment.genesis.source.version }
    : null;
  const sourceVersion = segment.entry.version;
  const inheritedHistory = sourceGenesis?.history ?? null;
  const classified = classifyConversationRounds(conversation);
  const constructionArgs: ConstructionArgs = { ...args, conversation, sourceGenesis, sourceVersion, rawSummaryCache: new Map() };
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

  const candidateGenesis = { id: randomUUID(), timestamp: new Date().toISOString() } as const;
  const accepted = (estimated: number): boolean =>
    args.strategy === 'preventive'
      ? estimated <= budget.triggerMessageThreshold
      : estimated < rejectedEstimatedProviderMessageTokens;

  const candidateFor = async (coveredRows: readonly AgentMessage[]): Promise<Candidate | null> => {
    if (coveredRows.length === 0) return null;
    const summaryText = await constructAccumulatedSummary(constructionArgs, inheritedHistory, coveredRows, classified);
    args.signal.throwIfAborted();
    const successor = buildSuccessorHistory({ conversation, sessionId, sourceVersion, sourceGenesis, coveredRows, summaryText });
    validateCompactedHistorySuccessor({ source: conversation, sourceGenesis, sourceVersion, successor, coveredRows });
    const cutoffSourceIndex = coveredRows.length - 1;
    const tail = sourceRows.slice(coveredRows.length);
    const seed: CompactedGenesisSeed = { id: candidateGenesis.id, timestamp: candidateGenesis.timestamp, history: successor, sourceVersion };
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
    };
  };

  const coverWholeClosedRounds = async (partition: SlidingBandPartitions): Promise<Candidate | null> => {
    const coveredRows = [...partition.merge_rounds, ...partition.summary_rounds].flatMap(rawRoundRows);
    if (coveredRows.length === 0) return null;
    const candidate = await candidateFor(coveredRows);
    return candidate && accepted(candidate.estimatedProviderMessageTokens) ? candidate : null;
  };
  const coverWithFallback = async (partition: SlidingBandPartitions): Promise<Candidate | null> => {
    const whole = await coverWholeClosedRounds(partition);
    if (whole) return whole;
    return extendThroughBoundaryRound(constructionArgs, partition, candidateFor, accepted);
  };

  let candidate: Candidate | null = null;
  if (args.strategy === 'preventive') {
    candidate = await coverWithFallback(computedNormal);
    if (!candidate) candidate = await coverWithFallback(computedEscalated);
    if (!candidate)
      throw new Error(
        'Compaction could not fit the residual context below the trigger threshold without splitting an indivisible provider bundle. Raise compaction.input_budget_tokens or reduce the prompt/tool surface.',
      );
  } else {
    candidate = await coverWithFallback(computedEscalated);
    if (!candidate) {
      return {
        kind: 'no_smaller_projection',
        rejectedEstimatedProviderMessageTokens,
        smallestCandidateEstimatedProviderMessageTokens,
      };
    }
  }
  args.signal.throwIfAborted();
  try {
    publishCompactedConversationSegment(args.conversations, sessionId, {
      history: candidate.history,
      cutoffSourceIndex: candidate.cutoffSourceIndex,
      cutoffMessageId: candidate.cutoffMessageId,
      continuation: successorContinuation(conversation, sourceRows.slice(0, candidate.cutoffSourceIndex + 1)).continuation,
    });
  } catch (error) {
    throw new CompactionAppendError(error);
  }
  return {
    kind: 'compacted',
    providerConversation: candidate.providerConversation,
    estimatedProviderMessageTokens: candidate.estimatedProviderMessageTokens,
  };
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

type ConstructionArgs = CompactArgs & {
  conversation: ValidatedConversation;
  sourceGenesis: CompactedGenesisSeed | null;
  sourceVersion: number;
  rawSummaryCache: Map<string, string>;
};

async function constructAccumulatedSummary(
  args: ConstructionArgs,
  inheritedHistory: CompactedHistory | null,
  coveredRows: readonly AgentMessage[],
  classified: ClassifiedConversation,
): Promise<string> {
  const coveredIds = new Set(coveredRows.map((row) => row.id));
  const coveredRounds = classified.rounds.filter((round) => round.rows.some((row) => coveredIds.has(row.message.id)));
  const mergeInputs: MergeSummaryInput[] = [];
  if (inheritedHistory) mergeInputs.push({ round_id: 'prior accumulated history', summary_text: inheritedHistory.summaryText });
  appendSupersededSlotSummaries(mergeInputs, inheritedHistory, coveredRows, args.conversation);
  let addedContent = false;
  for (const round of coveredRounds) {
    args.signal.throwIfAborted();
    const rows = rawRoundRows(round);
    const fullyCovered = rows.every((row) => coveredIds.has(row.id));
    const selected = fullyCovered ? rows : rows.filter((row) => coveredIds.has(row.id));
    if (selected.length === 0) continue;
    mergeInputs.push({
      round_id: round.round_id,
      summary_text: await summarizeRoundForCompaction(args, round, selected),
    });
    addedContent = true;
    args.signal.throwIfAborted();
  }
  if (!addedContent && mergeInputs.length === 0) return EMPTY_COVERAGE_SUMMARY;
  if (!addedContent) throw new Error('Compaction found no newly covered conversation content.');
  if (mergeInputs.length === 1) return mergeInputs[0]!.summary_text;
  return mergeSummaryGroups(args, mergeInputs);
}

function appendSupersededSlotSummaries(
  mergeInputs: MergeSummaryInput[],
  inheritedHistory: CompactedHistory | null,
  coveredRows: readonly AgentMessage[],
  conversation: ValidatedConversation,
): void {
  if (!inheritedHistory) return;
  const facts = inheritedHistory.requiredModelFacts;
  if (facts.latestRecovery && coveredRows.some((row) => row.kind === 'model_recovered'))
    mergeInputs.push({
      round_id: `superseded recovery notice ${facts.latestRecovery.sourceMessageId}`,
      summary_text: `An earlier runtime interruption of activation ${facts.latestRecovery.activationInputId} was recovered before this history; its recovery notice read exactly: ${MODEL_RECOVERY_NOTICE_TEXT}`,
    });
  if (facts.latestContentPolicyRefusal && coveredRows.some((row) => row.kind === 'content_policy_refusal'))
    mergeInputs.push({
      round_id: `superseded refusal marker ${facts.latestContentPolicyRefusal.markerId}`,
      summary_text: `An earlier activation ${facts.latestContentPolicyRefusal.activationInputId} ended after repeated provider content-policy refusal; its replanning notice read exactly: ${contentPolicyRefusalProjectionText(conversation.sourceSessionId, facts.latestContentPolicyRefusal.markerId)}`,
    });
}

async function extendThroughBoundaryRound(
  args: ConstructionArgs,
  partition: SlidingBandPartitions,
  candidateFor: (coveredRows: readonly AgentMessage[]) => Promise<Candidate | null>,
  accepted: (estimated: number) => boolean,
): Promise<Candidate | null> {
  const base = [...partition.merge_rounds, ...partition.summary_rounds].flatMap(rawRoundRows);
  const boundary = args.conversation.rounds.find((round) => round.rows.some((row) => row.id === args.conversation.sourceRows[base.length]?.id));
  if (!boundary) return null;
  let furthest: Candidate | null = null;
  for (let length = 1; length <= boundary.rows.length; length++) {
    const prefix = boundary.rows.slice(0, length).map((row) => row);
    if (!isSafeValidatedPrefix(args.conversation, prefix)) continue;
    const candidate = await candidateFor([...base, ...prefix]);
    if (candidate && accepted(candidate.estimatedProviderMessageTokens)) furthest = candidate;
  }
  return furthest;
}

async function mergeSummaryGroups(args: CompactArgs, inputs: MergeSummaryInput[]): Promise<string> {
  const groupSize = 20;
  let current = inputs;
  while (current.length > groupSize) {
    const next: MergeSummaryInput[] = [];
    for (let index = 0; index < current.length; index += groupSize) {
      const group = current.slice(index, index + groupSize);
      next.push({
        round_id: group.map((entry) => entry.round_id).join(','),
        summary_text: await summarizeMergeForCompaction(args, group),
      });
      args.signal.throwIfAborted();
    }
    current = next;
  }
  return summarizeMergeForCompaction(args, current);
}

async function summarizeRoundForCompaction(
  args: ConstructionArgs,
  round: ClassifiedRound,
  rows: readonly AgentMessage[],
): Promise<string> {
  const input = buildSummarizerRoundInput(args.conversation, round.round_id, rows);
  if (input.providerConversation.messages.length === 0) return EMPTY_ROUND_SUMMARY;
  const cacheKey = rawSummaryCacheKey(rows);
  const cached = args.rawSummaryCache.get(cacheKey);
  if (cached !== undefined) return cached;
  args.signal.throwIfAborted();
  const summary = await constructSummary(() =>
    summarizeRound({ input, summarizerProvider: args.summarizerProvider, signal: args.signal }));
  args.signal.throwIfAborted();
  args.rawSummaryCache.set(cacheKey, summary);
  return summary;
}

async function summarizeMergeForCompaction(
  args: CompactArgs,
  entries: MergeSummaryInput[],
): Promise<string> {
  args.signal.throwIfAborted();
  const summary = await constructSummary(() =>
    summarizeMerge({ entries, summarizerProvider: args.summarizerProvider, signal: args.signal }));
  args.signal.throwIfAborted();
  return summary;
}

async function constructSummary<T>(
  construct: () => Promise<T>,
): Promise<T> {
  try {
    return await construct();
  } catch (error) {
    if (error instanceof SummaryResultValidationError)
      throw new CompactionSummaryConstructionError(error);
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

function rawRoundRows(round: ClassifiedRound): AgentMessage[] {
  return round.rows.map((row) => row.message);
}

function rawSummaryCacheKey(rows: readonly AgentMessage[]): string {
  return JSON.stringify(rows.map((row) => row.id));
}

function estimateTextTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function estimateProviderConversationTokens(projection: ProviderConversationProjection): number {
  return projection.messages.reduce((sum, row) => sum + estimateMessageTokens(row), 0);
}

function isSafeValidatedPrefix(conversation: ValidatedConversation, prefix: readonly AgentMessage[]): boolean {
  try {
    return isSafeValidatedSourcePrefix(conversation, prefix);
  } catch {
    return false;
  }
}
