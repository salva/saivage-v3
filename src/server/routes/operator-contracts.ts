import type { FastifyInstance } from 'fastify';
import type { McpManager } from '../../mcp/manager-api.js';
import { operatorApiContracts } from '../../contracts/index.js';
import type { AuthPolicy } from '../auth-policy.js';
import { buildAgentOperatorContractHandlers } from './operator-agent-handlers.js';
import { buildChatOperatorContractHandlers } from './operator-chat-handlers.js';
import { buildConfigOperatorContractHandlers } from './operator-config-handlers.js';
import { buildEventsOperatorContractHandlers } from './operator-events-handlers.js';
import { buildFilesDebugOperatorContractHandlers } from './operator-files-debug-handlers.js';
import {
  defineOperatorContractHandlers,
  type OperatorContractHandlerMap,
} from './operator-handler-context.js';
import type {
  OperatorCardServiceContext,
  OperatorAvailabilityContext,
  OperatorConfigContext,
  OperatorProjectContext,
  OperatorRuntimeProviderContext,
} from './operator-handler-context.js';
import { buildMcpOperatorContractHandlers } from './operator-mcp-handlers.js';
import { buildProcessOperatorContractHandlers } from './operator-process-handlers.js';
import { buildRuntimeCardOperatorContractHandlers } from './operator-runtime-card-handlers.js';
import { ContractRuntime } from '../contract-runtime.js';
import type { EventLog } from '../../observability/index.js';
import type { ApplicationFatalPort } from '../../contracts/index.js';

export interface OperatorContractRouteRegistrationOptions
  extends
    OperatorProjectContext,
    OperatorAvailabilityContext,
    OperatorConfigContext,
    OperatorCardServiceContext,
    Omit<OperatorRuntimeProviderContext, 'runtimeApplication'> {
  fastify: FastifyInstance;
  authPolicy: AuthPolicy;
  eventLogger: EventLog;
  mcpManager?: McpManager;
  runtimeApplication: import('../../application/runtime-composition.js').RuntimeApplication;
  saivageConfig: import('../../schemas/saivage-config.js').SaivageConfig;
  workflows: import('../../runtime/card-process/card-process-config.js').CompiledRuntimeWorkflows;
  fatalPort: ApplicationFatalPort;
}

export function registerOperatorContractRoutes(
  options: OperatorContractRouteRegistrationOptions,
): void {
  const { fastify, projectRoot } = options;
  const runtime = new ContractRuntime({
    authPolicy: options.authPolicy,
    eventLogger: options.eventLogger,
    fatalPort: options.fatalPort,
  });
  const handlers = {
    ...defineOperatorContractHandlers({
      'auth.wsTicket': () => ({ body: options.authPolicy.issueWebSocketTicket() }),
    }),
    ...buildRuntimeCardOperatorContractHandlers({
      projectRoot,
      cardStore: options.cardStore,
      runtimeApplication: options.runtimeApplication,
      serverAvailabilityProvider: options.serverAvailabilityProvider,
      restartPort: options.restartPort,
      restartServerAvailable: options.authPolicy.authEnabled,
    }),
    ...buildMcpOperatorContractHandlers({
      mcpToolsProvider: options.mcpManager,
    }),
    ...buildAgentOperatorContractHandlers({ projectRoot, workflows: options.workflows }),
    ...buildChatOperatorContractHandlers({
      projectRoot,
      runtimeApplication: options.runtimeApplication,
      restartPort: options.restartPort,
      saivageConfig: options.saivageConfig,
    }),
    ...buildFilesDebugOperatorContractHandlers({
      projectRoot,
      cardServiceProvider: () => options.runtimeApplication.cardStore,
      configAuthority: options.configAuthority,
      workflows: options.workflows,
    }),
    ...buildProcessOperatorContractHandlers({
      projectRoot,
      processRunner: options.runtimeApplication.processRunner,
    }),
    ...buildEventsOperatorContractHandlers({ projectRoot }),
    ...buildConfigOperatorContractHandlers({
      projectRoot,
      configAuthority: options.configAuthority,
      providerRoutingReadModelProvider: options.providerRoutingReadModelProvider,
    }),
  } satisfies OperatorContractHandlerMap;

  runtime.mount(fastify, operatorApiContracts, handlers);
}
