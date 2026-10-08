import { readLatestProviderExchangePayload } from '../../persistence/index.js';
import {
  AgentOperatorReadModelService,
  AgentCurrentStateUnavailableError,
  AgentSessionNotFoundError,
  ConversationImageNotFoundError,
  ConversationImageSegmentChangedError,
  CardAgentScopeNotFoundError,
  ConversationCursorNotFoundError,
  ConversationSegmentChangedError,
  historicalUnavailableStatus,
} from '../../application/index.js';
import type { OperatorProjectContext } from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';
import {
  throwIfPublicationOutcomeUnknown,
  type ProviderExchangePayload,
  type OperatorApiSuccess,
} from '../../contracts/index.js';
import { projectProviderExchange } from '../../agents/execution-api.js';
import type { CompiledRuntimeWorkflows } from '../../runtime/runtime-api.js';
import {
  ConversationHistoricalVersionNotFoundError,
  ConversationHistoricalVersionUnavailableError,
} from '../../persistence/index.js';
import type { ConversationSessionId } from '../../schemas/index.js';
import type { ExecutingLlmSnapshot } from '../../runtime/runtime-api.js';

type AgentOperatorHandlerOptions = OperatorProjectContext & {
  workflows: CompiledRuntimeWorkflows;
  captureExecutingLlmSnapshots: () => ReadonlyMap<ConversationSessionId, ExecutingLlmSnapshot>;
};

