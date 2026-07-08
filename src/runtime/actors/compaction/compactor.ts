import { createHash } from 'node:crypto';
import { agentMessageSchema, type AgentMessage } from '../../../schemas/index.js';
import { generateRoundId } from '../../../schemas/round-id-server.js';
import type { LlmInvocationInput } from '../llm-invocation.js';
import { conversationMessagesForModel, readActiveVersionMessages } from '../conversation-store.js';
import { ensureConversationIndex, writeCompactedConversationVersion } from '../conversation-index.js';
import { computeCompactionBands, type BandConfig, type SnapPolicy } from './bands.js';
import { classifyConversationRounds, estimateMessageTokens, type ClassifiedRound } from './round-classifier.js';
import { dropRecoverableResultBodies, recoverableEvidenceDescriptors, type RecoverableEvidenceDescriptor } from './result-dropping.js';
import { appendSummaryCacheEntry, contentHashForMessages, readSummaryCache, renderRecoverableEvidenceSection, type SummaryCacheEntry } from './summary-cache.js';
import { summarizeMerge, summarizeRound, type SummarizerProviderPort } from './summarizer.js';

export type CompactionConfig = {
  enabled: boolean;
  trigger_fraction: number;
  completion_reserve_fraction: number;
  merge_line_fraction: number;
  summary_line_fraction: number;
  escalate_merge_line_fraction: number;
  escalate_summary_line_fraction: number;
  snap: SnapPolicy;
  summarizer_model?: string;
};

export interface BufferSizeEstimator {
  estimate(input: LlmInvocationInput): { estimatedTokens: number; bufferTokens: number };
}

export type ShouldCompactResult = { shouldCompact: boolean; estimatedTokens: number; bufferTokens: number; usageFraction: number };

export function shouldCompact(input: LlmInvocationInput, config: CompactionConfig, estimator: BufferSizeEstimator): ShouldCompactResult {
  if (!config.enabled) return { shouldCompact: false, estimatedTokens: 0, bufferTokens: 1, usageFraction: 0 };
  const estimated = estimator.estimate(input);
  if (estimated.bufferTokens <= 0) throw new Error('Compaction buffer estimator returned a non-positive context window.');
  const usageFraction = estimated.estimatedTokens / estimated.bufferTokens;
  return { shouldCompact: usageFraction >= config.trigger_fraction, estimatedTokens: estimated.estimatedTokens, bufferTokens: estimated.bufferTokens, usageFraction };
}

export async function compact(args: {
  projectRoot: string;
  sessionId: string;
  input: LlmInvocationInput;
  config: CompactionConfig;
  summarizerProvider: SummarizerProviderPort;
  bufferSizeEstimator: BufferSizeEstimator;
  signal?: AbortSignal;
}): Promise<AgentMessage[]> {
  if (!args.config.enabled) throw new Error('Compaction was invoked while disabled.');
  if (!args.config.summarizer_model || args.config.summarizer_model.trim().length === 0) throw new Error('Compaction is enabled but compaction.summarizer_model is unset.');

  const index = ensureConversationIndex(args.projectRoot, args.sessionId);
  const generation = nextCompactionGeneration(index);
  const activeRows = readActiveVersionMessages(args.projectRoot, args.sessionId);
  const measured = args.bufferSizeEstimator.estimate(args.input);
  const pass = await buildCompactedRows({ ...args, activeRows, bufferTokens: measured.bufferTokens, generation, mergeLine: args.config.merge_line_fraction, summaryLine: args.config.summary_line_fraction, snap: args.config.snap });
  let rows = pass.rows;
  let summaryIds = pass.summaryIds;
  let bands = pass.bands;

  const compactedInput = { ...args.input, contextMessages: conversationMessagesForModel(rows) };
  const after = args.bufferSizeEstimator.estimate(compactedInput);
  const targetTokens = Math.floor(after.bufferTokens * Math.max(0, args.config.trigger_fraction - args.config.completion_reserve_fraction));
  if (after.estimatedTokens > targetTokens) {
    const escalated = await buildCompactedRows({ ...args, activeRows, bufferTokens: measured.bufferTokens, generation, mergeLine: args.config.escalate_merge_line_fraction, summaryLine: args.config.escalate_summary_line_fraction, snap: 'compact_straddler' });
    rows = escalated.rows;
    summaryIds = escalated.summaryIds;
    bands = escalated.bands;
    const escalatedAfter = args.bufferSizeEstimator.estimate({ ...args.input, contextMessages: conversationMessagesForModel(rows) });
    if (escalatedAfter.estimatedTokens > Math.floor(escalatedAfter.bufferTokens * args.config.trigger_fraction)) {
      throw new Error(`Compaction did not reduce context below trigger (${escalatedAfter.estimatedTokens}/${escalatedAfter.bufferTokens}); refusing to silently truncate.`);
    }
  }

  const content = rows.map((row) => JSON.stringify(agentMessageSchema.parse(row))).join('\n') + (rows.length === 0 ? '' : '\n');
  const compactedThrough = compactedThroughFor(rows, activeRows);
  writeCompactedConversationVersion({
    projectRoot: args.projectRoot,
    sessionId: args.sessionId,
    sourceVersion: index.active_version,
    content,
    compactedThrough,
    summaryIds,
    compactionGeneration: generation,
    bands,
  });
  return conversationMessagesForModel(rows);
}

