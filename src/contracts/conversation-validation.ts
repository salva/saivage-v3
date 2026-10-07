import {
  canonicalJson,
  conversationSessionIdentity,
  MODEL_RECOVERY_NOTICE_TEXT,
  parseCanonicalContentPolicyRefusal,
  type AgentMessage,
  type CompactedHistory,
  type ConversationSessionId,
  type RequiredModelFactSlots,
  type ProtectedPrompt,
} from '../schemas/index.js';
import { loggedToolCallIdentity, loggedToolResultIdentity } from '../schemas/index.js';
import { parseToolCallMessageForModel } from './persisted-tool-call.js';
import { ToolResultSchema } from './tool-result.js';
import { parsePrivateContent } from './responses-conversation.js';

type SourceSegment = {
  readonly kind: 'initial' | 'repair';
  readonly rows: readonly AgentMessage[];
};
type ActivationCheckpoint =
  | { readonly source: 'row'; readonly message: AgentMessage }
  | { readonly source: 'compacted_genesis'; readonly marker_id: string; readonly input_id: string };
export type SourceRound = {
  readonly state: 'closed' | 'open';
  readonly label: string;
  readonly activation: ActivationCheckpoint;
  readonly rows: readonly AgentMessage[];
  readonly segments: readonly SourceSegment[];
};

type CanonicalConversationCall = {
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

type CompactedGenesisIdentity = Readonly<{ id: string; timestamp: string }>;

export type ValidatedConversation = {
  readonly sourceSessionId: ConversationSessionId;
  readonly physicalRows: readonly AgentMessage[];
  readonly sourceRows: readonly AgentMessage[];
  readonly preamble: readonly AgentMessage[];
  readonly rounds: readonly SourceRound[];
  readonly safeSourcePrefixEnds: readonly number[];
  readonly calls: readonly CanonicalConversationCall[];
  readonly unmatchedCall: CanonicalConversationCall | null;
  readonly compactedGenesis: CompactedGenesisIdentity | null;
  readonly effectiveCompactedHistory: CompactedHistory | null;
  readonly effectiveRequiredModelFacts: RequiredModelFactSlots;
};

type ConversationProtectionSelection = Readonly<{
  protectedPrompts: readonly ProtectedPrompt[];
  activePrompts: readonly ProtectedPrompt[];
  releasedInheritedMessages: readonly AgentMessage[];
}>;

export function selectConversationProtection(args: {
  readonly inherited: readonly ProtectedPrompt[];
  readonly rows: readonly AgentMessage[];
  readonly sourceVersion: number;
  readonly cutoffCount: number;
}): ConversationProtectionSelection {
  const occurrences = [
    ...args.inherited.map((entry) => ({ entry, message: entry.message, inherited: true })),
    ...args.rows.map((message, rowIndex) => ({
      entry: { source: { segmentVersion: args.sourceVersion, rowIndex }, message },
      message,
      inherited: false,
    })),
  ];
  const selected = new Set<number>();
  const latestByKey = new Map<string, number>();
  occurrences.forEach((occurrence, index) => {
    const policy = occurrence.message.context_policy;
    if (policy.kind !== 'content' || policy.compactable) return;
    if (policy.compaction_key === undefined) selected.add(index);
    else latestByKey.set(policy.compaction_key, index);
  });
  for (const index of latestByKey.values()) selected.add(index);
  const activePrompts = occurrences
    .filter((_, index) => selected.has(index))
    .map(({ entry }) => entry);
  const protectedPrompts = occurrences.flatMap((occurrence, index) => {
    if (!selected.has(index)) return [];
    if (occurrence.inherited) return [occurrence.entry];
    const rowIndex = args.rows.indexOf(occurrence.message);
    return rowIndex < args.cutoffCount ? [occurrence.entry] : [];
  });
  const releasedInheritedMessages = occurrences
    .slice(0, args.inherited.length)
    .flatMap((occurrence, index) => (selected.has(index) ? [] : [occurrence.message]));
  return Object.freeze({
    protectedPrompts: Object.freeze(protectedPrompts),
    activePrompts: Object.freeze(activePrompts),
    releasedInheritedMessages: Object.freeze(releasedInheritedMessages),
  });
}

interface CanonicalConversationSourceCheckpoint {
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
  readonly rowOrdinal: number;
}

interface CanonicalConversationSegmentCheckpoint {
  readonly kind: 'initial' | 'repair';
  readonly start: number;
  end: number;
}
interface CanonicalConversationRoundCheckpoint {
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

interface CanonicalConversationValidationState {
  readonly sessionId: ConversationSessionId;
  readonly physicalIds: Set<string>;
  readonly sources: CanonicalConversationSourceCheckpoint[];
  readonly sourceOrdinals: Map<string, number>;
  readonly rounds: CanonicalConversationRoundCheckpoint[];
  readonly toolCalls: Map<string, CanonicalToolCallCheckpoint>;
  readonly toolResults: Map<string, number>;
  unmatchedCallKey: string | null;
  readonly pendingInheritedActivation: InheritedConversationActivation | null;
}

export interface InheritedConversationActivation {
  readonly markerId: string;
  readonly inputId: string;
  readonly activeSegmentKind: 'initial' | 'repair';
  readonly startOrdinal: number;
}
export interface CompactedGenesisSeed {
  readonly id: string;
  readonly timestamp: string;
  readonly history: CompactedHistory;
  readonly sourceVersion: number;
}

function createCanonicalConversationValidationState(
  sessionId: ConversationSessionId,
  inheritedActivation?: InheritedConversationActivation,
): CanonicalConversationValidationState {
  const state: CanonicalConversationValidationState = {
    sessionId,
    physicalIds: new Set(),
    sources: [],
    sourceOrdinals: new Map(),
    rounds: [],
    toolCalls: new Map(),
    toolResults: new Map(),
    unmatchedCallKey: null,
    pendingInheritedActivation: inheritedActivation ?? null,
  };
  return state;
}

function reduceCanonicalConversationRow(
  state: CanonicalConversationValidationState,
  row: AgentMessage,
  rowOrdinal: number,
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
  if (inherited && ordinal === inherited.startOrdinal)
    state.rounds.push({
      label: inherited.markerId,
      activationInputId: inherited.inputId,
      activationOrdinal: null,
      start: ordinal,
      end: ordinal,
      segments: [{ kind: inherited.activeSegmentKind, start: ordinal, end: ordinal }],
    });

  const toolFacts = validateToolContent(row);
  if (row.kind === 'provider_private') parsePrivateContent(row);
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
  }

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
    rowOrdinal,
  });
  validateToolOrdering(state, source, row, callIdentity, resultIdentity);
  state.sources.push(source);
  state.sourceOrdinals.set(source.id, ordinal);
  return state;
}

