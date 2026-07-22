import type { AgentMessage, MessageKind, ConversationSessionId } from '../../schemas/index.js';
import {
  loggedToolCallIdentity,
  loggedToolCallKey,
  loggedToolResultIdentity,
} from '../../schemas/message-identity.js';
import { appendRecoveryNotice, isExactRecoveryNotice } from './conversation-session.js';
import { appendProviderVisibleSyntheticFailedToolResult } from './llm-delivery-log.js';
import { readConversation, type ConversationFileContext } from '../../persistence/conversation-file.js';
import { inspectCanonicalCallSettlementPairs } from './conversation-call-pairs.js';
import { validateConversationRows, type ValidatedConversation } from '../../contracts/conversation-compaction.js';

export type ConversationImplicitState =
  | 'empty'
  | 'system_prompt_only'
  | 'awaiting_tool_result'
  | 'settled_terminal'
  | 'assistant_text_pending'
  | 'pending_provider';

type RecoveryVisibility = 'visible' | 'ignored';

const recoveryVisibilityByKind = {
  text: 'visible',
  activity: 'ignored',
  tool_call: 'visible',
  tool_result: 'visible',
  model_issue: 'visible',
  model_repair: 'visible',
  context_compaction: 'visible',
  model_recovered: 'visible',
  system_prompt: 'visible',
  provider_private: 'ignored',
} as const satisfies Record<MessageKind, RecoveryVisibility>;

export function classifyConversation(messages: readonly AgentMessage[], terminalToolNames: ReadonlySet<string>): ConversationImplicitState {
  const recoveryVisibilities = messages.map((message) => recoveryVisibility(message.kind));

  const recoveryVisible = messages.filter((_message, index) => recoveryVisibilities[index] === 'visible');
  if (recoveryVisible.length === 0) return 'empty';
  if (recoveryVisible.length === 1 && recoveryVisible[0]?.kind === 'system_prompt') return 'system_prompt_only';

  const recoverySettlements = recoverySettlementKeys(recoveryVisible);
  for (let index = recoveryVisible.length - 1; index >= 0; index -= 1) {
    const message = recoveryVisible[index]!;
    if (message.kind !== 'tool_call') continue;
    const identity = toolCallIdentity(message);
    if (!recoverySettlements.has(loggedToolCallKey(identity))) return 'awaiting_tool_result';
    break;
  }

  if (lastModelVisibleExchangeIsSettledTerminal(recoveryVisible, terminalToolNames)) return 'settled_terminal';

  const last = recoveryVisible.at(-1)!;
  if (last.kind === 'text' && last.role === 'assistant') return 'assistant_text_pending';
  return 'pending_provider';
}

function recoveryVisibility(kind: MessageKind): RecoveryVisibility {
  if (!Object.hasOwn(recoveryVisibilityByKind, kind)) throw new Error(`Unhandled conversation message kind '${String(kind)}'.`);
  return recoveryVisibilityByKind[kind];
}

export type RoleSessionStabilization =
  | { disposition: 'clean'; messages: AgentMessage[] }
  | { disposition: 'ordinary_interruption'; messages: AgentMessage[] };

export function stabilizeRoleSession(args: {
  projectRoot: string;
  sessionId: ConversationSessionId;
  conversations: ConversationFileContext;
  terminalToolNames: ReadonlySet<string>;
}): RoleSessionStabilization {
  let conversation: ValidatedConversation;
  try { conversation = readConversation(args.projectRoot, args.sessionId); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    conversation = validateConversationRows(args.sessionId, []);
  }
  const messages = conversation.physicalRows;
  const sourceRows = conversation.sourceRows;
  const activationIndexes = sourceRows.flatMap((message, index) => activationMarker(message) ? [index] : []);
  if (activationIndexes.length === 0) {
    validateCallSettlementPairs(messages, null, false, args.terminalToolNames);
    const state = classifyConversation(sourceRows, args.terminalToolNames);
    if (state !== 'empty' && state !== 'system_prompt_only' && state !== 'settled_terminal') throw new Error(`Non-clean role session '${args.sessionId}' has no activation marker.`);
    return { disposition: 'clean', messages };
  }
  const latestActivationIndex = activationIndexes.at(-1)!;
  const marker = requireAssociatedActivationMarker(sourceRows[latestActivationIndex]!, args.sessionId);
  const activationRows = sourceRows.slice(latestActivationIndex);
  const final = activationRows.at(-1)!;
  const exactFinalRecovery = isExactRecoveryNotice(final, args.sessionId, marker.inputId);
  const recoveryRows = activationRows.filter((message) => message.kind === 'model_recovered');
  if (recoveryRows.length > 0 && !exactFinalRecovery) throw new Error(`Interrupted activation '${marker.inputId}' has a recovery notice that is not its final exact canonical source row.`);
  if (exactFinalRecovery) {
    if (recoveryRows.length !== 1) throw new Error(`Interrupted activation '${marker.inputId}' has colliding recovery notices.`);
    validateCallSettlementPairs(messages, physicalIndexForSource(messages, sourceRows[latestActivationIndex]!), false, args.terminalToolNames);
    return { disposition: 'clean', messages };
  }
  const state = classifyConversation(activationRows, args.terminalToolNames);
  if (state === 'settled_terminal') {
    validateCallSettlementPairs(messages, physicalIndexForSource(messages, sourceRows[latestActivationIndex]!), false, args.terminalToolNames);
    return { disposition: 'clean', messages };
  }
  const latestPhysicalIndex = physicalIndexForSource(messages, sourceRows[latestActivationIndex]!);
  const unmatched = validateCallSettlementPairs(messages, latestPhysicalIndex, true, args.terminalToolNames);
  if (unmatched) {
    appendProviderVisibleSyntheticFailedToolResult(args.conversations, {
      sessionId: args.sessionId,
      sourceInputId: unmatched.sourceInputId,
      toolCallId: unmatched.toolCallId,
      toolName: unmatched.toolName,
      error: 'Runtime activation was interrupted before completion. External or domain effects may or may not have happened.',
      data: { outcome_unknown: true },
    });
  }
  appendRecoveryNotice(args.conversations, args.sessionId, marker.inputId, 'ordinary_interruption');
  return {
    disposition: 'ordinary_interruption',
    messages: readConversation(args.projectRoot, args.sessionId).physicalRows,
  };
}

