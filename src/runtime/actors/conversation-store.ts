import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentMessageSchema } from '../../schemas/index.js';
import type { AgentMessage, MessageRole } from '../../schemas/index.js';
import type { ConversationStore, ConversationAppendResult } from '../../persistence/conversation-store.js';
import type { MutationAuthority } from '../../application/mutation-authority.js';
import { generateRoundId } from '../../schemas/round-id-server.js';
import { saivageCardsRoot } from '../../persistence/layout.js';
import {
  activeVersionPath,
  readConversationIndex,
  readValidatedConversationIndex,
} from './conversation-index.js';

export { conversationDir, conversationIndexPath } from './conversation-index.js';

export type { ConversationAppendResult } from '../../persistence/conversation-store.js';

export function readConversationMessages(projectRoot: string, sessionId: string): AgentMessage[] {
  return readActiveVersionMessages(projectRoot, sessionId);
}

export function readActiveVersionMessages(projectRoot: string, sessionId: string): AgentMessage[] {
  const index = readConversationIndex(projectRoot, sessionId);
  if (!index) return [];
  const path = activeVersionPath(projectRoot, sessionId, index.active_version);
  if (!existsSync(path)) throw new Error(`Conversation active version '${index.active_version}' for '${sessionId}' was not found.`);
  return readConversationVersionMessages(path);
}

export function hasIndexedConversationMessageOfKind(projectRoot: string, sessionId: string, messageId: string, expectedKind: AgentMessage['kind']): boolean {
  const index = readValidatedConversationIndex(projectRoot, sessionId);
  if (!index) return false;

  let found = false;
  for (const version of Object.keys(index.versions).map(Number).sort((left, right) => left - right)) {
    const path = activeVersionPath(projectRoot, sessionId, version);
    if (!existsSync(path)) throw new Error(`Conversation indexed version '${path}' was not found.`);
    for (const message of readConversationVersionMessages(path)) {
      if (message.id !== messageId) continue;
      if (message.kind !== expectedKind) {
        throw new Error(`Conversation indexed version '${path}' has '${messageId}' with kind '${message.kind}', expected '${expectedKind}'.`);
      }
      found = true;
    }
  }
  return found;
}

export function listConversationSessionIds(projectRoot: string): string[] {
  return conversationDirectories(projectRoot)
    .map(({ encodedSessionId }) => decodeURIComponent(encodedSessionId))
    .sort();
}

export type UserContextMessageCategory = 'notification' | 'reviewer_descendant' | 'continuation_hook';

export type ProviderVisibleUserContextMessage = Readonly<{ role: 'user'; content: string }>;

export function appendUserContextMessage(
  conversations: ConversationStore,
  authority: MutationAuthority,
  sessionId: string,
  inputId: string,
  category: UserContextMessageCategory,
  ordinal: number,
  userContextMessage: ProviderVisibleUserContextMessage,
): ConversationAppendResult {
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
  const result = conversations.appendBatch(authority, [message]);
  return { message, appended: result.appended };
}

export function appendActivationMarker(conversations: ConversationStore, authority: MutationAuthority, sessionId: string, payload: { event: 'activation_open'; role: string; card_id: string; input_id: string }): ConversationAppendResult {
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
  const result = conversations.appendBatch(authority, [message]);
  return { message, appended: result.appended };
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

export function appendCanonicalUserText(conversations: ConversationStore, authority: MutationAuthority, sessionId: string, content: string): ConversationAppendResult {
  const message = buildContextTextMessage(sessionId, 'user', content);
  const result = conversations.appendBatch(authority, [message]);
  return { message, appended: result.appended };
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
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => agentMessageSchema.parse(JSON.parse(line)));
  } catch (error) {
    throw new Error(`Conversation version '${path}' is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function conversationDirectories(projectRoot: string): Array<{ dir: string; encodedSessionId: string }> {
  const dirs: Array<{ dir: string; encodedSessionId: string }> = [];
  const analystRoot = join(projectRoot, '.saivage', 'agents', 'conversations');
  collectConversationDirectories(analystRoot, dirs);

  const cardsRoot = saivageCardsRoot(projectRoot);
  if (existsSync(cardsRoot)) {
    for (const cardEntry of readdirSync(cardsRoot, { withFileTypes: true })) {
      if (!cardEntry.isDirectory()) continue;
      collectConversationDirectories(join(cardsRoot, cardEntry.name, 'conversations'), dirs);
    }
  }
  return dirs;
}

function collectConversationDirectories(root: string, dirs: Array<{ dir: string; encodedSessionId: string }>): void {
  if (!existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) dirs.push({ dir: join(root, entry.name), encodedSessionId: entry.name });
  }
}

function roundId(kind: 'pre' | 'user' | 'assistant', seed: string): string {
  return `r-${kind}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}
