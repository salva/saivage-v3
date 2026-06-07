import { AgentSessionRepository, GLOBAL_ANALYST_SESSION_ID, isSafeAgentSessionId } from '../../agents/agent-session-repository.js';

export type ChatReadResult = { statusCode?: number; body: unknown };

export class ChatReadModelService {
  private readonly repository: AgentSessionRepository;

  constructor(private readonly projectRoot: string) {
    this.repository = new AgentSessionRepository(projectRoot);
  }

  listSessions(): ChatReadResult {
    const session = this.repository.ensureAnalystSession(GLOBAL_ANALYST_SESSION_ID);
    return { body: { sessions: [{ id: session.id, role: session.role, status: session.status, started_at: session.started_at }] } };
  }

  getEntries(sessionId: string): ChatReadResult {
    if (!isSafeAgentSessionId(sessionId)) return { statusCode: 400, body: { error: 'Invalid session ID format.', sessionId } };
    if (sessionId !== GLOBAL_ANALYST_SESSION_ID) return { statusCode: 404, body: { error: 'Only the canonical analyst chat is available.', sessionId } };
    const entries = this.repository.getMessages(GLOBAL_ANALYST_SESSION_ID);
    return { body: { sessionId: GLOBAL_ANALYST_SESSION_ID, entries } };
  }
}

export function isSafeChatSessionId(sessionId: string): boolean { return isSafeAgentSessionId(sessionId); }
