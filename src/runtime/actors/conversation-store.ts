import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentMessageSchema } from '../../schemas/index.js';
import type { AgentMessage, MessageRole } from '../../schemas/index.js';
import type { ConversationStore } from '../../persistence/conversation-store.js';
import { generateRoundId } from '../../schemas/round-id-server.js';
import { saivageCardsRoot } from '../../persistence/layout.js';
import { parseGrowingFile } from '../../persistence/growing-file.js';
import type { ProjectNamespaceReader } from '../../persistence/project-store-repository.js';
import {
  activeVersionPath,
  parseConversationSessionId,
  readConversationInventory,
} from './conversation-inventory.js';

export { conversationDir } from './conversation-inventory.js';

export function readConversationMessages(projectRoot: string, sessionId: string): AgentMessage[] {
  return readActiveVersionMessages(projectRoot, sessionId);
}

export function readActiveConversationMessages(projectRoot: string, sessionId: string, namespace: ProjectNamespaceReader): AgentMessage[] {
  const parsed = parseConversationSessionId(sessionId);
  if (parsed.cardId !== null && !namespace.isActiveCardId(parsed.cardId)) return [];
  return readConversationMessages(projectRoot, sessionId);
}

export function readActiveVersionMessages(projectRoot: string, sessionId: string): AgentMessage[] {
  const inventory = readConversationInventory(projectRoot, sessionId);
  if (!inventory) return [];
  const path = activeVersionPath(projectRoot, sessionId, inventory.activeVersion);
  return readConversationVersionMessages(path);
}

export function listConversationSessionIds(projectRoot: string, namespace: ProjectNamespaceReader): string[] {
  const ids = conversationDirectories(projectRoot, namespace).map(({ encodedSessionId }) => decodeURIComponent(encodedSessionId));
  if (new Set(ids).size !== ids.length) throw new Error('A canonical conversation session id occurs under more than one active root.');
  return ids.sort();
}

export type UserContextMessageCategory = 'notification' | 'reviewer_descendant' | 'continuation_hook';

export type ProviderVisibleUserContextMessage = Readonly<{ role: 'user'; content: string }>;

export function appendUserContextMessage(
  conversations: ConversationStore,
  sessionId: string,
  inputId: string,
  category: UserContextMessageCategory,
  ordinal: number,
  userContextMessage: ProviderVisibleUserContextMessage,
): AgentMessage {
  const content = userContextMessage.content;
  const timestamp = new Date().toISOString();
  const seed = `${sessionId}:user:${inputId}:${category}:${ordinal}:${timestamp}:${content}`;
  const message = agentMessageSchema.parse({
    id: `${sessionId}:ctxmsg:${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`,
    session_id: sessionId,
    role: 'user',
    kind: 'text',
    content,
    round_id: roundId('user', seed),
    message_index: 1,
    block_index: 0,
    timestamp,
  });
  conversations.appendBatch([message]);
  return message;
}

export function appendActivationMarker(conversations: ConversationStore, sessionId: string, payload: { event: 'activation_open'; role: string; card_id: string; input_id: string }): AgentMessage {
  const timestamp = new Date().toISOString();
  const seed = `${sessionId}:${payload.input_id}:${timestamp}`;
  const message = agentMessageSchema.parse({
    id: `${sessionId}:activation:${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`,
    session_id: sessionId,
    role: 'system',
    kind: 'activity',
    content: JSON.stringify({ ...payload, timestamp }),
    round_id: generateRoundId('pre'),
    message_index: 0,
    block_index: 0,
    timestamp,
  });
  conversations.appendBatch([message]);
  return message;
}

export function buildContextTextMessage(sessionId: string, role: Extract<MessageRole, 'user' | 'system'>, content: string): AgentMessage {
  const timestamp = new Date().toISOString();
  const seed = `${sessionId}:${role}:${timestamp}:${content}`;
  return agentMessageSchema.parse({
    id: `${sessionId}:context:${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`,
    session_id: sessionId,
    role,
    kind: 'text',
    content,
    round_id: roundId(role === 'system' ? 'pre' : 'user', seed),
    message_index: role === 'system' ? 0 : 1,
    block_index: 0,
    timestamp,
  });
}

export function appendCanonicalUserText(conversations: ConversationStore, sessionId: string, content: string): AgentMessage {
  const message = buildContextTextMessage(sessionId, 'user', content);
  conversations.appendBatch([message]);
  return message;
}

export function conversationMessagesForModel(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(isModelVisibleConversationMessage);
}

export function isModelVisibleConversationMessage(message: AgentMessage): boolean {
  return message.kind === 'text' || message.kind === 'tool_call' || message.kind === 'tool_result' || message.kind === 'model_repair' || message.kind === 'context_compaction';
}

export function isConversationBudgetVisible(message: AgentMessage): boolean {
  return isModelVisibleConversationMessage(message);
}

export function readConversationVersionMessages(path: string): AgentMessage[] {
  try {
    const content = readFileSync(path, 'utf-8');
    if (content.length === 0) throw new Error('published version is empty');
    if (!content.endsWith('\n')) throw new Error('published version has an incomplete final row');
    const messages = parseGrowingFile(path, content, agentMessageSchema);
    if (messages.length === 0) throw new Error('published version has no messages');
    if (new Set(messages.map((message) => message.id)).size !== messages.length) throw new Error('published version contains duplicate message ids');
    return messages;
  } catch (error) {
    throw new Error(`Conversation version '${path}' is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function conversationDirectories(projectRoot: string, namespace: ProjectNamespaceReader): Array<{ dir: string; encodedSessionId: string }> {
  const dirs: Array<{ dir: string; encodedSessionId: string }> = [];
  const analystRoot = join(projectRoot, '.saivage', 'agents', 'conversations');
  collectConversationDirectories(analystRoot, dirs, null);

  const cardsRoot = saivageCardsRoot(projectRoot);
  for (const cardId of namespace.activeCardIds()) collectConversationDirectories(join(cardsRoot, cardId, 'conversations'), dirs, cardId);
  return dirs;
}

function collectConversationDirectories(root: string, dirs: Array<{ dir: string; encodedSessionId: string }>, expectedCardId: string | null): void {
  if (!existsSync(root)) return;
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error(`Conversation root is not a real directory: '${root}'.`);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Conversation root entry is not a real directory: '${path}'.`);
    let sessionId: string;
    try { sessionId = decodeURIComponent(entry.name); }
    catch (error) { throw new Error(`Conversation directory name is malformed: '${path}'.`, { cause: error }); }
    if (encodeURIComponent(sessionId) !== entry.name) throw new Error(`Conversation directory name is not canonical: '${path}'.`);
    const parsed = parseConversationSessionId(sessionId);
    if (parsed.cardId !== expectedCardId) throw new Error(`Conversation '${sessionId}' is stored under the wrong owner root.`);
    dirs.push({ dir: path, encodedSessionId: entry.name });
  }
}

function roundId(kind: 'pre' | 'user' | 'assistant', seed: string): string {
  return `r-${kind}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}
