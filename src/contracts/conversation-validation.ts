import { createHash } from 'node:crypto';

import type { GrowingFileReplay, GrowingFileRowCheckpoint } from '../persistence/growing-file.js';
import {
  canonicalJson,
  conversationSessionIdentity,
  parseCanonicalContextCompaction,
  type AgentMessage,
  type ContextCompactionContent,
  type ConversationSessionId,
} from '../schemas/index.js';
import { loggedToolCallIdentity, loggedToolResultIdentity } from '../schemas/message-identity.js';
import { parseToolCallMessageForModel } from './persisted-tool-call.js';
import { ToolInvocationResultSchema } from './tool-invocation-projection.js';

export type SourceSegment = {
  readonly kind: 'initial' | 'repair';
  readonly rows: readonly AgentMessage[];
};
export type ActivationCheckpoint = { readonly source: 'row'; readonly message: AgentMessage } | { readonly source: 'compacted_genesis'; readonly marker_id: string; readonly input_id: string };
export type SourceRound = {
  readonly label: string;
  readonly activation: ActivationCheckpoint;
  readonly rows: readonly AgentMessage[];
  readonly segments: readonly SourceSegment[];
};

export type ValidatedCompactionSegment = {
  readonly kind: 'initial' | 'repair';
  readonly sourceRows: readonly AgentMessage[];
  readonly repairAnchor: AgentMessage | null;
};

export type ValidatedCompactionRound = {
  readonly complete: boolean;
  readonly label: string;
  readonly sourceRows: readonly AgentMessage[];
  readonly segments: readonly ValidatedCompactionSegment[];
};

export type ValidatedCompactionGroup = {
  readonly payload: ContextCompactionContent['summaries'][number];
  readonly rounds: readonly ValidatedCompactionRound[];
  readonly sourceRows: readonly AgentMessage[];
};

export type ValidatedContextCompaction = {
  readonly metadataRow: ContextCompactionMetadata;
  readonly payload: ContextCompactionContent;
  readonly groups: readonly ValidatedCompactionGroup[];
  readonly cutoffSourceIndex: number;
  readonly cutoffMessageId: string;
  readonly boundary: ContextCompactionContent['boundary'];
  readonly renderedContext: string;
};
export interface ContextCompactionMetadata { readonly id: string; readonly session_id: ConversationSessionId; readonly role: 'system'; readonly kind: 'context_compaction'; readonly content: string; readonly round_id: string; readonly message_index: number; readonly block_index: number; readonly timestamp: string }

export type CanonicalConversationCall = {
  readonly sessionId: ConversationSessionId;
  readonly sourceInputId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly message: AgentMessage;
  readonly sourceIndex: number;
  readonly physicalIndex: number;
  readonly resultSourceIndex: number | null;
};

export type ValidatedConversation = {
  readonly sourceSessionId: ConversationSessionId;
  readonly physicalRows: readonly AgentMessage[];
  readonly sourceRows: readonly AgentMessage[];
  readonly preamble: readonly AgentMessage[];
  readonly rounds: readonly SourceRound[];
  readonly safeSourcePrefixEnds: readonly number[];
  readonly compactions: readonly ValidatedContextCompaction[];
  readonly latestCompaction: ValidatedContextCompaction | null;
  readonly calls: readonly CanonicalConversationCall[];
  readonly unmatchedCall: CanonicalConversationCall | null;
  readonly compactedGenesis: ConversationCompactedGenesisSeed | null;
};

