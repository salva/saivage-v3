import { readLatestProviderExchangePayload } from '../../persistence/provider-exchange-log.js';
import {
  AgentOperatorReadModelService,
  AgentSessionNotFoundError,
  CardAgentScopeNotFoundError,
} from '../../application/read-models/agent-operator-read-model.js';
import type { OperatorProjectContext } from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';
import type { ProviderExchangePayload } from '../../contracts/provider-exchange.js';
import type { OperatorApiSuccess } from '../../contracts/index.js';
import { redactForOutbound } from '../../redaction/index.js';
import type { CompiledRuntimeWorkflows } from '../../runtime/card-process/card-process-config.js';
import { ConversationCursorNotFoundError } from '../../persistence/conversation-file.js';
import { throwIfPublicationOutcomeUnknown } from '../../contracts/index.js';

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
        return { body: agentReadModel().getConversation(params.id, query.since) };
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (error instanceof ConversationCursorNotFoundError)
          return {
            statusCode: 400,
            body: {
              error: 'ValidationError',
              issues: [{ path: 'since', message: 'Cursor is not present in this conversation.' }],
            },
          };
        if (error instanceof AgentSessionNotFoundError)
          return { statusCode: 404, body: { error: 'Agent session not found' } };
        throw error;
      }
    },
    'agents.llmExchange': async ({ params }) => {
      const sessionId = params.id;
      let exchange;
      try {
        exchange = readLatestProviderExchangePayload(projectRoot, sessionId);
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        throw error;
      }
      if (!exchange)
        return {
          statusCode: 404,
          body: { error: 'No LLM exchange recorded for this session yet.' },
        };
      return { body: { sessionId, exchange: projectProviderExchangeForOperator(exchange) } };
    },
  });
}

function projectProviderExchangeForOperator(
  exchange: ProviderExchangePayload,
): OperatorApiSuccess<'agents.llmExchange'>['exchange'] {
  return redactForOutbound({ source: 'provider-exchange', value: exchange });
}
