import { createHash, randomUUID } from 'node:crypto';
import { appendConversationBatch, readConversation, type ConversationFileContext } from '../../../persistence/conversation-file.js';
import { agentMessageSchema, canonicalJson, contextCompactionContentSchema, type AgentMessage, type ContextCompactionContent } from '../../../schemas/index.js';
import { validateConversationRows, type ValidatedContextCompaction } from '../../../contracts/conversation-compaction.js';
import { generateRoundId } from '../../../schemas/round-id-server.js';
import type { ToolDefinition } from '../../../agents/llm-contracts.js';
import type { LlmInvocationInput } from '../llm-invocation.js';
import { conversationMessagesForModel } from '../conversation-session.js';
import { assertEscalatedSuffixSubsets, computeSlidingCompactionBands, type SlidingBandPartitions, type SnapPolicy } from './bands.js';
import { classifyConversationRounds, estimateMessageTokens, type ClassifiedRound } from './round-classifier.js';
import { dropRecoverableResultBodies, recoverableEvidenceDescriptors } from './result-dropping.js';
import { summarizeMerge, summarizeRound, type MergeSummaryInput, type SummarizerProviderPort } from './summarizer.js';

export type CompactionConfig = {
  enabled: boolean; input_budget_tokens?: number; trigger_fraction: number; completion_reserve_fraction: number;
  merge_line_fraction: number; summary_line_fraction: number; escalate_merge_line_fraction: number; escalate_summary_line_fraction: number;
  snap: SnapPolicy; summarizer_model?: string;
};

export type CompactionBudget = {
  inputBudgetTokens: number; requestedCompletionTokens: number; triggerLineTokens: number; estimatedStaticTokens: number;
  triggerMessageThreshold: number; canonicalMessageHardCeiling: number;
  normalTailBudget: number; normalMiddleBudget: number; escalatedTailBudget: number; escalatedMiddleBudget: number;
};

export function deriveStage1CompactionBudget(config: CompactionConfig): Omit<CompactionBudget, 'estimatedStaticTokens' | 'triggerMessageThreshold' | 'canonicalMessageHardCeiling'> {
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
  if (escalatedTailBudget > normalTailBudget || escalatedMiddleBudget > normalMiddleBudget) throw new Error('Escalated compaction token budgets must not exceed normal token budgets.');
  return { inputBudgetTokens: B!, requestedCompletionTokens, triggerLineTokens: Math.floor(B! * config.trigger_fraction), normalTailBudget, normalMiddleBudget, escalatedTailBudget, escalatedMiddleBudget };
}

export function estimateCanonicalStaticTokens(systemPrompt: string, tools: readonly ToolDefinition[]): number {
  return estimateTextTokens(systemPrompt) + estimateTextTokens(canonicalJson(tools));
}

export function validateCompactionStaticCapacity(config: CompactionConfig, systemPrompt: string, tools: readonly ToolDefinition[]): CompactionBudget {
  const stage1 = deriveStage1CompactionBudget(config);
  const S = estimateCanonicalStaticTokens(systemPrompt, tools);
  const triggerMessageThreshold = stage1.triggerLineTokens - S;
  const canonicalMessageHardCeiling = stage1.inputBudgetTokens - S - stage1.requestedCompletionTokens;
  if (!Number.isFinite(S) || S < 0 || triggerMessageThreshold <= 0 || canonicalMessageHardCeiling <= 0 || triggerMessageThreshold > canonicalMessageHardCeiling) {
    throw new Error(`Autonomous prompt/tool surface does not fit the compaction budget (input_budget_tokens=${stage1.inputBudgetTokens}, estimated_static_tokens=${S}, requested_completion_tokens=${stage1.requestedCompletionTokens}, trigger_message_threshold=${triggerMessageThreshold}, canonical_message_hard_ceiling=${canonicalMessageHardCeiling}). Raise compaction.input_budget_tokens, reduce the prompt/tool surface, or lower completion_reserve_fraction.`);
  }
  return { ...stage1, estimatedStaticTokens: S, triggerMessageThreshold, canonicalMessageHardCeiling };
}

