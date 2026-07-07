import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_ANALYST_SESSION_ID, isSafeAgentSessionId, SAFE_AGENT_SESSION_ID_RE } from '../../agents/session-ids.js';
import { CardStore } from '../../cards/store-api.js';
import { llmExchangeSchema } from '../../contracts/index.js';
import { listConversationSessionIds, readConversationMessages } from '../../runtime/actors/conversation-store.js';
import { readActorSnapshots, type ActorSnapshotRecord } from '../../runtime/actors/snapshots.js';
import type { AgentMessage, AgentRole, SessionStatus } from '../../schemas/index.js';

export const GLOBAL_OPERATOR_AGENT_SESSION_ID = GLOBAL_ANALYST_SESSION_ID;
export const SAFE_AGENT_ID_RE = SAFE_AGENT_SESSION_ID_RE;

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
  constructor(private readonly projectRoot: string) {}

  listSessions(): { sessions: AgentOperatorSessionSummary[] } {
    const snapshots = readActorSnapshots(this.projectRoot);
    const sessions = listConversationSessionIds(this.projectRoot)
      .map((sessionId) => this.buildSessionSummary(sessionId, readConversationMessages(this.projectRoot, sessionId), snapshots))
      .filter((session): session is AgentOperatorSessionSummary => Boolean(session));
    sessions.sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')) || String(a.id).localeCompare(String(b.id)));
    return { sessions };
  }

  getSession(sessionId: string): { statusCode?: number; body: { session?: Record<string, unknown>; error?: string; sessionId?: string } } {
    if (!isSafeAgentSessionId(sessionId)) return { statusCode: 400, body: { error: 'Invalid agent session ID' } };
    const messages = readConversationMessages(this.projectRoot, sessionId);
    if (messages.length === 0) return { statusCode: 404, body: { error: 'Agent session not found', sessionId } };
    const base = this.buildSessionSummary(sessionId, messages, readActorSnapshots(this.projectRoot));
    if (!base) return { statusCode: 404, body: { error: 'Agent session not found', sessionId } };
    const lastActivity = this.lastMessageTimestamp(messages) ?? base.started_at;
    return { body: { session: { ...base, message_count: messages.length, last_activity_at: lastActivity } } };
  }

  getConversation(sessionId: string): { statusCode?: number; body: AgentOperatorConversationResponse | { error: string; sessionId?: string } } {
    if (!isSafeAgentSessionId(sessionId)) return { statusCode: 400, body: { error: 'Invalid agent session ID' } };
    const messages = readConversationMessages(this.projectRoot, sessionId);
    if (messages.length === 0) return { statusCode: 404, body: { error: 'Agent session not found', sessionId } };
    const snapshots = readActorSnapshots(this.projectRoot);
    const session = this.buildSessionSummary(sessionId, messages, snapshots);
    if (!session) return { statusCode: 404, body: { error: 'Agent session not found', sessionId } };
    const activity_status = this.deriveActivityStatus(sessionId, snapshots);
    return { body: { session, entries: messages, activity_status } };
  }

  private parseSessionId(sessionId: string): { role: Extract<AgentRole, 'analyst' | 'planner' | 'executor' | 'reviewer'>; card_id: string | null; assessment_id: string | null } | null {
    if (sessionId.startsWith('analyst:')) return { role: 'analyst', card_id: null, assessment_id: null };
    if (sessionId.startsWith('planner:')) return { role: 'planner', card_id: sessionId.slice('planner:'.length), assessment_id: null };
    if (sessionId.startsWith('executor:')) return { role: 'executor', card_id: sessionId.slice('executor:'.length), assessment_id: null };
    if (sessionId.startsWith('reviewer:')) {
      const rest = sessionId.slice('reviewer:'.length);
      const separator = rest.indexOf(':');
      if (separator === -1) return null;
      return { role: 'reviewer', card_id: rest.slice(0, separator), assessment_id: rest.slice(separator + 1) };
    }
    return null;
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

  private matchingSnapshot(sessionId: string, snapshots: ActorSnapshotRecord[]): ActorSnapshotRecord | null {
    return snapshots.find((snapshot) => snapshot.actor_id === sessionId && snapshot.actor_kind === 'llm') ?? null;
  }

  private deriveActivityStatus(sessionId: string, snapshots: ActorSnapshotRecord[]): AgentOperatorConversationResponse['activity_status'] {
    const snapshot = this.matchingSnapshot(sessionId, snapshots);
    if (snapshot?.context && typeof snapshot.context === 'object' && (snapshot.context as Record<string, unknown>).compacting === true) return { status: 'compacting', pending_calls: [], updated_at: snapshot.updated_at };
    if (snapshot?.state_value === 'calling_provider') return { status: 'thinking', pending_calls: [], updated_at: snapshot.updated_at };
    if (snapshot?.state_value === 'waiting_tool') return { status: 'tool_calling', pending_calls: [], updated_at: snapshot.updated_at };
    return { status: 'idle', pending_calls: [], updated_at: new Date(0).toISOString() };
  }

  private deriveStatus(sessionId: string, cardId: string | null, snapshots: ActorSnapshotRecord[]): ListedAgentStatus {
    const snapshot = this.matchingSnapshot(sessionId, snapshots);
    if (snapshot?.state_value === 'waiting_tool') return 'waiting';
    if (snapshot) return 'active';
    if (!cardId) return 'inactive';
    const status = new CardStore(this.projectRoot).read(cardId)?.status;
    if (status === 'done' || status === 'blocked' || status === 'failed') return status;
    return 'inactive';
  }

  private readLatestModel(sessionId: string): string | null {
    const path = join(this.projectRoot, '.saivage', 'agents', 'llm-exchanges', `${sessionId}.json`);
    if (!existsSync(path)) return null;
    const parsed = llmExchangeSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
    return parsed.candidate.model;
  }

  private buildSessionSummary(sessionId: string, messages: AgentMessage[], snapshots: ActorSnapshotRecord[]): AgentOperatorSessionSummary | null {
    if (!isSafeAgentSessionId(sessionId)) return null;
    const parsed = this.parseSessionId(sessionId);
    if (!parsed) return null;
    const model = this.readLatestModel(sessionId);
    return {
      id: sessionId,
      role: parsed.role,
      card_id: parsed.card_id,
      assessment_id: parsed.assessment_id,
      status: this.deriveStatus(sessionId, parsed.card_id, snapshots) satisfies SessionStatus,
      started_at: this.firstMessageTimestamp(messages),
      ...(model ? { model } : {}),
    };
  }
}

export { isSafeAgentSessionId };
