import {
  AgentConversationResponseSchema,
  AgentDetailResponseSchema,
  AgentListResponseSchema,
  AgentSessionSummarySchema,
  CardAgentSessionsResponseSchema,
  ConversationVersionContentResponseSchema,
  ConversationVersionListResponseSchema,
  type AgentSessionSummary,
} from '../../contracts/operator-api-agents.js';
import { ConversationCursorNotFoundError, ConversationHistoricalVersionNotFoundError, ConversationHistoricalVersionUnavailableError, ConversationSegmentChangedError, foldConversation, readConversationCatalog, readHistoricalConversationSegment, segmentContext } from '../../persistence/conversation-file.js';
import { listCards, readCard, readCurrentCardArtifact } from '../../persistence/card-files.js';
import {
  cardAgentSessionId,
  conversationSessionIdentity,
  globalAgentSessionId,
  type ConversationSessionId,
} from '../../schemas/index.js';
import type { CardId } from '../../schemas/card-id.js';
import type { CompiledProjectWorkflows } from '../../runtime/card-process/card-process-config.js';
import { throwIfPublicationOutcomeUnknown } from '../../contracts/index.js';

export class AgentSessionNotFoundError extends Error {}
export class CardAgentScopeNotFoundError extends Error {}
export class AgentCurrentStateUnavailableError extends Error {
  constructor(readonly resource: 'card' | 'conversation', readonly ownerId: string, options?: ErrorOptions) {
    super(`Current ${resource} state for '${ownerId}' is unavailable.`, options);
  }
}

export class AgentOperatorReadModelService {
  constructor(
    private readonly projectRoot: string,
    private readonly workflows: CompiledProjectWorkflows,
    private readonly captureExecutingLlmSessionIds: () => ReadonlySet<ConversationSessionId>,
  ) {}

  listSessions() {
    const liveSessionIds = this.captureExecutingLlmSessionIds();
    const candidates: ConversationSessionId[] = [globalAgentSessionId(this.workflows.analyst.name)];
    for (const card of listCards(this.projectRoot))
      candidates.push(...this.cardCandidates(card.id, card.type));
    return AgentListResponseSchema.parse({ sessions: this.summaries(candidates, liveSessionIds) });
  }

  listCardSessions(cardId: CardId) {
    const liveSessionIds = this.captureExecutingLlmSessionIds();
    const card = readCard(this.projectRoot, cardId);
    if (!card) throw new CardAgentScopeNotFoundError(`Card '${cardId}' not found.`);
    return CardAgentSessionsResponseSchema.parse({
      card_id: cardId,
      sessions: this.summaries(this.cardCandidates(cardId, card.type), liveSessionIds),
    });
  }

  getSession(sessionId: ConversationSessionId) {
    const liveSessionIds = this.captureExecutingLlmSessionIds();
    this.admitSession(sessionId);
    const summary = this.summary(sessionId, liveSessionIds);
    if (!summary) throw new AgentSessionNotFoundError(`Agent session '${sessionId}' not found.`);
    return AgentDetailResponseSchema.parse({ session: summary });
  }

  getConversation(sessionId: ConversationSessionId, query: { segment_version?: number; since?: string } = {}) {
    this.admitSession(sessionId);
    try {
      const conversation = foldConversation(this.projectRoot, sessionId, { segmentVersion: query.segment_version, since: query.since });
      return AgentConversationResponseSchema.parse({
        session_id: conversation.sessionId,
        segment_version: conversation.segmentVersion,
        segment_context: conversation.segmentContext,
        entries: conversation.entries,
        cursor: { segment_version: conversation.segmentVersion, message_id: conversation.cursor },
      });
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      if (error instanceof ConversationHistoricalVersionNotFoundError)
        throw new AgentSessionNotFoundError(`Agent session '${sessionId}' not found.`);
      if (error instanceof ConversationSegmentChangedError || error instanceof ConversationCursorNotFoundError) throw error;
      throw new AgentCurrentStateUnavailableError('conversation', sessionId, { cause: error });
    }
  }
  admitConversationCatalog(sessionId: ConversationSessionId) {
    const ownership = this.admitSession(sessionId);
    try { return Object.freeze({ ...readConversationCatalog(this.projectRoot, sessionId), ownership }); }
    catch (error) { throw new AgentCurrentStateUnavailableError('conversation', sessionId, { cause: error }); }
  }