export type ShouldCompactResult = { shouldCompact: boolean; estimatedMessageTokens: number; triggerMessageThreshold: number };
export function shouldCompact(input: LlmInvocationInput, config: CompactionConfig): ShouldCompactResult {
  if (!config.enabled) return { shouldCompact: false, estimatedMessageTokens: 0, triggerMessageThreshold: Number.POSITIVE_INFINITY };
  const budget = validateCompactionStaticCapacity(config, input.systemPrompt, input.tools);
  const estimatedMessageTokens = (input.contextMessages as AgentMessage[]).reduce((sum, row) => sum + estimateMessageTokens(row), 0);
  return { shouldCompact: estimatedMessageTokens >= budget.triggerMessageThreshold, estimatedMessageTokens, triggerMessageThreshold: budget.triggerMessageThreshold };
}

export async function compact(args: { projectRoot: string; conversations: ConversationFileContext; sessionId: string; input: LlmInvocationInput; config: CompactionConfig; summarizerProvider: SummarizerProviderPort; signal: AbortSignal }): Promise<{ rows: AgentMessage[]; compactionMessage: AgentMessage }> {
  if (!args.config.summarizer_model?.trim()) throw new Error('Compaction is enabled but compaction.summarizer_model is unset.');
  const budget = validateCompactionStaticCapacity(args.config, args.input.systemPrompt, args.input.tools);
  const conversation = readConversation(args.projectRoot, args.sessionId);
  const physicalRows = conversation.physicalRows;
  const sourceRows = conversation.sourceRows;
  const latest = conversation.latestCompaction;
  const classified = classifyConversationRounds(sourceRows);
  const normal = computeSlidingCompactionBands(classified.rounds, { tail_budget_tokens: budget.normalTailBudget, middle_budget_tokens: budget.normalMiddleBudget, snap: args.config.snap });
  const escalated = computeSlidingCompactionBands(classified.rounds, { tail_budget_tokens: budget.escalatedTailBudget, middle_budget_tokens: budget.escalatedMiddleBudget, snap: args.config.snap });
  assertEscalatedSuffixSubsets(normal, escalated);

  let built = await buildPayload(args, sourceRows, classified.preamble.map((row) => row.message), normal, budget, 'normal', latest);
  if (effectivePayloadTokens(built.payload, sourceRows) > budget.triggerMessageThreshold) {
    built = await buildPayload(args, sourceRows, classified.preamble.map((row) => row.message), escalated, budget, 'escalated', latest);
  }
  if (effectivePayloadTokens(built.payload, sourceRows) > budget.triggerMessageThreshold) {
    built = await applyHardFallback(args, sourceRows, built, budget, latest);
  }
  if (effectivePayloadTokens(built.payload, sourceRows) > budget.triggerMessageThreshold) throw new Error('Compaction could not fit the residual context below the trigger threshold without splitting an indivisible provider bundle. Raise compaction.input_budget_tokens or reduce the prompt/tool surface.');
  args.signal.throwIfAborted();
  assertMonotonicCutoff(latest, built.payload, sourceRows);
  const content = canonicalJson(contextCompactionContentSchema.parse(built.payload));
  const compactionMessage = agentMessageSchema.parse({ id: `${args.sessionId}:compaction:${randomUUID()}`, session_id: args.sessionId, role: 'system', kind: 'context_compaction', content, round_id: generateRoundId('compacted'), message_index: 0, block_index: 0, timestamp: new Date().toISOString() });
  const prospective = validateConversationRows([...physicalRows, compactionMessage]);
  appendConversationBatch(args.projectRoot, [compactionMessage], args.conversations.changes);
  return { rows: conversationMessagesForModel(prospective), compactionMessage };
}

