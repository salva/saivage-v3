import { randomUUID } from 'node:crypto';
import { appendConversationBatch, readConversation, type ConversationFileContext } from '../../../persistence/conversation-file.js';
import { agentMessageSchema, canonicalJson, contextCompactionContentSchema, type AgentMessage, type ContextCompactionContent } from '../../../schemas/index.js';
import { hashConversationRows, validateConversationRows, type ValidatedContextCompaction, type ValidatedConversation } from '../../../contracts/conversation-compaction.js';
import { classifySourceSegments } from '../../../contracts/conversation-source-classification.js';
import { generateRoundId } from '../../../schemas/round-id-server.js';
import type { ToolDefinition } from '../../../agents/llm-contracts.js';
import type { LlmInvocationInput, PreparedCompaction } from '../llm-invocation.js';
import { conversationMessagesForModel } from '../conversation-session.js';
import { assertEscalatedSuffixSubsets, computeSlidingCompactionBands, type SlidingBandPartitions, type SnapPolicy } from './bands.js';
import { classifyConversationRounds, estimateMessageTokens, type ClassifiedConversation, type ClassifiedRound } from './round-classifier.js';
import { dropRecoverableResultBodies, recoverableEvidenceDescriptors } from './result-dropping.js';
import { summarizeMerge, summarizeRound, type MergeSummaryInput, type SummarizerProviderPort } from './summarizer.js';

export type CompactionConfig = {
  enabled: boolean; input_budget_tokens?: number; trigger_fraction: number; completion_reserve_fraction: number;
  merge_line_fraction: number; summary_line_fraction: number; escalate_merge_line_fraction: number; escalate_summary_line_fraction: number;
  snap: SnapPolicy; summarizer_model?: string;
};

export function prepareCompaction(config: CompactionConfig, systemPrompt: string, tools: readonly ToolDefinition[]): PreparedCompaction {
  if (!config.enabled) throw new Error('Compaction budget requested while compaction is disabled.');
  const B = config.input_budget_tokens;
  if (!Number.isInteger(B) || (B ?? 0) <= 0) throw new Error('compaction.input_budget_tokens must be a positive integer when compaction is enabled.');
  if (!(config.completion_reserve_fraction > 0 && config.completion_reserve_fraction <= 1)) throw new Error('compaction.completion_reserve_fraction must be > 0 and <= 1.');
  if (!(0 <= config.merge_line_fraction && config.merge_line_fraction <= config.summary_line_fraction && config.summary_line_fraction <= config.trigger_fraction && config.trigger_fraction <= 1)) throw new Error('Compaction normal fractions must satisfy 0 <= merge <= summary <= trigger <= 1.');
  if (!(0 <= config.escalate_merge_line_fraction && config.escalate_merge_line_fraction <= config.escalate_summary_line_fraction && config.escalate_summary_line_fraction <= config.trigger_fraction)) throw new Error('Compaction escalated fractions must satisfy 0 <= escalate_merge <= escalate_summary <= trigger.');
  if (config.trigger_fraction + config.completion_reserve_fraction > 1) throw new Error('compaction trigger_fraction + completion_reserve_fraction must be <= 1.');
  const normalTailWidth = config.trigger_fraction - config.summary_line_fraction;
  const normalMiddleWidth = config.summary_line_fraction - config.merge_line_fraction;
  const escalatedTailWidth = config.trigger_fraction - config.escalate_summary_line_fraction;
  const escalatedMiddleWidth = config.escalate_summary_line_fraction - config.escalate_merge_line_fraction;
  if (escalatedTailWidth > normalTailWidth) throw new Error(`Escalated compaction tail width must be <= normal tail width (trigger - summary): escalated=${JSON.stringify(escalatedTailWidth)}, normal=${JSON.stringify(normalTailWidth)}.`);
  if (escalatedMiddleWidth > normalMiddleWidth) throw new Error(`Escalated compaction middle width must be <= normal middle width (summary - merge): escalated=${JSON.stringify(escalatedMiddleWidth)}, normal=${JSON.stringify(normalMiddleWidth)}.`);
  const requestedCompletionTokens = Math.floor(B! * config.completion_reserve_fraction);
  if (requestedCompletionTokens < 1) throw new Error('compaction requestedCompletionTokens must be positive.');
  const normalTailBudget = Math.floor(B! * normalTailWidth);
  const normalMiddleBudget = Math.floor(B! * normalMiddleWidth);
  const escalatedTailBudget = Math.floor(B! * escalatedTailWidth);
  const escalatedMiddleBudget = Math.floor(B! * escalatedMiddleWidth);
  const triggerLineTokens = Math.floor(B! * config.trigger_fraction);
  const estimatedStaticTokens = estimateCanonicalStaticTokens(systemPrompt, tools);
  const triggerMessageThreshold = triggerLineTokens - estimatedStaticTokens;
  const canonicalMessageHardCeiling = B! - estimatedStaticTokens - requestedCompletionTokens;
  if (!Number.isFinite(estimatedStaticTokens) || estimatedStaticTokens < 0 || triggerMessageThreshold <= 0 || canonicalMessageHardCeiling <= 0 || triggerMessageThreshold > canonicalMessageHardCeiling) {
    throw new Error(`Autonomous prompt/tool surface does not fit the compaction budget (input_budget_tokens=${B}, estimated_static_tokens=${estimatedStaticTokens}, requested_completion_tokens=${requestedCompletionTokens}, trigger_message_threshold=${triggerMessageThreshold}, canonical_message_hard_ceiling=${canonicalMessageHardCeiling}). Raise compaction.input_budget_tokens, reduce the prompt/tool surface, or lower completion_reserve_fraction.`);
  }
  if (!config.summarizer_model?.trim()) throw new Error('Compaction is enabled but compaction.summarizer_model is unset.');
  return {
    inputBudgetTokens: B!, requestedCompletionTokens, triggerLineTokens, estimatedStaticTokens, triggerMessageThreshold, canonicalMessageHardCeiling,
    normalTailBudget, normalMiddleBudget, escalatedTailBudget, escalatedMiddleBudget,
    triggerFraction: config.trigger_fraction, completionReserveFraction: config.completion_reserve_fraction,
    normalMergeLineFraction: config.merge_line_fraction, normalSummaryLineFraction: config.summary_line_fraction,
    escalatedMergeLineFraction: config.escalate_merge_line_fraction, escalatedSummaryLineFraction: config.escalate_summary_line_fraction,
    snap: config.snap, summarizerModel: config.summarizer_model,
  };
}

