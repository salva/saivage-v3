import { readLatestProviderExchangePayload } from '../../persistence/provider-exchange-log.js';
import { AgentOperatorReadModelService, isSafeAgentSessionId } from '../../application/read-models/index.js';
import type {
  OperatorContractHandlerMap,
  OperatorProjectContext,
} from './operator-handler-context.js';
import type { CardStore } from '../../cards/store-api.js';

type AgentOperatorHandlerOptions = OperatorProjectContext & { cardStore?: CardStore };

export function buildAgentOperatorContractHandlers(options: AgentOperatorHandlerOptions): OperatorContractHandlerMap {
  const { projectRoot } = options;
  const agentReadModel = new AgentOperatorReadModelService(projectRoot, options.cardStore);

  return {
    'agents.list': () => ({ body: agentReadModel.listSessions() }),
    'agents.detail': ({ params }) => agentReadModel.getSession((params as unknown as { id: string }).id),
    'agents.conversation': ({ params }) => agentReadModel.getConversation((params as unknown as { id: string }).id),
    'agents.llmExchange': async ({ params, request }) => {
      const sessionId = (params as unknown as { id: string }).id;
      if (!isSafeAgentSessionId(sessionId)) return { statusCode: 400, body: { error: 'Invalid agent session ID' } };
      try {
        const exchange = readLatestProviderExchangePayload(projectRoot, sessionId);
        if (!exchange) return { statusCode: 404, body: { error: 'No LLM exchange recorded for this session yet.' } };
        return { body: { exchange } };
      } catch (err) {
        request.log.error({ err, sessionId }, 'Failed to read provider exchange record');
        return { statusCode: 500, body: { error: 'Failed to read LLM exchange', message: err instanceof Error ? err.message : String(err) } };
      }
    },
  };
}
