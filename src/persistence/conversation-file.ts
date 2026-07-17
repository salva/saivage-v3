import { readFileSync } from 'node:fs';

import type { ReadModelChanges } from '../application/read-model-changes.js';
import { validateConversationRows, type ValidatedConversation } from '../contracts/conversation-compaction.js';
import { agentMessageSchema, parseConversationSessionId, type AgentMessage, type ConversationSessionId } from '../schemas/index.js';
import { readCanonicalGrowingFile, serializeGrowingEnvelope, appendEnvelope, publishFirstEnvelope, type GrowingFileIo } from './growing-file.js';
import type { PublicationTemporaryIdFactory } from './replace-file.js';
import { conversationFile } from '../runtime/actors/conversation-inventory.js';
import { listCards } from './card-files.js';

export interface ConversationFileContext { readonly projectRoot: string; readonly changes?: ReadModelChanges }

function readExact(path: string): string | null {
  try { return readFileSync(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export function probeConversation(projectRoot: string, sessionId: ConversationSessionId): boolean {
  return readExact(conversationFile(projectRoot, sessionId)) !== null;
}

export function readConversation(projectRoot: string, sessionId: ConversationSessionId): ValidatedConversation {
  const path = conversationFile(projectRoot, sessionId);
  let rows: AgentMessage[];
  try { rows = readCanonicalGrowingFile(path, agentMessageSchema); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return validateConversationRows(sessionId, []); throw error; }
  try { return validateConversationRows(sessionId, rows); }
  catch (error) { throw new Error(`Conversation '${sessionId}' is invalid: ${error instanceof Error ? error.message : String(error)}`); }
}

export function listConversationSessionIds(projectRoot: string): ConversationSessionId[] {
  const candidates: ConversationSessionId[] = ['analyst:global'];
  for (const card of listCards(projectRoot)) {
    if (card.type === 'project' || card.type === 'goal') candidates.push(parseConversationSessionId(`planner:${card.id}`), parseConversationSessionId(`reviewer:${card.id}`));
    else candidates.push(parseConversationSessionId(`executor:${card.id}`));
  }
  return candidates.filter((sessionId) => { if (!probeConversation(projectRoot, sessionId)) return false; readConversation(projectRoot, sessionId); return true; }).sort();
}

function validateBatch(messages: readonly AgentMessage[]): AgentMessage[] {
  if (messages.length === 0) throw new Error('Conversation append requires at least one message.');
  const parsed = messages.map((message) => agentMessageSchema.parse(message));
  const sessionId = parsed[0]!.session_id;
  if (parsed.some((message) => message.session_id !== sessionId)) throw new Error('Conversation append requires one session.');
  if (new Set(parsed.map((message) => message.id)).size !== parsed.length) throw new Error('Conversation append contains duplicate message ids.');
  return parsed;
}

export function publishConversationFirstBatch(projectRoot: string, messages: readonly AgentMessage[], changes?: ReadModelChanges, publicationTemporaryId?: PublicationTemporaryIdFactory): void {
  const parsed = validateBatch(messages);
  const sessionId = parsed[0]!.session_id;
  validateConversationRows(sessionId, parsed);
  publishFirstEnvelope(conversationFile(projectRoot, sessionId), serializeGrowingEnvelope(parsed, agentMessageSchema), publicationTemporaryId);
  changes?.conversationChanged(sessionId);
  changes?.agentsChanged();
}

export function appendConversationBatch(projectRoot: string, messages: readonly AgentMessage[], changes?: ReadModelChanges, publicationTemporaryId?: PublicationTemporaryIdFactory, io?: GrowingFileIo): void {
  const parsed = validateBatch(messages);
  const sessionId = parsed[0]!.session_id;
  const current = readConversation(projectRoot, sessionId);
  const existingIds = new Set(current.physicalRows.map((message) => message.id));
  const duplicate = parsed.find((message) => existingIds.has(message.id));
  if (duplicate) throw new Error(`Conversation message '${duplicate.id}' already exists.`);
  validateConversationRows(sessionId, [...current.physicalRows, ...parsed]);
  if (current.physicalRows.length === 0) publishConversationFirstBatch(projectRoot, parsed, changes, publicationTemporaryId);
  else {
    appendEnvelope(conversationFile(projectRoot, sessionId), serializeGrowingEnvelope(parsed, agentMessageSchema), io);
    changes?.conversationChanged(sessionId);
    changes?.agentsChanged();
  }
}
