import { createHash } from 'node:crypto';

import type { GrowingFileReplay, GrowingFileRowCheckpoint } from '../persistence/growing-file.js';
import {
  conversationSessionIdentity,
  parseCanonicalContextCompaction,
  type AgentMessage,
  type ContextCompactionContent,
  type ConversationSessionId,
} from '../schemas/index.js';
import { loggedToolCallIdentity, loggedToolResultIdentity } from '../schemas/message-identity.js';
import { conversationRowHashText } from './conversation-compaction.js';
import { validateActivationOpenMarker } from './conversation-source-classification.js';
import { parseToolCallMessageForModel } from './persisted-tool-call.js';
import { ToolInvocationResultSchema } from './tool-invocation-projection.js';

export interface CompactConversationSource {
  readonly id: string;
  readonly role: AgentMessage['role'];
  readonly kind: AgentMessage['kind'];
  readonly opensRound: boolean;
  readonly repairAnchor: boolean;
  readonly toolName: string | null;
  readonly toolCallId: string | null;
  readonly sourceInputId: string | null;
  readonly failedToolResult: boolean;
  readonly projectedPrivateMessageId: string | null;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly rowOrdinal: number;
}

export interface CompactConversationSegment { readonly kind: 'initial' | 'repair'; readonly start: number; end: number }
export interface CompactConversationRound { readonly label: string; readonly start: number; end: number; readonly segments: CompactConversationSegment[] }
export interface CompactToolCallState {
  readonly key: string;
  readonly toolName: string;
  readonly sourceOrdinal: number;
  resultOrdinal: number | null;
}

export interface CompactConversationValidationState {
  readonly sessionId: ConversationSessionId;
  readonly physicalIds: Set<string>;
  readonly sources: CompactConversationSource[];
  readonly sourceOrdinals: Map<string, number>;
  readonly rounds: CompactConversationRound[];
  readonly retainedStaticIds: string[];
  readonly toolCalls: Map<string, CompactToolCallState>;
  readonly toolResults: Map<string, number>;
  compactionCount: number;
  replayBytesRead: number;
}

export function createCompactConversationValidationState(sessionId: ConversationSessionId): CompactConversationValidationState {
  return {
    sessionId,
    physicalIds: new Set(),
    sources: [],
    sourceOrdinals: new Map(),
    rounds: [],
    retainedStaticIds: [],
    toolCalls: new Map(),
    toolResults: new Map(),
    compactionCount: 0,
    replayBytesRead: 0,
  };
}

export function reduceCompactConversationRow(
  state: CompactConversationValidationState,
  row: AgentMessage,
  checkpoint: GrowingFileRowCheckpoint,
  replay: GrowingFileReplay<AgentMessage>,
): CompactConversationValidationState {
  if (row.session_id !== state.sessionId) throw new Error(`Conversation row '${row.id}' belongs to session '${row.session_id}', not source session '${state.sessionId}'.`);
  if (state.physicalIds.has(row.id)) throw new Error('Conversation contains duplicate message ids.');
  state.physicalIds.add(row.id);
  if (row.kind === 'context_compaction') {
    validateCompactCompaction(state, row, replay);
    state.compactionCount += 1;
    return state;
  }

  const toolFacts = validateToolContent(row);
  const repairAnchor = row.kind === 'model_repair' || toolFacts.failedResult;
  const opensRound = validateActivationOpenMarker(state.sessionId, row);
  if (conversationSessionIdentity(state.sessionId).cardId === null && state.rounds.length === 0 && !opensRound) {
    throw new Error(`Global-agent conversation '${state.sessionId}' must start with an exact activation_open marker and have an empty preamble.`);
  }
  const ordinal = state.sources.length;
  if (opensRound) state.rounds.push({ label: row.id, start: ordinal, end: ordinal + 1, segments: [{ kind: 'initial', start: ordinal, end: ordinal + 1 }] });
  else if (state.rounds.length > 0) {
    const round = state.rounds.at(-1)!;
    round.end = ordinal + 1;
    if (repairAnchor) round.segments.push({ kind: 'repair', start: ordinal, end: ordinal + 1 });
    else round.segments.at(-1)!.end = ordinal + 1;
  } else if (row.role === 'system' && row.kind !== 'activity') state.retainedStaticIds.push(row.id);

  const callIdentity = loggedToolCallIdentity(row);
  const resultIdentity = loggedToolResultIdentity(row);
  const sourceInputId = callIdentity?.source_input_id ?? resultIdentity?.source_input_id ?? null;
  const source: CompactConversationSource = Object.freeze({
    id: row.id,
    role: row.role,
    kind: row.kind,
    opensRound,
    repairAnchor,
    toolName: row.tool ?? null,
    toolCallId: row.tool_call_id ?? null,
    sourceInputId,
    failedToolResult: toolFacts.failedResult,
    projectedPrivateMessageId: row.provider_projection?.private_message_id ?? null,
    lineStart: checkpoint.lineStart,
    lineEnd: checkpoint.lineEnd,
    rowOrdinal: checkpoint.rowOrdinal,
  });
  validateToolOrdering(state, source, callIdentity, resultIdentity);
  state.sources.push(source);
  state.sourceOrdinals.set(source.id, ordinal);
  return state;
}