function activationMarker(message: AgentMessage): { role: string; cardId: string; inputId: string } | null {
  if (message.kind !== 'activity') return null;
  try {
    const payload = JSON.parse(message.content) as { event?: unknown; role?: unknown; card_id?: unknown; input_id?: unknown };
    if (payload.event !== 'activation_open') return null;
    if (typeof payload.role !== 'string' || typeof payload.card_id !== 'string' || typeof payload.input_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payload.input_id)) throw new Error(`Activation marker '${message.id}' has malformed content.`);
    return { role: payload.role, cardId: payload.card_id, inputId: payload.input_id };
  } catch (error) {
    if (message.id.includes(':activation:')) throw error;
    return null;
  }
}

function requireAssociatedActivationMarker(message: AgentMessage, sessionId: ConversationSessionId): { role: string; cardId: string; inputId: string } {
  const marker = activationMarker(message);
  if (!marker) throw new Error(`Latest activation marker for '${sessionId}' is missing or malformed.`);
  const separator = sessionId.indexOf(':');
  const expectedRole = sessionId.slice(0, separator);
  const expectedCard = sessionId.slice(separator + 1);
  if (marker.role !== expectedRole || marker.cardId !== expectedCard) throw new Error(`Activation marker '${message.id}' does not match session '${sessionId}'.`);
  return marker;
}

function physicalIndexForSource(physicalRows: readonly AgentMessage[], source: AgentMessage): number {
  const index = physicalRows.findIndex((message) => message.id === source.id);
  if (index < 0) throw new Error(`Canonical activation marker '${source.id}' is missing from physical rows.`);
  return index;
}

function validateCallSettlementPairs(messages: readonly AgentMessage[], latestActivationIndex: number | null, interrupted: boolean, terminalToolNames: ReadonlySet<string>): { sourceInputId: string; toolCallId: string; toolName: string; message: AgentMessage } | null {
  const unmatched = inspectCanonicalCallSettlementPairs(messages).unmatched;
  if (unmatched.length === 0) return null;
  if (!interrupted) throw new Error('A cleanly closed or empty role session contains an unmatched tool call.');
  if (unmatched.length > 1) throw new Error('Interrupted role session contains more than one unmatched tool call.');
  const call = unmatched[0]!;
  if (latestActivationIndex === null || call.index < latestActivationIndex) throw new Error('Interrupted role session contains an unmatched tool call in an older activation round.');
  if (!call.message.tool || !call.message.tool_call_id) throw new Error(`Unmatched tool call '${call.message.id}' is malformed.`);
  void terminalToolNames;
  return { sourceInputId: call.sourceInputId, toolCallId: call.toolCallId, toolName: call.message.tool, message: call.message };
}

function parseResultPayload(message: AgentMessage): { success?: unknown; data?: unknown } {
  try { return JSON.parse(message.content) as { success?: unknown; data?: unknown }; } catch { throw new Error(`Tool result '${message.id}' has malformed JSON content.`); }
}

function recoverySettlementKeys(messages: readonly AgentMessage[]): Set<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    if (message.kind === 'tool_result') keys.add(loggedToolCallKey(toolResultIdentity(message)));
  }
  return keys;
}

function lastModelVisibleExchangeIsSettledTerminal(messages: readonly AgentMessage[], terminalToolNames: ReadonlySet<string>): boolean {
  const modelVisible = messages.filter((message) => message.kind === 'text' || message.kind === 'tool_call' || message.kind === 'tool_result' || message.kind === 'model_repair' || message.kind === 'context_compaction' || message.kind === 'model_recovered');
  const last = modelVisible.at(-1);
  if (!last || last.kind !== 'tool_result') return false;
  if (parseResultPayload(last).success !== true) return false;
  const resultIdentity = toolResultIdentity(last);
  const resultKey = loggedToolCallKey(resultIdentity);
  for (let index = modelVisible.length - 2; index >= 0; index -= 1) {
    const call = modelVisible[index]!;
    if (call.kind !== 'tool_call') continue;
    if (!call.tool || !terminalToolNames.has(call.tool)) return false;
    return loggedToolCallKey(toolCallIdentity(call)) === resultKey;
  }
  return false;
}

function toolCallIdentity(message: AgentMessage) {
  const identity = loggedToolCallIdentity(message);
  if (!identity) throw new Error(`Validated tool_call message '${message.id}' is missing tool_call_id.`);
  return identity;
}

function toolResultIdentity(message: AgentMessage) {
  const identity = loggedToolResultIdentity(message);
  if (!identity) throw new Error(`Validated tool_result message '${message.id}' is missing tool_call_id.`);
  return identity;
}
