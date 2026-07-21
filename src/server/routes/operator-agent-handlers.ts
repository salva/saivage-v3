import { readLatestProviderExchangePayload } from '../../persistence/provider-exchange-log.js';
import { AgentOperatorReadModelService } from '../../application/read-models/index.js';
import type {
  OperatorProjectContext,
} from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';
import { providerExchangePayloadSchema, type ProviderExchangePayload } from '../../contracts/provider-exchange.js';
import type { OperatorApiSuccess } from '../../contracts/index.js';
import { redactForOutbound } from '../../redaction/index.js';

type AgentOperatorHandlerOptions = OperatorProjectContext & { runtimeApplication?: import('../../application/runtime-composition.js').RuntimeApplication };

export function buildAgentOperatorContractHandlers(options: AgentOperatorHandlerOptions) {
  const { projectRoot } = options;
  const agentReadModel = (): AgentOperatorReadModelService => {
    const runtimeApplication = options.runtimeApplication;
    if (!runtimeApplication) throw new Error('Agent read operations require the runtime application.');
    return new AgentOperatorReadModelService(projectRoot, () => runtimeApplication.captureExecutingLlmSnapshots());
  };

  return defineOperatorContractHandlers({
    'agents.list': () => ({ body: agentReadModel().listSessions() }),
    'agents.detail': ({ params }) => agentReadModel().getSession(params.id),
    'agents.conversation': ({ params }) => agentReadModel().getConversation(params.id),
    'agents.llmExchange': async ({ params }) => {
      const sessionId = params.id;
      const exchange = readLatestProviderExchangePayload(projectRoot, sessionId);
      if (!exchange) return { statusCode: 404, body: { error: 'No LLM exchange recorded for this session yet.' } };
      return { body: { sessionId, exchange: projectProviderExchangeForOperator(exchange) } };
    },
  });
}

function projectProviderExchangeForOperator(exchange: ProviderExchangePayload): OperatorApiSuccess<'agents.llmExchange'>['exchange'] {
  return providerExchangePayloadSchema.parse(redactForOutbound(exchange));
}
