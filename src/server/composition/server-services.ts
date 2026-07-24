import type { FastifyInstance } from 'fastify';
import type { SaivageConfig } from '../../schemas/saivage-config.js';
import type { AppTerminalRegistration } from '../../boot/app.js';
import type { RestartPort } from '../../boot/restart-port.js';
import { createRuntimeApplication, type RuntimeApplication } from '../../application/runtime-composition.js';
import { CardService } from '../../cards/card-api.js';
import type { Environment } from '../../config/index.js';
import { createMcpToolInvocationInstallation, McpManager } from '../../mcp/manager-api.js';
import { createEventLog, type EventLog } from '../../observability/index.js';
import { AuthPolicy } from '../auth-policy.js';
import { LiveSyncSocket } from '../live-sync-socket.js';
import { SyncHub } from '../sync-hub.js';
import { createFastifyApp } from './fastify-app.js';
import type { RuntimeProcessIdentity } from '../../runtime/lock.js';
import { ManagedProcessGroupRegistry } from '../../runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../runtime/process-runner.js';
import { bindRuntimeWorkflows } from '../../runtime/card-process/card-process-config.js';
import { ProviderRegistry } from '../../agents/provider.js';
import { ModelRouter } from '../../agents/model-router.js';
import type { ApplicationFatalPort } from '../../contracts/index.js';

export interface ServerServices {
  projectRoot: string;
  config: SaivageConfig;
  fastify: FastifyInstance;
  eventLogger: EventLog;
  cardStore: CardService;
  runtimeApplication: RuntimeApplication;
  mcpManager: McpManager;
  liveSyncSocket: LiveSyncSocket;
  syncHub: SyncHub;
  authPolicy: AuthPolicy;
  workflows: import('../../runtime/card-process/card-process-config.js').CompiledRuntimeWorkflows;
}

export async function createServerServices(input: {
  environment: Environment;
  terminal: AppTerminalRegistration;
  processIdentity: RuntimeProcessIdentity;
  fatalPort: ApplicationFatalPort;
  restartPort?: RestartPort;
}): Promise<ServerServices> {
  const { environment, terminal } = input;
  const projectRoot = environment.projectRoot;
  const config = environment.config;
  const authPolicy = new AuthPolicy({ apiToken: environment.auth.apiToken });
  const restartServerAvailable = authPolicy.authEnabled;
  if (restartServerAvailable && !input.restartPort) throw new Error('Authenticated server requires an application-owned restart port.');

  const fastify = await createFastifyApp(environment, input.fatalPort);
  terminal.registerAdmissionCloser('http-admission', () => { /* onRequest observes the shared closing flag */ });
  terminal.registerCleanupLeaf('fastify', () => fastify.close());
  fastify.addHook('onRequest', async (_request, reply) => {
    if (terminal.isApplicationClosing()) await reply.code(503).send({ error: 'application_closing' });
  });

  const liveSyncSocket = new LiveSyncSocket();
  terminal.registerAdmissionCloser('websocket-admission', () => liveSyncSocket.closeAdmission());
  const syncHub = new SyncHub(liveSyncSocket);
  const eventLogger = createEventLog(projectRoot, () => syncHub.timelineChanged());
  const providerRegistry=new ProviderRegistry(config);
  const workflows = bindRuntimeWorkflows(environment.workflows,new ModelRouter(config,providerRegistry));
  const cardStore = new CardService(projectRoot, workflows, syncHub);

  const processRegistry = new ManagedProcessGroupRegistry();
  const runtimeProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime-cards');
  const analystProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'analyst-sessions');
  const mcpProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'mcp-servers');
  const processRunner = new ProcessRunner(projectRoot, processRegistry, input.fatalPort);
  const mcpToolInvocationInstallation = createMcpToolInvocationInstallation();
  const runtimeApplication = createRuntimeApplication({ projectRoot, processIdentity: input.processIdentity, config, workflows,providerRegistry, configAuthority: environment.configAuthority, eventLogger, cardStore, freshness: syncHub, processRunner, runtimeProcessRootScope, analystProcessRootScope, mcpToolInvocation: mcpToolInvocationInstallation.port, restartServerAvailable, restartPort: restartServerAvailable ? input.restartPort : undefined, fatalPort: input.fatalPort });
  terminal.registerAdmissionCloser('runtime', () => runtimeApplication.closeRuntimeAdmission());
  terminal.registerAdmissionCloser('process-admission', () => runtimeApplication.processRunner.closeLaunchAdmission());
  terminal.registerAdmissionCloser('analyst', () => runtimeApplication.closeAnalystAdmission());
  terminal.registerCleanupLeaf('runtime', () => runtimeApplication.cleanupRuntimeForApplicationStop());
  terminal.registerCleanupLeaf('analyst', () => runtimeApplication.cleanupAnalystForApplicationStop());

  const mcpManager = new McpManager({ configAuthority: environment.configAuthority, processRunner, mcpProcessRootScope, eventLogger });
  terminal.registerAdmissionCloser('mcp', () => mcpManager.closeAdmission());
  terminal.registerCleanupLeaf('mcp', () => mcpManager.cleanupForApplicationStop());
  const mcpReconciliation = await mcpManager.reconcilePersistedConfig();
  if (!mcpReconciliation.converged) throw new Error('MCP startup did not converge to persisted configuration.');
  fastify.log.info('MCP manager started');
  mcpToolInvocationInstallation.installer.install(mcpManager);
  await runtimeApplication.runtimeApi.start();
  fastify.log.info('Runtime application started');

  terminal.registerCleanupLeaf('sync-hub', () => syncHub.dispose());
  terminal.registerCleanupLeaf('live-sync', () => liveSyncSocket.dispose());

  return { projectRoot, config, fastify, eventLogger, cardStore, runtimeApplication, mcpManager, liveSyncSocket, syncHub, authPolicy, workflows };
}