function finishCanonicalConversationValidation(
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
  compactedGenesis?: CompactedGenesisSeed,
): ValidatedConversation {
  if (compactedGenesis) validateSelfContainedCompactedHistory(sessionId, compactedGenesis);
  const state = createCanonicalConversationValidationState(sessionId, inheritedActivation);
  physicalRows.forEach((row, rowOrdinal) => reduceCanonicalConversationRow(state, row, rowOrdinal));
  if (inheritedActivation && state.sources.length === inheritedActivation.startOrdinal)
    state.rounds.push({
      label: inheritedActivation.markerId,
      activationInputId: inheritedActivation.inputId,
      activationOrdinal: null,
      start: inheritedActivation.startOrdinal,
      end: inheritedActivation.startOrdinal,
      segments: [
        {
          kind: inheritedActivation.activeSegmentKind,
          start: inheritedActivation.startOrdinal,
          end: inheritedActivation.startOrdinal,
        },
      ],
    });
  finishCanonicalConversationValidation(state);
  return materializeValidatedConversation(state, physicalRows, compactedGenesis ?? null);
}

export function validateAtomicCoveredSourcePrefix(
  conversation: ValidatedConversation,
  coveredRows: readonly AgentMessage[],
): void {
  if (coveredRows.length === 0) throw new Error('Compaction coverage requires source rows.');
  const ordinals = coveredRows.map((row) => {
    const ordinal = conversation.sourceRows.findIndex((source) => source.id === row.id);
    if (ordinal < 0)
      throw new Error(`Covered row '${row.id}' is not a source row of the current conversation.`);
    return ordinal;
  });
  if (
    ordinals[0] !== 0 ||
    ordinals.some((ordinal, index) => index > 0 && ordinal !== ordinals[index - 1]! + 1)
  )
    throw new Error('Covered rows are not one exact contiguous canonical source prefix.');
  const coveredSet = new Set(coveredRows.map((row) => row.id));
  const groups: string[][] = [];
  for (const row of coveredRows) {
    if (row.kind === 'tool_call') {
      if (
        row.provider_projection?.private_message_id &&
        coveredSet.has(row.provider_projection.private_message_id)
      )
        continue;
      const call = conversation.calls.find((candidate) => candidate.message.id === row.id);
      if (!call || call.resultSourceIndex === null)
        throw new Error(
          `Covered tool call '${row.id}' is not part of one complete settled exchange.`,
        );
      const result = conversation.sourceRows[call.resultSourceIndex]!;
      if (!coveredSet.has(result.id))
        throw new Error(
          `Compaction coverage would split the provider bundle of tool call '${row.id}'.`,
        );
      groups.push([row.id, result.id]);
      continue;
    }
    if (row.kind === 'tool_result') continue;
    if (row.kind === 'provider_private') {
      const mate = coveredRows.find(
        (candidate) => candidate.provider_projection?.private_message_id === row.id,
      );
      if (!mate)
        throw new Error(
          `Covered private row '${row.id}' would be split from its marked visible mate.`,
        );
      if (mate.kind !== 'tool_call') {
        groups.push([row.id, mate.id]);
        continue;
      }
      const call = conversation.calls.find((candidate) => candidate.message.id === mate.id);
      if (!call || call.resultSourceIndex === null)
        throw new Error(
          `Covered private tool call '${mate.id}' is not part of one complete settled exchange.`,
        );
      const result = conversation.sourceRows[call.resultSourceIndex]!;
      if (!coveredSet.has(result.id))
        throw new Error(
          `Compaction coverage would split the provider bundle of private tool call '${mate.id}'.`,
        );
      groups.push([row.id, mate.id, result.id]);
      continue;
    }
    if (
      row.provider_projection?.private_message_id &&
      coveredSet.has(row.provider_projection.private_message_id)
    )
      continue; // Already included by its preceding canonical private mate.
    groups.push([row.id]);
  }
  const flattened = groups.flat();
  if (JSON.stringify(flattened) !== JSON.stringify(coveredRows.map((row) => row.id)))
    throw new Error(
      'Atomic covered source groups do not reassemble the exact covered source order.',
    );
}

