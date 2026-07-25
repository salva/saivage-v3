import {
  AgentConversationResponseSchema,
  AgentDetailResponseSchema,
  AgentListResponseSchema,
  AgentSessionSummarySchema,
  CardAgentSessionsResponseSchema,
  type AgentSessionSummary,
} from '../../contracts/operator-api-agents.js';
import { foldConversation, readConversationSummary } from '../../persistence/conversation-file.js';
import { listCards, readCard } from '../../persistence/card-files.js';
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

export class AgentOperatorReadModelService {
  constructor(
    private readonly projectRoot: string,
    private readonly workflows: CompiledProjectWorkflows,
  ) {}

  listSessions() {
    const candidates: ConversationSessionId[] = [globalAgentSessionId(this.workflows.analyst.name)];
    for (const card of listCards(this.projectRoot))
      candidates.push(...this.cardCandidates(card.id, card.type));
    return AgentListResponseSchema.parse({ sessions: this.summaries(candidates) });
  }

  listCardSessions(cardId: CardId) {
    const card = readCard(this.projectRoot, cardId);
    if (!card) throw new CardAgentScopeNotFoundError(`Card '${cardId}' not found.`);
    return CardAgentSessionsResponseSchema.parse({
      card_id: cardId,
      sessions: this.summaries(this.cardCandidates(cardId, card.type)),
    });
  }

  getSession(sessionId: ConversationSessionId) {
    const summary = this.summary(sessionId);
    if (!summary) throw new AgentSessionNotFoundError(`Agent session '${sessionId}' not found.`);
    return AgentDetailResponseSchema.parse({ session: summary });
  }

  getConversation(sessionId: ConversationSessionId, since?: string) {
    try {
      const conversation = foldConversation(this.projectRoot, sessionId, { since });
      return AgentConversationResponseSchema.parse({
        session_id: conversation.sessionId,
        entries: conversation.entries,
        cursor: conversation.cursor,
      });
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AgentSessionNotFoundError(`Agent session '${sessionId}' not found.`);
      throw error;
    }
  }

  readBoundedConversation(sessionId: ConversationSessionId, lastN: number) {
    try {
      return foldConversation(this.projectRoot, sessionId, { lastN });
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new AgentSessionNotFoundError(`Agent session '${sessionId}' not found.`);
      throw error;
    }
  }

  private cardCandidates(
    cardId: CardId,
    type: Parameters<CompiledProjectWorkflows['cardTypes']['get']>[0],
  ): ConversationSessionId[] {
    const workflow = this.workflows.cardTypes.get(type);
    if (!workflow) throw new Error(`No compiled workflow for '${type}'.`);
    const names = [...new Set([...workflow.nodes.values()].map((node) => node.agent.name))].sort();
    return names.map((name) => cardAgentSessionId(name, cardId));
  }

  private summaries(candidates: readonly ConversationSessionId[]): AgentSessionSummary[] {
    if (new Set(candidates).size !== candidates.length)
      throw new Error('Agent session candidate identities must be unique.');
    return candidates
      .flatMap((id) => {
        const summary = this.summary(id);
        return summary ? [summary] : [];
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private summary(sessionId: ConversationSessionId): AgentSessionSummary | null {
    let source;
    try {
      source = readConversationSummary(this.projectRoot, sessionId);
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const identity = conversationSessionIdentity(sessionId);
    return AgentSessionSummarySchema.parse({
      id: sessionId,
      agent_name: identity.agentName,
      session_scope: identity.cardId === null ? 'global' : 'card',
      card_id: identity.cardId,
      started_at: source.startedAt,
    });
  }
}
