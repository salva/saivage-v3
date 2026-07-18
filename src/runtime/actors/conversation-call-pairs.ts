import { parseToolCallMessage } from '../../contracts/persisted-tool-call.js';
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

export interface ParsedCanonicalConversationCall extends CanonicalConversationCall {
  readonly args: unknown;
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

export function inspectConversationCallPairs(messages: readonly AgentMessage[]): ParsedCanonicalConversationCall | null {
  const inspection = inspectCanonicalCallSettlementPairs(messages);
  const parsedCalls = new Map<string, ParsedCanonicalConversationCall>();
  for (const call of inspection.calls) {
    if (!call.message.tool) throw new Error(`Tool call '${call.message.id}' is missing canonical identity metadata.`);
    let embedded: ReturnType<typeof parseToolCallMessage>;
    try { embedded = parseToolCallMessage(JSON.parse(call.message.content)); }
    catch (error) { throw new Error(`Tool call '${call.message.id}' has malformed embedded content: ${error instanceof Error ? error.message : String(error)}`); }
    if (embedded.id !== call.toolCallId || embedded.name !== call.message.tool) throw new Error(`Tool call '${call.message.id}' embedded identity does not match row metadata.`);
    parsedCalls.set(canonicalCallKey(call), Object.freeze({ ...call, toolName: call.message.tool, args: embedded.args }));
  }
  if (inspection.unmatched.length > 1) throw new Error('Conversation contains more than one unmatched tool call.');
  const unmatched = inspection.unmatched[0];
  return unmatched ? parsedCalls.get(canonicalCallKey(unmatched))! : null;
}

function canonicalCallKey(call: Pick<CanonicalConversationCall, 'sessionId' | 'sourceInputId' | 'toolCallId'>): string {
  return loggedToolCallKey({ session_id: call.sessionId, source_input_id: call.sourceInputId, tool_call_id: call.toolCallId });
}
