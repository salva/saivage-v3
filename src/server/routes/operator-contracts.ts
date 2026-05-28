import type { FastifyInstance } from 'fastify';
import type { ActiveRuntime } from '../../runtime/control-api.js';
import { operatorApiContracts } from '../../contracts/index.js';
import {
  buildCardRunsResponse,
  buildRuntimeStatusReadModel,
  CardsReadModelService,
  DebugReadModelService,
  WorkspaceFileReadModelService,
} from '../../application/read-models/index.js';
import type { McpStatusProvider, McpToolsReadModelProvider } from '../../mcp/manager-api.js';
import { buildServerAvailability } from '../availability.js';
import { buildAgentOperatorContractHandlers } from './operator-agent-handlers.js';
import { buildChatOperatorContractHandlers } from './operator-chat-handlers.js';
import { ContractRuntime, type ContractHandler } from '../contract-runtime.js';

export function registerOperatorContractRoutes(options: {
  fastify: FastifyInstance;
  projectRoot: string;
  activeRuntime?: ActiveRuntime;
  activeRuntimeProvider?: () => ActiveRuntime | undefined;
  mcpStatusProvider?: () => McpStatusProvider | undefined;
  mcpToolsProvider?: () => McpToolsReadModelProvider | undefined;
  serverAvailabilityProvider?: () => ReturnType<typeof buildServerAvailability>;
  requestServerRestart?: () => Promise<void>;
}): void {
  const { fastify, projectRoot } = options;
  const runtime = new ContractRuntime();
  const cardsReadModel = new CardsReadModelService(projectRoot);
  const fileReadModel = new WorkspaceFileReadModelService(projectRoot);
  const debugReadModel = new DebugReadModelService(projectRoot);
  const getActiveRuntime = () => options.activeRuntimeProvider?.() ?? options.activeRuntime;
  const handlers: Partial<Record<keyof typeof operatorApiContracts, ContractHandler>> = {
    'health.liveness': () => ({ body: { status: 'ok', version: '0.1.0', project: 'saivage-v3' } }),
    'health.readiness': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      return { statusCode: 200, body: { status: 'ready', ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'runtime.getState': () => cardsReadModel.getRuntimeState(options.serverAvailabilityProvider?.()),
    'cards.list': () => cardsReadModel.listCards(),
    'cards.get': ({ params }) => cardsReadModel.getCard((params as unknown as { id: string }).id),
    'cards.history.list': ({ params }) => cardsReadModel.listHistory((params as unknown as { id: string }).id),
    'cards.history.get': ({ params }) => {
      const { id, seq } = params as unknown as { id: string; seq: string };
      return cardsReadModel.getHistoryEntry(id, seq);
    },
    'cards.diff': ({ params, query }) => cardsReadModel.diffCard((params as unknown as { id: string }).id, query as unknown as { from?: string; to?: string }),
    'runtime.status': () => ({ body: buildRuntimeStatusReadModel({ projectRoot, activeRuntime: getActiveRuntime(), serverAvailability: options.serverAvailabilityProvider?.() }) }),
    'runtime.cardRuns': () => ({ body: buildCardRunsResponse(projectRoot) }),
    'mcp.status': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      const provider = options.mcpStatusProvider?.();
      return { body: { servers: provider?.getStatus() ?? [], ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'mcp.tools': () => ({ body: options.mcpToolsProvider?.()?.getToolsReadModel() ?? { tools: [], servers: [], invocationStats: {}, serverDetails: [] } }),
    ...buildAgentOperatorContractHandlers({ projectRoot, activeRuntime: getActiveRuntime() }),
    ...buildChatOperatorContractHandlers({ projectRoot, activeRuntimeProvider: getActiveRuntime, requestServerRestart: options.requestServerRestart }),
    'files.list': ({ query }) => fileReadModel.listFiles((query as { path?: string } | undefined)?.path || '.'),
    'files.content': ({ query }) => fileReadModel.readFileContent((query as { path?: string } | undefined)?.path),
    'debug.state': () => ({ body: debugReadModel.getState() }),
    'debug.errors': () => ({ body: debugReadModel.getErrors() }),
    'debug.timeline': () => ({ body: debugReadModel.getTimeline() }),
  };

  runtime.mount(fastify, operatorApiContracts, handlers);
}
