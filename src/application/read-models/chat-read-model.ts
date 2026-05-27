import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GLOBAL_ANALYST_SESSION_ID, getOrCreateAnalystSession } from '../../agents/analyst-api.js';

const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

export type ChatReadResult = { statusCode?: number; body: unknown };

export class ChatReadModelService {
  constructor(private readonly projectRoot: string) {}

  listSessions(): ChatReadResult {
    const { session } = getOrCreateAnalystSession(this.projectRoot, GLOBAL_ANALYST_SESSION_ID);
    return { body: { sessions: [{ id: session.id, role: session.role, status: session.status, started_at: session.started_at }] } };
  }

  getEntries(sessionId: string): ChatReadResult {
    if (!SAFE_SESSION_ID_RE.test(sessionId)) return { statusCode: 400, body: { error: 'Invalid session ID format.', sessionId } };
    if (sessionId !== GLOBAL_ANALYST_SESSION_ID) return { statusCode: 404, body: { error: 'Only the canonical analyst chat is available.', sessionId } };
    const entriesPath = join(this.projectRoot, '.saivage', 'agents', 'messages', `${GLOBAL_ANALYST_SESSION_ID}.jsonl`);
    const entries: unknown[] = [];
    if (existsSync(entriesPath)) {
      const raw = readFileSync(entriesPath, 'utf-8');
      for (const line of raw.split('\n')) {
        if (line.trim()) {
          try { entries.push(JSON.parse(line)); } catch { void 0; }
        }
      }
    }
    return { body: { sessionId: GLOBAL_ANALYST_SESSION_ID, entries } };
  }
}

export function isSafeChatSessionId(sessionId: string): boolean { return SAFE_SESSION_ID_RE.test(sessionId); }
