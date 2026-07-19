import type { FastifyInstance } from 'fastify';
import type { SaivageConfig } from '../../agents/config-api.js';
import type { AppTerminalRegistration } from '../../boot/app.js';
import type { RestartPort } from '../../boot/restart-port.js';
import { createRuntimeApplication, type RuntimeApplication } from '../../application/runtime-composition.js';
import { ReadModelChangeBroadcaster, type ReadModelChangeSubscription } from '../../application/read-model-changes.js';
import { CardService } from '../../cards/card-api.js';
import type { Environment } from '../../config/index.js';
import { EventBus } from '../../events/index.js';
import { McpManager } from '../../mcp/manager-api.js';
import { createEventLog, createErrorLog, type ErrorLog, type EventLog } from '../../observability/index.js';
import type { AppLogContext } from '../../persistence/app-log.js';
import { AuthPolicy } from '../auth-policy.js';
import { LiveSyncSocket } from '../live-sync-socket.js';
import { SyncHub } from '../sync-hub.js';
import { createFastifyApp } from './fastify-app.js';
import type { RuntimeProcessIdentity } from '../../runtime/lock.js';

export interface ServerServices {
  projectRoot: string;
  config: SaivageConfig;
  fastify: FastifyInstance;
  eventBus: EventBus;
  eventLogger: EventLog;
  errorLogger: ErrorLog;
  appLogs: AppLogContext;
  cardStore: CardService;
  runtimeApplication: RuntimeApplication;
  mcpManager: McpManager;
  liveSyncSocket: LiveSyncSocket;
  syncHub: SyncHub;
  readModelChanges: ReadModelChangeBroadcaster;
  readModelChangeSubscription: ReadModelChangeSubscription | null;
  authPolicy: AuthPolicy;
}

export async function createServerServices(input: {
  environment: Environment;
  terminal: AppTerminalRegistration;
  processIdentity: RuntimeProcessIdentity;
  restartPort?: RestartPort;
}): Promise<ServerServices> {
  const { environment, terminal } = input;
  const projectRoot = environment.projectRoot;
  const config = environment.config;
  const authPolicy = new AuthPolicy({ apiToken: environment.auth.apiToken });
  const restartServerAvailable = authPolicy.authEnabled;
  if (restartServerAvailable && !input.restartPort) throw new Error('Authenticated server requires an application-owned restart port.');

  const fastify = await createFastifyApp(environment);
  terminal.registerAdmissionCloser('http-admission', () => { /* onRequest observes the shared closing flag */ });
  terminal.registerCleanupLeaf('fastify', () => fastify.close());
  fastify.addHook('onRequest', async (_request, reply) => {
    if (terminal.isApplicationClosing()) await reply.code(503).send({ error: 'application_closing' });
  });

  const eventBus = new EventBus();
  const readModelChanges = new ReadModelChangeBroadcaster();
  const appLogs: AppLogContext = { projectRoot, changes: readModelChanges };
  const eventLogger = createEventLog(projectRoot, appLogs, eventBus);
  const errorLogger = createErrorLog(projectRoot, appLogs, eventBus);
  const cardStore = new CardService(projectRoot, eventBus, readModelChanges);
  const liveSyncSocket = new LiveSyncSocket();
  terminal.registerAdmissionCloser('websocket-admission', () => liveSyncSocket.closeAdmission());
  const syncHub = new SyncHub(liveSyncSocket);

  const runtimeApplication = createRuntimeApplication({ projectRoot, processIdentity: input.processIdentity, config, configAuthority: environment.configAuthority, eventBus, eventLogger, appLogs, cardStore, readModelChanges, restartServerAvailable, restartPort: restartServerAvailable ? input.restartPort : undefined });
  await runtimeApplication.runtimeApi.start();
  fastify.log.info('Runtime application started');
  terminal.registerAdmissionCloser('runtime', () => runtimeApplication.closeRuntimeAdmission());
  terminal.registerAdmissionCloser('process-admission', () => runtimeApplication.processRunner.closeLaunchAdmission());
  terminal.registerAdmissionCloser('analyst', () => runtimeApplication.closeAnalystAdmission());
  terminal.registerCleanupLeaf('runtime', () => runtimeApplication.cleanupRuntimeForApplicationStop());
  terminal.registerCleanupLeaf('analyst', () => runtimeApplication.cleanupAnalystForApplicationStop());

  const mcpManager = new McpManager({ configAuthority: environment.configAuthority, processRunner: runtimeApplication.processRunner });
  terminal.registerAdmissionCloser('mcp', () => mcpManager.closeAdmission());
  terminal.registerCleanupLeaf('mcp', () => mcpManager.cleanupForApplicationStop());
  const mcpReconciliation = await mcpManager.reconcilePersistedConfig();
  if (!mcpReconciliation.converged) throw new Error('MCP startup did not converge to persisted configuration.');
  fastify.log.info('MCP manager started');
  runtimeApplication.setMcpManager(mcpManager);

  syncHub.wire(runtimeApplication.runtimeApi);
  let readModelChangeSubscription: ReadModelChangeSubscription | null = readModelChanges.subscribe(syncHub);
  terminal.registerCleanupLeaf('subscriptions', () => {
    readModelChangeSubscription?.unsubscribe();
    readModelChangeSubscription = null;
    syncHub.dispose();
  });
  terminal.registerCleanupLeaf('live-sync', () => liveSyncSocket.dispose());

  return { projectRoot, config, fastify, eventBus, eventLogger, errorLogger, appLogs, cardStore, runtimeApplication, mcpManager, liveSyncSocket, syncHub, readModelChanges, readModelChangeSubscription, authPolicy };
}
