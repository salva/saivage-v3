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
import { SUMMARY_OUTPUT_TARGET_BYTES, SummaryResultValidationError, type SummarizerProviderPort } from './summarizer.js';
import { ProviderTurnFailure } from '../../../agents/llm-contracts.js';
import { LlmRequestError } from '../../../contracts/llm-failure.js';
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
  foldFailed(): void;
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

type CompactionConstructionReason =
  | 'empty_output'
  | 'tool_calls'
  | 'incomplete_output'
  | 'request_context_capacity'
  | 'fold_limit'
  | 'no_reduction'
  | 'residual_capacity';

export class CompactionSummaryConstructionError extends Error {
  readonly reason: CompactionConstructionReason;
  readonly invocationCount: number;
  readonly invocationLimit: number;
  readonly correctionCount: number;
  readonly correctionLimit = 1;

  constructor(args: {
    reason: CompactionConstructionReason;
    invocationCount: number;
    invocationLimit?: number;
    correctionCount: number;
    summaryBytes?: number | null;
    summaryTargetBytes?: number;
    projectionTokens?: number;
    projectionCeiling?: number;
    cause: unknown;
  }) {
    const measurements = [
      args.summaryBytes !== undefined && args.summaryBytes !== null ? `summary_bytes=${args.summaryBytes}` : null,
      args.summaryTargetBytes !== undefined ? `summary_target_bytes=${args.summaryTargetBytes}` : null,
      args.projectionTokens !== undefined ? `projection_tokens=${args.projectionTokens}` : null,
      args.projectionCeiling !== undefined ? `projection_ceiling=${args.projectionCeiling}` : null,
    ].filter((value): value is string => value !== null);
    super(`Compaction summary construction failed: reason=${args.reason}, invocation_count=${args.invocationCount}, invocation_limit=${args.invocationLimit ?? 16}, correction_count=${args.correctionCount}, correction_limit=1${measurements.length ? `, ${measurements.join(', ')}` : ''}.`, { cause: args.cause });
    this.name = 'CompactionSummaryConstructionError';
    this.reason = args.reason;
    this.invocationCount = args.invocationCount;
    this.invocationLimit = args.invocationLimit ?? 16;
    this.correctionCount = args.correctionCount;
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
  args.signal.throwIfAborted();
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

  const candidateFor = async (cutoffCount: number): Promise<Candidate | null> => {
    if (cutoffCount === 0) return null;
    if (cutoffCount <= summaries.materializedThrough)
      throw new Error(`Compaction candidate cutoff ${cutoffCount} moved backward from materialized cutoff ${summaries.materializedThrough}.`);
    const summaryText = await summaries.materializeThrough(cutoffCount);
    return candidateFromSummary(cutoffCount, summaryText);
  };

  const candidateFromSummary = (cutoffCount: number, summaryText: string): Candidate => {
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
  const completed: Candidate[] = [];
  let expectedFailure: unknown = null;
  for (const endpoint of endpoints) {
    try {
      const evaluated = await candidateFor(endpoint);
      if (!evaluated) continue;
      completed.push(evaluated);
      if (args.strategy === 'authoritative_context_recovery' && isTokenReduction(evaluated)) { candidate = evaluated; break; }
      if (args.strategy === 'preventive' && isPreventiveCandidate(evaluated) && evaluated.estimatedProviderMessageTokens <= budget.triggerMessageThreshold) { candidate = evaluated; break; }
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      if (args.signal.aborted && error === args.signal.reason) throw error;
      if (!isExpectedRecoveryFailure(error)) throw error;
      expectedFailure = error;
      const retained = selectQualifying(completed);
      if (retained) candidate = retained;
      break;
    }
  }

  candidate ??= selectQualifying(completed);
  if (!candidate && expectedFailure === null && completed.length > 0 && summaries.canCorrectLatestFold) {
    const obstruction = finalObstruction(completed.at(-1)!);
    if (obstruction) {
      try {
        const correctedSummary = await summaries.correctLatestFold();
        const corrected = candidateFromSummary(summaries.materializedThrough, correctedSummary);
        completed.push(corrected);
        candidate = selectQualifying([corrected]);
        if (!candidate && args.strategy === 'preventive') expectedFailure = obstructionFor(corrected);
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (args.signal.aborted && error === args.signal.reason) throw error;
        if (!(error instanceof ProviderTurnFailure) &&
            !(error instanceof SummaryResultValidationError) &&
            !(error instanceof SummaryConstructionLimitError) &&
            !(error instanceof ProjectionObstruction)) throw error;
        expectedFailure = error;
      }
    }
  }

  if (!candidate) {
    if (expectedFailure instanceof ProviderTurnFailure) throw expectedFailure;
    if (expectedFailure instanceof SummaryResultValidationError || expectedFailure instanceof SummaryConstructionLimitError)
      throw constructionFailure(expectedFailure, summaries.invocationCount, summaries.correctionCount);
    if (expectedFailure instanceof ProjectionObstruction)
      throw constructionFailure(expectedFailure, summaries.invocationCount, summaries.correctionCount);
    if (args.strategy === 'preventive') {
      const obstruction = completed.length > 0 ? obstructionFor(completed.at(-1)!) : new ProjectionObstruction('request_context_capacity');
      throw constructionFailure(obstruction, summaries.invocationCount, summaries.correctionCount);
    }
    return {
      kind: 'no_smaller_projection',
      rejectedEstimatedProviderMessageTokens,
      smallestCandidateEstimatedProviderMessageTokens,
    };
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

  function isTokenReduction(value: Candidate): boolean {
    return value.estimatedProviderMessageTokens < rejectedEstimatedProviderMessageTokens;
  }

  function isPreventiveCandidate(value: Candidate): boolean {
    return isTokenReduction(value) && value.estimatedProviderMessageTokens <= budget.canonicalMessageHardCeiling;
  }

  function selectQualifying(values: readonly Candidate[]): Candidate | null {
    const qualifying = values.filter((value) => args.strategy === 'preventive'
      ? isPreventiveCandidate(value)
      : args.strategy === 'authoritative_context_recovery'
        ? isTokenReduction(value)
        : value.composedProviderConversationBytes < rejectedComposedProviderConversationBytes);
    if (args.strategy === 'authoritative_context_recovery') return qualifying[0] ?? null;
    return qualifying.reduce<Candidate | null>((best, value) => {
      if (!best) return value;
      const valueSize = args.strategy === 'local_exact_admission' ? value.composedProviderConversationBytes : value.estimatedProviderMessageTokens;
      const bestSize = args.strategy === 'local_exact_admission' ? best.composedProviderConversationBytes : best.estimatedProviderMessageTokens;
      return valueSize < bestSize || (valueSize === bestSize && value.cutoffSourceIndex > best.cutoffSourceIndex) ? value : best;
    }, null);
  }

  function finalObstruction(value: Candidate): ProjectionObstruction | null {
    return selectQualifying([value]) ? null : obstructionFor(value);
  }

  function obstructionFor(value: Candidate): ProjectionObstruction {
    if (args.strategy === 'preventive' && value.estimatedProviderMessageTokens > budget.canonicalMessageHardCeiling)
      return new ProjectionObstruction('residual_capacity', value.estimatedProviderMessageTokens, budget.canonicalMessageHardCeiling);
    if (args.strategy === 'local_exact_admission' && value.composedProviderConversationBytes >= rejectedComposedProviderConversationBytes)
      return new ProjectionObstruction('no_reduction');
    return new ProjectionObstruction('no_reduction', value.estimatedProviderMessageTokens, rejectedEstimatedProviderMessageTokens - 1);
  }
}

class ProjectionObstruction extends Error {
  constructor(
    readonly reason: 'request_context_capacity' | 'no_reduction' | 'residual_capacity',
    readonly projectionTokens?: number,
    readonly projectionCeiling?: number,
  ) {
    super(reason);
    this.name = 'ProjectionObstruction';
  }
}

function isExpectedRecoveryFailure(error: unknown): boolean {
  if (error instanceof SummaryResultValidationError || error instanceof SummaryConstructionLimitError) return true;
  return error instanceof ProviderTurnFailure && error.originalFailure instanceof LlmRequestError &&
    (error.originalFailure.failure.kind === 'output_token_limit_exceeded' ||
      error.originalFailure.failure.kind === 'input_context_exhausted' ||
      error.originalFailure.failure.kind === 'content_policy');
}

function constructionFailure(
  cause: SummaryResultValidationError | SummaryConstructionLimitError | ProjectionObstruction,
  invocationCount: number,
  correctionCount: number,
): CompactionSummaryConstructionError {
  if (cause instanceof SummaryResultValidationError)
    return new CompactionSummaryConstructionError({ reason: cause.reason, invocationCount, correctionCount, summaryBytes: cause.summaryBytes, summaryTargetBytes: SUMMARY_OUTPUT_TARGET_BYTES, cause });
  if (cause instanceof SummaryConstructionLimitError)
    return new CompactionSummaryConstructionError({ reason: cause.reason, invocationCount: cause.invocationCount, invocationLimit: cause.invocationLimit, correctionCount, cause });
  return new CompactionSummaryConstructionError({ reason: cause.reason, invocationCount, correctionCount, projectionTokens: cause.projectionTokens, projectionCeiling: cause.projectionCeiling, cause });
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