export function estimateCanonicalStaticTokens(systemPrompt: string, tools: readonly ToolDefinition[]): number {
  return estimateTextTokens(systemPrompt) + estimateTextTokens(canonicalJson(tools));
}

export function shouldCompact(input: LlmInvocationInput): boolean {
  const budget = input.preparedCompaction;
  if (!budget) return false;
  const estimatedMessageTokens = (input.contextMessages as AgentMessage[]).reduce((sum, row) => sum + estimateMessageTokens(row), 0);
  return estimatedMessageTokens >= budget.triggerMessageThreshold;
}

type CompactArgs = { conversations: ConversationFileContext; input: LlmInvocationInput & { preparedCompaction: PreparedCompaction }; summarizerProvider: SummarizerProviderPort; signal: AbortSignal };
type Candidate = { payload: ContextCompactionContent; conversation: ValidatedConversation; compaction: ValidatedContextCompaction; message: AgentMessage };
type CandidateFactory = (payload: ContextCompactionContent) => Candidate;
type CandidateFit = { candidate: Candidate; fits: boolean };

export async function compact(args: CompactArgs): Promise<{ rows: AgentMessage[]; compactionMessage: AgentMessage }> {
  const projectRoot = args.conversations.projectRoot;
  const sessionId = args.input.sessionId;
  const budget = args.input.preparedCompaction;
  const conversation = readConversation(projectRoot, sessionId);
  const sourceRows = conversation.sourceRows;
  const latest = conversation.latestCompaction;
  const classified = classifyConversationRounds(sourceRows);
  const normal = computeSlidingCompactionBands(classified.rounds, { tail_budget_tokens: budget.normalTailBudget, middle_budget_tokens: budget.normalMiddleBudget, snap: budget.snap });
  const escalated = computeSlidingCompactionBands(classified.rounds, { tail_budget_tokens: budget.escalatedTailBudget, middle_budget_tokens: budget.escalatedMiddleBudget, snap: budget.snap });
  assertEscalatedSuffixSubsets(normal, escalated);

  const metadataIdentity = { id: `${sessionId}:compaction:${randomUUID()}`, session_id: sessionId, round_id: generateRoundId('compacted'), timestamp: new Date().toISOString() };
  const candidateFor: CandidateFactory = (payload) => {
    const parsed = contextCompactionContentSchema.parse(payload);
    const message = agentMessageSchema.parse({ ...metadataIdentity, role: 'system', kind: 'context_compaction', content: canonicalJson(parsed), message_index: 0, block_index: 0 });
    const prospective = validateConversationRows([...conversation.physicalRows, message]);
    const compaction = prospective.latestCompaction;
    if (!compaction || compaction.metadataRow.id !== message.id) throw new Error('Prospective compaction validation did not derive the candidate metadata row.');
    return { payload: parsed, conversation: prospective, compaction, message };
  };
  const measuredCandidates = new Map<string, CandidateFit>();
  const fitCandidate = (candidate: Candidate): CandidateFit => {
    const key = canonicalJson(candidate.payload);
    const measured = measuredCandidates.get(key);
    if (measured) return measured;
    const fit = { candidate, fits: effectiveCompactionTokens(candidate.compaction, classified) <= budget.triggerMessageThreshold };
    measuredCandidates.set(key, fit);
    return fit;
  };

  const normalFit = await buildCandidate(args, sourceRows, classified, normal, budget, 'normal', latest, candidateFor, fitCandidate);
  let candidate: Candidate;
  if (normalFit.fits) {
    candidate = normalFit.candidate;
  } else {
    const escalatedFit = await buildCandidate(args, sourceRows, classified, escalated, budget, 'escalated', latest, candidateFor, fitCandidate);
    if (escalatedFit.fits) {
      candidate = escalatedFit.candidate;
    } else {
      const fallback = await applyHardFallback(args, sourceRows, classified, escalatedFit.candidate, budget, latest, candidateFor, fitCandidate);
      if (!fallback) throw new Error('Compaction could not fit the residual context below the trigger threshold without splitting an indivisible provider bundle. Raise compaction.input_budget_tokens or reduce the prompt/tool surface.');
      candidate = fallback;
    }
  }
  args.signal.throwIfAborted();
  assertMonotonicCutoff(latest, candidate.compaction);
  appendConversationBatch(projectRoot, [candidate.message], args.conversations.changes);
  return { rows: conversationMessagesForModel(candidate.conversation), compactionMessage: candidate.message };
}

