import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendSyncIdempotentByKey } from '../../persistence/index.js';
import { agentMessageSchema } from '../../schemas/index.js';
import type { AgentMessage, MessageRole } from '../../schemas/index.js';
import { parseProviderExchangePayload } from '../../contracts/provider-exchange.js';
import { generateRoundId } from '../../schemas/round-id-server.js';
import { saivageCardsRoot } from '../../persistence/layout.js';
import {
  activeVersionPath,
  ensureConversationIndex,
  readConversationIndex,
} from './conversation-index.js';

export { conversationDir, conversationIndexPath } from './conversation-index.js';

export type ConversationAppendResult = { message: AgentMessage; appended: boolean };

export function readConversationMessages(projectRoot: string, sessionId: string): AgentMessage[] {
  return readActiveVersionMessages(projectRoot, sessionId);
}

export function readActiveVersionMessages(projectRoot: string, sessionId: string): AgentMessage[] {
  const index = readConversationIndex(projectRoot, sessionId);
  if (!index) return [];
  const path = activeVersionPath(projectRoot, sessionId, index.active_version);
  if (!existsSync(path)) throw new Error(`Conversation active version '${index.active_version}' for '${sessionId}' was not found.`);
  return readConversationVersion(path);
}

export function listConversationSessionIds(projectRoot: string): string[] {
  return conversationDirectories(projectRoot)
    .map(({ encodedSessionId }) => decodeURIComponent(encodedSessionId))
    .sort();
}

export function appendConversationMessage(projectRoot: string, message: AgentMessage): ConversationAppendResult {
  const parsed = agentMessageSchema.parse(message);
  return { message: parsed, appended: appendSyncIdempotentByKey(activeConversationVersionPath(projectRoot, parsed.session_id), parsed, 'id') };
}

export function appendProviderExchangeMessage(projectRoot: string, message: AgentMessage): ConversationAppendResult {
  const parsed = agentMessageSchema.parse(message);
  if (parsed.kind !== 'provider_exchange') throw new Error(`appendProviderExchangeMessage requires kind provider_exchange, got '${parsed.kind}'.`);
  parseProviderExchangePayload(parsed.content);
  const path = activeConversationVersionPath(projectRoot, parsed.session_id);
  const canonicalRow = JSON.stringify(parsed);
  for (const existing of readConversationVersion(path)) {
    if (existing.kind !== 'provider_exchange' || existing.id !== parsed.id) continue;
    if (JSON.stringify(existing) === canonicalRow) return { message: parsed, appended: false };
    throw new Error(`provider_exchange duplicate id contract violation for session '${parsed.session_id}' message '${parsed.id}' in active conversation version.`);
  }
  return { message: parsed, appended: appendSyncIdempotentByKey(path, parsed, 'id') };
}

export type UserContextMessageCategory = 'planner_state' | 'notification' | 'reviewer_descendant' | 'continuation_hook';

export type ProviderVisibleUserContextMessage = Readonly<{ role: 'user'; content: string }>;

export function appendUserContextMessage(
  projectRoot: string,
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
  return appendConversationMessage(projectRoot, message);
}

export function appendActivationMarker(projectRoot: string, sessionId: string, payload: { event: 'activation_open'; role: string; card_id: string; input_id: string }): ConversationAppendResult {
  const timestamp = new Date().toISOString();
  const seed = `${sessionId}:${payload.input_id}:${timestamp}`;
  return appendConversationMessage(projectRoot, agentMessageSchema.parse({
    id: `${sessionId}:activation:${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`,
    session_id: sessionId,
    role: 'system',
    kind: 'activity',
    content: JSON.stringify({ ...payload, timestamp }),
    round_id: generateRoundId('pre'),
    message_index: 0,
    block_index: 0,
    timestamp,
  }));
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

export function conversationMessagesForModel(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(isModelVisibleConversationMessage);
}

export function isModelVisibleConversationMessage(message: AgentMessage): boolean {
  return message.kind === 'text' || message.kind === 'tool_call' || message.kind === 'tool_result' || message.kind === 'model_repair' || message.kind === 'context_compaction';
}

export function isConversationBudgetVisible(message: AgentMessage): boolean {
  return isModelVisibleConversationMessage(message);
}

function activeConversationVersionPath(projectRoot: string, sessionId: string): string {
  const index = ensureConversationIndex(projectRoot, sessionId);
  const path = activeVersionPath(projectRoot, sessionId, index.active_version);
  if (!existsSync(path)) throw new Error(`Conversation active version '${index.active_version}' for '${sessionId}' was not found.`);
  return path;
}

function readConversationVersion(path: string): AgentMessage[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => agentMessageSchema.parse(JSON.parse(line)));
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
