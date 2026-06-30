import { readLatestLlmExchange, LlmExchangeCorruptedError } from '../../agents/session-api.js';
import { AgentOperatorReadModelService, isSafeAgentSessionId } from '../../application/read-models/index.js';
import type {
  OperatorContractHandlerMap,
  OperatorProjectContext,
  OperatorStaticRuntimeContext,
} from './operator-handler-context.js';

function saivageDir(projectRoot: string): string { return `${projectRoot}/.saivage`; }

type AgentOperatorHandlerOptions = OperatorProjectContext & OperatorStaticRuntimeContext;

export function buildAgentOperatorContractHandlers(options: AgentOperatorHandlerOptions): OperatorContractHandlerMap {
  const { projectRoot } = options;
  const agentReadModel = new AgentOperatorReadModelService(projectRoot);

  return {
    'agents.list': () => ({ body: agentReadModel.listSessions() }),
    'agents.detail': ({ params }) => agentReadModel.getSession((params as unknown as { id: string }).id),
    'agents.conversation': ({ params }) => agentReadModel.getConversation((params as unknown as { id: string }).id),
    'agents.llmExchange': async ({ params, request }) => {
      const sessionId = (params as unknown as { id: string }).id;
      if (!isSafeAgentSessionId(sessionId)) return { statusCode: 400, body: { error: 'Invalid agent session ID' } };
      try {
        const exchange = await readLatestLlmExchange(saivageDir(projectRoot), sessionId);
        if (!exchange) return { statusCode: 404, body: { error: 'No LLM exchange recorded for this session yet.' } };
        return { body: { exchange } };
      } catch (err) {
        if (err instanceof LlmExchangeCorruptedError) {
          request.log.error({ err, sessionId, cause: err.cause }, 'Corrupted LLM exchange record');
          return { statusCode: 500, body: { error: 'Corrupted LLM exchange record.' } };
        }
        return { statusCode: 500, body: { error: 'Failed to read LLM exchange', message: err instanceof Error ? err.message : String(err) } };
      }
    },
  };
}
