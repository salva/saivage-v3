import {
  AgentConversationResponseSchema,
  type AgentActivityStatus,
  type AgentConversationResponse,
  type AgentSessionSummary,
} from '../../contracts/operator-api-agents.js';
import type { ExactWaitBarrier, ExecutingLlmSnapshot } from '../../runtime/actors/executing-llm-snapshot.js';
import {
  conversationSessionIdentity,
  type AgentMessage,
  type ConversationSessionId,
  type ExecutorConversationSessionId,
  type PlannerConversationSessionId,
  type ReviewerConversationSessionId,
} from '../../schemas/index.js';
import { projectToolInvocation } from '../../tools/tool-invocation-outbound.js';
import {
  inspectCompleteCanonicalConversation,
  projectCompleteCanonicalConversation,
  type CanonicalResultAbsentCall,
  type ExactResultAbsentDeclaration,
} from './canonical-conversation-outbound.js';

export interface AgentConversationProjectionInput {
  readonly sessionId: ConversationSessionId;
  readonly messages: readonly AgentMessage[];
  readonly model: string | null;
  readonly snapshot?: ExecutingLlmSnapshot;
}

export function projectAgentConversationForOutbound(input: AgentConversationProjectionInput): AgentConversationResponse {
  const { sessionId, snapshot } = input;
  const identity = conversationSessionIdentity(sessionId);
  const status = snapshot?.activity.mode ?? 'inactive';
  const rows = input.messages.map(stripPrivateProjectionMarker);
  const unmatched = inspectCompleteCanonicalConversation(rows);
  let declaration: ExactResultAbsentDeclaration | undefined;
  const pendingCalls: AgentActivityStatus['pending_calls'] = [];

  if (snapshot?.activity.mode === 'active') {
    if (unmatched) declaration = { state: 'active-in-flight', ...withoutArguments(unmatched) };
  } else if (snapshot?.activity.mode === 'waiting') {
    if (!unmatched) throw new Error(`Waiting session '${sessionId}' has no unmatched canonical tool call.`);
    verifyWaitingBarrier(sessionId, unmatched, snapshot.activity.barrier);
    declaration = { state: 'waiting', ...withoutArguments(unmatched) };
    pendingCalls.push({ id: unmatched.toolCallId, tool: unmatched.toolName, started_at: unmatched.startedAt });
  }

  const projectedRows = projectCompleteCanonicalConversation(rows, declaration, projectToolInvocation)
    .filter((message) => message.kind !== 'provider_private');
  const session = projectSessionSummary(sessionId, identity.cardId, status, rows[0]!.timestamp, input.model);
  return AgentConversationResponseSchema.parse({
    session,
    entries: projectedRows,
    activity_status: { status, pending_calls: pendingCalls },
  });
}

function verifyWaitingBarrier(
  sessionId: ConversationSessionId,
  call: CanonicalResultAbsentCall,
  barrier: ExactWaitBarrier,
): void {
  const barrierIdentity = barrier.kind === 'child' ? barrier.relationship : barrier;
  if (barrierIdentity.sessionId !== sessionId) throw new Error(`Wait barrier session '${barrierIdentity.sessionId}' does not match '${sessionId}'.`);
  if (call.sessionId !== barrierIdentity.sessionId
    || call.sourceInputId !== barrierIdentity.sourceInputId
    || call.toolCallId !== barrierIdentity.toolCallId
    || call.toolName !== barrierIdentity.toolName) {
    throw new Error(`Waiting session '${sessionId}' tool call does not match its exact barrier.`);
  }

  if (barrier.kind === 'process') {
    if (call.toolName !== 'run_command' && call.toolName !== 'wait_process') throw new Error(`Tool '${call.toolName}' cannot own a process wait barrier.`);
    if (call.toolName === 'wait_process' && parsedArguments(call.arguments)['process_id'] !== barrier.processId) {
      throw new Error(`Waiting process call does not match process '${barrier.processId}'.`);
    }
  }
  if (barrier.kind === 'child') {
    if (call.toolName !== 'activate_card') throw new Error(`Tool '${call.toolName}' cannot own a child wait barrier.`);
    if (parsedArguments(call.arguments)['card_id'] !== barrier.relationship.childCardId) {
      throw new Error(`Waiting child call does not match child '${barrier.relationship.childCardId}'.`);
    }
  }
}

function parsedArguments(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Barrier-owning tool arguments must be an object.');
  return parsed as Record<string, unknown>;
}

function withoutArguments(call: NonNullable<ReturnType<typeof inspectCompleteCanonicalConversation>>) {
  const { arguments: _arguments, ...identity } = call;
  return identity;
}

function projectSessionSummary(
  sessionId: ConversationSessionId,
  cardId: ReturnType<typeof conversationSessionIdentity>['cardId'],
  status: AgentActivityStatus['status'],
  startedAt: string,
  model: string | null,
): AgentSessionSummary {
  const common = { status, started_at: startedAt, ...(model ? { model } : {}) };
  if (sessionId === 'analyst:global') return { id: sessionId, role: 'analyst', card_id: null, ...common };
  if (isPlannerSessionId(sessionId)) return { id: sessionId, role: 'planner', card_id: cardId, ...common };
  if (isReviewerSessionId(sessionId)) return { id: sessionId, role: 'reviewer', card_id: cardId, ...common };
  if (isExecutorSessionId(sessionId)) return { id: sessionId, role: 'executor', card_id: cardId, ...common };
  throw new Error(`Unreachable conversation session '${sessionId}'.`);
}

function isPlannerSessionId(sessionId: ConversationSessionId): sessionId is PlannerConversationSessionId { return sessionId.startsWith('planner:'); }
function isReviewerSessionId(sessionId: ConversationSessionId): sessionId is ReviewerConversationSessionId { return sessionId.startsWith('reviewer:'); }
function isExecutorSessionId(sessionId: ConversationSessionId): sessionId is ExecutorConversationSessionId { return sessionId.startsWith('executor:'); }

function stripPrivateProjectionMarker(message: AgentMessage): AgentMessage {
  if (!message.provider_projection) return message;
  const result = { ...message };
  delete result.provider_projection;
  return result;
}
