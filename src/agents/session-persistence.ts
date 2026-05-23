import { existsSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentSessionSchema, agentMessageSchema } from '../schemas/validators.js';
import { explainLegacyStateRejection, writeFileAtomic } from '../persistence/file-tree.js';
import type {
  AgentSession,
  AgentMessage,
  AgentRole,
  MessageKind,
  MessageRole,
  EntityLink,
  SessionStatus,
} from '../schemas/types.js';

const SESSIONS_DIR = 'sessions';
const MESSAGES_DIR = 'messages';

function sessionsDir(saivageDir: string): string {
  return join(saivageDir, 'agents', SESSIONS_DIR);
}

function messagesDir(saivageDir: string): string {
  return join(saivageDir, 'agents', MESSAGES_DIR);
}

function sessionPath(saivageDir: string, sessionId: string): string {
  return join(sessionsDir(saivageDir), `${sessionId}.json`);
}

function messagesPath(saivageDir: string, sessionId: string): string {
  return join(messagesDir(saivageDir), `${sessionId}.jsonl`);
}

function projectRootFromSaivageDir(saivageDir: string): string {
  return join(saivageDir, '..');
}

let sessionCounter = 0;

function nextSessionId(role: string): string {
  sessionCounter++;
  const ts = Date.now();
  return `${role}-${ts}-${sessionCounter}`;
}

function nextMessageId(sessionId: string, count: number): string {
  return `msg-${sessionId}-${count + 1}`;
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

export function estimateMessageTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(msg.content);
    if (msg.tool) {
      total += estimateTokens(msg.tool);
    }
  }
  return total;
}

export function createSession(
  saivageDir: string,
  role: AgentRole,
  goalCardId?: string | null,
  cardId?: string | null,
  model?: string,
  requestedSessionId?: string,
): AgentSession {
  const sessionId = requestedSessionId ?? (role === 'planner' && goalCardId && cardId === goalCardId ? `planner:${goalCardId}` : nextSessionId(role));
  const session: AgentSession = {
    id: sessionId,
    role,
    goal_card_id: goalCardId ?? null,
    card_id: cardId ?? null,
    status: 'active',
    started_at: new Date().toISOString(),
    model,
  };

  agentSessionSchema.parse(session);

  const sp = sessionPath(saivageDir, session.id);
  writeFileAtomic(sp, JSON.stringify(session, null, 2) + '\n');

  return session;
}

