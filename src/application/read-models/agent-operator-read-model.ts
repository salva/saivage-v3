import { readLatestProviderExchangePayload } from '../../persistence/provider-exchange-log.js';
import { probeConversation, readConversation, readConversationInventory } from '../../persistence/conversation-file.js';
import {
  conversationSessionIdentity,
  parseConversationSessionId,
  type AgentMessage,
  type ConversationSessionId,
  type ExecutorConversationSessionId,
  type PlannerConversationSessionId,
  type ReviewerConversationSessionId,
} from '../../schemas/index.js';
import type { ExactWaitBarrier, ExecutingLlmSnapshot } from '../../runtime/actors/executing-llm-snapshot.js';
import { inspectConversationCallPairs } from '../../runtime/actors/conversation-call-pairs.js';
import type {
  OperatorApiHandlerResult,
  OperatorApiSuccess,
} from '../../contracts/index.js';

type AgentListResponse = OperatorApiSuccess<'agents.list'>;
type AgentActivityStatus = OperatorApiSuccess<'agents.conversation'>['activity_status'];
export type ListedAgentStatus = AgentActivityStatus['status'];
export type AgentOperatorSessionSummary = AgentListResponse['sessions'][number];
export type AgentOperatorConversationResponse = OperatorApiSuccess<'agents.conversation'>;
type SuccessResult<K extends 'agents.detail' | 'agents.conversation'> = {
  statusCode?: 200;
  body: OperatorApiSuccess<K>;
};
type AgentDetailReadModelResult = SuccessResult<'agents.detail'> | Extract<OperatorApiHandlerResult<'agents.detail'>, { statusCode: 400 | 404 }>;
type AgentConversationReadModelResult = SuccessResult<'agents.conversation'> | Extract<OperatorApiHandlerResult<'agents.conversation'>, { statusCode: 400 | 404 }>;

type SnapshotProvider = () => readonly ExecutingLlmSnapshot[];

export class AgentOperatorReadModelService {
  constructor(private readonly projectRoot: string, private readonly snapshots: SnapshotProvider) {}

  listSessions(): AgentListResponse {
    const live = captureExecutingLlmSnapshotMap(this.snapshots());
    const sessions = readConversationInventory(this.projectRoot).map(({ sessionId, conversation }) => this.project(sessionId, conversation.physicalRows, live.get(sessionId)).session);
    for (const id of live.keys()) if (!sessions.some((session) => session.id === id)) throw new Error(`Executing agent snapshot '${id}' has no aggregate conversation row.`);
    sessions.sort((a, b) => b.started_at.localeCompare(a.started_at) || a.id.localeCompare(b.id));
    return { sessions };
  }

  getSession(sessionId: string): AgentDetailReadModelResult {
    const live = captureExecutingLlmSnapshotMap(this.snapshots());
    const parsed = this.parse(sessionId);
    if (!parsed) return { statusCode: 400, body: { error: 'Invalid agent session ID' } };
    if (!probeConversation(this.projectRoot, parsed)) return { statusCode: 404, body: { error: 'Agent session not found' } };
    const messages = readConversation(this.projectRoot, parsed).physicalRows;
    const projected = this.project(parsed, messages, live.get(parsed));
    return { body: { session: { ...projected.session, message_count: messages.length, last_activity_at: this.lastTimestamp(messages) ?? projected.session.started_at } } };
  }

  getConversation(sessionId: string): AgentConversationReadModelResult {
    const live = captureExecutingLlmSnapshotMap(this.snapshots());
    const parsed = this.parse(sessionId);
    if (!parsed) return { statusCode: 400, body: { error: 'Invalid agent session ID' } };
    if (!probeConversation(this.projectRoot, parsed)) return { statusCode: 404, body: { error: 'Agent session not found' } };
    return { body: this.project(parsed, readConversation(this.projectRoot, parsed).physicalRows, live.get(parsed)) };
  }

  private project(sessionId: ConversationSessionId, messages: AgentMessage[], snapshot: ExecutingLlmSnapshot | undefined): AgentOperatorConversationResponse {
    const model = readLatestProviderExchangePayload(this.projectRoot, sessionId)?.model ?? null;
    return projectAgentConversation({ sessionId, messages, model, snapshot });
  }

  private parse(value: string): ConversationSessionId | null { try { return parseConversationSessionId(value); } catch { return null; } }
  private lastTimestamp(messages: AgentMessage[]): string | null { return messages.at(-1)?.timestamp ?? null; }
}

