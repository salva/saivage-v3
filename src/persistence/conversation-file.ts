import type { FreshnessEffects } from '../application/freshness-effects.js';
import {
  validateConversationRows,
  type ValidatedConversation,
} from '../contracts/conversation-compaction.js';
import {
  createCompactConversationValidationState,
  finishCompactConversationValidation,
  reduceCompactConversationRow,
  validateConversationPrefixRows,
} from '../contracts/conversation-compact-reducer.js';
import {
  agentMessageSchema,
  conversationSessionIdentity,
  type AgentMessage,
  type ConversationSessionId,
} from '../schemas/index.js';
import {
  foldCanonicalGrowingFileRows,
  readCanonicalGrowingFileFirstEnvelope,
  readCanonicalGrowingFile,
  serializeGrowingEnvelope,
  appendEnvelope,
  publishFirstEnvelope,
  type GrowingFileIo,
} from './growing-file.js';
import type { PublicationTemporaryIdFactory } from './replace-file.js';
import { conversationFile } from '../runtime/actors/conversation-inventory.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import { projectCanonicalConversationRow } from '../application/read-models/canonical-conversation-outbound.js';
import { projectToolInvocation } from '../tools/tool-invocation-outbound.js';

export interface ConversationFileContext {
  readonly projectRoot: string;
  readonly changes?: Pick<FreshnessEffects, 'conversationChanged' | 'agentMembershipChanged'>;
}

export interface ConversationAppendOptions {
  readonly publicationTemporaryId?: PublicationTemporaryIdFactory;
  readonly io?: GrowingFileIo;
}

export interface ConversationSummary {
  readonly sessionId: ConversationSessionId;
  readonly startedAt: string;
}
export interface FoldedConversation {
  readonly sessionId: ConversationSessionId;
  readonly entries: readonly AgentMessage[];
  readonly cursor: string;
  readonly totalEntries: number;
}

export function readConversation(
  projectRoot: string,
  sessionId: ConversationSessionId,
): ValidatedConversation {
  const path = conversationFile(projectRoot, sessionId);
  const rows = readCanonicalGrowingFile(path, agentMessageSchema);
  try {
    return validateConversationRows(sessionId, rows);
  } catch (error) {
    throw new Error(
      `Conversation '${sessionId}' is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function readConversationSummary(
  projectRoot: string,
  sessionId: ConversationSessionId,
): ConversationSummary {
  const first = readCanonicalGrowingFileFirstEnvelope(
    conversationFile(projectRoot, sessionId),
    agentMessageSchema,
  );
  try {
    validateConversationPrefixRows(sessionId, first.rows);
  } catch (error) {
    throw new Error(
      `Conversation '${sessionId}' is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return Object.freeze({ sessionId, startedAt: first.rows[0]!.timestamp });
}

export function foldConversation(
  projectRoot: string,
  sessionId: ConversationSessionId,
  options: { since?: string; lastN?: number } = {},
): FoldedConversation {
  const validation = createCompactConversationValidationState(sessionId);
  const selected: AgentMessage[] = [];
  let cursorFound = options.since === undefined;
  let cursor = options.since ?? '';
  let totalEntries = 0;
  const result = foldCanonicalGrowingFileRows({
    path: conversationFile(projectRoot, sessionId),
    rowSchema: agentMessageSchema,
    logicalId: (row) => row.id,
    initialState: validation,
    reduce(state, row, checkpoint, replay) {
      reduceCompactConversationRow(state, row, checkpoint, replay);
      cursor = row.id;
      if (options.since !== undefined && !cursorFound) {
        if (row.id === options.since) cursorFound = true;
        return state;
      }
      if (row.kind === 'provider_private') return state;
      const clean = row.provider_projection ? stripProviderProjection(row) : row;
      const projected = projectCanonicalConversationRow(clean, projectToolInvocation);
      totalEntries += 1;
      selected.push(projected);
      if (options.lastN !== undefined && selected.length > options.lastN) selected.shift();
      return state;
    },
  });
  finishCompactConversationValidation(result.state);
  if (!cursorFound) throw new ConversationCursorNotFoundError(options.since!);
  return Object.freeze({ sessionId, entries: Object.freeze(selected), cursor, totalEntries });
}

export class ConversationCursorNotFoundError extends Error {
  constructor(readonly cursor: string) {
    super(`Conversation cursor '${cursor}' was not found.`);
  }
}

function stripProviderProjection(row: AgentMessage): AgentMessage {
  const result = { ...row };
  delete result.provider_projection;
  return agentMessageSchema.parse(result);
}

function validateBatch(messages: readonly AgentMessage[]): AgentMessage[] {
  if (messages.length === 0) throw new Error('Conversation append requires at least one message.');
  const parsed = messages.map((message) => agentMessageSchema.parse(message));
  const sessionId = parsed[0]!.session_id;
  if (parsed.some((message) => message.session_id !== sessionId))
    throw new Error('Conversation append requires one session.');
  if (new Set(parsed.map((message) => message.id)).size !== parsed.length)
    throw new Error('Conversation append contains duplicate message ids.');
  return parsed;
}

export function appendConversationBatch(
  conversations: ConversationFileContext,
  messages: readonly AgentMessage[],
  options: ConversationAppendOptions = {},
): void {
  const parsed = validateBatch(messages);
  const sessionId = parsed[0]!.session_id;
  let current: ValidatedConversation;
  try {
    current = readConversation(conversations.projectRoot, sessionId);
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    current = validateConversationRows(sessionId, []);
  }
  const existingIds = new Set(current.physicalRows.map((message) => message.id));
  const duplicate = parsed.find((message) => existingIds.has(message.id));
  if (duplicate) throw new Error(`Conversation message '${duplicate.id}' already exists.`);
  validateConversationRows(sessionId, [...current.physicalRows, ...parsed]);
  if (current.physicalRows.length === 0)
    publishFirstEnvelope(
      conversationFile(conversations.projectRoot, sessionId),
      serializeGrowingEnvelope(parsed, agentMessageSchema),
      options.publicationTemporaryId,
    );
  else {
    const path = conversationFile(conversations.projectRoot, sessionId);
    const result = appendEnvelope(
      path,
      serializeGrowingEnvelope(parsed, agentMessageSchema),
      options.io,
    );
    switch (result.kind) {
      case 'appended':
        break;
      case 'missing':
        throw new Error(`Conversation '${sessionId}' disappeared before append.`);
    }
  }
  afterPublication(conversations, parsed, current.physicalRows.length === 0);
}

function afterPublication(
  conversations: ConversationFileContext,
  messages: readonly AgentMessage[],
  first: boolean,
): void {
  const sessionId = messages[0]!.session_id;
  conversations.changes?.conversationChanged(sessionId, messages.at(-1)!.id);
  if (first) {
    const identity = conversationSessionIdentity(sessionId);
    conversations.changes?.agentMembershipChanged(
      identity.cardId === null
        ? { scope: 'global-session', sessionId }
        : { scope: 'card', cardId: identity.cardId },
    );
  }
}
