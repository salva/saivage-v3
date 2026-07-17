import { createHash, randomUUID } from 'node:crypto';
import { agentMessageSchema } from '../../schemas/index.js';
import { GLOBAL_ANALYST_SESSION_ID, type AgentMessage, type MessageRole, type ConversationSessionId } from '../../schemas/index.js';
import type { ValidatedConversation } from '../../contracts/conversation-compaction.js';
import type { ProviderConversationProjection } from '../../agents/llm-contracts.js';
import { validateResponsesPairs } from '../../agents/llm-openai-responses-mapper.js';
import { appendConversationBatch, listConversationSessionIds as listDirectConversationSessionIds, readConversation, type ConversationFileContext } from '../../persistence/conversation-file.js';
import { generateRoundId } from '../../schemas/round-id-server.js';

export function readConversationMessages(projectRoot: string, sessionId: ConversationSessionId): ValidatedConversation {
  return readConversation(projectRoot, sessionId);
}

export function listConversationSessionIds(projectRoot: string): ConversationSessionId[] {
  return listDirectConversationSessionIds(projectRoot);
}

export type UserContextMessageCategory = 'notification' | 'reviewer_descendant' | 'continuation_hook';

export type ProviderVisibleUserContextMessage = Readonly<{ role: 'user'; content: string }>;

export function appendUserContextMessage(
  conversations: ConversationFileContext,
  sessionId: ConversationSessionId,
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
  appendConversationBatch(conversations.projectRoot, [message], conversations.changes);
  return message;
}

export function appendActivationMarker(conversations: ConversationFileContext, sessionId: ConversationSessionId, payload: { event: 'activation_open'; role: 'planner' | 'reviewer' | 'executor'; card_id: string; input_id: string }): AgentMessage {
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
  appendConversationBatch(conversations.projectRoot, [message], conversations.changes);
  return message;
}

export function appendAnalystIngressBatch(
  conversations: ConversationFileContext,
  inputId: string,
  workspaceContent: string,
  userContent: string,
): readonly [AgentMessage, AgentMessage, AgentMessage] {
  const marker = buildAnalystActivationMarker(inputId);
  const workspace = buildContextTextMessage(GLOBAL_ANALYST_SESSION_ID, 'system', workspaceContent);
  const user = buildContextTextMessage(GLOBAL_ANALYST_SESSION_ID, 'user', userContent);
  const rows = [marker, workspace, user] as const;
  appendConversationBatch(conversations.projectRoot, rows, conversations.changes);
  return rows;
}

export function appendAnalystRestartBatch(
  conversations: ConversationFileContext,
  inputId: string,
  userContent: string,
): readonly [AgentMessage, AgentMessage] {
  const rows = [buildAnalystActivationMarker(inputId), buildContextTextMessage(GLOBAL_ANALYST_SESSION_ID, 'user', userContent)] as const;
  appendConversationBatch(conversations.projectRoot, rows, conversations.changes);
  return rows;
}

function buildAnalystActivationMarker(inputId: string): AgentMessage {
  const sessionId = GLOBAL_ANALYST_SESSION_ID;
  const timestamp = new Date().toISOString();
  return agentMessageSchema.parse({
    id: `${sessionId}:activation:${randomUUID()}`,
    session_id: sessionId,
    role: 'system',
    kind: 'activity',
    content: JSON.stringify({ event: 'activation_open', role: 'analyst', input_id: inputId, timestamp }),
    round_id: generateRoundId('pre'),
    message_index: 0,
    block_index: 0,
    timestamp,
  });
}

export function appendRecoveryNotice(conversations: ConversationFileContext, sessionId: ConversationSessionId, inputId: string): AgentMessage {
  const message = agentMessageSchema.parse({
    id: `${inputId}:model-recovered`,
    session_id: sessionId,
    role: 'system',
    kind: 'model_recovered',
    content: 'The previous runtime activation was interrupted. External or domain effects may or may not have happened. Inspect current card, record, and tool facts before repeating work.',
    round_id: roundId('pre', inputId),
    message_index: 0,
    block_index: 1,
    timestamp: new Date().toISOString(),
  });
  appendConversationBatch(conversations.projectRoot, [message], conversations.changes);
  return message;
}

export function buildContextTextMessage(sessionId: ConversationSessionId, role: Extract<MessageRole, 'user' | 'system'>, content: string): AgentMessage {
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

export function appendCanonicalUserText(conversations: ConversationFileContext, sessionId: ConversationSessionId, content: string): AgentMessage {
  const message = buildContextTextMessage(sessionId, 'user', content);
  appendConversationBatch(conversations.projectRoot, [message], conversations.changes);
  return message;
}

export function providerConversationProjection(conversation: ValidatedConversation): ProviderConversationProjection {
  const latest = conversation.latestCompaction;
  const messages = !latest
    ? conversation.sourceRows.filter(isProviderConversationMessage)
    : projectCompactedConversation(conversation, latest);
  const wrongSession = messages.find((message) => message.session_id !== conversation.sourceSessionId);
  if (wrongSession) throw new Error(`Projected conversation row '${wrongSession.id}' belongs to session '${wrongSession.session_id}', not source session '${conversation.sourceSessionId}'.`);
  validateResponsesPairs(conversation.sourceSessionId, messages);
  return { sourceSessionId: conversation.sourceSessionId, messages };
}

function projectCompactedConversation(conversation: ValidatedConversation, latest: NonNullable<ValidatedConversation['latestCompaction']>): AgentMessage[] {
  const retainedIds = new Set(latest.payload.retained_static_message_ids);
  const retained = conversation.sourceRows.filter((message, index) => index <= latest.cutoffSourceIndex && retainedIds.has(message.id) && isProviderConversationMessage(message));
  const metadata = latest.metadataRow;
  const synthetic = agentMessageSchema.parse({ id: `${metadata.id}:rendered`, session_id: metadata.session_id, role: 'system', kind: 'text', content: latest.renderedContext, round_id: metadata.round_id, message_index: metadata.message_index, block_index: metadata.block_index, timestamp: metadata.timestamp });
  return [...retained, synthetic, ...conversation.sourceRows.slice(latest.cutoffSourceIndex + 1).filter(isProviderConversationMessage)];
}

export function isProviderConversationMessage(message: AgentMessage): boolean {
  return message.kind === 'text' || message.kind === 'tool_call' || message.kind === 'tool_result' || message.kind === 'model_repair' || message.kind === 'model_recovered' || message.kind === 'provider_private';
}

export function isConversationBudgetVisible(message: AgentMessage): boolean {
  return isProviderConversationMessage(message) && message.kind !== 'provider_private';
}

function roundId(kind: 'pre' | 'user' | 'assistant', seed: string): string {
  return `r-${kind}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}
