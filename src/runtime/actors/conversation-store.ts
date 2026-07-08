import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appendSyncIdempotentByKey } from '../../persistence/index.js';
import { agentMessageSchema } from '../../schemas/index.js';
import type { AgentMessage, MessageRole } from '../../schemas/index.js';
import { generateRoundId } from '../../schemas/round-id-server.js';
import {
  activeVersionPath,
  ensureConversationIndex,
  readConversationIndex,
} from './conversation-index.js';

export { conversationDir, conversationIndexPath } from './conversation-index.js';

export function readConversationMessages(projectRoot: string, sessionId: string): AgentMessage[] {
  const index = readConversationIndex(projectRoot, sessionId);
  if (!index) return [];
  const seen = new Set<string>();
  const messages: AgentMessage[] = [];
  for (const version of Object.keys(index.versions).map(Number).sort((a, b) => a - b)) {
    const path = activeVersionPath(projectRoot, sessionId, version);
    if (!existsSync(path)) throw new Error(`Conversation version '${version}' for '${sessionId}' was not found.`);
    for (const message of readConversationVersion(path)) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      messages.push(message);
    }
  }
  return messages;
}

export function readActiveVersionMessages(projectRoot: string, sessionId: string): AgentMessage[] {
  const index = readConversationIndex(projectRoot, sessionId);
  if (!index) return [];
  const path = activeVersionPath(projectRoot, sessionId, index.active_version);
  if (!existsSync(path)) throw new Error(`Conversation active version '${index.active_version}' for '${sessionId}' was not found.`);
  return readConversationVersion(path);
}

export function listConversationSessionIds(projectRoot: string): string[] {
  const dir = join(projectRoot, '.saivage', 'agents', 'conversations');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => decodeURIComponent(entry.name))
    .sort();
}

export function appendConversationMessage(projectRoot: string, message: AgentMessage): void {
  const parsed = agentMessageSchema.parse(message);
  appendSyncIdempotentByKey(activeConversationVersionPath(projectRoot, parsed.session_id), parsed, 'id');
}

export type UserContextMessageCategory = 'planner_state' | 'notification' | 'reviewer_descendant' | 'continuation_hook';

export type ProviderVisibleUserContextMessage = Readonly<{ role: 'user'; content: string }>;

export function providerVisibleUserContextContent(message: ProviderVisibleUserContextMessage): string {
  return message.content;
}

export function appendUserContextMessage(
  projectRoot: string,
  sessionId: string,
  inputId: string,
  category: UserContextMessageCategory,
  ordinal: number,
  content: string,
): AgentMessage {
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
  appendConversationMessage(projectRoot, message);
  return message;
}

export function appendActivationMarker(projectRoot: string, sessionId: string, payload: { event: 'activation_open'; role: string; card_id: string; input_id: string }): void {
  const timestamp = new Date().toISOString();
  const seed = `${sessionId}:${payload.input_id}:${timestamp}`;
  appendConversationMessage(projectRoot, agentMessageSchema.parse({
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
  return messages.filter((message) => message.kind === 'text' || message.kind === 'tool_call' || message.kind === 'tool_result' || message.kind === 'model_repair' || message.kind === 'context_compaction');
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

function roundId(kind: 'pre' | 'user' | 'assistant', seed: string): string {
  return `r-${kind}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}