async function buildCandidate(args: CompactArgs, sourceRows: AgentMessage[], classified: ClassifiedConversation, partition: SlidingBandPartitions, budget: PreparedCompaction, band: 'normal' | 'escalated', latest: ValidatedContextCompaction | null, candidateFor: CandidateFactory, fitCandidate: (candidate: Candidate) => CandidateFit): Promise<CandidateFit> {
  const preamble = classified.preamble.map((row) => row.message);
  const mergedRounds = partition.merge_rounds;
  const individual = await Promise.all(partition.summary_rounds.map((round) => summarizeRawRound(args, round)));
  let mergedHistory: ContextCompactionContent['summaries'][number] | null = null;
  if (mergedRounds.length > 0) {
    const mergedRows = mergedRounds.flatMap(rawRoundRows);
    const mergeInputs: MergeSummaryInput[] = [];
    const prior = latest?.groups[0]?.payload.kind === 'merged' ? latest.groups[0] : null;
    const priorIds = prior?.sourceRows.map((row) => row.id) ?? [];
    const newIds = mergedRows.map((row) => row.id);
    let firstNewRound = 0;
    if (prior && isExactPrefix(priorIds, newIds) && hashConversationRows(mergedRows.slice(0, priorIds.length)) === prior.payload.content_hash) {
      mergeInputs.push({ round_id: prior.rounds.map((round) => round.label).join(','), summary_text: prior.payload.summary_text });
      firstNewRound = prior.rounds.length;
    }
    for (const round of mergedRounds.slice(firstNewRound)) mergeInputs.push({ round_id: round.round_id, summary_text: (await summarizeRawRound(args, round)).summary_text });
    const summaryText = await mergeSummaryGroups(args, mergeInputs);
    args.signal.throwIfAborted();
    mergedHistory = { kind: 'merged', rounds: mergedRounds.map((round) => buildCoveredRound(rawRoundRows(round), true)), content_hash: hashConversationRows(mergedRows), summary_text: summaryText, evidence: recoverableEvidenceDescriptors(mergedRows) };
  }
  const coveredRounds = [...mergedRounds, ...partition.summary_rounds];
  if (coveredRounds.length === 0) {
    if (latest) return fitCandidate(candidateFor(latest.payload));
    return fallbackFromScratch(args, sourceRows, classified, preamble, budget, band, candidateFor, fitCandidate);
  }
  return fitCandidate(candidateFor(payloadFor(preamble, mergedHistory, individual, budget, band === 'normal' ? 'normal' : 'escalated', band)));
}