export interface CanonicalConversationSourceCheckpoint {
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

export interface CanonicalConversationSegmentCheckpoint {
  readonly kind: 'initial' | 'repair';
  readonly start: number;
  end: number;
}
export interface CanonicalConversationRoundCheckpoint {
  readonly label: string;
  readonly activationInputId: string;
  readonly activationOrdinal: number | null;
  readonly start: number;
  end: number;
  readonly segments: CanonicalConversationSegmentCheckpoint[];
}
interface CanonicalToolCallCheckpoint {
  readonly key: string;
  readonly toolName: string;
  readonly sourceInputId: string;
  readonly toolCallId: string;
  readonly templateSha256: string;
  readonly evidenceMode: 'none' | 'observational_query' | 'canonical_locator';
  readonly sourceOrdinal: number;
  readonly physicalOrdinal: number;
  resultOrdinal: number | null;
}
interface CanonicalCompactionRoundCheckpoint {
  readonly complete: boolean;
  readonly label: string;
  readonly sourceOrdinals: readonly number[];
  readonly segments: readonly { kind: 'initial' | 'repair'; sourceOrdinals: readonly number[] }[];
}
interface CanonicalCompactionCheckpoint {
  readonly physicalOrdinal: number;
  readonly metadata: ContextCompactionMetadata;
  readonly payload: ContextCompactionContent;
  readonly groups: readonly {
    payload: ContextCompactionContent['summaries'][number];
    rounds: readonly CanonicalCompactionRoundCheckpoint[];
    sourceOrdinals: readonly number[];
  }[];
  readonly cutoffSourceOrdinal: number;
}

export interface CanonicalConversationValidationState {
  readonly sessionId: ConversationSessionId;
  readonly physicalIds: Set<string>;
  readonly sources: CanonicalConversationSourceCheckpoint[];
  readonly sourceOrdinals: Map<string, number>;
  readonly rounds: CanonicalConversationRoundCheckpoint[];
  readonly retainedStaticIds: string[];
  readonly toolCalls: Map<string, CanonicalToolCallCheckpoint>;
  readonly toolResults: Map<string, number>;
  readonly compactions: CanonicalCompactionCheckpoint[];
  replayBytesRead: number;
  unmatchedCallKey: string | null;
  readonly pendingInheritedActivation: InheritedConversationActivation | null;
}

export interface InheritedConversationActivation {
  readonly markerId: string;
  readonly inputId: string;
  readonly activeSegmentKind: 'initial' | 'repair';
  readonly startOrdinal: number;
}
export interface ConversationCompactedGenesisSeed {
  readonly id: string;
  readonly timestamp: string;
  readonly payload: ContextCompactionContent;
  readonly retainedStaticRowCount: number;
}

export function createCanonicalConversationValidationState(
  sessionId: ConversationSessionId,
  inheritedActivation?: InheritedConversationActivation,
): CanonicalConversationValidationState {
  const state: CanonicalConversationValidationState = {
    sessionId,
    physicalIds: new Set(),
    sources: [],
    sourceOrdinals: new Map(),
    rounds: [],
    retainedStaticIds: [],
    toolCalls: new Map(),
    toolResults: new Map(),
    compactions: [],
    replayBytesRead: 0,
    unmatchedCallKey: null,
    pendingInheritedActivation: inheritedActivation ?? null,
  };
  return state;
}

export function reduceCanonicalConversationRow(
  state: CanonicalConversationValidationState,
  row: AgentMessage,
  checkpoint: GrowingFileRowCheckpoint,
  replay: GrowingFileReplay<AgentMessage>,
): CanonicalConversationValidationState {
  if (row.session_id !== state.sessionId)
    throw new Error(
      `Conversation row '${row.id}' belongs to session '${row.session_id}', not source session '${state.sessionId}'.`,
    );
  if (state.physicalIds.has(row.id))
    throw new Error('Conversation contains duplicate message ids.');
  state.physicalIds.add(row.id);
  const ordinal = state.sources.length;
  const inherited = state.pendingInheritedActivation;
  if (inherited && ordinal === inherited.startOrdinal) state.rounds.push({ label: inherited.markerId, activationInputId: inherited.inputId, activationOrdinal: null, start: ordinal, end: ordinal, segments: [{ kind: inherited.activeSegmentKind, start: ordinal, end: ordinal }] });

  const toolFacts = validateToolContent(row);
  const repairAnchor =
    row.kind === 'model_repair' || row.kind === 'content_policy_retry' || toolFacts.failedResult;
  const opensRound = validateActivationOpenMarker(state.sessionId, row);
  if (
    conversationSessionIdentity(state.sessionId).cardId === null &&
    state.rounds.length === 0 &&
    !opensRound
  ) {
    throw new Error(
      `Global-agent conversation '${state.sessionId}' must start with an exact activation_open marker and have an empty preamble.`,
    );
  }
  if (opensRound)
    state.rounds.push({
      label: row.id,
      activationInputId: JSON.parse(row.content).input_id as string,
      activationOrdinal: ordinal,
      start: ordinal,
      end: ordinal + 1,
      segments: [{ kind: 'initial', start: ordinal, end: ordinal + 1 }],
    });
  else if (state.rounds.length > 0) {
    const round = state.rounds.at(-1)!;
    round.end = ordinal + 1;
    if (repairAnchor) round.segments.push({ kind: 'repair', start: ordinal, end: ordinal + 1 });
    else round.segments.at(-1)!.end = ordinal + 1;
  } else if (row.role === 'system' && row.kind !== 'activity') state.retainedStaticIds.push(row.id);

  const callIdentity = loggedToolCallIdentity(row);
  const resultIdentity = loggedToolResultIdentity(row);
  const sourceInputId = callIdentity?.source_input_id ?? resultIdentity?.source_input_id ?? null;
  const source = Object.freeze({
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
  validateToolOrdering(state, source, row, callIdentity, resultIdentity);
  state.sources.push(source);
  state.sourceOrdinals.set(source.id, ordinal);
  return state;
}

export function finishCanonicalConversationValidation(
  state: CanonicalConversationValidationState,
): CanonicalConversationValidationState {
  const unmatched = [...state.toolCalls.values()].filter((call) => call.resultOrdinal === null);
  if (unmatched.length > 1)
    throw new Error('Conversation contains more than one unmatched tool call.');
  if (unmatched.length === 1 && unmatched[0]!.sourceOrdinal !== state.sources.length - 1)
    throw new Error('Conversation contains a non-final unmatched tool call.');
  state.unmatchedCallKey = unmatched[0]?.key ?? null;
  return state;
}

export function validateConversation(
  sessionId: ConversationSessionId,
  physicalRows: readonly AgentMessage[],
  inheritedActivation?: InheritedConversationActivation,
  compactedGenesis?: ConversationCompactedGenesisSeed,
): ValidatedConversation {
  const state = createCanonicalConversationValidationState(sessionId, inheritedActivation);
  const replayRows = (checkpoints: readonly GrowingFileRowCheckpoint[]): readonly AgentMessage[] =>
    checkpoints.map((checkpoint) => {
      const row = physicalRows[checkpoint.rowOrdinal];
      if (!row) throw new Error('Conversation replay checkpoint is invalid.');
      return row;
    });
  const replay: GrowingFileReplay<AgentMessage> = {
    replayRow: (checkpoint) => replayRows([checkpoint])[0]!,
    replayRows,
  };
  physicalRows.forEach((row, rowOrdinal) =>
    reduceCanonicalConversationRow(state, row, { lineStart: 0, lineEnd: 1, rowOrdinal }, replay),
  );
  finishCanonicalConversationValidation(state);
  return { ...materializeValidatedConversation(state, physicalRows), compactedGenesis: compactedGenesis ?? null };
}

export function validateProspectiveContextCompaction(conversation: ValidatedConversation, metadata: ContextCompactionMetadata): ValidatedConversation {
  const physicalRows = conversation.physicalRows;
  const seeds = conversation.compactedGenesis;
  const inheritedRound = conversation.rounds.find((round) => round.activation.source === 'compacted_genesis');
  const inherited = inheritedRound ? { markerId: inheritedRound.activation.source === 'compacted_genesis' ? inheritedRound.activation.marker_id : '', inputId: inheritedRound.activation.source === 'compacted_genesis' ? inheritedRound.activation.input_id : '', activeSegmentKind: inheritedRound.segments.at(-1)!.kind, startOrdinal: inheritedRound.rows.length === 0 ? 0 : physicalRows.findIndex((row) => row.id === inheritedRound.rows[0]!.id) } : undefined;
  const state = createCanonicalConversationValidationState(conversation.sourceSessionId, inherited);
  const replay: GrowingFileReplay<AgentMessage> = { replayRow: (checkpoint) => physicalRows[checkpoint.rowOrdinal]!, replayRows: (checkpoints) => checkpoints.map((checkpoint) => physicalRows[checkpoint.rowOrdinal]!) };
  physicalRows.forEach((row, rowOrdinal) => reduceCanonicalConversationRow(state, row, { lineStart: 0, lineEnd: 1, rowOrdinal }, replay));
  state.compactions.push(validateCompaction(state, metadata, physicalRows.length, replay)); finishCanonicalConversationValidation(state);
  return { ...materializeValidatedConversation(state, physicalRows), compactedGenesis: seeds };
}

export function estimateCanonicalConversationValidationBytes(
  state: CanonicalConversationValidationState,
): number {
  return (
    state.sources.reduce(
      (total, source) =>
        total +
        source.id.length +
        source.role.length +
        source.kind.length +
        (source.toolName?.length ?? 0) +
        (source.toolCallId?.length ?? 0) +
        (source.sourceInputId?.length ?? 0) +
        (source.projectedPrivateMessageId?.length ?? 0) +
        64,
      0,
    ) +
    state.retainedStaticIds.reduce((total, id) => total + id.length, 0) +
    [...state.toolCalls.values()].reduce(
      (total, call) => total + call.key.length + call.toolName.length + 16,
      0,
    ) +
    [...state.toolResults.keys()].reduce((total, key) => total + key.length + 8, 0)
  );
}

export function validatedSourceSegmentsForPrefix(
  conversation: ValidatedConversation,
  rows: readonly AgentMessage[],
): readonly SourceSegment[] {
  const ids = rows.map((row) => row.id);
  const round = conversation.rounds.find(
    (candidate) =>
      ids.length <= candidate.rows.length &&
      ids.every((id, index) => candidate.rows[index]!.id === id),
  );
  if (!round || ids.length === 0)
    throw new Error('Source rows are not a non-empty prefix of one validated canonical round.');
  let remaining = ids.length;
  const segments: SourceSegment[] = [];
  for (const segment of round.segments) {
    if (remaining === 0) break;
    const selected = segment.rows.slice(0, remaining);
    if (selected.length > 0)
      segments.push(Object.freeze({ kind: segment.kind, rows: Object.freeze(selected) }));
    remaining -= selected.length;
  }
  return Object.freeze(segments);
}

export function isSafeValidatedSourcePrefix(
  conversation: ValidatedConversation,
  rows: readonly AgentMessage[],
): boolean {
  validatedSourceSegmentsForPrefix(conversation, rows);
  const lastIndex = conversation.sourceRows.findIndex((row) => row.id === rows.at(-1)!.id);
  return conversation.safeSourcePrefixEnds.includes(lastIndex + 1);
}

function materializeValidatedConversation(
  state: CanonicalConversationValidationState,
  physicalRows: readonly AgentMessage[],
): ValidatedConversation {
  const physical = Object.freeze([...physicalRows]);
  const sourceRows = Object.freeze(state.sources.map((source) => physical[source.rowOrdinal]!));
  const preambleEnd = state.rounds[0]?.start ?? sourceRows.length;
  const preamble = Object.freeze(sourceRows.slice(0, preambleEnd));
  const rounds = Object.freeze(
    state.rounds.map(
      (round): SourceRound =>
        Object.freeze({
          label: round.label,
          activation: round.activationOrdinal === null ? { source: 'compacted_genesis' as const, marker_id: round.label, input_id: round.activationInputId } : { source: 'row' as const, message: sourceRows[round.activationOrdinal]! },
          rows: Object.freeze(sourceRows.slice(round.start, round.end)),
          segments: Object.freeze(
            round.segments.map((segment) =>
              Object.freeze({
                kind: segment.kind,
                rows: Object.freeze(sourceRows.slice(segment.start, segment.end)),
              }),
            ),
          ),
        }),
    ),
  );
  const compactions = Object.freeze(
    state.compactions.map((compaction): ValidatedContextCompaction => {
      const groups = Object.freeze(
        compaction.groups.map(
          (group): ValidatedCompactionGroup =>
            Object.freeze({
              payload: group.payload,
              rounds: Object.freeze(
                group.rounds.map(
                  (round): ValidatedCompactionRound =>
                    Object.freeze({
                      complete: round.complete,
                      label: round.label,
                      sourceRows: Object.freeze(
                        round.sourceOrdinals.map((ordinal) => sourceRows[ordinal]!),
                      ),
                      segments: Object.freeze(
                        round.segments.map(
                          (segment): ValidatedCompactionSegment =>
                            Object.freeze({
                              kind: segment.kind,
                              sourceRows: Object.freeze(
                                segment.sourceOrdinals.map((ordinal) => sourceRows[ordinal]!),
                              ),
                              repairAnchor:
                                segment.kind === 'repair'
                                  ? sourceRows[segment.sourceOrdinals[0]!]!
                                  : null,
                            }),
                        ),
                      ),
                    }),
                ),
              ),
              sourceRows: Object.freeze(
                group.sourceOrdinals.map((ordinal) => sourceRows[ordinal]!),
              ),
            }),
        ),
      );
      const cutoff = sourceRows[compaction.cutoffSourceOrdinal]!;
      return Object.freeze({
        metadataRow: compaction.metadata,
        payload: compaction.payload,
        groups,
        cutoffSourceIndex: compaction.cutoffSourceOrdinal,
        cutoffMessageId: cutoff.id,
        boundary: compaction.payload.boundary,
        renderedContext: renderContextCompactionPayload(compaction.payload),
      });
    }),
  );
  const calls = Object.freeze(
    [...state.toolCalls.values()].map(
      (call): CanonicalConversationCall =>
        Object.freeze({
          sessionId: state.sessionId,
          sourceInputId: call.sourceInputId,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          startedAt: sourceRows[call.sourceOrdinal]!.timestamp,
          message: sourceRows[call.sourceOrdinal]!,
          sourceIndex: call.sourceOrdinal,
          physicalIndex: call.physicalOrdinal,
          resultSourceIndex: call.resultOrdinal,
        }),
    ),
  );
  const unmatchedCall =
    state.unmatchedCallKey === null
      ? null
      : (calls.find((call) => toolKey(call) === state.unmatchedCallKey) ?? null);
  if (state.unmatchedCallKey !== null && unmatchedCall === null)
    throw new Error('Canonical unmatched tool call fact is missing.');
  const safeSourcePrefixEnds = Object.freeze(
    state.sources.flatMap((source, index) =>
      isSafeFallbackBoundary(source, state.sources[index + 1]) ? [index + 1] : [],
    ),
  );
  return Object.freeze({
    sourceSessionId: state.sessionId,
    physicalRows: physical,
    sourceRows,
    preamble,
    rounds,
    safeSourcePrefixEnds,
    compactions,
    latestCompaction: compactions.at(-1) ?? null,
    calls,
    unmatchedCall,
    compactedGenesis: null,
  });
}

function validateToolOrdering(
  state: CanonicalConversationValidationState,
  source: CanonicalConversationSourceCheckpoint,
  row: AgentMessage,
  callIdentity: ReturnType<typeof loggedToolCallIdentity>,
  resultIdentity: ReturnType<typeof loggedToolResultIdentity>,
): void {
  if (callIdentity) {
    if (row.context_policy.kind !== 'tool_call')
      throw new Error(`Tool call '${row.id}' is missing its tool_call context policy.`);
    const key = toolKey(callIdentity);
    if (state.toolCalls.has(key))
      throw new Error('Conversation contains a duplicate tool call identity.');
    state.toolCalls.set(key, {
      key,
      toolName: source.toolName!,
      sourceInputId: callIdentity.source_input_id,
      toolCallId: callIdentity.tool_call_id,
      templateSha256: row.context_policy.template_sha256,
      evidenceMode: row.context_policy.template.evidenceMode,
      sourceOrdinal: state.sources.length,
      physicalOrdinal: source.rowOrdinal,
      resultOrdinal: null,
    });
    return;
  }
  if (resultIdentity) {
    if (row.context_policy.kind !== 'tool_result')
      throw new Error(`Tool result '${row.id}' is missing its tool_result context policy.`);
    const key = toolKey(resultIdentity);
    if (state.toolResults.has(key))
      throw new Error('Conversation contains a duplicate tool result identity.');
    const call = state.toolCalls.get(key);
    if (!call || call.toolName !== source.toolName)
      throw new Error(
        'Conversation tool result has no matching earlier call with the same identity and tool name.',
      );
    const policy = row.context_policy;
    if (policy.call_policy_sha256 !== call.templateSha256)
      throw new Error(`Tool result '${row.id}' does not commit to its call's policy template hash.`);
    const result = parseToolResultContent(row);
    if (result.success) {
      const expected = call.evidenceMode;
      if (policy.evidence.kind !== expected)
        throw new Error(`Successful tool result '${row.id}' must carry exactly its call's declared '${expected}' evidence.`);
    } else if (policy.evidence.kind !== 'none') {
      throw new Error(`Failed tool result '${row.id}' must carry none evidence.`);
    }
    const resultOrdinal = state.sources.length;
    state.toolResults.set(key, resultOrdinal);
    call.resultOrdinal = resultOrdinal;
  }
}

function parseToolResultContent(row: AgentMessage): { success: boolean } {
  try {
    return { success: ToolInvocationResultSchema.parse(JSON.parse(row.content)).success === true };
  } catch (error) {
    throw new Error(`Tool result '${row.id}' has malformed content: ${errorMessage(error)}`);
  }
}

function validateCompaction(
  state: CanonicalConversationValidationState,
  row: ContextCompactionMetadata,
  physicalOrdinal: number,
  replay: GrowingFileReplay<AgentMessage>,
): CanonicalCompactionCheckpoint {
  if (row.session_id !== state.sessionId || row.role !== 'system' || row.kind !== 'context_compaction' || state.physicalIds.has(row.id)) throw new Error('Compaction metadata identity is invalid.');
  const payload = parseCanonicalContextCompaction(row.content);
  const groups: CanonicalCompactionCheckpoint['groups'][number][] = [];
  let roundIndex = 0;
  for (const group of payload.summaries) {
    const rounds: CanonicalCompactionRoundCheckpoint[] = [];
    const groupOrdinals: number[] = [];
    for (const roundPayload of group.rounds) {
      const round = state.rounds[roundIndex++];
      if (!round)
        throw new Error(
          'Compaction references more rounds than physically preceding source rows contain.',
        );
      const ids = roundPayload.segments.flatMap((segment) => segment.source_message_ids);
      const ordinals = ids.map((id) => {
        const ordinal = state.sourceOrdinals.get(id);
        if (ordinal === undefined)
          throw new Error(
            `Compaction source message '${id}' is not a physically preceding source row.`,
          );
        return ordinal;
      });
      const expectedLength = roundPayload.complete ? round.end - round.start : ordinals.length;
      const expected = Array.from(
        { length: expectedLength },
        (_unused, index) => round.start + index,
      );
      assertOrdinals(
        ordinals,
        expected,
        `Compaction round '${round.label}' is not the canonical ${roundPayload.complete ? 'complete round' : 'round prefix'}.`,
      );
      if (!roundPayload.complete && ordinals.length >= round.end - round.start)
        throw new Error(`Partial compaction round '${round.label}' must omit a non-empty suffix.`);
      const expectedSegments = segmentsForPrefix(round, ordinals.length);
      if (roundPayload.segments.length !== expectedSegments.length)
        throw new Error(`Compaction round '${round.label}' has incorrect source segmentation.`);
      const segments = roundPayload.segments.map((segment, index) => {
        const expectedSegment = expectedSegments[index]!;
        if (segment.kind !== expectedSegment.kind)
          throw new Error(`Compaction round '${round.label}' has incorrect source segmentation.`);
        const sourceOrdinals = segment.source_message_ids.map(
          (id) => state.sourceOrdinals.get(id)!,
        );
        assertOrdinals(
          sourceOrdinals,
          expectedSegment.ordinals,
          `Compaction round '${round.label}' has incorrect source segmentation.`,
        );
        return Object.freeze({ kind: segment.kind, sourceOrdinals: Object.freeze(sourceOrdinals) });
      });
      groupOrdinals.push(...ordinals);
      rounds.push(
        Object.freeze({
          complete: roundPayload.complete,
          label: round.label,
          sourceOrdinals: Object.freeze(ordinals),
          segments: Object.freeze(segments),
        }),
      );
    }
    if (hashReplayedRows(state, groupOrdinals, replay) !== group.content_hash)
      throw new Error('Compaction raw content hash mismatch.');
    groups.push(
      Object.freeze({
        payload: group,
        rounds: Object.freeze(rounds),
        sourceOrdinals: Object.freeze(groupOrdinals),
      }),
    );
  }
  const covered = groups.flatMap((group) => group.sourceOrdinals);
  if (covered.length === 0) throw new Error('Compaction must cover source rows.');
  const expectedCovered = groups
    .flatMap((group) => group.rounds)
    .flatMap((round) => round.sourceOrdinals);
  assertOrdinals(
    covered,
    expectedCovered,
    'Compaction coverage is not the canonical source prefix.',
  );
  if (
    JSON.stringify(payload.retained_static_message_ids) !== JSON.stringify(state.retainedStaticIds)
  )
    throw new Error(
      'Compaction retained static message ids do not match the eligible preceding preamble.',
    );
  const finalRound = groups.at(-1)!.rounds.at(-1)!;
  const cutoffOrdinal = covered.at(-1)!;
  if (
    !finalRound.complete &&
    !isSafeFallbackBoundary(state.sources[cutoffOrdinal]!, state.sources[cutoffOrdinal + 1])
  )
    throw new Error('Partial compaction round ends inside an indivisible provider bundle.');
  const expectedBoundary = finalRound.complete
    ? 'round'
    : fallbackBoundary(state.sources[cutoffOrdinal]!);
  if (payload.boundary !== expectedBoundary)
    throw new Error(
      `Compaction boundary '${payload.boundary}' does not match derived boundary '${expectedBoundary}'.`,
    );
  const previous = state.compactions.at(-1);
  if (previous && cutoffOrdinal < previous.cutoffSourceOrdinal)
    throw new Error('Compaction cutoff retreats behind the preceding canonical compaction.');
  return Object.freeze({
    physicalOrdinal,
    metadata: row,
    payload,
    groups: Object.freeze(groups),
    cutoffSourceOrdinal: cutoffOrdinal,
  });
}

function hashReplayedRows(
  state: CanonicalConversationValidationState,
  ordinals: readonly number[],
  replay: GrowingFileReplay<AgentMessage>,
): string {
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
    if (row.id !== source.id)
      throw new Error(
        `Conversation replay row '${row.id}' does not match checkpointed source '${source.id}'.`,
      );
    if (index > 0) hash.update('\n', 'utf8');
    hash.update(conversationRowHashText(row), 'utf8');
  });
  return hash.digest('hex');
}

function segmentsForPrefix(
  round: CanonicalConversationRoundCheckpoint,
  length: number,
): Array<{ kind: 'initial' | 'repair'; ordinals: number[] }> {
  let remaining = length;
  const result: Array<{ kind: 'initial' | 'repair'; ordinals: number[] }> = [];
  for (const segment of round.segments) {
    if (remaining === 0) break;
    const count = Math.min(remaining, segment.end - segment.start);
    result.push({
      kind: segment.kind,
      ordinals: Array.from({ length: count }, (_unused, index) => segment.start + index),
    });
    remaining -= count;
  }
  return result;
}

function assertOrdinals(
  actual: readonly number[],
  expected: readonly number[],
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

function toolKey(identity: {
  session_id?: string;
  sessionId?: string;
  source_input_id?: string;
  sourceInputId?: string;
  tool_call_id?: string;
  toolCallId?: string;
}): string {
  return JSON.stringify([
    identity.session_id ?? identity.sessionId,
    identity.source_input_id ?? identity.sourceInputId,
    identity.tool_call_id ?? identity.toolCallId,
  ]);
}

function validateToolContent(row: AgentMessage): { failedResult: boolean } {
  if (row.kind === 'tool_call') {
    if (row.role !== 'assistant') throw new Error(`Tool call '${row.id}' must use assistant role.`);
    let embedded: ReturnType<typeof parseToolCallMessageForModel>;
    try {
      embedded = parseToolCallMessageForModel(JSON.parse(row.content));
    } catch (error) {
      throw new Error(
        `Tool call '${row.id}' has malformed embedded content: ${errorMessage(error)}`,
      );
    }
    if (embedded.id !== row.tool_call_id || embedded.name !== row.tool)
      throw new Error(`Tool call '${row.id}' embedded identity does not match row metadata.`);
    return { failedResult: false };
  }
  if (row.kind === 'tool_result') {
    if (row.role !== 'tool') throw new Error(`Tool result '${row.id}' must use tool role.`);
    try {
      return {
        failedResult: ToolInvocationResultSchema.parse(JSON.parse(row.content)).success === false,
      };
    } catch (error) {
      throw new Error(`Tool result '${row.id}' has malformed content: ${errorMessage(error)}`);
    }
  }
  return { failedResult: false };
}

function validateActivationOpenMarker(
  sourceSessionId: ConversationSessionId,
  message: AgentMessage,
): boolean {
  if (message.kind !== 'activity') return false;
  const payload = parseJsonObject(message.content);
  if (payload.event !== 'activation_open') return false;
  const identity = conversationSessionIdentity(sourceSessionId);
  const expectedKeys =
    identity.cardId === null
      ? ['agent_name', 'event', 'input_id', 'timestamp']
      : ['agent_name', 'card_id', 'event', 'input_id', 'timestamp'];
  if (
    JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expectedKeys) ||
    payload.agent_name !== identity.agentName ||
    payload.timestamp !== message.timestamp ||
    !isCanonicalUuid(payload.input_id) ||
    (identity.cardId !== null && payload.card_id !== identity.cardId)
  ) {
    throw new Error(
      `Conversation '${sourceSessionId}' has a malformed ${identity.agentName} activation_open marker.`,
    );
  }
  return true;
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isCanonicalUuid(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function fallbackBoundary(
  row: CanonicalConversationSourceCheckpoint,
): 'repair' | 'exchange' | 'message' {
  return row.kind === 'tool_result' ? (row.failedToolResult ? 'repair' : 'exchange') : 'message';
}
function isSafeFallbackBoundary(
  last: CanonicalConversationSourceCheckpoint,
  next: CanonicalConversationSourceCheckpoint | undefined,
): boolean {
  if (last.kind === 'tool_call' || next?.kind === 'tool_result') return false;
  if (last.kind === 'provider_private' || next?.projectedPrivateMessageId === last.id) return false;
  return true;
}

export function renderCompactionContext(groups: readonly ValidatedCompactionGroup[]): string {
  return renderContextCompactionPayload({ summaries: groups.map((group) => group.payload) });
}
export function renderContextCompactionPayload(payload: Pick<ContextCompactionContent, 'summaries'>): string {
  return payload.summaries.map((group, index) => {
    const partial = group.rounds.some((round) => !round.complete);
    const heading = group.kind === 'merged' ? 'Merged history' : `History summary ${index + 1}${partial ? ' (partial prefix)' : ''}`;
    return `${heading}:\n${group.summary_text}${renderEvidence(group.evidence)}`;
  }).join('\n\n');
}

function renderEvidence(evidence: readonly unknown[]): string {
  return evidence.length === 0
    ? ''
    : `\nRecoverable evidence:\n${evidence.map((item) => `- ${canonicalJson(item)}`).join('\n')}`;
}
export function hashConversationRows(rows: readonly AgentMessage[]): string {
  return createHash('sha256')
    .update(rows.map(conversationRowHashText).join('\n'), 'utf8')
    .digest('hex');
}
export function conversationRowHashText(row: AgentMessage): string {
  return JSON.stringify({
    id: row.id,
    role: row.role,
    kind: row.kind,
    content: row.content,
    tool: row.tool,
    tool_call_id: row.tool_call_id,
    source_input_id: undefined,
  });
}