export function captureExecutingLlmSnapshotMap(snapshots: readonly ExecutingLlmSnapshot[]): ReadonlyMap<ConversationSessionId, ExecutingLlmSnapshot> {
  const map = new Map<ConversationSessionId, ExecutingLlmSnapshot>();
  for (const raw of snapshots) {
    const sessionId = parseConversationSessionId(raw.sessionId);
    const identity = conversationSessionIdentity(sessionId);
    if (raw.agentId !== sessionId || raw.role !== identity.role || raw.cardId !== identity.cardId) throw new Error(`Executing agent snapshot '${raw.sessionId}' has inconsistent identity.`);
    if (map.has(sessionId)) throw new Error(`Conversation session '${sessionId}' has duplicate live ownership.`);
    if (raw.activity.mode === 'active' && raw.activity.barrier !== null) throw new Error(`Active snapshot '${sessionId}' has a wait barrier.`);
    if (raw.activity.mode === 'waiting' && !raw.activity.barrier) throw new Error(`Waiting snapshot '${sessionId}' has no wait barrier.`);
    const activity = raw.activity.mode === 'active' ? Object.freeze({ mode: 'active' as const, barrier: null }) : Object.freeze({ mode: 'waiting' as const, barrier: freezeBarrier(raw.activity.barrier) });
    map.set(sessionId, Object.freeze({ ...raw, sessionId, activity }));
  }
  return immutableReadonlyMap(map);
}

export function projectAgentConversation(input: { sessionId: ConversationSessionId; messages: AgentMessage[]; model: string | null; snapshot?: ExecutingLlmSnapshot }): AgentOperatorConversationResponse {
  const { sessionId, messages, snapshot } = input;
  const identity = conversationSessionIdentity(sessionId);
  const status: ListedAgentStatus = snapshot?.activity.mode ?? 'inactive';
  const pending_calls: AgentActivityStatus['pending_calls'] = [];
  if (snapshot?.activity.mode === 'waiting') {
    const barrierIdentity = barrierToolIdentity(snapshot.activity.barrier);
    if (barrierIdentity.sessionId !== sessionId) throw new Error(`Wait barrier session '${barrierIdentity.sessionId}' does not match '${sessionId}'.`);
    const call = inspectConversationCallPairs(messages);
    if (!call) throw new Error(`Waiting session '${sessionId}' has no unmatched canonical tool call.`);
    if (call.sessionId !== barrierIdentity.sessionId || call.sourceInputId !== barrierIdentity.sourceInputId || call.toolCallId !== barrierIdentity.toolCallId || call.toolName !== barrierIdentity.toolName) throw new Error(`Waiting session '${sessionId}' tool call does not match its exact barrier.`);
    if (snapshot.activity.barrier.kind === 'process') {
      if (call.toolName !== 'run_command' && call.toolName !== 'wait_process') throw new Error(`Tool '${call.toolName}' cannot own a process wait barrier.`);
      if (call.toolName === 'wait_process' && (call.args as { process_id?: unknown }).process_id !== snapshot.activity.barrier.processId) throw new Error(`Waiting process call does not match process '${snapshot.activity.barrier.processId}'.`);
    }
    if (snapshot.activity.barrier.kind === 'child') {
      if (call.toolName !== 'activate_card') throw new Error(`Tool '${call.toolName}' cannot own a child wait barrier.`);
      if ((call.args as { card_id?: unknown }).card_id !== snapshot.activity.barrier.relationship.childCardId) throw new Error(`Waiting child call does not match child '${snapshot.activity.barrier.relationship.childCardId}'.`);
    }
    pending_calls.push({ id: call.toolCallId, tool: call.toolName, started_at: call.startedAt });
  }
  const session = projectSessionSummary(sessionId, identity.cardId, status, messages[0]!.timestamp, input.model);
  return { session, entries: messages.filter((message) => message.kind !== 'provider_private').map(stripPrivateProjectionMarker), activity_status: { status, pending_calls } };
}

function projectSessionSummary(
  sessionId: ConversationSessionId,
  cardId: ReturnType<typeof conversationSessionIdentity>['cardId'],
  status: ListedAgentStatus,
  startedAt: string,
  model: string | null,
): AgentOperatorSessionSummary {
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

function barrierToolIdentity(barrier: ExactWaitBarrier) { return barrier.kind === 'child' ? barrier.relationship : barrier; }
function freezeBarrier(barrier: ExactWaitBarrier): ExactWaitBarrier { return barrier.kind === 'child' ? Object.freeze({ kind: 'child', relationship: Object.freeze({ ...barrier.relationship }) }) : Object.freeze({ ...barrier }); }
function stripPrivateProjectionMarker(message: AgentMessage): AgentMessage { if (!message.provider_projection) return message; const result = { ...message }; delete result.provider_projection; return result; }
function immutableReadonlyMap<K, V>(source: Map<K, V>): ReadonlyMap<K, V> {
  const readonlyMap: ReadonlyMap<K, V> = Object.freeze({
    get size() { return source.size; },
    get: (key: K) => source.get(key),
    has: (key: K) => source.has(key),
    entries: () => source.entries(),
    keys: () => source.keys(),
    values: () => source.values(),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) => source.forEach((value, key) => callback.call(thisArg, value, key, readonlyMap), thisArg),
    [Symbol.iterator]: () => source[Symbol.iterator](),
  } satisfies ReadonlyMap<K, V>);
  return readonlyMap;
}