export function getSession(
  saivageDir: string,
  sessionId: string,
): AgentSession | null {
  const sp = sessionPath(saivageDir, sessionId);
  if (!existsSync(sp)) return null;

  const raw = readFileSync(sp, 'utf-8');
  const obj = JSON.parse(raw);
  const parsed = agentSessionSchema.safeParse(obj);
  if (!parsed.success) {
    explainLegacyStateRejection(
      projectRootFromSaivageDir(saivageDir),
      'AgentSession',
      `session ${sessionId}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export function completeSession(
  saivageDir: string,
  sessionId: string,
  status: 'done' | 'blocked' | 'failed',
): AgentSession {
  const session = getSession(saivageDir, sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const updated: AgentSession = {
    ...session,
    status,
    completed_at: new Date().toISOString(),
  };

  agentSessionSchema.parse(updated);
  writeFileAtomic(
    sessionPath(saivageDir, sessionId),
    JSON.stringify(updated, null, 2) + '\n',
  );

  return updated;
}

export function setSessionStatus(
  saivageDir: string,
  sessionId: string,
  status: SessionStatus,
): AgentSession {
  const session = getSession(saivageDir, sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const updated: AgentSession = {
    ...session,
    status,
    completed_at: status === 'active' || status === 'waiting' ? null : new Date().toISOString(),
  };

  agentSessionSchema.parse(updated);
  writeFileAtomic(
    sessionPath(saivageDir, sessionId),
    JSON.stringify(updated, null, 2) + '\n',
  );

  return updated;
}

export function markSessionWaiting(saivageDir: string, sessionId: string): AgentSession {
  return setSessionStatus(saivageDir, sessionId, 'waiting');
}

export function failActiveWorkerSessions(
  saivageDir: string,
  reason = 'Session was left active by a previous runtime process.',
): AgentSession[] {
  const failed: AgentSession[] = [];

  for (const sessionId of listSessions(saivageDir)) {
    const session = getSession(saivageDir, sessionId);
    if (!session || (session.status !== 'active' && session.status !== 'waiting') || session.role === 'analyst') continue;

    const updated = completeSession(saivageDir, session.id, 'failed');
    appendMessage(saivageDir, session.id, {
      role: 'system',
      kind: 'model_issue',
      content: reason,
    });
    failed.push(updated);
  }

  return failed;
}

export function updateSessionModel(
  saivageDir: string,
  sessionId: string,
  model: string,
): AgentSession {
  const session = getSession(saivageDir, sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const updated: AgentSession = { ...session, model };
  agentSessionSchema.parse(updated);
  writeFileAtomic(
    sessionPath(saivageDir, sessionId),
    JSON.stringify(updated, null, 2) + '\n',
  );

  return updated;
}

export function appendMessage(
  saivageDir: string,
  sessionId: string,
  message: {
    role: MessageRole;
    kind: MessageKind;
    content: string;
    tool?: string;
    tool_call_id?: string;
    links?: EntityLink[];
  },
): AgentMessage {
  const existing = getSessionMessages(saivageDir, sessionId);
  const msg: AgentMessage = {
    id: nextMessageId(sessionId, existing.length),
    session_id: sessionId,
    role: message.role,
    kind: message.kind,
    content: message.content,
    tool: message.tool,
    tool_call_id: message.tool_call_id,
    timestamp: new Date().toISOString(),
    links: message.links,
  };

  agentMessageSchema.parse(msg);

  const mp = messagesPath(saivageDir, sessionId);
  const line = JSON.stringify(msg) + '\n';
  if (existsSync(mp)) {
    const existingContent = readFileSync(mp, 'utf-8');
    writeFileAtomic(mp, existingContent + line);
  } else {
    writeFileAtomic(mp, line);
  }

  return msg;
}

export function getSessionMessages(
  saivageDir: string,
  sessionId: string,
): AgentMessage[] {
  const mp = messagesPath(saivageDir, sessionId);
  if (!existsSync(mp)) return [];

  const raw = readFileSync(mp, 'utf-8');
  if (raw.trim() === '') return [];

  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  return lines.map((line) => {
    const obj = JSON.parse(line);
    return agentMessageSchema.parse(obj);
  });
}

export function replaceSessionMessages(
  saivageDir: string,
  sessionId: string,
  messages: AgentMessage[],
): void {
  const mp = messagesPath(saivageDir, sessionId);
  const content =
    messages.map((m) => JSON.stringify(m)).join('\n') +
    (messages.length > 0 ? '\n' : '');
  writeFileAtomic(mp, content);
}

export function getSessionTokenCount(
  saivageDir: string,
  sessionId: string,
): number {
  const messages = getSessionMessages(saivageDir, sessionId);
  return estimateMessageTokens(messages);
}

export function deleteSession(saivageDir: string, sessionId: string): void {
  const sp = sessionPath(saivageDir, sessionId);
  if (existsSync(sp)) {
    unlinkSync(sp);
  }
  const mp = messagesPath(saivageDir, sessionId);
  if (existsSync(mp)) {
    unlinkSync(mp);
  }
}

export function listSessions(saivageDir: string): string[] {
  const sd = sessionsDir(saivageDir);
  if (!existsSync(sd)) return [];

  return readdirSync(sd)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => f.replace('.json', ''));
}

export function buildConversationContext(
  messages: AgentMessage[],
): string {
  return messages
    .map((m) => {
      const role = m.role.toUpperCase();
      const content = m.content.length > 2000
        ? m.content.slice(0, 2000) + '... [truncated]'
        : m.content;
      return `[${role}]${m.tool ? ` (${m.tool})` : ''}: ${content}`;
    })
    .join('\n\n');
}


export interface UnresolvedActivateCardToolCall {
  session_id: string;
  tool_call_id: string;
  card_id: string;
}

function parseToolCalls(content: string): Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }> {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { toolCalls?: unknown }).toolCalls)) {
      return (parsed as { toolCalls: Array<{ id?: unknown; function?: { name?: unknown; arguments?: unknown } }> }).toolCalls;
    }
  } catch {}
  return [];
}

function parseCardId(args: unknown): string | null {
  if (typeof args !== 'string') return null;
  try {
    const parsed = JSON.parse(args);
    const cardId = (parsed as { cardId?: unknown }).cardId;
    return typeof cardId === 'string' ? cardId : null;
  } catch {
    return null;
  }
}

export function findUniqueUnresolvedActivateCardToolCall(
  saivageDir: string,
  sessionId: string,
  childCardId: string,
): UnresolvedActivateCardToolCall | null {
  const messages = getSessionMessages(saivageDir, sessionId);
  const resolved = new Set(
    messages
      .filter((message) => (message.kind === 'tool_result' || message.kind === 'tool_error') && typeof message.tool_call_id === 'string')
      .map((message) => message.tool_call_id as string),
  );
  const matches: UnresolvedActivateCardToolCall[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || message.kind !== 'tool_call') continue;
    for (const call of parseToolCalls(message.content)) {
      if (call.function?.name !== 'activate_card' || typeof call.id !== 'string') continue;
      if (resolved.has(call.id)) continue;
      const cardId = parseCardId(call.function.arguments);
      if (cardId === childCardId) matches.push({ session_id: sessionId, tool_call_id: call.id, card_id: childCardId });
    }
  }
  if (matches.length === 0) return null;
  // If the planner emitted more than one unresolved activate_card(childCardId) call
  // in the same session (e.g. after a model retry that re-emitted the same intent),
  // prefer the most recent one rather than crashing the safeTick loop. The older
  // duplicate(s) will remain unresolved, which is harmless — they will be ignored
  // by subsequent tool-result lookups keyed on the chosen tool_call_id.
  return matches[matches.length - 1];
}

export function findPlannerSessionForCard(saivageDir: string, cardId: string): AgentSession | null {
  const deterministic = getSession(saivageDir, `planner:${cardId}`);
  if (deterministic) return deterministic;
  const sessions = listSessions(saivageDir)
    .map((id) => getSession(saivageDir, id))
    .filter((session): session is AgentSession => Boolean(session))
    .filter((session) => session.role === 'planner' && session.goal_card_id === cardId && session.card_id === cardId)
    .sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
  return sessions[0] ?? null;
}

export function appendActivateCardToolResultOnce(
  saivageDir: string,
  sessionId: string,
  toolCallId: string,
  content: string,
): AgentMessage {
  const messages = getSessionMessages(saivageDir, sessionId);
  const existing = messages.find((message) => message.kind === 'tool_result' && message.tool_call_id === toolCallId);
  if (existing) return existing;
  return appendMessage(saivageDir, sessionId, {
    role: 'tool',
    kind: 'tool_result',
    content,
    tool: 'activate_card',
    tool_call_id: toolCallId,
  });
}