async function buildCompactedRows(args: {
  projectRoot: string;
  sessionId: string;
  input: LlmInvocationInput;
  config: CompactionConfig;
  summarizerProvider: SummarizerProviderPort;
  bufferSizeEstimator: BufferSizeEstimator;
  signal?: AbortSignal;
  activeRows: AgentMessage[];
  bufferTokens: number;
  generation: number;
  mergeLine: number;
  summaryLine: number;
  snap: SnapPolicy;
}): Promise<{ rows: AgentMessage[]; summaryIds: string[]; bands: { merge_line: number; summary_line: number; trigger: number; snap: SnapPolicy } }> {
  const classified = classifyConversationRounds(args.activeRows);
  const config: BandConfig = { buffer_tokens: args.bufferTokens, merge_line_fraction: args.mergeLine, summary_line_fraction: args.summaryLine, trigger_fraction: args.config.trigger_fraction, snap: args.snap };
  const partitions = computeCompactionBands({ total_estimated_tokens: classified.total_estimated_tokens, rounds: classified.rounds, already_compacted_history: classified.already_compacted_history, config });
  if (partitions.tail_rounds.length === 0) throw new Error('Compaction refused because snapped verbatim tail would be empty.');

  const cache = new Map(readSummaryCache(args.projectRoot, args.sessionId).map((entry) => [entry.cache_key, entry]));
  const mergeEntries: SummaryCacheEntry[] = [];
  const perRoundEntries: SummaryCacheEntry[] = [];

  const activeRawRoundIds = new Set(classified.rounds.map((round) => round.round_id));
  for (const entry of cache.values()) {
    if (!activeRawRoundIds.has(entry.round_id)) {
      mergeEntries.push(entry);
      continue;
    }
    if (entry.provenance.source_end_token !== undefined && entry.provenance.source_end_token <= partitions.snapped_boundaries.merge_line) mergeEntries.push(entry);
  }
  for (const round of partitions.merge_rounds) mergeEntries.push(await getOrCreateRoundSummary(args, round, cache));
  for (const round of partitions.summary_rounds) perRoundEntries.push(await getOrCreateRoundSummary(args, round, cache));

  const mergedRows: AgentMessage[] = [];
  if (mergeEntries.length > 0) {
    const uniqueMergeEntries = uniqueEntries(mergeEntries);
    const summaryText = await summarizeMerge({ entries: uniqueMergeEntries, summarizerProvider: args.summarizerProvider, modelSpec: args.config.summarizer_model as string, signal: args.signal });
    mergedRows.push(summaryMessage(args.sessionId, args.generation, 'merged', summaryText, uniqueMergeEntries.flatMap((entry) => entry.recoverable_evidence) as RecoverableEvidenceDescriptor[]));
    mergeEntries.length = 0;
    mergeEntries.push(...uniqueMergeEntries);
  }

  const perRoundRows = uniqueEntries(perRoundEntries).map((entry) => summaryMessage(args.sessionId, args.generation, entry.round_id, entry.summary_text, entry.recoverable_evidence as RecoverableEvidenceDescriptor[]));
  const tailRows = partitions.tail_rounds.flatMap((round) => round.rows.map((row) => row.message));
  const rows = [...classified.preamble.map((row) => row.message), ...mergedRows, ...perRoundRows, ...tailRows];
  const summaryIds = [...uniqueEntries(mergeEntries), ...uniqueEntries(perRoundEntries)].map((entry) => entry.cache_key);
  verifyExactlyOnce(summaryIds);

  return { rows, summaryIds, bands: { merge_line: args.mergeLine, summary_line: args.summaryLine, trigger: args.config.trigger_fraction, snap: args.snap } };
}