type BuiltPayload = { payload: ContextCompactionContent; coveredRows: AgentMessage[] };
async function buildPayload(args: Parameters<typeof compact>[0], sourceRows: AgentMessage[], preamble: AgentMessage[], partition: SlidingBandPartitions, budget: CompactionBudget, band: 'normal' | 'escalated', latest: ValidatedContextCompaction | null): Promise<BuiltPayload> {
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
    if (prior && isExactPrefix(priorIds, newIds) && hashRows(mergedRows.slice(0, priorIds.length)) === prior.payload.content_hash) {
      mergeInputs.push({ round_id: prior.rounds.map((round) => round.label).join(','), summary_text: prior.payload.summary_text });
      firstNewRound = mergedRounds.findIndex((round) => round.rows.some((row) => row.message.id === newIds[priorIds.length]));
      if (firstNewRound < 0) firstNewRound = mergedRounds.length;
    }
    for (const round of mergedRounds.slice(firstNewRound)) mergeInputs.push({ round_id: round.round_id, summary_text: (await summarizeRawRound(args, round)).summary_text });
    const summaryText = await mergeSummaryGroups(args, mergeInputs);
    args.signal.throwIfAborted();
    mergedHistory = { kind: 'merged', rounds: mergedRounds.map((round) => summaryRoundForRows(rawRoundRows(round), true)), content_hash: hashRows(mergedRows), summary_text: summaryText, evidence: recoverableEvidenceDescriptors(mergedRows) };
  }
  const coveredRounds = [...mergedRounds, ...partition.summary_rounds];
  if (coveredRounds.length === 0) {
    if (latest) return { payload: latest.payload, coveredRows: sourceRows.slice(0, latest.cutoffSourceIndex + 1) };
    return fallbackFromScratch(args, sourceRows, preamble, partition, budget, band);
  }
  const coveredRows = coveredRounds.flatMap(rawRoundRows);
  const payload = payloadFor(args, sourceRows, preamble, coveredRows, mergedHistory, individual, partition, budget, band === 'normal' ? 'normal' : 'escalated', band);
  return { payload, coveredRows };
}

async function mergeSummaryGroups(args: Parameters<typeof compact>[0], inputs: MergeSummaryInput[]): Promise<string> {
  const groupSize = 20;
  let current = inputs;
  while (current.length > groupSize) {
    const next: MergeSummaryInput[] = [];
    for (let index = 0; index < current.length; index += groupSize) {
      const group = current.slice(index, index + groupSize);
      next.push({ round_id: group.map((entry) => entry.round_id).join(','), summary_text: await summarizeMerge({ entries: group, summarizerProvider: args.summarizerProvider, modelSpec: args.config.summarizer_model!, signal: args.signal }) });
      args.signal.throwIfAborted();
    }
    current = next;
  }
  return summarizeMerge({ entries: current, summarizerProvider: args.summarizerProvider, modelSpec: args.config.summarizer_model!, signal: args.signal });
}

async function fallbackFromScratch(args: Parameters<typeof compact>[0], sourceRows: AgentMessage[], preamble: AgentMessage[], partition: SlidingBandPartitions, budget: CompactionBudget, band: 'normal' | 'escalated'): Promise<BuiltPayload> {
  const boundaryRound = classifyConversationRounds(sourceRows).rounds[0];
  if (!boundaryRound) throw new Error('Compaction has no safe non-static source round to compact.');
  const boundaryRows = rawRoundRows(boundaryRound);
  for (let length = 1; length < boundaryRows.length; length++) {
    const prefix = boundaryRows.slice(0, length);
    if (!safeFallbackBoundary(prefix, boundaryRows[length])) continue;
    const last = prefix[prefix.length - 1]!;
    const partial: ContextCompactionContent['summaries'][number] = { kind: 'individual', rounds: [summaryRoundForRows(prefix, false)], content_hash: hashRows(prefix), summary_text: await summarizeRound({ round_id: boundaryRound.round_id, rows: dropRecoverableResultBodies(prefix), summarizerProvider: args.summarizerProvider, modelSpec: args.config.summarizer_model!, signal: args.signal }), evidence: recoverableEvidenceDescriptors(prefix) };
    args.signal.throwIfAborted();
    const retainedStatic = preamble.filter((row) => row.role === 'system' && row.kind !== 'activity').map((row) => row.id);
    const modeBand = band;
    const payload = contextCompactionContentSchema.parse({ boundary: fallbackBoundary(last), retained_static_message_ids: retainedStatic, summaries: [partial], applied_policy: { mode: 'hard_limit_fallback', band: modeBand, input_budget_tokens: budget.inputBudgetTokens, canonical_estimated_static_tokens: budget.estimatedStaticTokens, requested_completion_tokens: budget.requestedCompletionTokens, canonical_message_hard_ceiling: budget.canonicalMessageHardCeiling, trigger_line_tokens: budget.triggerLineTokens, trigger_message_threshold: budget.triggerMessageThreshold, trigger_fraction: args.config.trigger_fraction, completion_reserve_fraction: args.config.completion_reserve_fraction, merge_line_fraction: band === 'normal' ? args.config.merge_line_fraction : args.config.escalate_merge_line_fraction, summary_line_fraction: band === 'normal' ? args.config.summary_line_fraction : args.config.escalate_summary_line_fraction, tail_budget_tokens: band === 'normal' ? budget.normalTailBudget : budget.escalatedTailBudget, middle_budget_tokens: band === 'normal' ? budget.normalMiddleBudget : budget.escalatedMiddleBudget, snap: args.config.snap } });
    if (effectivePayloadTokens(payload, sourceRows) <= budget.triggerMessageThreshold) return { payload, coveredRows: prefix };
  }
  throw new Error('Compaction could not find a safe residual prefix below the trigger threshold. Raise compaction.input_budget_tokens or reduce the prompt/tool surface.');
}

