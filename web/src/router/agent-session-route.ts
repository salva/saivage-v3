import { parseConversationSessionId, type ConversationSessionId } from '../api/contracts';

export type AgentSessionRouteResult =
  | { kind: 'none' }
  | { kind: 'valid'; sessionId: ConversationSessionId }
  | { kind: 'invalid' };

export function parseAgentDetailRouteParam(value: unknown): AgentSessionRouteResult {
  if (value === undefined) return { kind: 'none' };
  if (typeof value !== 'string' || value.length === 0) return { kind: 'invalid' };
  try { return { kind: 'valid', sessionId: parseConversationSessionId(value) }; }
  catch { return { kind: 'invalid' }; }
}