async function getOrCreateRoundSummary(args: { projectRoot: string; sessionId: string; config: CompactionConfig; summarizerProvider: SummarizerProviderPort; signal?: AbortSignal }, round: ClassifiedRound, cache: Map<string, SummaryCacheEntry>): Promise<SummaryCacheEntry> {
  const rows = conversationMessagesForModel(round.rows.map((row) => row.message));
  const hash = contentHashForMessages(rows);
  const cacheKey = `${round.round_id}:${hash}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;
  const evidence = recoverableEvidenceDescriptors(rows);
  const dropped = dropRecoverableResultBodies(rows);
  const summaryText = await summarizeRound({ round_id: round.round_id, rows: dropped, summarizerProvider: args.summarizerProvider, modelSpec: args.config.summarizer_model as string, signal: args.signal });
  const entry = appendSummaryCacheEntry(args.projectRoot, args.sessionId, {
    cache_key: cacheKey,
    round_id: round.round_id,
    content_hash: hash,
    summary_text: summaryText,
    recoverable_evidence: evidence,
    provenance: { source_message_ids: rows.map((row) => row.id), source_start_token: round.start_token, source_end_token: round.end_token },
  });
  cache.set(cacheKey, entry);
  return entry;
}

function summaryMessage(sessionId: string, generation: number, source: string, summaryText: string, evidence: readonly RecoverableEvidenceDescriptor[]): AgentMessage {
  const timestamp = new Date().toISOString();
  const seed = `${sessionId}:compaction:${generation}:${source}:${summaryText}`;
  return agentMessageSchema.parse({
    id: `${sessionId}:compaction:${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`,
    session_id: sessionId,
    role: 'user',
    kind: 'context_compaction',
    content: `[Compacted prior conversation — generation ${generation}]:\n${summaryText}\n\n${renderRecoverableEvidenceSection(evidence)}`,
    round_id: generateRoundId('compacted'),
    message_index: 0,
    block_index: 0,
    timestamp,
  });
}

function uniqueEntries(entries: SummaryCacheEntry[]): SummaryCacheEntry[] {
  return [...new Map(entries.map((entry) => [entry.cache_key, entry])).values()];
}

function verifyExactlyOnce(summaryIds: string[]): void {
  if (summaryIds.length !== new Set(summaryIds).size) throw new Error('Compaction exactly-once coverage violation: duplicate summary cache entry consumed.');
}

function compactedThroughFor(rows: AgentMessage[], fallbackRows: AgentMessage[]): { message_id: string; round_id: string; timestamp: string } {
  const row = [...rows].reverse().find((message) => message.kind === 'context_compaction') ?? fallbackRows[fallbackRows.length - 1];
  if (!row) throw new Error('Cannot write compaction metadata for an empty conversation.');
  return { message_id: row.id, round_id: row.round_id, timestamp: row.timestamp };
}

function nextCompactionGeneration(index: { versions: Record<string, { compaction_generation?: number }> }): number {
  return Math.max(0, ...Object.values(index.versions).map((entry) => entry.compaction_generation ?? 0)) + 1;
}

export const heuristicBufferSizeEstimator: BufferSizeEstimator = {
  estimate(input) {
    const promptTokens = Math.max(1, Math.ceil(input.systemPrompt.length / 4));
    const toolTokens = Math.max(0, Math.ceil(JSON.stringify(input.tools).length / 4));
    const messageTokens = (input.contextMessages as AgentMessage[]).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    const requested = input.capabilityRequest as { contextWindowTokens?: unknown };
    return { estimatedTokens: promptTokens + toolTokens + messageTokens, bufferTokens: typeof requested.contextWindowTokens === 'number' ? requested.contextWindowTokens : 128000 };
  },
};
