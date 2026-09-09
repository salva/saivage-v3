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
import { classifyConversationRounds, estimateMessageTokens,
} from './round-classifier.js';
import { throwIfPublicationOutcomeUnknown } from '../../../contracts/index.js';
import { createSequentialRefineAccumulator, SummaryConstructionLimitError } from './refine-accumulator.js';
import { SummaryResultValidationError, type SummarizerProviderPort } from './summarizer.js';
import { versionFilename } from '../../../persistence/version-index.js';
import { estimateUtf8Tokens } from './token-estimator.js';

export type AutonomousCompactionPolicy = {
  input_budget_tokens: number; trigger_fraction: number; completion_reserve_fraction: number;
  tail_fraction: number;
  snap: 'keep_straddler_verbatim' | 'compact_straddler';
};

export function prepareCompaction(config: AutonomousCompactionPolicy, systemPrompt: string, tools: readonly ToolDefinition[], requestedCompletionTokens?: number,
): PreparedCompaction {
  const B = config.input_budget_tokens;
  if (!Number.isInteger(B) || B <= 0) throw new Error('compaction.input_budget_tokens must be a positive integer.');
  if (!(config.completion_reserve_fraction > 0 && config.completion_reserve_fraction <= 1)) throw new Error('compaction.completion_reserve_fraction must be > 0 and <= 1.');
  if (!(config.trigger_fraction > 0 && config.trigger_fraction <= 1)) throw new Error('compaction.trigger_fraction must be > 0 and <= 1.');
  if (!(config.tail_fraction >= 0 && config.tail_fraction <= config.trigger_fraction)) throw new Error('compaction.tail_fraction must satisfy 0 <= tail_fraction <= trigger_fraction.');
  if (config.trigger_fraction + config.completion_reserve_fraction > 1) throw new Error('compaction trigger_fraction + completion_reserve_fraction must be <= 1.');
  const reservedCompletionTokens = Math.floor(B * config.completion_reserve_fraction);
  if (reservedCompletionTokens < 2000)
    throw new Error('compaction reservedCompletionTokens must be at least 2000.');
  const requested = requestedCompletionTokens ?? reservedCompletionTokens;
  if (!Number.isInteger(requested) || requested < 1)
    throw new Error('compaction requestedCompletionTokens must be a positive integer.');
  if (requested > reservedCompletionTokens)
    throw new Error(
      `compaction requestedCompletionTokens (${requested}) must not exceed reservedCompletionTokens (${reservedCompletionTokens}).`,
    );
  const tailBudgetTokens = Math.floor(B * config.tail_fraction);
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
    tailBudgetTokens,
    triggerFraction: config.trigger_fraction,
    completionReserveFraction: config.completion_reserve_fraction,
    tailFraction: config.tail_fraction,
    snap: config.snap,
  };
}

function estimateCanonicalStaticTokens(
  systemPrompt: string,
  tools: readonly ToolDefinition[],
): number {
  return estimateUtf8Tokens(systemPrompt) + estimateUtf8Tokens(JSON.stringify(tools));
}

export function shouldCompact(input: PreparedLlmInvocationInput): boolean {
  const budget = input.preparedCompaction;
  const estimatedMessageTokens = input.providerConversation.messages.reduce(
    (sum, item) => sum + estimateProviderItemTokens(item),
    0,
  );
  return estimatedMessageTokens >= budget.triggerMessageThreshold;
}

