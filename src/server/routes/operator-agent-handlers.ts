import { readLatestProviderExchangePayload } from '../../persistence/provider-exchange-log.js';
import { AgentOperatorReadModelService } from '../../application/read-models/index.js';
import type {
  OperatorContractHandlerMap,
  OperatorProjectContext,
} from './operator-handler-context.js';
import type { CardService } from '../../cards/card-api.js';
import { ConversationSessionIdSchema } from '../../schemas/index.js';
import { providerExchangePayloadSchema, type ProviderExchangePayload } from '../../contracts/provider-exchange.js';
import { redactForOutbound } from '../../redaction/index.js';

type AgentOperatorHandlerOptions = OperatorProjectContext & { cardStore?: CardService; runtimeApplication?: import('../../application/runtime-composition.js').RuntimeApplication };

export function buildAgentOperatorContractHandlers(options: AgentOperatorHandlerOptions): OperatorContractHandlerMap {
  const { projectRoot } = options;
  const agentReadModel = (): AgentOperatorReadModelService => {
    if (!options.runtimeApplication) throw new Error('Agent read operations require the runtime application.');
    return new AgentOperatorReadModelService(projectRoot, () => options.runtimeApplication!.captureExecutingLlmSnapshots());
  };

  return {
    'agents.list': () => ({ body: agentReadModel().listSessions() }),
    'agents.detail': ({ params }) => agentReadModel().getSession((params as unknown as { id: string }).id),
    'agents.conversation': ({ params }) => agentReadModel().getConversation((params as unknown as { id: string }).id),
    'agents.llmExchange': async ({ params, request }) => {
      const sessionId = (params as unknown as { id: string }).id;
      const parsedSessionId = ConversationSessionIdSchema.safeParse(sessionId);
      if (!parsedSessionId.success) return { statusCode: 400, body: { error: 'Invalid agent session ID' } };
      try {
        const exchange = readLatestProviderExchangePayload(projectRoot, parsedSessionId.data);
        if (!exchange) return { statusCode: 404, body: { error: 'No LLM exchange recorded for this session yet.' } };
        return { body: { sessionId: parsedSessionId.data, exchange: projectProviderExchangeForOperator(exchange) } };
      } catch {
        request.log.error({ sessionId: parsedSessionId.data, operation: 'agents.llmExchange' }, 'Failed to read LLM exchange');
        return { statusCode: 500, body: { error: 'Failed to read LLM exchange' } };
      }
    },
  };
}

function projectProviderExchangeForOperator(exchange: ProviderExchangePayload): ProviderExchangePayload {
  return providerExchangePayloadSchema.parse(redactForOutbound(exchange, 'operator.api', {
    source: 'agents.llm-exchange',
  }));
}
