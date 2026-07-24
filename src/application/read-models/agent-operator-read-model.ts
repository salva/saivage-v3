import { readLatestProviderExchangePayload, readLatestProviderExchangePayloadMap } from '../../persistence/provider-exchange-log.js';
import { readConversation, readConversationInventory } from '../../persistence/conversation-file.js';
import {
  conversationSessionIdentity,
  parseConversationSessionId,
  type AgentMessage,
  type ConversationSessionId,
} from '../../schemas/index.js';
import type { ExactWaitBarrier, ExecutingLlmSnapshot } from '../../runtime/actors/executing-llm-snapshot.js';
import type {
  OperatorApiHandlerResult,
  OperatorApiSuccess,
} from '../../contracts/index.js';
import { redactForOutbound } from '../../redaction/index.js';
import type { CompiledProjectWorkflows } from '../../runtime/card-process/card-process-config.js';
import { throwIfPublicationOutcomeUnknown } from '../../contracts/index.js';

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
  constructor(private readonly projectRoot: string, private readonly snapshots: SnapshotProvider,private readonly workflows:CompiledProjectWorkflows) {}

  listSessions(): AgentListResponse {
    const live = captureExecutingLlmSnapshotMap(this.snapshots());
    const inventory = readConversationInventory(this.projectRoot,this.workflows);
    const inventoryIds = new Set(inventory.map(({ sessionId }) => sessionId));
    for (const id of live.keys()) if (!inventoryIds.has(id)) throw new Error(`Executing agent snapshot '${id}' has no aggregate conversation row.`);
    if (inventory.length === 0) return { sessions: [] };
    const latestBySession = readLatestProviderExchangePayloadMap(this.projectRoot);
    const sessions = inventory.map(({ sessionId, conversation }) => this.project(
      sessionId,
      conversation.physicalRows,
      latestBySession.get(sessionId)?.model ?? null,
      live.get(sessionId),
    ).session);
    sessions.sort((a, b) => b.started_at.localeCompare(a.started_at) || a.id.localeCompare(b.id));
    return { sessions };
  }

  getSession(sessionId: string): AgentDetailReadModelResult {
    const live = captureExecutingLlmSnapshotMap(this.snapshots());
    const parsed = this.parse(sessionId);
    if (!parsed) return { statusCode: 400, body: { error: 'Invalid agent session ID' } };
    let messages: AgentMessage[];
    try { messages = readConversation(this.projectRoot, parsed).physicalRows; }
    catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { statusCode: 404, body: { error: 'Agent session not found' } };
      throw error;
    }
    const projected = this.project(parsed, messages, readLatestProviderExchangePayload(this.projectRoot, parsed)?.model ?? null, live.get(parsed));
    return { body: { session: { ...projected.session, message_count: messages.length, last_activity_at: this.lastTimestamp(messages) ?? projected.session.started_at } } };
  }

  getConversation(sessionId: string): AgentConversationReadModelResult {
    const live = captureExecutingLlmSnapshotMap(this.snapshots());
    const parsed = this.parse(sessionId);
    if (!parsed) return { statusCode: 400, body: { error: 'Invalid agent session ID' } };
    let messages: AgentMessage[];
    try { messages = readConversation(this.projectRoot, parsed).physicalRows; }
    catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { statusCode: 404, body: { error: 'Agent session not found' } };
      throw error;
    }
    return { body: this.project(parsed, messages, readLatestProviderExchangePayload(this.projectRoot, parsed)?.model ?? null, live.get(parsed)) };
  }

  private project(sessionId: ConversationSessionId, messages: AgentMessage[], model: string | null, snapshot: ExecutingLlmSnapshot | undefined): AgentOperatorConversationResponse {
    return redactForOutbound({ source: 'agent-conversation', value: { sessionId, messages, model, snapshot } });
  }

  private parse(value: string): ConversationSessionId | null { try { return parseConversationSessionId(value); } catch { return null; } }
  private lastTimestamp(messages: AgentMessage[]): string | null { return messages.at(-1)?.timestamp ?? null; }
}

export function captureExecutingLlmSnapshotMap(snapshots: readonly ExecutingLlmSnapshot[]): ReadonlyMap<ConversationSessionId, ExecutingLlmSnapshot> {
  const map = new Map<ConversationSessionId, ExecutingLlmSnapshot>();
  for (const raw of snapshots) {
    const sessionId = parseConversationSessionId(raw.sessionId);
    const identity = conversationSessionIdentity(sessionId);
    if (raw.agentId !== sessionId || raw.agentName !== identity.agentName || raw.cardId !== identity.cardId) throw new Error(`Executing agent snapshot '${raw.sessionId}' has inconsistent identity.`);
    if (map.has(sessionId)) throw new Error(`Conversation session '${sessionId}' has duplicate live ownership.`);
    if (raw.activity.mode === 'active' && raw.activity.barrier !== null) throw new Error(`Active snapshot '${sessionId}' has a wait barrier.`);
    if (raw.activity.mode === 'waiting' && !raw.activity.barrier) throw new Error(`Waiting snapshot '${sessionId}' has no wait barrier.`);
    const activity = raw.activity.mode === 'active' ? Object.freeze({ mode: 'active' as const, barrier: null }) : Object.freeze({ mode: 'waiting' as const, barrier: freezeBarrier(raw.activity.barrier) });
    map.set(sessionId, Object.freeze({ ...raw, sessionId, activity }));
  }
  return map;
}

function freezeBarrier(barrier: ExactWaitBarrier): ExactWaitBarrier { return barrier.kind === 'child' ? Object.freeze({ kind: 'child', relationship: Object.freeze({ ...barrier.relationship }) }) : Object.freeze({ ...barrier }); }
