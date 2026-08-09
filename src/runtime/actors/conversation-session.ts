import { createHash, randomUUID } from 'node:crypto';
import { agentMessageSchema, conversationSessionIdentity, CONTENT_POLICY_RETRY_TEXT, type AgentMessage, type MessageRole, type ConversationSessionId,
  type CardConversationSessionId,
} from '../../schemas/index.js';
import type { ValidatedConversation } from '../../contracts/conversation-validation.js';
import type { ProviderConversationProjection } from '../../agents/llm-contracts.js';
import { validateResponsesPairs } from '../../agents/llm-openai-responses-mapper.js';
import { appendConversationBatch, type ConversationFileContext,
} from '../../persistence/conversation-file.js';
import { generateRoundId } from '../../schemas/round-id-server.js';
import type { SummarizerProviderRow } from './compaction/result-dropping.js';

export type UserContextMessageCategory =
  | 'notification' | 'reviewer_descendant' | 'process_transition' | 'process_node' | 'continuation_hook';

export type ProviderVisibleUserContextMessage = Readonly<{ role: 'user'; content: string }>;

export function contentPolicyEvidenceUrl(sessionId: ConversationSessionId, markerId: string,
): string {
  return `/agents/${encodeURIComponent(sessionId)}?entry=${encodeURIComponent(markerId)}`;
}

export function contentPolicyRefusalProjectionText(
  sessionId: ConversationSessionId,
  markerId: string,
): string {
  return `A prior activation ended after repeated provider content-policy refusal. Reassess the task decomposition and use only assistance the provider can give within its safety requirements. Operator evidence: ${contentPolicyEvidenceUrl(sessionId, markerId)}.`;
}

export function appendUserContextMessage(
  conversations: ConversationFileContext,
  sessionId: ConversationSessionId,
  inputId: string,
  category: UserContextMessageCategory,
  ordinal: number,
  userContextMessage: ProviderVisibleUserContextMessage,
): AgentMessage {
  const message = buildUserContextMessage(
    sessionId,
    inputId,
    category,
    ordinal,
    userContextMessage,
  );
  appendConversationBatch(conversations, [message]);
  return message;
}

