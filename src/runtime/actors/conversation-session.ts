import { createHash, randomUUID } from 'node:crypto';
import { agentMessageSchema, conversationSessionIdentity, DURABLE_PRIMARY_CONTENT_POLICY, MODEL_RECOVERY_NOTICE_TEXT, STRUCTURAL_ROW_POLICY, type AgentMessage, type MessageRole, type ConversationSessionId,
  type CardConversationSessionId,
} from '../../schemas/index.js';
import type { ValidatedConversation } from '../../contracts/conversation-validation.js';
import type { ProviderConversationProjection } from '../../agents/llm-contracts.js';
import { composeContextProjection, providerConversationFromComposedContext } from './context/composition-projector.js';
import { classifyConversationRowPolicy } from './context/row-policy.js';
import type { ContextBlock } from './context/context-blocks.js';
import { appendConversationBatch, type ConversationFileContext,
} from '../../persistence/conversation-file.js';
import { deterministicRoundId, generateRoundId } from '../../schemas/round-id-server.js';

type UserContextMessageCategory =
  | 'notification' | 'reviewer_descendant' | 'process_transition' | 'continuation_hook';

export type ProviderVisibleUserContextMessage = Readonly<{ role: 'user'; content: string }>;

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
    context_policy: DURABLE_PRIMARY_CONTENT_POLICY,
    round_id: deterministicRoundId('user', seed),
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
    context_policy: STRUCTURAL_ROW_POLICY.activation_boundary,
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

function buildAnalystActivationMarker(
  sessionId: ConversationSessionId,
  inputId: string,
): AgentMessage {
  const timestamp = new Date().toISOString();
  return agentMessageSchema.parse({
    id: `${sessionId}:activation:${randomUUID()}`,
    session_id: sessionId,
    role: 'system',
    kind: 'activity',
    context_policy: STRUCTURAL_ROW_POLICY.activation_boundary,
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
    context_policy: STRUCTURAL_ROW_POLICY.model_recovery_notice,
    content: MODEL_RECOVERY_NOTICE_TEXT,
    round_id: deterministicRoundId('pre', inputId),
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
    message.content === MODEL_RECOVERY_NOTICE_TEXT &&
    message.round_id === deterministicRoundId('pre', inputId) &&
    message.message_index === 0 &&
    message.block_index === 1
  );
}

function buildContextTextMessage(
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
    context_policy: DURABLE_PRIMARY_CONTENT_POLICY,
    round_id: deterministicRoundId(role === 'system' ? 'pre' : 'user', seed),
    message_index: role === 'system' ? 0 : 1,
    block_index: 0,
    timestamp,
  });
}

export function providerConversationProjection(
  conversation: ValidatedConversation,
  preparedDynamicBlocks: readonly ContextBlock[],
): ProviderConversationProjection {
  const genesis = conversation.compactedGenesis;
  const history = conversation.effectiveCompactedHistory;
  return providerConversationFromComposedContext(composeContextProjection({
    sourceSessionId: conversation.sourceSessionId,
    effectiveHistory: genesis && history
      ? {
          summaryText: history.summaryText,
          historyMessageId: `${genesis.id}:compacted-history`,
          historyTimestamp: genesis.timestamp,
          requiredModelFacts: history.requiredModelFacts,
        }
      : null,
    dynamicBlocks: preparedDynamicBlocks,
    uncoveredRows: conversation.sourceRows,
  }));
}

export function isConversationBudgetVisible(message: AgentMessage): boolean {
  return classifyConversationRowPolicy(message).projection.primaryVisible;
}
