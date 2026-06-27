import { readRuntimeState } from '../../runtime/state-api.js';
import type { AgentMessage, AgentSession, RuntimeState } from '../../schemas/index.js';
import { deriveCurrentAgentSessionId } from '../../runtime/current-run.js';
import type { RuntimeApi } from '../../runtime/control-api.js';
import { AgentSessionRepository, GLOBAL_ANALYST_SESSION_ID, isSafeAgentSessionId, SAFE_AGENT_SESSION_ID_RE } from '../../agents/agent-session-repository.js';

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
  entries: unknown[];
  activity_status: { status: 'idle' | 'thinking' | 'tool_calling' | 'responding' | 'compacting'; pending_calls: unknown[]; updated_at: string };
}

export class AgentOperatorReadModelService {
  private readonly repository: AgentSessionRepository;

  constructor(private readonly projectRoot: string, private readonly runtimeApi?: Pick<RuntimeApi, 'getActivityStatus'>) {
    this.repository = new AgentSessionRepository(projectRoot);
  }

  listSessions(): { sessions: AgentOperatorSessionSummary[] } {
    const sessionIds = new Set<string>([GLOBAL_OPERATOR_AGENT_SESSION_ID, ...this.repository.listKnownSessionIds()]);
    const state = readRuntimeState(this.projectRoot);
    const sessions = Array.from(sessionIds)
      .map((sessionId) => this.buildSessionSummary(sessionId, state))
      .filter((session): session is AgentOperatorSessionSummary => Boolean(session));
    sessions.sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')) || String(a.id).localeCompare(String(b.id)));
    return { sessions };
  }

  getSession(sessionId: string): { statusCode?: number; body: { session?: Record<string, unknown>; error?: string; sessionId?: string } } {
    if (!isSafeAgentSessionId(sessionId)) return { statusCode: 400, body: { error: 'Invalid agent session ID' } };
    const manifest = this.readManifest(sessionId);
    const messages = this.readConversationEntries(sessionId);
    if (this.isNonCanonicalAnalystSession(sessionId, manifest)) return { statusCode: 404, body: { error: 'Agent session not found', sessionId } };
    if (!manifest && messages.length === 0 && sessionId !== GLOBAL_OPERATOR_AGENT_SESSION_ID) return { statusCode: 404, body: { error: 'Agent session not found', sessionId } };
    const base = this.buildSessionSummary(sessionId, readRuntimeState(this.projectRoot)) ?? {
      id: sessionId,
      role: this.parseRole(sessionId),
      status: 'inactive' as const,
      started_at: new Date(0).toISOString(),
    };
    const lastActivity = this.lastMessageTimestamp(sessionId)
      ?? (typeof manifest?.completed_at === 'string' ? manifest.completed_at : null)
      ?? (typeof base.started_at === 'string' ? base.started_at : null);
    return { body: { session: { ...base, message_count: messages.length, last_activity_at: lastActivity } } };
  }

  getConversation(sessionId: string): { statusCode?: number; body: AgentOperatorConversationResponse | { error: string; sessionId?: string } } {
    if (!isSafeAgentSessionId(sessionId)) return { statusCode: 400, body: { error: 'Invalid agent session ID' } };
    const manifest = this.readManifest(sessionId);
    if (this.isNonCanonicalAnalystSession(sessionId, manifest)) return { statusCode: 404, body: { error: 'Agent session not found', sessionId } };
    const messages = this.readConversationEntries(sessionId);
    const session = this.buildSessionSummary(sessionId, readRuntimeState(this.projectRoot));
    if (!session || (messages.length === 0 && !manifest && sessionId !== GLOBAL_OPERATOR_AGENT_SESSION_ID)) return { statusCode: 404, body: { error: 'Agent session not found', sessionId } };
    const activity_status = this.runtimeApi?.getActivityStatus(sessionId) ?? { status: 'idle' as const, pending_calls: [], updated_at: new Date(0).toISOString() };
    return { body: { session, entries: messages, activity_status } };
  }

  private readManifest(sessionId: string): AgentSession | null {
    return this.repository.getSession(sessionId);
  }

  private readConversationEntries(sessionId: string): AgentMessage[] {
    return this.repository.getMessages(sessionId);
  }

  private parseRole(sessionId: string): string {
    if (sessionId === 'analyst' || sessionId.startsWith('analyst-')) return 'analyst';
    if (sessionId.startsWith('planner:') || sessionId.startsWith('planner-')) return 'planner';
    if (sessionId.startsWith('reviewer:') || sessionId.startsWith('reviewer-')) return 'reviewer';
    if (sessionId.startsWith('executor:') || sessionId.startsWith('executor-')) return 'executor';
    if (sessionId.startsWith('card-')) return 'analyst';
    return 'analyst';
  }

  private isNonCanonicalAnalystSession(sessionId: string, manifest?: AgentSession | null): boolean {
    const role = typeof manifest?.role === 'string' ? manifest.role : this.parseRole(sessionId);
    return role === 'analyst' && sessionId !== GLOBAL_OPERATOR_AGENT_SESSION_ID;
  }

  private firstMessageTimestamp(sessionId: string): string | null {
    const messages = this.readConversationEntries(sessionId);
    const first = messages.find((message) => typeof message.timestamp === 'string');
    return first?.timestamp ?? null;
  }

  private lastMessageTimestamp(sessionId: string): string | null {
    const messages = this.readConversationEntries(sessionId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const timestamp = messages[i]?.timestamp;
      if (typeof timestamp === 'string') return timestamp;
    }
    return null;
  }

  private hasOpenPlannerRun(state: RuntimeState | null, sessionId: string): boolean {
    return (state?.runtime_runs ?? []).some((run) => run.session_id === sessionId && run.phase === 'planner' && run.runtime_status === 'running' && !run.finished_at);
  }

  private isActivePlannerTurn(state: RuntimeState | null, sessionId: string): boolean {
    const activeRun = state?.active_card_run;
    return activeRun?.phase === 'planner' && activeRun.planner_session_id === sessionId;
  }

  private listedStatus(state: RuntimeState | null, session: AgentSession | null, sessionId: string, currentSessionId: string | null): ListedAgentStatus {
    const openPlannerRun = this.hasOpenPlannerRun(state, sessionId);
    if (currentSessionId && sessionId === currentSessionId) return openPlannerRun && !this.isActivePlannerTurn(state, sessionId) ? 'waiting' : 'active';
    if (openPlannerRun) return 'waiting';
    const manifestStatus = session?.status;
    if (manifestStatus === 'active') return 'active';
    if (manifestStatus === 'waiting' || manifestStatus === 'done' || manifestStatus === 'blocked' || manifestStatus === 'failed') return manifestStatus;
    return 'inactive';
  }

  private buildSessionSummary(sessionId: string, state: RuntimeState | null): AgentOperatorSessionSummary | null {
    if (!isSafeAgentSessionId(sessionId)) return null;
    const manifest = this.readManifest(sessionId);
    if (this.isNonCanonicalAnalystSession(sessionId, manifest)) return null;
    const startedAt = typeof manifest?.started_at === 'string' ? manifest.started_at : this.firstMessageTimestamp(sessionId) ?? new Date(0).toISOString();
    return {
      ...(manifest ?? {}),
      id: sessionId,
      role: typeof manifest?.role === 'string' ? manifest.role : this.parseRole(sessionId),
      status: this.listedStatus(state, manifest, sessionId, deriveCurrentAgentSessionId(state)),
      started_at: startedAt,
    };
  }
}

export { isSafeAgentSessionId };