async function applyHardFallback(args: Parameters<typeof compact>[0], sourceRows: AgentMessage[], base: BuiltPayload, budget: CompactionBudget, latest: ValidatedContextCompaction | null): Promise<BuiltPayload> {
  const start = sourceRows.findIndex((row) => row.id === coveredSourceIds(base.payload).at(-1)) + 1;
  if (start <= 0) throw new Error('Hard fallback base cutoff is not an immutable source row.');
  const remaining = sourceRows.slice(start);
  const boundaryRound = classifyConversationRounds(remaining).rounds[0];
  if (!boundaryRound) return base;
  const boundaryRows = rawRoundRows(boundaryRound);
  for (let length = 1; length <= boundaryRows.length; length++) {
    const prefix = boundaryRows.slice(0, length);
    if (!safeFallbackBoundary(prefix, boundaryRows[length])) continue;
    const allCovered = sourceRows.slice(0, start + length);
    if (latest && allCovered.length <= latest.cutoffSourceIndex + 1) continue;
    const last = prefix[prefix.length - 1]!;
    const summaryText = await summarizeRound({ round_id: last.round_id, rows: dropRecoverableResultBodies(prefix), summarizerProvider: args.summarizerProvider, modelSpec: args.config.summarizer_model!, signal: args.signal });
    args.signal.throwIfAborted();
    const partial: ContextCompactionContent['summaries'][number] = { kind: 'individual', rounds: [summaryRoundForRows(prefix, false)], content_hash: hashRows(prefix), summary_text: summaryText, evidence: recoverableEvidenceDescriptors(prefix) };
    const payload = { ...base.payload, boundary: fallbackBoundary(last), summaries: [...base.payload.summaries, partial], applied_policy: { ...base.payload.applied_policy, mode: 'hard_limit_fallback' as const } };
    const parsed = contextCompactionContentSchema.parse(payload);
    if (effectivePayloadTokens(parsed, sourceRows) <= budget.triggerMessageThreshold) return { payload: parsed, coveredRows: allCovered };
  }
  return base;
}

function payloadFor(args: Parameters<typeof compact>[0], sourceRows: AgentMessage[], preamble: AgentMessage[], coveredRows: AgentMessage[], merged: ContextCompactionContent['summaries'][number] | null, individual: ContextCompactionContent['summaries'], partition: SlidingBandPartitions, budget: CompactionBudget, mode: 'normal' | 'escalated', band: 'normal' | 'escalated'): ContextCompactionContent {
  const retainedStatic = preamble.filter((row) => row.role === 'system' && row.kind !== 'activity').map((row) => row.id);
  void sourceRows;
  void coveredRows;
  return contextCompactionContentSchema.parse({
    boundary: 'round', retained_static_message_ids: retainedStatic, summaries: [...(merged ? [merged] : []), ...individual],
    applied_policy: { mode, band, input_budget_tokens: budget.inputBudgetTokens, canonical_estimated_static_tokens: budget.estimatedStaticTokens, requested_completion_tokens: budget.requestedCompletionTokens, canonical_message_hard_ceiling: budget.canonicalMessageHardCeiling, trigger_line_tokens: budget.triggerLineTokens, trigger_message_threshold: budget.triggerMessageThreshold, trigger_fraction: args.config.trigger_fraction, completion_reserve_fraction: args.config.completion_reserve_fraction, merge_line_fraction: band === 'normal' ? args.config.merge_line_fraction : args.config.escalate_merge_line_fraction, summary_line_fraction: band === 'normal' ? args.config.summary_line_fraction : args.config.escalate_summary_line_fraction, tail_budget_tokens: band === 'normal' ? budget.normalTailBudget : budget.escalatedTailBudget, middle_budget_tokens: band === 'normal' ? budget.normalMiddleBudget : budget.escalatedMiddleBudget, snap: args.config.snap },
  });
}

