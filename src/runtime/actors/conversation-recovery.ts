import type { AgentMessage, MessageKind } from '../../schemas/index.js';
import {
  loggedToolCallIdentity,
  loggedToolCallKey,
  loggedToolErrorIdentity,
  loggedToolResultIdentity,
} from '../../schemas/message-identity.js';
import { isModelVisibleConversationMessage } from './conversation-store.js';

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
  'provider_exchange',
  'tool_call',
  'tool_result',
  'tool_error',
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
    const identity = safeToolCallIdentity(message);
    if (!identity || !recoverySettlements.has(loggedToolCallKey(identity))) return 'awaiting_tool_result';
    break;
  }

  if (lastModelVisibleExchangeIsSettledTerminal(recoveryVisible, terminalToolNames)) return 'settled_terminal';

  const last = recoveryVisible.at(-1)!;
  if (last.kind === 'text' && last.role === 'assistant') return 'assistant_text_pending';
  return 'pending_provider';
}

function recoverySettlementKeys(messages: readonly AgentMessage[]): Set<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    const resultIdentity = safeToolResultIdentity(message);
    if (resultIdentity) keys.add(loggedToolCallKey(resultIdentity));
    const errorIdentity = safeToolErrorIdentity(message);
    if (errorIdentity) keys.add(loggedToolCallKey(errorIdentity));
  }
  return keys;
}

function lastModelVisibleExchangeIsSettledTerminal(messages: readonly AgentMessage[], terminalToolNames: ReadonlySet<string>): boolean {
  const modelVisible = messages.filter(isModelVisibleConversationMessage);
  const last = modelVisible.at(-1);
  if (!last || last.kind !== 'tool_result') return false;
  const resultIdentity = safeToolResultIdentity(last);
  if (!resultIdentity) return false;
  const resultKey = loggedToolCallKey(resultIdentity);
  for (let index = modelVisible.length - 2; index >= 0; index -= 1) {
    const call = modelVisible[index]!;
    if (call.kind !== 'tool_call') continue;
    if (!call.tool || !terminalToolNames.has(call.tool)) return false;
    const callIdentity = safeToolCallIdentity(call);
    return callIdentity !== null && loggedToolCallKey(callIdentity) === resultKey;
  }
  return false;
}

function safeToolCallIdentity(message: AgentMessage) {
  try { return loggedToolCallIdentity(message); } catch { return null; }
}

function safeToolResultIdentity(message: AgentMessage) {
  try { return loggedToolResultIdentity(message); } catch { return null; }
}

function safeToolErrorIdentity(message: AgentMessage) {
  try { return loggedToolErrorIdentity(message); } catch { return null; }
}