export function finishCompactConversationValidation(state: CompactConversationValidationState): CompactConversationValidationState {
  const unmatched = [...state.toolCalls.values()].filter((call) => call.resultOrdinal === null);
  if (unmatched.length > 1) throw new Error('Conversation contains more than one unmatched tool call.');
  if (unmatched.length === 1 && unmatched[0]!.sourceOrdinal !== state.sources.length - 1) {
    throw new Error('Conversation contains a non-final unmatched tool call.');
  }
  return state;
}

export function validateConversationPrefixRows(sessionId: ConversationSessionId, rows: readonly AgentMessage[]): void {
  const state = createCompactConversationValidationState(sessionId);
  const replayRows = (checkpoints: readonly GrowingFileRowCheckpoint[]): readonly AgentMessage[] => checkpoints.map((checkpoint) => {
    const row = rows[checkpoint.rowOrdinal];
    if (!row) throw new Error('Conversation prefix replay checkpoint is invalid.');
    return row;
  });
  const replay: GrowingFileReplay<AgentMessage> = { replayRow: (checkpoint) => replayRows([checkpoint])[0]!, replayRows };
  rows.forEach((row, rowOrdinal) => reduceCompactConversationRow(state, row, { lineStart: 0, lineEnd: 1, rowOrdinal }, replay));
  finishCompactConversationValidation(state);
}

export function estimateCompactConversationValidationBytes(state: CompactConversationValidationState): number {
  return state.sources.reduce((total, source) => total
    + source.id.length + source.role.length + source.kind.length + (source.toolName?.length ?? 0)
    + (source.toolCallId?.length ?? 0) + (source.sourceInputId?.length ?? 0) + (source.projectedPrivateMessageId?.length ?? 0) + 64, 0)
    + state.retainedStaticIds.reduce((total, id) => total + id.length, 0)
    + [...state.toolCalls.values()].reduce((total, call) => total + call.key.length + call.toolName.length + 16, 0)
    + [...state.toolResults.keys()].reduce((total, key) => total + key.length + 8, 0);
}

function validateToolOrdering(
  state: CompactConversationValidationState,
  source: CompactConversationSource,
  callIdentity: ReturnType<typeof loggedToolCallIdentity>,
  resultIdentity: ReturnType<typeof loggedToolResultIdentity>,
): void {
  if (callIdentity) {
    const key = toolKey(callIdentity);
    if (state.toolCalls.has(key)) throw new Error('Conversation contains a duplicate tool call identity.');
    state.toolCalls.set(key, { key, toolName: source.toolName!, sourceOrdinal: state.sources.length, resultOrdinal: null });
    return;
  }
  if (resultIdentity) {
    const key = toolKey(resultIdentity);
    if (state.toolResults.has(key)) throw new Error('Conversation contains a duplicate tool result identity.');
    const call = state.toolCalls.get(key);
    if (!call || call.toolName !== source.toolName) {
      throw new Error('Conversation tool result has no matching earlier call with the same identity and tool name.');
    }
    const resultOrdinal = state.sources.length;
    state.toolResults.set(key, resultOrdinal);
    call.resultOrdinal = resultOrdinal;
  }
}

function validateCompactCompaction(state: CompactConversationValidationState, row: AgentMessage, replay: GrowingFileReplay<AgentMessage>): void {
  const payload = parseCanonicalContextCompaction(row.content);
  const groups: Array<{ payload: ContextCompactionContent['summaries'][number]; ordinals: number[]; complete: boolean }> = [];
  let roundIndex = 0;
  for (const group of payload.summaries) {
    const groupOrdinals: number[] = [];
    for (const roundPayload of group.rounds) {
      const round = state.rounds[roundIndex++];
      if (!round) throw new Error('Compaction references more rounds than physically preceding source rows contain.');
      const ids = roundPayload.segments.flatMap((segment) => segment.source_message_ids);
      const ordinals = ids.map((id) => {
        const ordinal = state.sourceOrdinals.get(id);
        if (ordinal === undefined) throw new Error(`Compaction source message '${id}' is not a physically preceding source row.`);
        return ordinal;
      });
      const expectedLength = roundPayload.complete ? round.end - round.start : ordinals.length;
      const expected = Array.from({ length: expectedLength }, (_unused, index) => round.start + index);
      assertOrdinals(ordinals, expected, `Compaction round '${round.label}' is not the canonical ${roundPayload.complete ? 'complete round' : 'round prefix'}.`);
      if (!roundPayload.complete && ordinals.length >= round.end - round.start) throw new Error(`Partial compaction round '${round.label}' must omit a non-empty suffix.`);
      const expectedSegments = segmentsForPrefix(round, ordinals.length);
      if (roundPayload.segments.length !== expectedSegments.length) throw new Error(`Compaction round '${round.label}' has incorrect source segmentation.`);
      roundPayload.segments.forEach((segment, index) => {
        const expectedSegment = expectedSegments[index]!;
        if (segment.kind !== expectedSegment.kind) throw new Error(`Compaction round '${round.label}' has incorrect source segmentation.`);
        assertOrdinals(segment.source_message_ids.map((id) => state.sourceOrdinals.get(id)!), expectedSegment.ordinals, `Compaction round '${round.label}' has incorrect source segmentation.`);
      });
      groupOrdinals.push(...ordinals);
    }
    if (hashReplayedRows(state, groupOrdinals, replay) !== group.content_hash) throw new Error('Compaction raw content hash mismatch.');
    groups.push({ payload: group, ordinals: groupOrdinals, complete: group.rounds.at(-1)!.complete });
  }
  const covered = groups.flatMap((group) => group.ordinals);
  if (covered.length === 0) throw new Error('Compaction must cover source rows.');
  const canonicalCovered = groups.flatMap((group) => group.ordinals);
  assertOrdinals(covered, canonicalCovered, 'Compaction coverage is not the canonical source prefix.');
  if (JSON.stringify(payload.retained_static_message_ids) !== JSON.stringify(state.retainedStaticIds)) throw new Error('Compaction retained static message ids do not match the eligible preceding preamble.');
  const finalGroup = groups.at(-1)!;
  const cutoffOrdinal = covered.at(-1)!;
  if (!finalGroup.complete && !isSafeFallbackBoundary(state.sources[cutoffOrdinal]!, state.sources[cutoffOrdinal + 1])) {
    throw new Error(`Partial compaction round ends inside an indivisible provider bundle.`);
  }
  const expectedBoundary = finalGroup.complete ? 'round' : fallbackBoundary(state.sources[cutoffOrdinal]!);
  if (payload.boundary !== expectedBoundary) throw new Error(`Compaction boundary '${payload.boundary}' does not match derived boundary '${expectedBoundary}'.`);
}

