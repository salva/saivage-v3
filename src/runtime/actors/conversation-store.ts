import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { appendSyncIdempotentByKey, writeFileAtomic } from '../../persistence/index.js';
import { agentMessageSchema } from '../../schemas/index.js';
import type { AgentMessage, MessageRole } from '../../schemas/index.js';

const conversationSegmentNameSchema = z.string().regex(/^seg-\d{3}\.jsonl$/);
const conversationIndexSchema = z.object({
  schema_version: z.literal(1),
  active_segment: conversationSegmentNameSchema,
}).strict();

type ConversationIndex = z.infer<typeof conversationIndexSchema>;

export function conversationDir(projectRoot: string, sessionId: string): string {
  return join(projectRoot, '.saivage', 'agents', 'conversations', encodeURIComponent(sessionId));
}

export function conversationIndexPath(projectRoot: string, sessionId: string): string {
  return join(conversationDir(projectRoot, sessionId), 'index.json');
}

export function conversationSegmentPath(projectRoot: string, sessionId: string, segmentName: string): string {
  return join(conversationDir(projectRoot, sessionId), conversationSegmentNameSchema.parse(segmentName));
}

export function readConversationMessages(projectRoot: string, sessionId: string): AgentMessage[] {
  const seen = new Set<string>();
  const messages: AgentMessage[] = [];
  for (const message of conversationSegmentPaths(projectRoot, sessionId).flatMap((path) => readConversationSegment(path))) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    messages.push(message);
  }
  return messages;
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
  appendSyncIdempotentByKey(activeConversationSegmentPath(projectRoot, parsed.session_id), parsed, 'id');
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
  return messages.filter((message) => message.kind === 'text' || message.kind === 'tool_call' || message.kind === 'tool_result' || message.kind === 'model_repair');
}

function activeConversationSegmentPath(projectRoot: string, sessionId: string): string {
  const index = ensureConversationIndex(projectRoot, sessionId);
  const path = conversationSegmentPath(projectRoot, sessionId, index.active_segment);
  if (!existsSync(path)) throw new Error(`Conversation active segment '${index.active_segment}' for '${sessionId}' was not found.`);
  return path;
}

function ensureConversationIndex(projectRoot: string, sessionId: string): ConversationIndex {
  const dir = conversationDir(projectRoot, sessionId);
  const path = conversationIndexPath(projectRoot, sessionId);
  if (existsSync(path)) return readConversationIndex(path);
  mkdirSync(dir, { recursive: true });
  const segment = conversationSegmentPath(projectRoot, sessionId, 'seg-001.jsonl');
  writeFileAtomic(segment, '');
  const index: ConversationIndex = { schema_version: 1, active_segment: 'seg-001.jsonl' };
  writeFileAtomic(path, JSON.stringify(index, null, 2) + '\n');
  return index;
}

function readConversationIndex(path: string): ConversationIndex {
  try {
    return conversationIndexSchema.parse(JSON.parse(readFileSync(path, 'utf-8')));
  } catch (error) {
    throw new Error(`Conversation index '${path}' is malformed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function conversationSegmentPaths(projectRoot: string, sessionId: string): string[] {
  const dir = conversationDir(projectRoot, sessionId);
  const indexPath = conversationIndexPath(projectRoot, sessionId);
  if (!existsSync(indexPath)) return [];
  const index = readConversationIndex(indexPath);
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && conversationSegmentNameSchema.safeParse(entry.name).success)
    .map((entry) => entry.name)
    .sort();
  if (!entries.includes(index.active_segment)) throw new Error(`Conversation active segment '${index.active_segment}' for '${sessionId}' was not found.`);
  return entries.map((entry) => conversationSegmentPath(projectRoot, sessionId, entry));
}

function readConversationSegment(path: string): AgentMessage[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => agentMessageSchema.parse(JSON.parse(line)));
}

function roundId(kind: 'pre' | 'user' | 'assistant', seed: string): string {
  return `r-${kind}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}
