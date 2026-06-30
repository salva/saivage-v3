import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage, AgentRole, AgentSession } from '../schemas/index.js';
import { agentMessageSchema } from '../schemas/index.js';
import {
  completeSession,
  createSession,
  getSession,
  getSessionMessages,
  getSessionTokenCount,
  listSessions,
  markSessionWaiting,
  replaceSessionMessages,
  setSessionStatus,
  updateSessionModel,
} from '../runtime/session-persistence.js';
import { GLOBAL_ANALYST_SESSION_ID, isSafeAgentSessionId, SAFE_AGENT_SESSION_ID_RE } from './session-ids.js';

export { GLOBAL_ANALYST_SESSION_ID, isSafeAgentSessionId, SAFE_AGENT_SESSION_ID_RE } from './session-ids.js';

export class AgentSessionRepository {
  readonly saivageDir: string;

  constructor(readonly projectRoot: string) {
    this.saivageDir = join(projectRoot, '.saivage');
  }

  createSession(role: AgentRole, goalCardId?: string | null, cardId?: string | null, model?: string, sessionId?: string, assessmentId?: string | null): AgentSession {
    return createSession(this.saivageDir, role, goalCardId ?? null, cardId ?? null, model, sessionId, assessmentId);
  }

  ensureAnalystSession(sessionId = GLOBAL_ANALYST_SESSION_ID): AgentSession {
    const existing = this.getSession(sessionId);
    return existing ?? this.createSession('analyst', null, null, undefined, sessionId);
  }

  getSession(sessionId: string): AgentSession | null {
    if (!isSafeAgentSessionId(sessionId)) return null;
    return getSession(this.saivageDir, sessionId);
  }

  listSessionIds(): string[] {
    return listSessions(this.saivageDir).filter(isSafeAgentSessionId);
  }

  listMessageSessionIds(): string[] {
    const messagesDir = join(this.saivageDir, 'agents', 'messages');
    if (!existsSync(messagesDir)) return [];
    return readdirSync(messagesDir)
      .filter((file) => file.endsWith('.jsonl'))
      .map((file) => decodeMessageSessionFilename(file.slice(0, -'.jsonl'.length)))
      .filter(isSafeAgentSessionId);
  }

  listKnownSessionIds(): string[] {
    return Array.from(new Set([...this.listSessionIds(), ...this.listMessageSessionIds()]));
  }

  getMessages(sessionId: string): AgentMessage[] {
    if (!isSafeAgentSessionId(sessionId)) return [];
    const messages = getSessionMessages(this.saivageDir, sessionId);
    if (messages.length > 0) return messages;
    const encoded = encodeURIComponent(sessionId);
    if (encoded === sessionId) return messages;
    return readEncodedSessionMessages(this.saivageDir, encoded);
  }

  replaceMessages(sessionId: string, messages: AgentMessage[]): void { replaceSessionMessages(this.saivageDir, sessionId, messages); }
  getTokenCount(sessionId: string): number { return getSessionTokenCount(this.saivageDir, sessionId); }
  completeSession(sessionId: string, status: Extract<AgentSession['status'], 'done' | 'blocked' | 'failed'>): AgentSession | null { return completeSession(this.saivageDir, sessionId, status); }
  setSessionStatus(sessionId: string, status: AgentSession['status']): AgentSession | null { return setSessionStatus(this.saivageDir, sessionId, status); }
  markSessionWaiting(sessionId: string): AgentSession | null { return markSessionWaiting(this.saivageDir, sessionId); }
  updateSessionModel(sessionId: string, model: string): AgentSession | null { return updateSessionModel(this.saivageDir, sessionId, model); }
}

function decodeMessageSessionFilename(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function readEncodedSessionMessages(saivageDir: string, encodedSessionId: string): AgentMessage[] {
  const path = join(saivageDir, 'agents', 'messages', `${encodedSessionId}.jsonl`);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (raw.trim() === '') return [];
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => agentMessageSchema.parse(JSON.parse(line)));
}
