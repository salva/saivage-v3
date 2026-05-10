import { existsSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentSessionSchema, agentMessageSchema } from '../schemas/validators.js';
import { writeFileAtomic } from '../utils/file-tree.js';
import type {
  AgentSession,
  AgentMessage,
  AgentRole,
  MessageKind,
  MessageRole,
  EntityLink,
} from '../schemas/types.js';

// ── Constants ─────────────────────────────────────────────────

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

// ── Counter for session IDs ───────────────────────────────────

let sessionCounter = 0;

function nextSessionId(role: string): string {
  sessionCounter++;
  const ts = Date.now();
  return `${role}-${ts}-${sessionCounter}`;
}

function nextMessageId(sessionId: string, count: number): string {
  return `msg-${sessionId}-${count + 1}`;
}

// ── Token Counting ────────────────────────────────────────────

/**
 * Estimate token count for a string.
 * Uses a rough heuristic: ~3.5 chars per token for English text.
 * This is a fast approximation; for production use, a real tokenizer
 * should be plugged in.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

/**
 * Estimate token count for an array of messages.
 */
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

// ── Public API ────────────────────────────────────────────────

/**
 * Create a new agent session.
 */
export function createSession(
  saivageDir: string,
  role: AgentRole,
  goalCardId?: string | null,
  cardId?: string | null,
  model?: string,
): AgentSession {
  const session: AgentSession = {
    id: nextSessionId(role),
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

/**
 * Get a session by ID.
 */
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
    throw new Error(
      `AgentSession validation failed for ${sessionId}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Complete a session (mark as done or failed).
 */
export function completeSession(
  saivageDir: string,
  sessionId: string,
  status: 'done' | 'failed',
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

/**
 * Update a session's model field.
 */
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

/**
 * Append a message to a session's JSONL message log.
 */
export function appendMessage(
  saivageDir: string,
  sessionId: string,
  message: {
    role: MessageRole;
    kind: MessageKind;
    content: string;
    tool?: string;
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

/**
 * Get all messages for a session, in chronological order.
 */
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
    const parsed = agentMessageSchema.parse(obj);
    return parsed;
  });
}

/**
 * Replace all messages in a session (used by compaction).
 */
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

/**
 * Get the total estimated token count for a session's messages.
 */
export function getSessionTokenCount(
  saivageDir: string,
  sessionId: string,
): number {
  const messages = getSessionMessages(saivageDir, sessionId);
  return estimateMessageTokens(messages);
}

/**
 * Delete a session and its messages.
 */
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

/**
 * List all session IDs.
 */
export function listSessions(saivageDir: string): string[] {
  const sd = sessionsDir(saivageDir);
  if (!existsSync(sd)) return [];

  return readdirSync(sd)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => f.replace('.json', ''));
}

/**
 * Build a conversation context string from messages.
 */
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
