import type { FastifyInstance } from 'fastify';
import type { McpManager } from '../../mcp/manager-api.js';
import { operatorApiContracts } from '../../contracts/index.js';
import type { AuthPolicy } from '../auth-policy.js';
import { buildAgentOperatorContractHandlers } from './operator-agent-handlers.js';
import { buildChatOperatorContractHandlers } from './operator-chat-handlers.js';
import { buildConfigOperatorContractHandlers } from './operator-config-handlers.js';
import { buildEventsOperatorContractHandlers } from './operator-events-handlers.js';
import { buildFilesDebugOperatorContractHandlers } from './operator-files-debug-handlers.js';
import type {
  OperatorCardStoreContext,
  OperatorAvailabilityContext,
  OperatorConfigContext,
  OperatorContractHandlerMap,
  OperatorProjectContext,
  OperatorRuntimeProviderContext,
} from './operator-handler-context.js';
import { buildMcpOperatorContractHandlers } from './operator-mcp-handlers.js';
import { buildProcessOperatorContractHandlers } from './operator-process-handlers.js';
import { buildRuntimeCardOperatorContractHandlers } from './operator-runtime-card-handlers.js';
import { ContractRuntime } from '../contract-runtime.js';

interface OperatorContractRouteRegistrationOptions extends
  OperatorProjectContext,
  OperatorAvailabilityContext,
  OperatorConfigContext,
  OperatorCardStoreContext,
  OperatorRuntimeProviderContext {
  fastify: FastifyInstance;
  authPolicy: AuthPolicy;
  mcpManager?: McpManager;
}

export function registerOperatorContractRoutes(options: OperatorContractRouteRegistrationOptions): void {
  const { fastify, projectRoot } = options;
  const runtime = new ContractRuntime({ authPolicy: options.authPolicy });
  const handlers: OperatorContractHandlerMap = {
    'auth.wsTicket': () => ({ body: options.authPolicy.issueWebSocketTicket() }),
    ...buildRuntimeCardOperatorContractHandlers({ projectRoot, cardStore: options.cardStore, runtimeApplication: options.runtimeApplication, serverAvailabilityProvider: options.serverAvailabilityProvider }),
    ...buildMcpOperatorContractHandlers({ mcpStatusProvider: options.mcpManager, mcpToolsProvider: options.mcpManager, serverAvailabilityProvider: options.serverAvailabilityProvider }),
    ...buildAgentOperatorContractHandlers({ projectRoot, cardStore: options.cardStore }),
    ...buildChatOperatorContractHandlers({ projectRoot, runtimeApplication: options.runtimeApplication, restartPort: options.restartPort, saivageConfig: options.saivageConfig }),
    ...buildFilesDebugOperatorContractHandlers({ projectRoot, cardStoreProvider: () => options.cardStore }),
    ...buildProcessOperatorContractHandlers({ projectRoot, processRunner: options.runtimeApplication?.processRunner }),
    ...buildEventsOperatorContractHandlers({ projectRoot }),
    ...buildConfigOperatorContractHandlers({
      projectRoot,
      saivageConfig: options.saivageConfig,
      configWarnings: options.configWarnings,
      providerRoutingReadModelProvider: () => options.runtimeApplication?.getProviderRoutingReadModel(),
    }),
  };

  runtime.mount(fastify, operatorApiContracts, handlers);
}