async function mergeSummaryGroups(args: CompactArgs, inputs: MergeSummaryInput[]): Promise<string> {
  const groupSize = 20;
  let current = inputs;
  while (current.length > groupSize) {
    const next: MergeSummaryInput[] = [];
    for (let index = 0; index < current.length; index += groupSize) {
      const group = current.slice(index, index + groupSize);
      next.push({ round_id: group.map((entry) => entry.round_id).join(','), summary_text: await summarizeMerge({ entries: group, summarizerProvider: args.summarizerProvider, modelSpec: args.input.preparedCompaction.summarizerModel, signal: args.signal }) });
      args.signal.throwIfAborted();
    }
    current = next;
  }
  return summarizeMerge({ entries: current, summarizerProvider: args.summarizerProvider, modelSpec: args.input.preparedCompaction.summarizerModel, signal: args.signal });
}

async function fallbackFromScratch(args: CompactArgs, sourceRows: AgentMessage[], classified: ClassifiedConversation, preamble: AgentMessage[], budget: PreparedCompaction, band: 'normal' | 'escalated', candidateFor: CandidateFactory, fitCandidate: (candidate: Candidate) => CandidateFit): Promise<CandidateFit> {
  const boundaryRound = classified.rounds[0];
  if (!boundaryRound) throw new Error('Compaction has no safe non-static source round to compact.');
  const boundaryRows = rawRoundRows(boundaryRound);
  for (let length = 1; length < boundaryRows.length; length++) {
    const prefix = boundaryRows.slice(0, length);
    if (!safeFallbackBoundary(prefix, boundaryRows[length])) continue;
    const last = prefix[prefix.length - 1]!;
    const partial: ContextCompactionContent['summaries'][number] = { kind: 'individual', rounds: [buildCoveredRound(prefix, false)], content_hash: hashConversationRows(prefix), summary_text: await summarizeRound({ round_id: boundaryRound.round_id, rows: dropRecoverableResultBodies(prefix), summarizerProvider: args.summarizerProvider, modelSpec: budget.summarizerModel, signal: args.signal }), evidence: recoverableEvidenceDescriptors(prefix) };
    args.signal.throwIfAborted();
    const retainedStatic = preamble.filter((row) => row.role === 'system' && row.kind !== 'activity').map((row) => row.id);
    const modeBand = band;
    const payload = contextCompactionContentSchema.parse({ boundary: fallbackBoundary(last), retained_static_message_ids: retainedStatic, summaries: [partial], applied_policy: appliedPolicy(budget, 'hard_limit_fallback', modeBand) });
    const candidate = candidateFor(payload);
    const fit = fitCandidate(candidate);
    if (fit.fits) return fit;
  }
  throw new Error('Compaction could not find a safe residual prefix below the trigger threshold. Raise compaction.input_budget_tokens or reduce the prompt/tool surface.');
}

async function applyHardFallback(args: CompactArgs, sourceRows: AgentMessage[], classified: ClassifiedConversation, base: Candidate, budget: PreparedCompaction, latest: ValidatedContextCompaction | null, candidateFor: CandidateFactory, fitCandidate: (candidate: Candidate) => CandidateFit): Promise<Candidate | null> {
  const start = base.compaction.cutoffSourceIndex + 1;
  if (start <= 0) throw new Error('Hard fallback base cutoff is not an immutable source row.');
  const boundaryRound = classified.rounds.find((round) => rawRoundRows(round).some((row) => row.id === sourceRows[start]?.id)) ?? null;
  if (!boundaryRound) return null;
  const boundaryRows = rawRoundRows(boundaryRound);
  const roundStart = sourceRows.findIndex((row) => row.id === boundaryRows[0]!.id);
  const replacesPartial = !base.compaction.groups.at(-1)!.rounds.at(-1)!.complete;
  const coveredInRound = replacesPartial ? start - roundStart : 0;
  for (let length = coveredInRound + 1; length <= boundaryRows.length; length++) {
    const prefix = boundaryRows.slice(0, length);
    if (!safeFallbackBoundary(prefix, boundaryRows[length])) continue;
    const cutoffSourceIndex = roundStart + length - 1;
    if (latest && cutoffSourceIndex <= latest.cutoffSourceIndex) continue;
    const last = prefix[prefix.length - 1]!;
    const complete = length === boundaryRows.length;
    const summaryText = await summarizeRound({ round_id: boundaryRound.round_id, rows: dropRecoverableResultBodies(prefix), summarizerProvider: args.summarizerProvider, modelSpec: budget.summarizerModel, signal: args.signal });
    args.signal.throwIfAborted();
    const group: ContextCompactionContent['summaries'][number] = { kind: 'individual', rounds: [buildCoveredRound(prefix, complete)], content_hash: hashConversationRows(prefix), summary_text: summaryText, evidence: recoverableEvidenceDescriptors(prefix) };
    const summaries = replacesPartial ? [...base.payload.summaries.slice(0, -1), group] : [...base.payload.summaries, group];
    const payload = contextCompactionContentSchema.parse({ ...base.payload, boundary: complete ? 'round' : fallbackBoundary(last), summaries, applied_policy: { ...base.payload.applied_policy, mode: 'hard_limit_fallback' as const } });
    const candidate = candidateFor(payload);
    if (fitCandidate(candidate).fits) return candidate;
  }
  return null;
}