  listConversationVersions(sessionId: ConversationSessionId) { const catalog = this.admitConversationCatalog(sessionId); const versions = catalog.versions.map((entry) => ({ entry_id: entry.entry_id, version: entry.version, published_at: entry.created_at, genesis_kind: entry.genesis.kind, source_version: entry.genesis.kind === 'compacted' ? entry.genesis.source_version : null })); return ConversationVersionListResponseSchema.parse({ session_id: sessionId, versions, total: versions.length }); }
  getConversationVersion(sessionId: ConversationSessionId, version: number) { this.admitSession(sessionId); let segment; try { segment = readHistoricalConversationSegment(this.projectRoot, sessionId, version); } catch (error) { if (error instanceof ConversationHistoricalVersionNotFoundError || error instanceof ConversationHistoricalVersionUnavailableError) throw error; throw new AgentCurrentStateUnavailableError('conversation', sessionId, { cause: error }); } return ConversationVersionContentResponseSchema.parse({ session_id: sessionId, version, entry_id: segment.entry.entry_id, published_at: segment.entry.created_at, segment_context: segmentContext(segment.genesis), entries: foldVisible(segment.rows) }); }

  readCurrentSegmentTail(sessionId: ConversationSessionId, lastN: number) {
    const liveSessionIds = this.captureExecutingLlmSessionIds();
    const catalog = this.admitConversationCatalog(sessionId);
    const identity = conversationSessionIdentity(sessionId);
    const ownership = catalog.ownership;
    const live = liveSessionIds.has(sessionId);
    const session = AgentSessionSummarySchema.parse({ id: sessionId, agent_name: identity.agentName, session_scope: identity.cardId === null ? 'global' : 'card', card_id: identity.cardId, started_at: catalog.createdAt, status: live ? 'active' : 'inactive', activity: live ? 'busy' : 'idle' });
    if (catalog.currentVersion === null) return { kind: 'empty' as const, ownership, session };
    try { return { kind: 'populated' as const, ownership, session, conversation: foldConversation(this.projectRoot, sessionId, { lastN }) }; }
    catch (error) { throwIfPublicationOutcomeUnknown(error); throw new AgentCurrentStateUnavailableError('conversation', sessionId, { cause: error }); }
  }

  private cardCandidates(
    cardId: CardId,
    type: Parameters<CompiledProjectWorkflows['cardTypes']['get']>[0],
  ): ConversationSessionId[] {
    const workflow = this.workflows.cardTypes.get(type);
    if (!workflow) throw new Error(`No compiled workflow for '${type}'.`);
    const names = [...new Set([...workflow.states.values()].flatMap((state) => state.kind==='node'?[state.agent.name]:[]))].sort();
    return names.map((name) => cardAgentSessionId(name, cardId));
  }

  private admitSession(sessionId: ConversationSessionId): 'active' | 'retained_tombstone' {
    const identity = conversationSessionIdentity(sessionId);
    if (identity.cardId === null) {
      if (sessionId !== globalAgentSessionId(this.workflows.analyst.name) || this.workflows.analyst.session !== 'global') throw new AgentSessionNotFoundError(`Agent session '${sessionId}' not found.`);
      return 'active';
    }
    let cardResult;
    try { cardResult = readCurrentCardArtifact(this.projectRoot, identity.cardId); }
    catch (error) { throw new AgentCurrentStateUnavailableError('card', identity.cardId, { cause: error }); }
    if (cardResult.kind === 'card-not-found') throw new AgentSessionNotFoundError(`Agent session '${sessionId}' not found.`);
    const card = cardResult.value.kind === 'card-version' ? cardResult.value.card : cardResult.value.final_card;
    const workflow = this.workflows.cardTypes.get(card.type); if (!workflow) throw new Error(`No compiled workflow for '${card.type}'.`);
    const configured = [...workflow.states.values()].some((state) => state.kind === 'node' && state.agent.session === 'card' && state.agent.name === identity.agentName);
    if (!configured) throw new AgentSessionNotFoundError(`Agent session '${sessionId}' not found.`);
    return cardResult.value.kind === 'card-tombstone' ? 'retained_tombstone' : 'active';
  }

  private summaries(candidates: readonly ConversationSessionId[], liveSessionIds: ReadonlySet<ConversationSessionId>): AgentSessionSummary[] {
    if (new Set(candidates).size !== candidates.length)
      throw new Error('Agent session candidate identities must be unique.');
    return candidates
      .flatMap((id) => { const summary = this.summary(id, liveSessionIds); return summary ? [summary] : []; })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private summary(sessionId: ConversationSessionId, liveSessionIds: ReadonlySet<ConversationSessionId>): AgentSessionSummary | null {
    this.admitSession(sessionId);
    const source = this.admitConversationCatalog(sessionId); if (source.currentVersion === null) return null;
    const identity = conversationSessionIdentity(sessionId);
    const live = liveSessionIds.has(sessionId);
    return AgentSessionSummarySchema.parse({
      id: sessionId,
      agent_name: identity.agentName,
      session_scope: identity.cardId === null ? 'global' : 'card',
      card_id: identity.cardId,
      started_at: source.createdAt,
      status: live ? 'active' : 'inactive',
      activity: live ? 'busy' : 'idle',
    });
  }
}

function foldVisible(rows: readonly import('../../schemas/index.js').AgentMessage[]) { return rows.filter((row) => row.kind !== 'provider_private').map((row) => { const clean = { ...row }; delete clean.provider_projection; return clean; }); }
