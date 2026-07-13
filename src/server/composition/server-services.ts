import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Environment } from '../../config/index.js';
import type { SaivageConfig } from '../../agents/config-api.js';
import { createResourceScope, type ResourceScope } from '../../lifecycle/index.js';
import { createRuntimeApplication, type RuntimeApplication } from '../../application/runtime-composition.js';
import { CardStoreRepository } from '../../cards/store-api.js';
import { EventBus } from '../../events/index.js';
import { McpManager } from '../../mcp/manager-api.js';
import { EventLogger, ErrorLogger } from '../../observability/index.js';
import { TelegramBot } from '../../telegram/index.js';
import { clearProjectNotificationDeliveryAdapters, clearProjectNotificationEventBus, setProjectNotificationEventBus } from '../../notifications/index.js';
import { AuthPolicy } from '../auth-policy.js';
import type { RestartPort } from '../../boot/restart-port.js';
import { LiveSyncSocket } from '../live-sync-socket.js';
import { SyncHub } from '../sync-hub.js';
import { createFastifyApp } from './fastify-app.js';
import { startTelegramNotifications } from './telegram-lifecycle.js';
import { ReadModelChangeBroadcaster, type ReadModelChangeSubscription } from '../../application/read-model-changes.js';
import type { ProjectPersistenceAuthority } from '../../persistence/project-persistence-authority.js';
import type { CompositionMutationAuthority } from '../../application/mutation-authority.js';
import type { MutationLane } from '../../application/mutation-lane.js';
import { AuthProfileRepository } from '../../auth/auth-profile-store.js';

export interface ServerServices {
  projectRoot: string;
  config: SaivageConfig;
  fastify: FastifyInstance;
  scope: ResourceScope;
  eventBus: EventBus;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  cardStore: CardStoreRepository;
  runtimeApplication: RuntimeApplication;
  mcpManager: McpManager;
  liveSyncSocket: LiveSyncSocket;
  syncHub: SyncHub;
  readModelChanges: ReadModelChangeBroadcaster;
  readModelChangeSubscription: ReadModelChangeSubscription | null;
  authPolicy: AuthPolicy;
  telegramBot?: TelegramBot;
  stop(): Promise<void>;
}

async function stopServerResources(services: Omit<ServerServices, 'stop'>): Promise<void> {
  const { projectRoot, fastify, runtimeApplication, mcpManager, telegramBot, syncHub } = services;
  services.readModelChangeSubscription?.unsubscribe();
  services.readModelChangeSubscription = null;
  syncHub.dispose();
  clearProjectNotificationDeliveryAdapters(projectRoot);
  clearProjectNotificationEventBus(projectRoot);

  try {
    await fastify.close();
  } finally {
    if (telegramBot) {
      try {
        await telegramBot.stop();
        fastify.log.info('Telegram bot stopped');
      } catch (err) {
        fastify.log.warn(`Telegram bot stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      await mcpManager.dispose();
      fastify.log.info('MCP manager stopped');
    } catch (err) {
      fastify.log.warn(`MCP manager stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await runtimeApplication.analystRuntime.shutdown();
      await runtimeApplication.runtimeApi.shutdown();
      fastify.log.info('Runtime application stopped');
    } catch (err) {
      fastify.log.warn(`Runtime application stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export async function createServerServices(input: {
  environment: Environment;
  scope?: ResourceScope;
  restartPort?: RestartPort;
  authority: ProjectPersistenceAuthority;
  compositionAuthority: CompositionMutationAuthority;
  mutationLane: MutationLane;
}): Promise<ServerServices> {
  const { environment } = input;
  const projectRoot = environment.projectRoot;
  const config = environment.config;
  const scope = input.scope ?? createResourceScope('server');

  const authPolicy = new AuthPolicy({ apiToken: environment.auth.apiToken });
  const restartServerAvailable = authPolicy.authEnabled;
  if (restartServerAvailable && !input.restartPort) throw new Error('Authenticated server requires an application-owned restart port.');

  const fastify = await createFastifyApp(environment);
  const eventBus = new EventBus();
  setProjectNotificationEventBus(projectRoot, eventBus);
  const saivageDir = join(projectRoot, '.saivage');
  const eventLogger = new EventLogger(saivageDir);
  const errorLogger = new ErrorLogger(saivageDir);
  const readModelChanges = new ReadModelChangeBroadcaster();
  const cardStore = new CardStoreRepository({ projectRoot, reader: input.authority.reader, writer: input.authority.writer, eventBus, readModelChanges });
  const authProfiles = new AuthProfileRepository(projectRoot, input.mutationLane);
  authProfiles.restabilize(input.compositionAuthority);
  const liveSyncSocket = new LiveSyncSocket();
  const syncHub = new SyncHub(liveSyncSocket);

  const runtimeApplication = createRuntimeApplication({ projectRoot, config, configAuthority: environment.configAuthority, eventBus, eventLogger, errorLogger, cardStore, authProfiles, mutationLane: input.mutationLane, compositionAuthority: input.compositionAuthority, readModelChanges, restartServerAvailable, restartPort: restartServerAvailable ? input.restartPort : undefined });
  await runtimeApplication.runtimeApi.start();
  fastify.log.info('Runtime application started');

  const mcpManager = new McpManager({ configAuthority: environment.configAuthority, processRunner: runtimeApplication.processRunner });
  const mcpReconciliation = await mcpManager.reconcilePersistedConfig();
  if (!mcpReconciliation.converged) throw new Error('MCP startup did not converge to persisted configuration.');
  fastify.log.info('MCP manager started');
  runtimeApplication.setMcpManager(mcpManager);

  const telegramBot = await startTelegramNotifications({ projectRoot, saivageConfig: config, fastify, runtimeApplication });
  syncHub.wire(runtimeApplication.runtimeApi);
  const readModelChangeSubscription = readModelChanges.subscribe(syncHub);

  const servicesBase = {
    projectRoot,
    config,
    fastify,
    scope,
    eventBus,
    eventLogger,
    errorLogger,
    cardStore,
    runtimeApplication,
    mcpManager,
    liveSyncSocket,
    syncHub,
    readModelChanges,
    readModelChangeSubscription,
    authPolicy,
    telegramBot,
  };

  scope.add({ dispose: () => stopServerResources(servicesBase) }, { name: 'server-stop' });

  async function stop(): Promise<void> {
    await scope.dispose();
  }

  return { ...servicesBase, stop };
}
