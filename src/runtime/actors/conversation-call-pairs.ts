import { loggedToolCallIdentity, loggedToolCallKey, loggedToolResultIdentity } from '../../schemas/message-identity.js';
import type { AgentMessage, ConversationSessionId } from '../../schemas/index.js';

export interface CanonicalConversationCall {
  readonly sessionId: ConversationSessionId;
  readonly sourceInputId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly message: AgentMessage;
  readonly index: number;
}

export interface CanonicalCallPairInspection {
  readonly calls: readonly CanonicalConversationCall[];
  readonly unmatched: readonly CanonicalConversationCall[];
}

/**
 * Read-only canonical row pairing shared by recovery and operator projection.
 * Recovery deliberately applies its interruption/latest-activation rules after
 * this structural inspection.
 */
export function inspectCanonicalCallSettlementPairs(messages: readonly AgentMessage[]): CanonicalCallPairInspection {
  const calls = new Map<string, CanonicalConversationCall>();
  const settled = new Set<string>();
  for (const [index, message] of messages.entries()) {
    if (message.kind === 'tool_call') {
      const identity = loggedToolCallIdentity(message);
      if (!identity) throw new Error(`Validated tool_call message '${message.id}' is missing tool_call_id.`);
      const key = loggedToolCallKey(identity);
      if (calls.has(key)) throw new Error(`Duplicate tool call identity '${key}'.`);
      calls.set(key, Object.freeze({
        sessionId: identity.session_id,
        sourceInputId: identity.source_input_id,
        toolCallId: identity.tool_call_id,
        toolName: message.tool ?? '',
        startedAt: message.timestamp,
        message,
        index,
      }));
    }
    if (message.kind === 'tool_result') {
      const identity = loggedToolResultIdentity(message);
      if (!identity) throw new Error(`Validated tool_result message '${message.id}' is missing tool_call_id.`);
      const key = loggedToolCallKey(identity);
      if (!calls.has(key)) throw new Error(`Tool settlement '${message.id}' has no prior matching call.`);
      if (settled.has(key)) throw new Error(`Tool call identity '${key}' has duplicate settlements.`);
      settled.add(key);
    }
  }
  const allCalls = [...calls.entries()];
  return Object.freeze({
    calls: Object.freeze(allCalls.map(([, call]) => call)),
    unmatched: Object.freeze(allCalls.filter(([key]) => !settled.has(key)).map(([, call]) => call)),
  });
}