function payloadFor(preamble: AgentMessage[], merged: ContextCompactionContent['summaries'][number] | null, individual: ContextCompactionContent['summaries'], budget: PreparedCompaction, mode: 'normal' | 'escalated', band: 'normal' | 'escalated'): ContextCompactionContent {
  const retainedStatic = preamble.filter((row) => row.role === 'system' && row.kind !== 'activity').map((row) => row.id);
  return contextCompactionContentSchema.parse({
    boundary: 'round', retained_static_message_ids: retainedStatic, summaries: [...(merged ? [merged] : []), ...individual],
    applied_policy: appliedPolicy(budget, mode, band),
  });
}

async function summarizeRawRound(args: CompactArgs, round: ClassifiedRound): Promise<ContextCompactionContent['summaries'][number]> {
  const rows = rawRoundRows(round);
  const summaryText = await summarizeRound({ round_id: round.round_id, rows: dropRecoverableResultBodies(rows), summarizerProvider: args.summarizerProvider, modelSpec: args.input.preparedCompaction.summarizerModel, signal: args.signal });
  args.signal.throwIfAborted();
  return { kind: 'individual', rounds: [buildCoveredRound(rows, true)], content_hash: hashConversationRows(rows), summary_text: summaryText, evidence: recoverableEvidenceDescriptors(rows) };
}

function buildCoveredRound(rows: AgentMessage[], complete: boolean): ContextCompactionContent['summaries'][number]['rounds'][number] {
  return { complete, segments: classifySourceSegments(rows).map((segment) => ({ kind: segment.kind, source_message_ids: segment.rows.map((row) => row.id) })) };
}

function appliedPolicy(budget: PreparedCompaction, mode: ContextCompactionContent['applied_policy']['mode'], band: 'normal' | 'escalated'): ContextCompactionContent['applied_policy'] {
  return { mode, band, input_budget_tokens: budget.inputBudgetTokens, canonical_estimated_static_tokens: budget.estimatedStaticTokens, trigger_fraction: budget.triggerFraction, completion_reserve_fraction: budget.completionReserveFraction, merge_line_fraction: band === 'normal' ? budget.normalMergeLineFraction : budget.escalatedMergeLineFraction, summary_line_fraction: band === 'normal' ? budget.normalSummaryLineFraction : budget.escalatedSummaryLineFraction, snap: budget.snap };
}

function effectiveCompactionTokens(compaction: ValidatedContextCompaction, classified: ClassifiedConversation): number {
  const retained = new Set(compaction.payload.retained_static_message_ids);
  const rows = [...classified.preamble, ...classified.rounds.flatMap((round) => round.rows)];
  return estimateTextTokens(compaction.renderedContext) + rows.reduce((sum, row, index) => sum + ((retained.has(row.message.id) || index > compaction.cutoffSourceIndex) ? row.estimated_tokens : 0), 0);
}
function assertMonotonicCutoff(previous: ValidatedContextCompaction | null, next: ValidatedContextCompaction): void {
  if (!previous) return;
  if (next.cutoffSourceIndex < previous.cutoffSourceIndex) throw new Error('Compaction cutoff would retreat; reset or start a new conversation.');
}
function safeFallbackBoundary(prefix: AgentMessage[], next: AgentMessage | undefined): boolean {
  const last = prefix[prefix.length - 1]!;
  if (last.kind === 'tool_call') return false;
  if (next?.kind === 'tool_result') return false;
  if (last.kind === 'provider_private' || next?.provider_projection?.private_message_id === last.id) return false;
  return true;
}
function fallbackBoundary(row: AgentMessage): 'repair' | 'exchange' | 'message' { return row.kind === 'tool_result' && failedResult(row) ? 'repair' : row.kind === 'tool_result' ? 'exchange' : 'message'; }
function failedResult(row: AgentMessage): boolean { try { return JSON.parse(row.content).success === false; } catch { return false; } }
function rawRoundRows(round: ClassifiedRound): AgentMessage[] { return round.rows.map((row) => row.message); }
function estimateTextTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, 'utf8') / 4); }
function isExactPrefix(prefix: string[], values: string[]): boolean { return prefix.length <= values.length && prefix.every((value, index) => values[index] === value); }
