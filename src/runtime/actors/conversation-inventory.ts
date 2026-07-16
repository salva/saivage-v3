import { join } from 'node:path';
import { saivageCardsRoot } from '../../persistence/layout.js';
import { cardIdSchema } from '../../schemas/index.js';

export interface ParsedConversationSessionId {
  readonly sessionId: string;
  readonly role: 'planner' | 'executor' | 'reviewer' | 'analyst';
  readonly cardId: string | null;
}

const CARD_ID = '(?:project|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})';
const ROLE_SESSION = new RegExp(`^(planner|executor|reviewer):(${CARD_ID})$`, 'u');
const ANALYST = /^analyst:(global|telegram-(?:0|-?[1-9][0-9]*))$/u;

export function parseConversationSessionId(sessionId: string): ParsedConversationSessionId {
  const roleSession = ROLE_SESSION.exec(sessionId);
  if (roleSession) {
    cardIdSchema.parse(roleSession[2]);
    return Object.freeze({ sessionId, role: roleSession[1] as 'planner' | 'executor' | 'reviewer', cardId: roleSession[2]! });
  }
  if (ANALYST.test(sessionId)) return Object.freeze({ sessionId, role: 'analyst', cardId: null });
  throw new Error(`Conversation session id '${sessionId}' is outside the canonical durable grammar.`);
}

export function conversationDir(projectRoot: string, sessionId: string): string {
  const parsed = parseConversationSessionId(sessionId);
  const encoded = encodeURIComponent(sessionId);
  return parsed.cardId === null
    ? join(projectRoot, '.saivage', 'agents', 'conversations', encoded)
    : join(saivageCardsRoot(projectRoot), parsed.cardId, 'conversations', encoded);
}

export function conversationFile(projectRoot: string, sessionId: string): string {
  return join(conversationDir(projectRoot, sessionId), 'conversation.jsonl');
}