export function buildUserContextMessage(
  sessionId: ConversationSessionId,
  inputId: string,
  category: UserContextMessageCategory,
  ordinal: number,
  userContextMessage: ProviderVisibleUserContextMessage,
): AgentMessage {
  const content = userContextMessage.content;
  const timestamp = new Date().toISOString();
  const seed = `${sessionId}:user:${inputId}:${category}:${ordinal}:${timestamp}:${content}`;
  return agentMessageSchema.parse({
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
}

export function appendActivationMarker(
  conversations: ConversationFileContext,
  sessionId: ConversationSessionId,
  payload: { event: 'activation_open'; agent_name: string; card_id: string; input_id: string },
): AgentMessage {
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
  appendConversationBatch(conversations, [message]);
  return message;
}

export function buildAnalystIngressRows(
  sessionId: ConversationSessionId,
  inputId: string,
  workspaceContent: string,
  userContent: string,
): readonly [AgentMessage, AgentMessage, AgentMessage] {
  return [
    buildAnalystActivationMarker(sessionId, inputId),
    buildContextTextMessage(sessionId, 'system', workspaceContent),
    buildContextTextMessage(sessionId, 'user', userContent),
  ];
}

export function buildAnalystRestartRows(
  sessionId: ConversationSessionId,
  inputId: string,
  userContent: string,
): readonly [AgentMessage, AgentMessage] {
  return [
    buildAnalystActivationMarker(sessionId, inputId),
    buildContextTextMessage(sessionId, 'user', userContent),
  ];
}

export function buildAnalystActivationMarker(
  sessionId: ConversationSessionId,
  inputId: string,
): AgentMessage {
  const timestamp = new Date().toISOString();
  return agentMessageSchema.parse({
    id: `${sessionId}:activation:${randomUUID()}`,
    session_id: sessionId,
    role: 'system',
    kind: 'activity',
    content: JSON.stringify({
      event: 'activation_open',
      agent_name: conversationSessionIdentity(sessionId).agentName,
      input_id: inputId,
      timestamp,
    }),
    round_id: generateRoundId('pre'),
    message_index: 0,
    block_index: 0,
    timestamp,
  });
}

export function appendRecoveryNotice(
  conversations: ConversationFileContext,
  sessionId: CardConversationSessionId,
  inputId: string,
  _disposition: 'ordinary_interruption',
): AgentMessage {
  const message = agentMessageSchema.parse({
    id: `${inputId}:model-recovered`,
    session_id: sessionId,
    role: 'system',
    kind: 'model_recovered',
    content:
      'The previous runtime activation was interrupted. External or domain effects may or may not have happened. Inspect current card, record, and tool facts before repeating work.',
    round_id: roundId('pre', inputId),
    message_index: 0,
    block_index: 1,
    timestamp: new Date().toISOString(),
  });
  appendConversationBatch(conversations, [message]);
  return message;
}

export function isExactRecoveryNotice(
  message: AgentMessage,
  sessionId: CardConversationSessionId,
  inputId: string,
): boolean {
  return (
    message.id === `${inputId}:model-recovered` &&
    message.session_id === sessionId &&
    message.role === 'system' &&
    message.kind === 'model_recovered' &&
    message.content ===
      'The previous runtime activation was interrupted. External or domain effects may or may not have happened. Inspect current card, record, and tool facts before repeating work.' &&
    message.round_id === roundId('pre', inputId) &&
    message.message_index === 0 &&
    message.block_index === 1
  );
}

export function buildContextTextMessage(
  sessionId: ConversationSessionId,
  role: Extract<MessageRole, 'user' | 'system'>,
  content: string,
): AgentMessage {
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

export function providerConversationProjection(
  conversation: ValidatedConversation,
): ProviderConversationProjection {
  const latest = conversation.latestCompaction;
  const messages = !latest
    ? conversation.sourceRows.flatMap(projectProviderConversationMessage)
    : projectCompactedConversation(conversation, latest);
  const wrongSession = messages.find(
    (message) => message.session_id !== conversation.sourceSessionId,
  );
  if (wrongSession)
    throw new Error(
      `Projected conversation row '${wrongSession.id}' belongs to session '${wrongSession.session_id}', not source session '${conversation.sourceSessionId}'.`,
    );
  validateResponsesPairs(conversation.sourceSessionId, messages);
  return { sourceSessionId: conversation.sourceSessionId, messages };
}

export type SummarizerConversationProjection = Readonly<{
  kind: 'summarizer_projection';
  sourceSessionId: ConversationSessionId;
  messages: AgentMessage[];
}>;

export function summarizerConversationProjection(
  sourceSessionId: ConversationSessionId,
  transformedSourceRows: readonly SummarizerProviderRow[],
): SummarizerConversationProjection {
  if (transformedSourceRows.some((row) => row.kind === 'context_compaction'))
    throw new Error('Summarizer projection does not accept compaction metadata.');
  const messages = transformedSourceRows.flatMap(projectProviderConversationMessage);
  validateResponsesPairs(sourceSessionId, messages);
  return Object.freeze({ kind: 'summarizer_projection', sourceSessionId, messages });
}

function projectCompactedConversation(
  conversation: ValidatedConversation,
  latest: NonNullable<ValidatedConversation['latestCompaction']>,
): AgentMessage[] {
  const retainedIds = new Set(latest.payload.retained_static_message_ids);
  const retained = conversation.sourceRows
    .filter((message, index) => index <= latest.cutoffSourceIndex && retainedIds.has(message.id))
    .flatMap(projectProviderConversationMessage);
  const metadata = latest.metadataRow;
  const synthetic = agentMessageSchema.parse({
    id: `${metadata.id}:rendered`,
    session_id: metadata.session_id,
    role: 'system',
    kind: 'text',
    content: latest.renderedContext,
    round_id: metadata.round_id,
    message_index: metadata.message_index,
    block_index: metadata.block_index,
    timestamp: metadata.timestamp,
  });
  const coveredMarkers = conversation.sourceRows
    .slice(0, latest.cutoffSourceIndex + 1)
    .filter((message) => message.kind === 'content_policy_refusal')
    .flatMap(projectProviderConversationMessage);
  return [
    ...retained,
    synthetic,
    ...coveredMarkers,
    ...conversation.sourceRows
      .slice(latest.cutoffSourceIndex + 1)
      .flatMap(projectProviderConversationMessage),
  ];
}

export function isProviderConversationMessage(message: AgentMessage): boolean {
  return (
    message.kind === 'text' ||
    message.kind === 'tool_call' ||
    message.kind === 'tool_result' ||
    message.kind === 'model_repair' ||
    message.kind === 'model_recovered' ||
    message.kind === 'provider_private' ||
    message.kind === 'content_policy_retry' ||
    message.kind === 'content_policy_refusal'
  );
}

export function isConversationBudgetVisible(message: AgentMessage): boolean {
  return isProviderConversationMessage(message) && message.kind !== 'provider_private';
}

function projectProviderConversationMessage(message: AgentMessage): AgentMessage[] {
  if (!isProviderConversationMessage(message)) return [];
  if (message.kind === 'content_policy_retry')
    return [
      agentMessageSchema.parse({
        ...message,
        kind: 'text',
        role: 'user',
        content: CONTENT_POLICY_RETRY_TEXT,
      }),
    ];
  if (message.kind === 'content_policy_refusal')
    return [
      agentMessageSchema.parse({
        ...message,
        kind: 'text',
        role: 'user',
        content: contentPolicyRefusalProjectionText(message.session_id, message.id),
      }),
    ];
  return [message];
}

function roundId(kind: 'pre' | 'user' | 'assistant', seed: string): string {
  return `r-${kind}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}
