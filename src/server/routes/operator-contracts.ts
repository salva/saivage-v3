import type { FastifyInstance } from 'fastify';
import type { McpManager } from '../../mcp/manager-api.js';
import { operatorApiContracts } from '../../contracts/index.js';
import type { AuthPolicy } from '../auth-policy.js';
import { buildAgentOperatorContractHandlers } from './operator-agent-handlers.js';
import { buildWorkflowOperatorContractHandlers } from './operator-workflow-handlers.js';
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
import type { McpLifecycleIngress } from '../composition/mcp-lifecycle-ingress.js';
import { buildWorkGcOperatorContractHandlers } from './operator-work-gc-handlers.js';

interface OperatorContractRouteRegistrationOptions
  extends
    OperatorProjectContext,
    OperatorAvailabilityContext,
    OperatorConfigContext,
    OperatorCardServiceContext,
    Omit<OperatorRuntimeProviderContext, 'runtimeApplication'> {
  fastify: FastifyInstance;
  authPolicy: AuthPolicy;
  eventLogger: EventLog;
  mcpManager: McpManager;
  mcpLifecycleIngress: McpLifecycleIngress;
  runtimeApplication: import('../../application/runtime-composition.js').RuntimeApplication;
  workflows: import('../../runtime/runtime-api.js').CompiledRuntimeWorkflows;
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
    ...buildWorkGcOperatorContractHandlers(options.runtimeApplication),
    ...buildWorkflowOperatorContractHandlers(options.workflows),
    ...defineOperatorContractHandlers({
      'auth.wsTicket': () => ({ body: options.authPolicy.issueWebSocketTicket() }),
    }),
    ...buildRuntimeCardOperatorContractHandlers({
      projectRoot,
      cardStore: options.cardStore,
      runtimeApplication: options.runtimeApplication,
      serverAvailabilityProvider: options.serverAvailabilityProvider,
      restartCapability: options.restartCapability,
    }),
    ...buildMcpOperatorContractHandlers({
      mcpToolsProvider: options.mcpManager,
      mcpLifecycle: options.mcpLifecycleIngress,
    }),
    ...buildAgentOperatorContractHandlers({
      projectRoot,
      workflows: options.workflows,
      captureExecutingLlmSnapshots: options.runtimeApplication.captureExecutingLlmSnapshots,
    }),
    ...buildChatOperatorContractHandlers({
      runtimeApplication: options.runtimeApplication,
      restartCapability: options.restartCapability,
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
