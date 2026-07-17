import { readLatestProviderExchangePayload } from '../../persistence/provider-exchange-log.js';
import { listConversationSessionIds, readConversation } from '../../persistence/conversation-file.js';
import { conversationSessionIdentity, parseConversationSessionId, type AgentMessage, type AgentRole, type SessionStatus, type ConversationSessionId } from '../../schemas/index.js';

export type ListedAgentStatus = 'active' | 'waiting' | 'inactive' | 'done' | 'blocked' | 'failed';
export type AgentOperatorSessionSummary = Record<string, unknown> & {
  id: string;
  role: string;
  status: ListedAgentStatus;
  started_at: string;
};

export interface AgentOperatorConversationResponse {
  session: AgentOperatorSessionSummary;
  entries: AgentMessage[];
  activity_status: { status: 'idle' | 'thinking' | 'tool_calling' | 'responding' | 'compacting'; pending_calls: unknown[]; updated_at: string };
}

export class AgentOperatorReadModelService {
  constructor(private readonly projectRoot: string, private readonly cards: { read(cardId: string): { status: string } | null }) {}

  listSessions(): { sessions: AgentOperatorSessionSummary[] } {
    const sessions = listConversationSessionIds(this.projectRoot)
      .map((sessionId) => this.buildSessionSummary(sessionId, readConversation(this.projectRoot, sessionId).physicalRows))
      .filter((session): session is AgentOperatorSessionSummary => Boolean(session));
    sessions.sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')) || String(a.id).localeCompare(String(b.id)));
    return { sessions };
  }

  getSession(sessionId: string): { statusCode?: number; body: { session?: Record<string, unknown>; error?: string; sessionId?: string } } {
    const parsedId = this.parseSessionId(sessionId);
    if (!parsedId) return { statusCode: 400, body: { error: 'Invalid agent session ID' } };
    const messages = readConversation(this.projectRoot, parsedId.sessionId).physicalRows;
    if (messages.length === 0) return { statusCode: 404, body: { error: 'Agent session not found', sessionId } };
    const base = this.buildSessionSummary(parsedId.sessionId, messages);
    if (!base) return { statusCode: 404, body: { error: 'Agent session not found', sessionId } };
    const lastActivity = this.lastMessageTimestamp(messages) ?? base.started_at;
    return { body: { session: { ...base, message_count: messages.length, last_activity_at: lastActivity } } };
  }

  getConversation(sessionId: string): { statusCode?: number; body: AgentOperatorConversationResponse | { error: string; sessionId?: string } } {
    const parsedId = this.parseSessionId(sessionId);
    if (!parsedId) return { statusCode: 400, body: { error: 'Invalid agent session ID' } };
    const messages = readConversation(this.projectRoot, parsedId.sessionId).physicalRows;
    if (messages.length === 0) return { statusCode: 404, body: { error: 'Agent session not found', sessionId } };
    const session = this.buildSessionSummary(parsedId.sessionId, messages);
    if (!session) return { statusCode: 404, body: { error: 'Agent session not found', sessionId } };
    const activity_status = this.deriveActivityStatus(messages);
    return { body: { session, entries: messages.filter((message) => message.kind !== 'provider_private').map(stripPrivateProjectionMarker), activity_status } };
  }

  private parseSessionId(sessionId: string): { sessionId: ConversationSessionId; role: Extract<AgentRole, 'analyst' | 'planner' | 'executor' | 'reviewer'>; card_id: string | null } | null {
    try {
      const parsed = parseConversationSessionId(sessionId);
      const identity = conversationSessionIdentity(parsed);
      return { sessionId: parsed, role: identity.role, card_id: identity.cardId };
    } catch {
      return null;
    }
  }

  private firstMessageTimestamp(messages: AgentMessage[]): string {
    return messages.find((message) => typeof message.timestamp === 'string')?.timestamp ?? new Date(0).toISOString();
  }

  private lastMessageTimestamp(messages: AgentMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const timestamp = messages[i]?.timestamp;
      if (typeof timestamp === 'string') return timestamp;
    }
    return null;
  }

  private deriveActivityStatus(messages: AgentMessage[]): AgentOperatorConversationResponse['activity_status'] {
    return { status: 'idle', pending_calls: [], updated_at: this.lastMessageTimestamp(messages) ?? new Date(0).toISOString() };
  }

  private deriveStatus(cardId: string | null): ListedAgentStatus {
    if (!cardId) return 'inactive';
    const status = this.cards.read(cardId)?.status;
    if (status === 'done' || status === 'blocked' || status === 'failed') return status;
    return 'inactive';
  }

  private readLatestModel(sessionId: ConversationSessionId): string | null {
    return readLatestProviderExchangePayload(this.projectRoot, sessionId)?.model ?? null;
  }

  private buildSessionSummary(sessionId: ConversationSessionId, messages: AgentMessage[]): AgentOperatorSessionSummary | null {
    const parsed = this.parseSessionId(sessionId);
    if (!parsed) return null;
    const model = this.readLatestModel(sessionId);
    return {
      id: sessionId,
      role: parsed.role,
      card_id: parsed.card_id,
      status: this.deriveStatus(parsed.card_id) satisfies SessionStatus,
      started_at: this.firstMessageTimestamp(messages),
      ...(model ? { model } : {}),
    };
  }
}

function stripPrivateProjectionMarker(message: AgentMessage): AgentMessage {
  if (!message.provider_projection) return message;
  const publicMessage = { ...message };
  delete publicMessage.provider_projection;
  return publicMessage;
}
