import type { FastifyInstance } from 'fastify';
import type { RuntimeApplication } from '../../application/runtime-composition.js';
import type { CardStore } from '../../cards/store-api.js';
import { operatorApiContracts } from '../../contracts/index.js';
import { buildAgentOperatorContractHandlers } from './operator-agent-handlers.js';
import { buildChatOperatorContractHandlers } from './operator-chat-handlers.js';
import { buildConfigOperatorContractHandlers } from './operator-config-handlers.js';
import { buildEventsOperatorContractHandlers } from './operator-events-handlers.js';
import { buildFilesDebugOperatorContractHandlers } from './operator-files-debug-handlers.js';
import type {
  OperatorAvailabilityContext,
  OperatorConfigContext,
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
  OperatorConfigContext,
  Partial<OperatorRuntimeProviderContext> {
  fastify: FastifyInstance;
  cardStore?: CardStore;
  runtimeApplication?: RuntimeApplication;
}

export function registerOperatorContractRoutes(options: OperatorContractRouteRegistrationOptions): void {
  const { fastify, projectRoot } = options;
  const runtime = new ContractRuntime();
  const getRuntimeApplication = () => options.runtimeApplicationProvider?.() ?? options.runtimeApplication;
  const getCardStore = () => options.cardStore ?? getRuntimeApplication()?.cardStore;
  const handlers: OperatorContractHandlerMap = {
    ...buildRuntimeCardOperatorContractHandlers({ projectRoot, cardStoreProvider: getCardStore, runtimeApplicationProvider: getRuntimeApplication, serverAvailabilityProvider: options.serverAvailabilityProvider }),
    ...buildMcpOperatorContractHandlers({ mcpStatusProvider: options.mcpStatusProvider, mcpToolsProvider: options.mcpToolsProvider, serverAvailabilityProvider: options.serverAvailabilityProvider }),
    ...buildAgentOperatorContractHandlers({ projectRoot, runtimeApplication: getRuntimeApplication()?.runtimeApi }),
    ...buildChatOperatorContractHandlers({ projectRoot, runtimeApplicationProvider: getRuntimeApplication, requestServerRestart: options.requestServerRestart }),
    ...buildFilesDebugOperatorContractHandlers({ projectRoot, cardStoreProvider: getCardStore }),
    ...buildProcessOperatorContractHandlers({ projectRoot }),
    ...buildEventsOperatorContractHandlers({ projectRoot }),
    ...buildConfigOperatorContractHandlers({ projectRoot, saivageConfig: options.saivageConfig, configWarnings: options.configWarnings }),
  };

  runtime.mount(fastify, operatorApiContracts, handlers);
}
