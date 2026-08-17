import type { AgentMessage, MessageKind, CardConversationSessionId } from '../../schemas/index.js';
import { conversationSessionIdentity } from '../../schemas/index.js';
import {
  loggedToolCallIdentity,
  loggedToolCallKey,
  loggedToolResultIdentity,
} from '../../schemas/message-identity.js';
import { appendRecoveryNotice, isExactRecoveryNotice } from './conversation-session.js';
import { appendProviderVisibleSyntheticFailedToolResult } from './llm-delivery-log.js';
import { readConversation, type ConversationFileContext,
} from '../../persistence/conversation-file.js';
import { syntheticToolSettlement } from '../../tools/invocation.js';
import {
  validateConversation, type ValidatedConversation,
} from '../../contracts/conversation-validation.js';

export type ConversationImplicitState =
  | 'empty'
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
  content_policy_retry: 'visible',
  content_policy_refusal: 'visible',
  model_recovered: 'visible',
  provider_private: 'ignored',
} as const satisfies Record<MessageKind, RecoveryVisibility>;

export function classifyConversation(messages: readonly AgentMessage[], terminalToolNames: ReadonlySet<string>,
  unmatchedToolCall: AgentMessage | null,
): ConversationImplicitState {
  const recoveryVisibilities = messages.map((message) => recoveryVisibility(message.kind));

  const recoveryVisible = messages.filter((_message, index) => recoveryVisibilities[index] === 'visible',
  );
  if (recoveryVisible.length === 0) return 'empty';

  if (unmatchedToolCall && recoveryVisible.some((message) => message.id === unmatchedToolCall.id))
    return 'awaiting_tool_result';

  if (lastModelVisibleExchangeIsSettledTerminal(recoveryVisible, terminalToolNames)) return 'settled_terminal';

  const last = recoveryVisible.at(-1)!;
  if (last.kind === 'text' && last.role === 'assistant') return 'assistant_text_pending';
  return 'pending_provider';
}

function recoveryVisibility(kind: MessageKind): RecoveryVisibility {
  if (!Object.hasOwn(recoveryVisibilityByKind, kind)) throw new Error(`Unhandled conversation message kind '${String(kind)}'.`);
  return recoveryVisibilityByKind[kind];
}

export type AgentSessionStabilization =
  | { disposition: 'clean'; messages: readonly AgentMessage[] }
  | { disposition: 'ordinary_interruption'; messages: readonly AgentMessage[] };

export function stabilizeAgentSession(args: {
  sessionId: CardConversationSessionId;
  conversations: ConversationFileContext;
  terminalToolNames: ReadonlySet<string>;
}): AgentSessionStabilization {
  let conversation: ValidatedConversation;
  try { conversation = readConversation(args.conversations.projectRoot, args.sessionId); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    conversation = validateConversation(args.sessionId, []);
  }
  const messages = conversation.physicalRows;
  const sourceRows = conversation.sourceRows;
  const latestRound = conversation.rounds.at(-1);
  if (!latestRound) {
    validateCallSettlementPairs(conversation, null, false);
    const state = classifyConversation(sourceRows, args.terminalToolNames,
      conversation.unmatchedCall?.message ?? null,
    );
    if (state !== 'empty' && state !== 'settled_terminal') throw new Error(`Non-clean role session '${args.sessionId}' has no activation marker.`);
    return { disposition: 'clean', messages };
  }
  const latestActivationIndex = sourceRows.findIndex((row) => row.id === latestRound.rows[0]?.id);
  if (latestActivationIndex < 0) throw new Error(`Activation '${latestRound.label}' has no retained source rows.`);
  const marker = latestRound.activation.source === 'compacted_genesis' ? { inputId: latestRound.activation.input_id } : requireAssociatedActivationMarker(latestRound.activation.message, args.sessionId);
  const activationRows = sourceRows.slice(latestActivationIndex);
  const final = activationRows.at(-1)!;
  const refusalMarkers = activationRows.filter((message) => message.kind === 'content_policy_refusal',
  );
  if (refusalMarkers.length > 0) {
    if (refusalMarkers.length !== 1 || final.kind !== 'content_policy_refusal') throw new Error(`Activation '${marker.inputId}' has rows after or colliding with its terminal content-policy refusal marker.`,
      );
    validateCallSettlementPairs(
      conversation, physicalIndexForSource(messages, sourceRows[latestActivationIndex]!), false,
    );
    return { disposition: 'clean', messages };
  }
  const exactFinalRecovery = isExactRecoveryNotice(final, args.sessionId, marker.inputId);
  const recoveryRows = activationRows.filter((message) => message.kind === 'model_recovered');
  if (recoveryRows.length > 0 && !exactFinalRecovery) throw new Error(`Interrupted activation '${marker.inputId}' has a recovery notice that is not its final exact canonical source row.`,
    );
  if (exactFinalRecovery) {
    if (recoveryRows.length !== 1) throw new Error(`Interrupted activation '${marker.inputId}' has colliding recovery notices.`);
    validateCallSettlementPairs(
      conversation, physicalIndexForSource(messages, sourceRows[latestActivationIndex]!), false,
    );
    return { disposition: 'clean', messages };
  }
  const state = classifyConversation(activationRows, args.terminalToolNames,
    conversation.unmatchedCall?.message ?? null,
  );
  if (state === 'settled_terminal') {
    validateCallSettlementPairs(
      conversation, physicalIndexForSource(messages, sourceRows[latestActivationIndex]!), false,
    );
    return { disposition: 'clean', messages };
  }
  const latestPhysicalIndex = physicalIndexForSource(messages, sourceRows[latestActivationIndex]!);
  const unmatched = validateCallSettlementPairs(conversation, latestPhysicalIndex, true);
  if (unmatched) {
    if (unmatched.message.context_policy.kind !== 'tool_call') throw new Error('Interrupted unmatched call has no call-owned result policy.');
    appendProviderVisibleSyntheticFailedToolResult(args.conversations, {
      sessionId: args.sessionId,
      sourceInputId: unmatched.sourceInputId,
      toolCallId: unmatched.toolCallId,
      toolName: unmatched.toolName,
      settlement: syntheticToolSettlement('execution_failed', unmatched.message.context_policy.template, 'Runtime activation was interrupted before completion. External or domain effects may or may not have happened.', { outcome_unknown: true }),
      callPolicySha256: unmatched.message.context_policy.template_sha256,
    });
  }
  appendRecoveryNotice(args.conversations, args.sessionId, marker.inputId, 'ordinary_interruption');
  return {
    disposition: 'ordinary_interruption',
    messages: readConversation(args.conversations.projectRoot, args.sessionId).physicalRows,
  };
}

