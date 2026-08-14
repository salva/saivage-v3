import { readLatestProviderExchangePayload } from '../../persistence/provider-exchange-log.js';
import {
  AgentOperatorReadModelService,
  AgentCurrentStateUnavailableError,
  AgentSessionNotFoundError,
  CardAgentScopeNotFoundError,
} from '../../application/read-models/agent-operator-read-model.js';
import type { OperatorProjectContext } from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';
import type { ProviderExchangePayload } from '../../contracts/provider-exchange.js';
import type { OperatorApiSuccess } from '../../contracts/index.js';
import { redactForOutbound } from '../../redaction/index.js';
import type { CompiledRuntimeWorkflows } from '../../runtime/card-process/card-process-config.js';
import { ConversationCursorNotFoundError, ConversationHistoricalVersionNotFoundError, ConversationHistoricalVersionUnavailableError, ConversationSegmentChangedError } from '../../persistence/conversation-file.js';
import { throwIfPublicationOutcomeUnknown } from '../../contracts/index.js';
import { historicalUnavailableStatus } from '../../application/read-models/historical-unavailable-status.js';

type AgentOperatorHandlerOptions = OperatorProjectContext & { workflows: CompiledRuntimeWorkflows };

export function buildAgentOperatorContractHandlers(options: AgentOperatorHandlerOptions) {
  const { projectRoot } = options;
  const agentReadModel = (): AgentOperatorReadModelService => {
    return new AgentOperatorReadModelService(projectRoot, options.workflows);
  };

  return defineOperatorContractHandlers({
    'agents.list': () => ({ body: agentReadModel().listSessions() }),
    'agents.detail': ({ params }) => {
      try {
        return { body: agentReadModel().getSession(params.id) };
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (error instanceof AgentSessionNotFoundError)
          return { statusCode: 404, body: { error: 'Agent session not found' } };
        if (error instanceof ConversationHistoricalVersionNotFoundError) return { statusCode: 404, body: { error: 'Agent session not found' } };
        throw error;
      }
    },
    'agents.cardSessions': ({ params }) => {
      try {
        return { body: agentReadModel().listCardSessions(params.id) };
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (error instanceof CardAgentScopeNotFoundError)
          return { statusCode: 404, body: { error: 'Card not found', cardId: params.id } };
        throw error;
      }
    },
    'agents.conversation': ({ params, query }) => {
      try {
        return { body: agentReadModel().getConversation(params.id, query) };
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (error instanceof ConversationCursorNotFoundError)
          return {
            statusCode: 400,
            body: {
              error: 'conversation_cursor_not_found', session_id: params.id, segment_version: query.segment_version!, since: query.since!,
            },
          };
        if (error instanceof AgentSessionNotFoundError)
          return { statusCode: 404, body: { error: 'Agent session not found' } };
        if (error instanceof ConversationSegmentChangedError) return { statusCode: 409, body: { error: 'conversation_segment_changed', session_id: params.id, requested_segment_version: error.requestedVersion, current_segment_version: error.currentVersion } };
        if (error instanceof AgentCurrentStateUnavailableError) return { statusCode: 503, body: { error: 'current_state_unavailable', resource: error.resource, owner_id: error.ownerId, restart_required: true } };
        throw error;
      }
    },
    'agents.conversationVersions.list': ({ params }) => { try { return { body: agentReadModel().listConversationVersions(params.id) }; } catch (error) { if (error instanceof AgentSessionNotFoundError) return { statusCode: 404, body: { error: 'Agent session not found' } }; if (error instanceof AgentCurrentStateUnavailableError) return { statusCode: 503, body: { error: 'current_state_unavailable', resource: error.resource, owner_id: error.ownerId, restart_required: true } }; throw error; } },
    'agents.conversationVersions.get': ({ params }) => { try { return { body: agentReadModel().getConversationVersion(params.id, params.version) }; } catch (error) { if (error instanceof AgentSessionNotFoundError) return { statusCode: 404, body: { error: 'Agent session not found' } }; if (error instanceof ConversationHistoricalVersionNotFoundError) return { statusCode: 404, body: { error: 'historical_version_not_found', resource: 'conversation', owner_id: params.id, version: params.version } }; if (error instanceof ConversationHistoricalVersionUnavailableError) return { statusCode: historicalUnavailableStatus(error.reason), body: { error: 'historical_version_content_unavailable', resource: 'conversation', owner_id: params.id, version: params.version, reason: error.reason } }; if (error instanceof AgentCurrentStateUnavailableError) return { statusCode: 503, body: { error: 'current_state_unavailable', resource: error.resource, owner_id: error.ownerId, restart_required: true } }; throw error; } },
    'agents.llmExchange': async ({ params }) => {
      const sessionId = params.id;
      try {
        const catalog = agentReadModel().admitConversationCatalog(sessionId);
        if (catalog.currentVersion === null) return { statusCode: 404, body: { error: 'No LLM exchange recorded for this session yet.' } };
      } catch (error) {
        if (error instanceof AgentSessionNotFoundError) return { statusCode: 404, body: { error: 'Agent session not found' } };
        if (error instanceof AgentCurrentStateUnavailableError) return { statusCode: 503, body: { error: 'current_state_unavailable', resource: error.resource, owner_id: error.ownerId, restart_required: true } };
        throw error;
      }
      let exchange;
      try {
        exchange = readLatestProviderExchangePayload(projectRoot, sessionId);
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        return { statusCode: 503, body: { error: 'current_state_unavailable', resource: 'provider_exchange_log', owner_id: sessionId, restart_required: true } };
      }
      if (!exchange)
        return {
          statusCode: 404,
          body: { error: 'No LLM exchange recorded for this session yet.' },
        };
      return { body: { session_id: sessionId, exchange: projectProviderExchangeForOperator(exchange) } };
    },
  });
}

function projectProviderExchangeForOperator(
  exchange: ProviderExchangePayload,
): OperatorApiSuccess<'agents.llmExchange'>['exchange'] {
  return redactForOutbound({ source: 'provider-exchange', value: exchange });
}
