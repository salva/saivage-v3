import type { AgentMessage, MessageKind } from '../../schemas/index.js';
import {
  loggedToolCallIdentity,
  loggedToolCallKey,
  loggedToolResultIdentity,
} from '../../schemas/message-identity.js';
import { readConversationMessages } from './conversation-session.js';
import { appendProviderVisibleSyntheticFailedToolResult } from './llm-delivery-log.js';
import type { ConversationFileContext } from '../../persistence/conversation-file.js';

export type ConversationImplicitState =
  | 'empty'
  | 'system_prompt_only'
  | 'awaiting_tool_result'
  | 'settled_terminal'
  | 'assistant_text_pending'
  | 'pending_provider';

const messageKindsHandled: ReadonlySet<MessageKind> = new Set([
  'text',
  'activity',
  'tool_call',
  'tool_result',
  'model_issue',
  'model_repair',
  'context_compaction',
  'model_recovered',
  'system_prompt',
]);

export function classifyConversation(messages: readonly AgentMessage[], terminalToolNames: ReadonlySet<string>): ConversationImplicitState {
  for (const message of messages) {
    if (!messageKindsHandled.has(message.kind)) {
      throw new Error(`Unhandled conversation message kind '${String(message.kind)}'.`);
    }
  }

  const recoveryVisible = messages.filter((message) => message.kind !== 'activity');
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

export function stabilizeRoleSession(args: {
  projectRoot: string;
  sessionId: string;
  conversations: ConversationFileContext;
  terminalToolNames: ReadonlySet<string>;
}): { interrupted: boolean; messages: AgentMessage[] } {
  const messages = readConversationMessages(args.projectRoot, args.sessionId).physicalRows;
  const activationIndexes = messages.flatMap((message, index) => isActivationOpen(message) ? [index] : []);
  if (activationIndexes.length === 0) {
    validateCallSettlementPairs(messages, null, false, args.terminalToolNames);
    return { interrupted: false, messages };
  }
  const latestActivationIndex = activationIndexes.at(-1)!;
  const interrupted = !latestRoundCleanlyClosed(messages.slice(latestActivationIndex), args.terminalToolNames, args.sessionId.startsWith('reviewer:'));
  const unmatched = validateCallSettlementPairs(messages, latestActivationIndex, interrupted, args.terminalToolNames);
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
  return { interrupted, messages: readConversationMessages(args.projectRoot, args.sessionId).physicalRows };
}

function isActivationOpen(message: AgentMessage): boolean {
  if (message.kind !== 'activity') return false;
  try {
    const payload = JSON.parse(message.content) as { event?: unknown; role?: unknown; card_id?: unknown; input_id?: unknown };
    if (payload.event !== 'activation_open') return false;
    if (typeof payload.role !== 'string' || typeof payload.card_id !== 'string' || typeof payload.input_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(payload.input_id)) throw new Error(`Activation marker '${message.id}' has malformed content.`);
    return true;
  } catch (error) {
    if (message.id.includes(':activation:')) throw error;
    return false;
  }
}

function latestRoundCleanlyClosed(messages: readonly AgentMessage[], terminalToolNames: ReadonlySet<string>, reviewerSession: boolean): boolean {
  const calls = new Map<string, AgentMessage>();
  for (const message of messages) {
    if (message.kind === 'tool_call') calls.set(loggedToolCallKey(toolCallIdentity(message)), message);
    if (message.kind !== 'tool_result') continue;
    const identity = toolResultIdentity(message);
    const call = calls.get(loggedToolCallKey(identity));
    if (!call || !call.tool || !terminalToolNames.has(call.tool)) continue;
    const payload = parseResultPayload(message);
    if (payload.success === true) return true;
    if (reviewerSession && payload.success === false && (payload.data as { reason?: unknown } | undefined)?.reason === 'pending_notifications') return true;
  }
  return false;
}

function validateCallSettlementPairs(messages: readonly AgentMessage[], latestActivationIndex: number | null, interrupted: boolean, terminalToolNames: ReadonlySet<string>): { sourceInputId: string; toolCallId: string; toolName: string } | null {
  const calls = new Map<string, { message: AgentMessage; index: number }>();
  const settled = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message.kind === 'tool_call') {
      const identity = toolCallIdentity(message);
      const key = loggedToolCallKey(identity);
      if (calls.has(key)) throw new Error(`Duplicate tool call identity '${key}'.`);
      calls.set(key, { message, index });
    }
    if (message.kind === 'tool_result') {
      const identity = toolResultIdentity(message);
      const key = loggedToolCallKey(identity);
      if (!calls.has(key)) throw new Error(`Tool settlement '${message.id}' has no prior matching call.`);
      if (settled.has(key)) throw new Error(`Tool call identity '${key}' has duplicate settlements.`);
      settled.add(key);
    }
  }
  const unmatched = [...calls.entries()].filter(([key]) => !settled.has(key));
  if (unmatched.length === 0) return null;
  if (!interrupted) throw new Error('A cleanly closed or empty role session contains an unmatched tool call.');
  if (unmatched.length > 1) throw new Error('Interrupted role session contains more than one unmatched tool call.');
  const [, call] = unmatched[0]!;
  if (latestActivationIndex === null || call.index < latestActivationIndex) throw new Error('Interrupted role session contains an unmatched tool call in an older activation round.');
  if (!call.message.tool || !call.message.tool_call_id) throw new Error(`Unmatched tool call '${call.message.id}' is malformed.`);
  const identity = toolCallIdentity(call.message);
  void terminalToolNames;
  return { sourceInputId: identity.source_input_id, toolCallId: identity.tool_call_id, toolName: call.message.tool };
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