export function validateCompactedHistorySuccessor(args: {
  readonly source: ValidatedConversation;
  readonly sourceVersion: number;
  readonly successor: CompactedHistory;
  readonly coveredRows: readonly AgentMessage[];
}): void {
  const { source, successor } = args;
  const protection = selectConversationProtection({
    inherited: source.effectiveCompactedHistory?.protectedPrompts ?? [],
    rows: source.sourceRows,
    sourceVersion: args.sourceVersion,
    cutoffCount: args.coveredRows.length,
  });
  validateAtomicCoveredSourcePrefix(source, args.coveredRows);
  if (canonicalJson(protection.protectedPrompts) !== canonicalJson(successor.protectedPrompts))
    throw new Error(
      'Successor protected prompts do not exactly derive from the source protection selection.',
    );
  const expectedFacts = deriveRequiredModelFacts({
    inherited: source.effectiveCompactedHistory?.requiredModelFacts ?? {
      latestRecovery: null,
      latestContentPolicyRefusal: null,
    },
    coveredRows: args.coveredRows,
    source,
  });
  if (JSON.stringify(expectedFacts) !== JSON.stringify(successor.requiredModelFacts))
    throw new Error(
      'Successor required model facts do not match the newest covered canonical occurrences.',
    );
}

export function deriveRequiredModelFacts(args: {
  readonly inherited: RequiredModelFactSlots;
  readonly coveredRows: readonly AgentMessage[];
  readonly source: ValidatedConversation;
}): RequiredModelFactSlots {
  let latestRecovery = args.inherited.latestRecovery;
  let latestContentPolicyRefusal = args.inherited.latestContentPolicyRefusal;
  for (const row of args.coveredRows) {
    if (row.kind === 'model_recovered') {
      validateCoveredRecoveryRow(row);
      latestRecovery = {
        sourceMessageId: row.id,
        activationInputId: row.id.slice(0, -':model-recovered'.length),
      };
    }
    if (row.kind === 'content_policy_refusal') {
      const payload = parseCanonicalContentPolicyRefusal(row.content);
      validateCoveredRefusalRow(args.source, row, payload.source_input_id);
      latestContentPolicyRefusal = { markerId: row.id, activationInputId: payload.source_input_id };
    }
  }
  return { latestRecovery, latestContentPolicyRefusal };
}

function validateCoveredRecoveryRow(row: AgentMessage): void {
  const activationInputId = row.id.slice(0, -':model-recovered'.length);
  if (!row.id.endsWith(':model-recovered') || row.content !== MODEL_RECOVERY_NOTICE_TEXT)
    throw new Error(
      `Covered recovery notice '${row.id}' does not carry the exact canonical recovery warning and identity.`,
    );
  if (!isCanonicalUuid(activationInputId))
    throw new Error(
      `Covered recovery notice '${row.id}' does not name a canonical activation input id.`,
    );
}

function validateCoveredRefusalRow(
  source: ValidatedConversation,
  row: AgentMessage,
  activationInputId: string,
): void {
  if (!isCanonicalUuid(activationInputId))
    throw new Error(
      `Covered refusal marker '${row.id}' does not name a canonical activation input id.`,
    );
  const round = source.rounds.find((candidate) =>
    candidate.rows.some((candidateRow) => candidateRow.id === row.id),
  );
  if (!round || round.rows.at(-1)!.id !== row.id)
    throw new Error(
      `Covered refusal marker '${row.id}' is not the terminal row of its activation.`,
    );
}

