import type { FastifyInstance } from 'fastify';
import type { ActiveRuntime } from '../../runtime/control-api.js';
import { operatorApiContracts } from '../../contracts/index.js';
import { buildAgentOperatorContractHandlers } from './operator-agent-handlers.js';
import { buildChatOperatorContractHandlers } from './operator-chat-handlers.js';
import { buildFilesDebugOperatorContractHandlers } from './operator-files-debug-handlers.js';
import type {
  OperatorAvailabilityContext,
  OperatorContractHandlerMap,
  OperatorMcpProviderContext,
  OperatorProjectContext,
  OperatorRestartContext,
  OperatorRuntimeProviderContext,
} from './operator-handler-context.js';
import { buildMcpOperatorContractHandlers } from './operator-mcp-handlers.js';
import { buildProcessOperatorContractHandlers } from './operator-process-handlers.js';
import { buildRuntimeCardOperatorContractHandlers } from './operator-runtime-card-handlers.js';
import { ContractRuntime } from '../contract-runtime.js';

interface OperatorContractRouteRegistrationOptions extends
  OperatorProjectContext,
  OperatorMcpProviderContext,
  OperatorAvailabilityContext,
  OperatorRestartContext,
  Partial<OperatorRuntimeProviderContext> {
  fastify: FastifyInstance;
  activeRuntime?: ActiveRuntime;
}

export function registerOperatorContractRoutes(options: OperatorContractRouteRegistrationOptions): void {
  const { fastify, projectRoot } = options;
  const runtime = new ContractRuntime();
  const getActiveRuntime = () => options.activeRuntimeProvider?.() ?? options.activeRuntime;
  const handlers: OperatorContractHandlerMap = {
    ...buildRuntimeCardOperatorContractHandlers({ projectRoot, activeRuntimeProvider: getActiveRuntime, serverAvailabilityProvider: options.serverAvailabilityProvider }),
    ...buildMcpOperatorContractHandlers({ mcpStatusProvider: options.mcpStatusProvider, mcpToolsProvider: options.mcpToolsProvider, serverAvailabilityProvider: options.serverAvailabilityProvider }),
    ...buildAgentOperatorContractHandlers({ projectRoot, activeRuntime: getActiveRuntime() }),
    ...buildChatOperatorContractHandlers({ projectRoot, activeRuntimeProvider: getActiveRuntime, requestServerRestart: options.requestServerRestart }),
    ...buildFilesDebugOperatorContractHandlers({ projectRoot }),
    ...buildProcessOperatorContractHandlers({ projectRoot }),
  };

  runtime.mount(fastify, operatorApiContracts, handlers);
}