export function buildAgentOperatorContractHandlers(options: AgentOperatorHandlerOptions) {
  const { projectRoot } = options;
  const agentReadModel = (): AgentOperatorReadModelService => {
    return new AgentOperatorReadModelService(
      projectRoot,
      options.workflows,
      options.captureExecutingLlmSnapshots,
    );
  };

  return defineOperatorContractHandlers({
    'agents.conversationImage': async ({ params, query, reply }) => {
      try {
        const body = await agentReadModel().getConversationImage(params.id, query);
        reply.header('Content-Type', 'image/png');
        return { body };
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (error instanceof ConversationImageNotFoundError)
          return { statusCode: 404, body: { error: 'conversation_image_not_found' } };
        if (error instanceof ConversationImageSegmentChangedError)
          return { statusCode: 409, body: { error: 'conversation_image_segment_changed' } };
        if (error instanceof AgentSessionNotFoundError)
          return { statusCode: 404, body: { error: 'Agent session not found' } };
        if (error instanceof ConversationHistoricalVersionNotFoundError)
          return {
            statusCode: 404,
            body: {
              error: 'historical_version_not_found',
              resource: 'conversation',
              owner_id: params.id,
              version: query.segment_version,
            },
          };
        if (error instanceof ConversationHistoricalVersionUnavailableError)
          return {
            statusCode: historicalUnavailableStatus(error.reason),
            body: {
              error: 'historical_version_content_unavailable',
              resource: 'conversation',
              owner_id: params.id,
              version: query.segment_version,
              reason: error.reason,
            },
          };
        if (error instanceof AgentCurrentStateUnavailableError)
          return {
            statusCode: 503,
            body: {
              error: 'current_state_unavailable',
              resource: error.resource,
              owner_id: error.ownerId,
              restart_required: true,
            },
          };
        throw error;
      }
    },
    'agents.currentInstructions': ({ params }) => {
      try {
        return { body: agentReadModel().getCurrentInstructions(params.id) };
      } catch (error) {
        if (error instanceof AgentSessionNotFoundError)
          return { statusCode: 404, body: { error: 'Agent session not found' } };
        if (error instanceof AgentCurrentStateUnavailableError)
          return {
            statusCode: 503,
            body: {
              error: 'current_state_unavailable',
              resource: error.resource,
              owner_id: error.ownerId,
              restart_required: true,
            },
          };
        throw error;
      }
    },
    'agents.list': () => ({ body: agentReadModel().listSessions() }),
    'agents.detail': ({ params }) => {
      try {
        return { body: agentReadModel().getSession(params.id) };
      } catch (error) {
        if (error instanceof AgentSessionNotFoundError)
          return { statusCode: 404, body: { error: 'Agent session not found' } };
        if (error instanceof ConversationHistoricalVersionNotFoundError)
          return { statusCode: 404, body: { error: 'Agent session not found' } };
        throw error;
      }
    },
    'agents.cardSessions': ({ params }) => {
      try {
        return { body: agentReadModel().listCardSessions(params.id) };
      } catch (error) {
        if (error instanceof CardAgentScopeNotFoundError)
          return { statusCode: 404, body: { error: 'Card not found', cardId: params.id } };
        throw error;
      }
    },
    'agents.conversation': ({ params, query }) => {
      try {
        return { body: agentReadModel().getConversation(params.id, query) };
      } catch (error) {
        if (error instanceof ConversationCursorNotFoundError)
          return {
            statusCode: 400,
            body: {
              error: 'conversation_cursor_not_found',
              session_id: params.id,
              segment_id: query.segment_id!,
              segment_version: query.segment_version!,
              since: query.since!,
            },
          };
        if (error instanceof AgentSessionNotFoundError)
          return { statusCode: 404, body: { error: 'Agent session not found' } };
        if (error instanceof ConversationSegmentChangedError)
          return {
            statusCode: 409,
            body: {
              error: 'conversation_segment_changed',
              session_id: params.id,
              requested_segment_version: error.requestedVersion,
              current_segment_version: error.currentVersion,
              requested_segment_id: error.requestedId,
              current_segment_id: error.currentId,
            },
          };
        if (error instanceof AgentCurrentStateUnavailableError)
          return {
            statusCode: 503,
            body: {
              error: 'current_state_unavailable',
              resource: error.resource,
              owner_id: error.ownerId,
              restart_required: true,
            },
          };
        throw error;
      }
    },
    'agents.conversationVersions.list': ({ params }) => {
      try {
        return { body: agentReadModel().listConversationVersions(params.id) };
      } catch (error) {
        if (error instanceof AgentSessionNotFoundError)
          return { statusCode: 404, body: { error: 'Agent session not found' } };
        if (error instanceof AgentCurrentStateUnavailableError)
          return {
            statusCode: 503,
            body: {
              error: 'current_state_unavailable',
              resource: error.resource,
              owner_id: error.ownerId,
              restart_required: true,
            },
          };
        throw error;
      }
    },
    'agents.conversationVersions.get': ({ params }) => {
      try {
        return { body: agentReadModel().getConversationVersion(params.id, params.version) };
      } catch (error) {
        if (error instanceof AgentSessionNotFoundError)
          return { statusCode: 404, body: { error: 'Agent session not found' } };
        if (error instanceof ConversationHistoricalVersionNotFoundError)
          return {
            statusCode: 404,
            body: {
              error: 'historical_version_not_found',
              resource: 'conversation',
              owner_id: params.id,
              version: params.version,
            },
          };
        if (error instanceof ConversationHistoricalVersionUnavailableError)
          return {
            statusCode: historicalUnavailableStatus(error.reason),
            body: {
              error: 'historical_version_content_unavailable',
              resource: 'conversation',
              owner_id: params.id,
              version: params.version,
              reason: error.reason,
            },
          };
        if (error instanceof AgentCurrentStateUnavailableError)
          return {
            statusCode: 503,
            body: {
              error: 'current_state_unavailable',
              resource: error.resource,
              owner_id: error.ownerId,
              restart_required: true,
            },
          };
        throw error;
      }
    },
    'agents.llmExchange': async ({ params }) => {
      const sessionId = params.id;
      try {
        const catalog = agentReadModel().admitConversationCatalog(sessionId);
        if (catalog.currentVersion === null)
          return { statusCode: 404, body: { error: 'llm_exchange_not_found' } };
      } catch (error) {
        if (error instanceof AgentSessionNotFoundError)
          return { statusCode: 404, body: { error: 'Agent session not found' } };
        if (error instanceof AgentCurrentStateUnavailableError)
          return {
            statusCode: 503,
            body: {
              error: 'current_state_unavailable',
              resource: error.resource,
              owner_id: error.ownerId,
              restart_required: true,
            },
          };
        throw error;
      }
      let exchange;
      try {
        exchange = readLatestProviderExchangePayload(projectRoot, sessionId);
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        return {
          statusCode: 503,
          body: {
            error: 'current_state_unavailable',
            resource: 'provider_exchange_log',
            owner_id: sessionId,
            restart_required: true,
          },
        };
      }
      if (!exchange)
        return {
          statusCode: 404,
          body: { error: 'llm_exchange_not_found' },
        };
      return {
        body: { session_id: sessionId, exchange: projectProviderExchangeForOperator(exchange) },
      };
    },
  });
}

function projectProviderExchangeForOperator(
  exchange: ProviderExchangePayload,
): OperatorApiSuccess<'agents.llmExchange'>['exchange'] {
  return projectProviderExchange(exchange);
}