function validateSelfContainedCompactedHistory(
  sessionId: ConversationSessionId,
  seed: CompactedGenesisSeed,
): void {
  const history = seed.history;
  const ids = new Set<string>();
  let prior: ProtectedPrompt['source'] | null = null;
  for (const entry of history.protectedPrompts) {
    if (entry.message.session_id !== sessionId)
      throw new Error('Compacted genesis protected prompt belongs to another session.');
    if (entry.message.context_policy.kind !== 'content' || entry.message.context_policy.compactable)
      throw new Error('Compacted genesis protected prompt is not protected-capable content.');
    if (ids.has(entry.message.id))
      throw new Error('Compacted genesis protected prompts contain duplicate message ids.');
    ids.add(entry.message.id);
    if (entry.source.segmentVersion > seed.sourceVersion)
      throw new Error(
        'Compacted genesis protected prompt source is later than its source segment.',
      );
    if (
      prior &&
      (entry.source.segmentVersion < prior.segmentVersion ||
        (entry.source.segmentVersion === prior.segmentVersion &&
          entry.source.rowIndex <= prior.rowIndex))
    )
      throw new Error('Compacted genesis protected prompt coordinates are not strictly ordered.');
    prior = entry.source;
  }
}

function materializeValidatedConversation(
  state: CanonicalConversationValidationState,
  physicalRows: readonly AgentMessage[],
  genesis: CompactedGenesisSeed | null,
): ValidatedConversation {
  const physical = Object.freeze([...physicalRows]);
  const sourceRows = Object.freeze(state.sources.map((source) => physical[source.rowOrdinal]!));
  if (genesis) {
    const protectedIds = new Set(genesis.history.protectedPrompts.map((entry) => entry.message.id));
    if (sourceRows.some((row) => protectedIds.has(row.id)))
      throw new Error(
        'Compacted genesis protected prompt ids must be disjoint from retained canonical rows.',
      );
  }
  const preambleEnd = state.rounds[0]?.start ?? sourceRows.length;
  const preamble = Object.freeze(sourceRows.slice(0, preambleEnd));
  const rounds = Object.freeze(
    state.rounds.map(
      (round, index): SourceRound =>
        Object.freeze({
          state: index === state.rounds.length - 1 ? ('open' as const) : ('closed' as const),
          label: round.label,
          activation:
            round.activationOrdinal === null
              ? {
                  source: 'compacted_genesis' as const,
                  marker_id: round.label,
                  input_id: round.activationInputId,
                }
              : { source: 'row' as const, message: sourceRows[round.activationOrdinal]! },
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
    calls,
    unmatchedCall,
    compactedGenesis: genesis
      ? Object.freeze({ id: genesis.id, timestamp: genesis.timestamp })
      : null,
    effectiveCompactedHistory: genesis?.history ?? null,
    effectiveRequiredModelFacts:
      genesis?.history.requiredModelFacts ??
      Object.freeze({ latestRecovery: null, latestContentPolicyRefusal: null }),
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
      throw new Error(
        `Tool result '${row.id}' does not commit to its call's policy template hash.`,
      );
    const result = parseToolResultContent(row);
    if (result.success) {
      const expected = call.evidenceMode;
      if (policy.evidence.kind !== expected)
        throw new Error(
          `Successful tool result '${row.id}' must carry exactly its call's declared '${expected}' evidence.`,
        );
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
    const result = ToolResultSchema.parse(JSON.parse(row.content));
    if (result.success && (row.tool === 'view_image') !== !!result.image)
      throw new Error(
        'Successful executed view_image requires an image descriptor; other tools cannot carry images.',
      );
    if (
      result.success &&
      result.image &&
      row.context_policy.kind === 'tool_result' &&
      row.context_policy.settlement_origin !== 'executed'
    )
      throw new Error('Only executed view_image results can select images.');
    return { success: result.success === true };
  } catch (error) {
    throw new Error(`Tool result '${row.id}' has malformed content: ${errorMessage(error)}`);
  }
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
        failedResult: ToolResultSchema.parse(JSON.parse(row.content)).success === false,
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
function isSafeFallbackBoundary(
  last: CanonicalConversationSourceCheckpoint,
  next: CanonicalConversationSourceCheckpoint | undefined,
): boolean {
  if (last.kind === 'tool_call' || next?.kind === 'tool_result') return false;
  if (last.kind === 'provider_private' || next?.projectedPrivateMessageId === last.id) return false;
  return true;
}