function hashReplayedRows(state: CompactConversationValidationState, ordinals: readonly number[], replay: GrowingFileReplay<AgentMessage>): string {
  const hash = createHash('sha256');
  const sources = ordinals.map((ordinal) => state.sources[ordinal]!);
  const distinctSpans = new Set(sources.map((source) => `${source.lineStart}:${source.lineEnd}`));
  state.replayBytesRead += [...distinctSpans].reduce((total, span) => {
    const [start, end] = span.split(':').map(Number);
    return total + end! - start!;
  }, 0);
  const rows = replay.replayRows(sources);
  rows.forEach((row, index) => {
    const source = sources[index]!;
    if (row.id !== source.id) throw new Error(`Conversation replay row '${row.id}' does not match checkpointed source '${source.id}'.`);
    if (index > 0) hash.update('\n', 'utf8');
    hash.update(conversationRowHashText(row), 'utf8');
  });
  return hash.digest('hex');
}

function segmentsForPrefix(round: CompactConversationRound, length: number): Array<{ kind: 'initial' | 'repair'; ordinals: number[] }> {
  let remaining = length;
  const result: Array<{ kind: 'initial' | 'repair'; ordinals: number[] }> = [];
  for (const segment of round.segments) {
    if (remaining === 0) break;
    const count = Math.min(remaining, segment.end - segment.start);
    result.push({ kind: segment.kind, ordinals: Array.from({ length: count }, (_unused, index) => segment.start + index) });
    remaining -= count;
  }
  return result;
}

function assertOrdinals(actual: readonly number[], expected: readonly number[], message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

function toolKey(identity: { session_id: string; source_input_id: string; tool_call_id: string }): string {
  return JSON.stringify([identity.session_id, identity.source_input_id, identity.tool_call_id]);
}

function validateToolContent(row: AgentMessage): { failedResult: boolean } {
  if (row.kind === 'tool_call') {
    if (row.role !== 'assistant') throw new Error(`Tool call '${row.id}' must use assistant role.`);
    let embedded: ReturnType<typeof parseToolCallMessageForModel>;
    try { embedded = parseToolCallMessageForModel(JSON.parse(row.content)); }
    catch (error) { throw new Error(`Tool call '${row.id}' has malformed embedded content: ${errorMessage(error)}`); }
    if (embedded.id !== row.tool_call_id || embedded.name !== row.tool) throw new Error(`Tool call '${row.id}' embedded identity does not match row metadata.`);
    return { failedResult: false };
  }
  if (row.kind === 'tool_result') {
    if (row.role !== 'tool') throw new Error(`Tool result '${row.id}' must use tool role.`);
    try { return { failedResult: ToolInvocationResultSchema.parse(JSON.parse(row.content)).success === false }; }
    catch (error) { throw new Error(`Tool result '${row.id}' has malformed content: ${errorMessage(error)}`); }
  }
  return { failedResult: false };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fallbackBoundary(row: CompactConversationSource): 'repair' | 'exchange' | 'message' {
  if (row.kind === 'tool_result') return row.failedToolResult ? 'repair' : 'exchange';
  return 'message';
}

function isSafeFallbackBoundary(last: CompactConversationSource, next: CompactConversationSource | undefined): boolean {
  if (last.kind === 'tool_call' || next?.kind === 'tool_result') return false;
  if (last.kind === 'provider_private' || next?.projectedPrivateMessageId === last.id) return false;
  return true;
}
