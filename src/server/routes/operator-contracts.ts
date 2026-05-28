import type { FastifyInstance } from 'fastify';
import type { ActiveRuntime } from '../../runtime/control-api.js';
import { operatorApiContracts } from '../../contracts/index.js';
import type { McpStatusProvider, McpToolsReadModelProvider } from '../../mcp/manager-api.js';
import { buildServerAvailability } from '../availability.js';
import { buildAgentOperatorContractHandlers } from './operator-agent-handlers.js';
import { buildChatOperatorContractHandlers } from './operator-chat-handlers.js';
import { buildFilesDebugOperatorContractHandlers } from './operator-files-debug-handlers.js';
import { buildMcpOperatorContractHandlers } from './operator-mcp-handlers.js';
import { buildRuntimeCardOperatorContractHandlers } from './operator-runtime-card-handlers.js';
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
  const getActiveRuntime = () => options.activeRuntimeProvider?.() ?? options.activeRuntime;
  const handlers: Partial<Record<keyof typeof operatorApiContracts, ContractHandler>> = {
    ...buildRuntimeCardOperatorContractHandlers({ projectRoot, activeRuntimeProvider: getActiveRuntime, serverAvailabilityProvider: options.serverAvailabilityProvider }),
    ...buildMcpOperatorContractHandlers({ mcpStatusProvider: options.mcpStatusProvider, mcpToolsProvider: options.mcpToolsProvider, serverAvailabilityProvider: options.serverAvailabilityProvider }),
    ...buildAgentOperatorContractHandlers({ projectRoot, activeRuntime: getActiveRuntime() }),
    ...buildChatOperatorContractHandlers({ projectRoot, activeRuntimeProvider: getActiveRuntime, requestServerRestart: options.requestServerRestart }),
    ...buildFilesDebugOperatorContractHandlers({ projectRoot }),
  };

  runtime.mount(fastify, operatorApiContracts, handlers);
}
