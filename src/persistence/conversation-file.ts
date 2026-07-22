import type { FreshnessEffects } from '../application/freshness-effects.js';
import { validateConversationRows, type ValidatedConversation } from '../contracts/conversation-compaction.js';
import { agentMessageSchema, parseConversationSessionId, type AgentMessage, type ConversationSessionId } from '../schemas/index.js';
import { readCanonicalGrowingFile, serializeGrowingEnvelope, appendEnvelope, publishFirstEnvelope, type GrowingFileIo } from './growing-file.js';
import type { PublicationTemporaryIdFactory } from './replace-file.js';
import { conversationFile } from '../runtime/actors/conversation-inventory.js';
import { listCards } from './card-files.js';

export interface ConversationFileContext {
  readonly projectRoot: string;
  readonly changes?: Pick<FreshnessEffects, 'conversationChanged' | 'agentsChanged'>;
}

export interface ConversationAppendOptions {
  readonly publicationTemporaryId?: PublicationTemporaryIdFactory;
  readonly io?: GrowingFileIo;
}

export interface ConversationInventoryEntry {
  readonly sessionId: ConversationSessionId;
  readonly conversation: ValidatedConversation;
}

export function readConversation(projectRoot: string, sessionId: ConversationSessionId): ValidatedConversation {
  const path = conversationFile(projectRoot, sessionId);
  const rows = readCanonicalGrowingFile(path, agentMessageSchema);
  try { return validateConversationRows(sessionId, rows); }
  catch (error) { throw new Error(`Conversation '${sessionId}' is invalid: ${error instanceof Error ? error.message : String(error)}`); }
}

function readInventoryCandidate(projectRoot: string, sessionId: ConversationSessionId): ValidatedConversation | null {
  try { return readConversation(projectRoot, sessionId); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export function readConversationInventory(projectRoot: string): readonly ConversationInventoryEntry[] {
  const candidates: ConversationSessionId[] = ['analyst:global'];
  for (const card of listCards(projectRoot)) {
    if (card.type === 'project' || card.type === 'goal') candidates.push(parseConversationSessionId(`planner:${card.id}`), parseConversationSessionId(`reviewer:${card.id}`));
    else candidates.push(parseConversationSessionId(`executor:${card.id}`));
  }
  const inventory = candidates.flatMap((sessionId) => {
    const conversation = readInventoryCandidate(projectRoot, sessionId);
    return conversation ? [Object.freeze({ sessionId, conversation })] : [];
  });
  inventory.sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
  return Object.freeze(inventory);
}

function validateBatch(messages: readonly AgentMessage[]): AgentMessage[] {
  if (messages.length === 0) throw new Error('Conversation append requires at least one message.');
  const parsed = messages.map((message) => agentMessageSchema.parse(message));
  const sessionId = parsed[0]!.session_id;
  if (parsed.some((message) => message.session_id !== sessionId)) throw new Error('Conversation append requires one session.');
  if (new Set(parsed.map((message) => message.id)).size !== parsed.length) throw new Error('Conversation append contains duplicate message ids.');
  return parsed;
}

export function appendConversationBatch(conversations: ConversationFileContext, messages: readonly AgentMessage[], options: ConversationAppendOptions = {}): void {
  const parsed = validateBatch(messages);
  const sessionId = parsed[0]!.session_id;
  let current: ValidatedConversation;
  try { current = readConversation(conversations.projectRoot, sessionId); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    current = validateConversationRows(sessionId, []);
  }
  const existingIds = new Set(current.physicalRows.map((message) => message.id));
  const duplicate = parsed.find((message) => existingIds.has(message.id));
  if (duplicate) throw new Error(`Conversation message '${duplicate.id}' already exists.`);
  validateConversationRows(sessionId, [...current.physicalRows, ...parsed]);
  if (current.physicalRows.length === 0) publishFirstEnvelope(conversationFile(conversations.projectRoot, sessionId), serializeGrowingEnvelope(parsed, agentMessageSchema), options.publicationTemporaryId);
  else {
    const path = conversationFile(conversations.projectRoot, sessionId);
    const result = appendEnvelope(path, serializeGrowingEnvelope(parsed, agentMessageSchema), options.io);
    switch (result.kind) {
      case 'appended': break;
      case 'missing': throw new Error(`Conversation '${sessionId}' disappeared before append.`);
    }
  }
  afterPublication(conversations, parsed);
}

function afterPublication(conversations: ConversationFileContext, messages: readonly AgentMessage[]): void {
  conversations.changes?.conversationChanged(messages[0]!.session_id);
  conversations.changes?.agentsChanged();
}