function activationMarker(message: AgentMessage,
): { agentName: string; cardId: string; inputId: string } | null {
  if (message.kind !== 'activity') return null;
  try {
    const payload = JSON.parse(message.content) as { event?: unknown; agent_name?: unknown; card_id?: unknown; input_id?: unknown;
    };
    if (payload.event !== 'activation_open') return null;
    if (typeof payload.agent_name !== 'string' || typeof payload.card_id !== 'string' || typeof payload.input_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payload.input_id,
      )) throw new Error(`Activation marker '${message.id}' has malformed content.`);
    return { agentName: payload.agent_name, cardId: payload.card_id, inputId: payload.input_id };
  } catch (error) {
    if (message.id.includes(':activation:')) throw error;
    return null;
  }
}

function requireAssociatedActivationMarker(message: AgentMessage, sessionId: CardConversationSessionId,
): { agentName: string; cardId: string; inputId: string } {
  const marker = activationMarker(message);
  if (!marker) throw new Error(`Latest activation marker for '${sessionId}' is missing or malformed.`);
  const identity=conversationSessionIdentity(sessionId);
  if (identity.cardId===null||marker.agentName !== identity.agentName || marker.cardId !== identity.cardId) throw new Error(`Activation marker '${message.id}' does not match session '${sessionId}'.`);
  return marker;
}

function physicalIndexForSource(physicalRows: readonly AgentMessage[], source: AgentMessage,
): number {
  const index = physicalRows.findIndex((message) => message.id === source.id);
  if (index < 0) throw new Error(`Canonical activation marker '${source.id}' is missing from physical rows.`);
  return index;
}

function validateCallSettlementPairs(
  conversation: ValidatedConversation, latestActivationIndex: number | null, interrupted: boolean,
): { sourceInputId: string; toolCallId: string; toolName: string; message: AgentMessage } | null {
  const call = conversation.unmatchedCall;
  if (!call) return null;
  if (!interrupted) throw new Error('A cleanly closed or empty role session contains an unmatched tool call.');
  if (latestActivationIndex === null || call.physicalIndex < latestActivationIndex) throw new Error('Interrupted role session contains an unmatched tool call in an older activation round.',
    );
  if (!call.message.tool || !call.message.tool_call_id) throw new Error(`Unmatched tool call '${call.message.id}' is malformed.`);
  return { sourceInputId: call.sourceInputId, toolCallId: call.toolCallId, toolName: call.message.tool, message: call.message,
  };
}

function parseResultPayload(message: AgentMessage): { success?: unknown; data?: unknown } {
  try { return JSON.parse(message.content) as { success?: unknown; data?: unknown }; } catch { throw new Error(`Tool result '${message.id}' has malformed JSON content.`);
  }
}

function lastModelVisibleExchangeIsSettledTerminal(messages: readonly AgentMessage[], terminalToolNames: ReadonlySet<string>,
): boolean {
  const modelVisible = messages.filter((message) => message.kind === 'text' || message.kind === 'tool_call' || message.kind === 'tool_result' || message.kind === 'model_repair' || message.kind === 'content_policy_retry' || message.kind === 'content_policy_refusal' || message.kind === 'model_recovered',
  );
  if (modelVisible.at(-1)?.kind === 'content_policy_refusal') return true;
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