export type CompactionStrategy = 'preventive' | 'authoritative_context_recovery' | 'local_exact_admission';
export type CompactionProgressCallbacks = Readonly<{
  foldStarted(): void;
  foldCompleted(): void;
}>;
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
  progress: CompactionProgressCallbacks;
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
  const endpoints = selectedCoverageEndpoints(conversation, classified, budget.tailBudgetTokens, budget.snap);
  const summaries = createSequentialRefineAccumulator({
    conversation,
    inheritedHistory,
    preparedBlocks: args.input.preparedContext.dynamicBlocks,
    summarizerProvider: args.summarizerProvider,
    budget: {
      inputBudgetTokens: budget.inputBudgetTokens,
      completionReserveTokens: budget.reservedCompletionTokens,
    },
    signal: args.signal,
    progress: args.progress,
  });

  const accepted = (estimated: number): boolean =>
    args.strategy === 'preventive'
      ? estimated <= budget.triggerMessageThreshold
      : estimated < rejectedEstimatedProviderMessageTokens;

  const candidateFor = async (cutoffCount: number): Promise<Candidate | null> => {
    if (cutoffCount === 0) return null;
    if (cutoffCount <= summaries.materializedThrough)
      throw new Error(`Compaction candidate cutoff ${cutoffCount} moved backward from materialized cutoff ${summaries.materializedThrough}.`);
    let summaryText: string;
    try {
      summaryText = await summaries.materializeThrough(cutoffCount);
    } catch (error) {
      if (error instanceof SummaryResultValidationError || error instanceof SummaryConstructionLimitError) throw new CompactionSummaryConstructionError(error);
      throw error;
    }
    args.signal.throwIfAborted();
    const coveredRows = sourceRows.slice(0, cutoffCount);
    const successor = buildSuccessorHistory({ conversation, sessionId, sourceVersion, sourceGenesis, coveredRows, summaryText });
    validateCompactedHistorySuccessor({ source: conversation, sourceGenesis, sourceVersion, successor, coveredRows });
    const cutoffSourceIndex = coveredRows.length - 1;
    const tail = sourceRows.slice(coveredRows.length);
    const seed: CompactedGenesisSeed = { id: successorIdentity.genesisId, timestamp: successorIdentity.timestamp, history: successor, sourceVersion };
    const { inherited } = successorContinuation(conversation, coveredRows);
    const prospective = validateConversation(sessionId, tail, inherited, seed);
    const providerConversation = providerConversationProjection(prospective, args.input.preparedContext.dynamicBlocks);
    const estimatedProviderMessageTokens = estimateProviderConversationTokens(providerConversation);
    smallestCandidateEstimatedProviderMessageTokens =
      smallestCandidateEstimatedProviderMessageTokens === null
        ? estimatedProviderMessageTokens
        : Math.min(smallestCandidateEstimatedProviderMessageTokens, estimatedProviderMessageTokens);
    const candidate = {
      history: successor,
      cutoffSourceIndex,
      cutoffMessageId: coveredRows[cutoffSourceIndex]!.id,
      providerConversation,
      estimatedProviderMessageTokens,
      composedProviderConversationBytes: composedProviderConversationBytes(providerConversation),
    };
    return candidate;
  };

  let candidate: Candidate | null = null;
  if (args.strategy === 'preventive') {
    for (const endpoint of endpoints) {
      const evaluated = await candidateFor(endpoint);
      if (evaluated && accepted(evaluated.estimatedProviderMessageTokens)) { candidate = evaluated; break; }
    }
    if (!candidate)
      throw new Error(
        'Compaction could not fit the residual context below the trigger threshold using the selected safe coverage endpoints. Raise compaction.input_budget_tokens or reduce the prompt/tool surface.',
      );
  } else if (args.strategy === 'authoritative_context_recovery') {
    for (const endpoint of endpoints) {
      const evaluated = await candidateFor(endpoint);
      if (evaluated && accepted(evaluated.estimatedProviderMessageTokens)) { candidate = evaluated; break; }
    }
    if (!candidate) {
      return {
        kind: 'no_smaller_projection',
        rejectedEstimatedProviderMessageTokens,
        smallestCandidateEstimatedProviderMessageTokens,
      };
    }
  } else {
    const evaluated: Candidate[] = [];
    for (const endpoint of endpoints) {
      const entry = await candidateFor(endpoint);
      if (entry) evaluated.push(entry);
    }
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
  const providerConversation = providerConversationProjection(published, args.input.preparedContext.dynamicBlocks);
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

function selectedCoverageEndpoints(
  conversation: ValidatedConversation,
  classified: ReturnType<typeof classifyConversationRounds>,
  tailBudgetTokens: number,
  snap: AutonomousCompactionPolicy['snap'],
): readonly number[] {
  const closed = classified.rounds.filter((round) => round.state === 'closed');
  let retained = 0;
  let firstRetained = closed.length;
  for (let index = closed.length - 1; index >= 0; index--) {
    const round = closed[index]!;
    if (retained + round.estimated_tokens <= tailBudgetTokens) {
      retained += round.estimated_tokens;
      firstRetained = index;
      continue;
    }
    if (snap === 'keep_straddler_verbatim') firstRetained = index;
    break;
  }
  const desiredBase = classified.preamble.length + closed.slice(0, firstRetained).reduce((count, round) => count + round.rows.length, 0);
  const base = conversation.safeSourcePrefixEnds.includes(desiredBase) ? desiredBase : 0;
  const furthest = conversation.safeSourcePrefixEnds.at(-1) ?? 0;
  const endpoints = [base, furthest].filter((value, index, values) => value > 0 && (index === 0 || value > values[index - 1]!));
  return Object.freeze(endpoints);
}

function assertFreshCompactionProjection(input: PreparedLlmInvocationInput, conversation: ValidatedConversation): void {
  const fresh = providerConversationProjection(conversation, input.preparedContext.dynamicBlocks);
  if (providerConversationFingerprint(fresh) !== providerConversationFingerprint(input.providerConversation))
    throw new Error(
      `Compaction rejected provider projection is stale: it is not the exact effective projection of the freshly read conversation '${conversation.sourceSessionId}'.`,
    );
}

function providerConversationFingerprint(projection: ProviderConversationProjection): string {
  return JSON.stringify([
    projection.sourceSessionId,
    projection.messages.map((item) => item.kind === 'synthetic_context'
      ? [item.kind, item.origin, item.block_identity, item.role, item.content]
      : [item.id, item.role, item.kind, item.content, item.tool ?? null, item.tool_call_id ?? null]),
  ]);
}

function composedProviderConversationBytes(projection: ProviderConversationProjection): number {
  return Buffer.byteLength(JSON.stringify(projection.messages.map((item) => item.kind === 'synthetic_context'
    ? [item.kind, item.origin, item.block_identity, item.role, item.content]
    : [item.id, item.role, item.kind, item.content])), 'utf8');
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

function estimateProviderConversationTokens(projection: ProviderConversationProjection): number {
  return projection.messages.reduce((sum, item) => sum + estimateProviderItemTokens(item), 0);
}

function estimateProviderItemTokens(item: ProviderConversationProjection['messages'][number]): number {
  return item.kind === 'synthetic_context'
    ? Math.max(1, estimateUtf8Tokens(`${item.role} ${item.kind} ${item.origin} ${item.block_identity} ${item.content}`))
    : estimateMessageTokens(item);
}