async function summarizeRawRound(args: Parameters<typeof compact>[0], round: ClassifiedRound): Promise<ContextCompactionContent['summaries'][number]> {
  const rows = rawRoundRows(round);
  const summaryText = await summarizeRound({ round_id: round.round_id, rows: dropRecoverableResultBodies(rows), summarizerProvider: args.summarizerProvider, modelSpec: args.config.summarizer_model!, signal: args.signal });
  args.signal.throwIfAborted();
  return { kind: 'individual', rounds: [summaryRoundForRows(rows, true)], content_hash: hashRows(rows), summary_text: summaryText, evidence: recoverableEvidenceDescriptors(rows) };
}

function summaryRoundForRows(rows: AgentMessage[], complete: boolean): ContextCompactionContent['summaries'][number]['rounds'][number] {
  const anchors = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.kind === 'model_repair' || (row.kind === 'tool_result' && failedResult(row)));
  const segments: ContextCompactionContent['summaries'][number]['rounds'][number]['segments'] = [];
  const firstRepair = anchors[0]?.index ?? rows.length;
  if (firstRepair > 0) segments.push({ kind: 'initial', source_message_ids: rows.slice(0, firstRepair).map((row) => row.id) });
  anchors.forEach(({ index }, ordinal) => segments.push({ kind: 'repair', source_message_ids: rows.slice(index, anchors[ordinal + 1]?.index ?? rows.length).map((item) => item.id) }));
  if (segments.length === 0) segments.push({ kind: 'initial', source_message_ids: rows.map((row) => row.id) });
  return { complete, segments };
}

function renderContext(groups: ContextCompactionContent['summaries']): string {
  const sections: string[] = [];
  for (const group of groups) {
    const labels = group.rounds.map((round) => round.segments[0]!.source_message_ids[0]!);
    const heading = group.kind === 'merged' ? `Merged history rounds ${labels.join(', ')}` : `Round ${labels[0]}${group.rounds[0]!.complete ? '' : ' (partial prefix)'}`;
    sections.push(`${heading}:\n${group.summary_text}${renderEvidence(group.evidence)}`);
  }
  return sections.join('\n\n');
}
function renderEvidence(evidence: readonly unknown[]): string { return evidence.length === 0 ? '' : `\nRecoverable evidence:\n${evidence.map((item) => `- ${canonicalJson(item)}`).join('\n')}`; }

function effectivePayloadTokens(payload: ContextCompactionContent, sourceRows: AgentMessage[]): number {
  const cutoff = sourceRows.findIndex((row) => row.id === coveredSourceIds(payload).at(-1));
  const retained = new Set(payload.retained_static_message_ids);
  return estimateTextTokens(renderContext(payload.summaries)) + sourceRows.reduce((sum, row, index) => sum + ((retained.has(row.id) || index > cutoff) ? estimateMessageTokens(row) : 0), 0);
}
function assertMonotonicCutoff(previous: ValidatedContextCompaction | null, next: ContextCompactionContent, sourceRows: AgentMessage[]): void {
  if (!previous) return;
  const oldIndex = previous.cutoffSourceIndex;
  const newIndex = sourceRows.findIndex((row) => row.id === coveredSourceIds(next).at(-1));
  if (newIndex < oldIndex) throw new Error('Compaction cutoff would retreat; reset or start a new conversation.');
}
function coveredSourceIds(payload: ContextCompactionContent): string[] { return payload.summaries.flatMap((group) => group.rounds.flatMap((round) => round.segments.flatMap((segment) => segment.source_message_ids))); }
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
function hashRows(rows: AgentMessage[]): string {
  if (rows.some((row) => row === undefined)) throw new Error('Compaction hash references a missing immutable source row.');
  const text = rows.map((row) => JSON.stringify({ id: row.id, role: row.role, kind: row.kind, content: row.content, tool: row.tool, tool_call_id: row.tool_call_id, source_input_id: undefined })).join('\n');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
