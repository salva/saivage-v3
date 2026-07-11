import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Environment } from '../../config/index.js';
import type { SaivageConfig } from '../../agents/config-api.js';
import { createResourceScope, type ResourceScope } from '../../lifecycle/index.js';
import { createRuntimeApplication, type RuntimeApplication } from '../../application/runtime-composition.js';
import { CardStore } from '../../cards/store-api.js';
import { EventBus } from '../../events/index.js';
import { McpManager } from '../../mcp/manager-api.js';
import { EventLogger, ErrorLogger } from '../../observability/index.js';
import { TelegramBot } from '../../telegram/index.js';
import { clearProjectNotificationDeliveryAdapters, clearProjectNotificationEventBus, setProjectNotificationEventBus } from '../../notifications/index.js';
import { configureAuthPolicy } from '../auth-policy.js';
import { getAuthPolicy } from '../auth-policy.js';
import type { RestartPort } from '../../boot/restart-port.js';
import { LiveSyncSocket } from '../live-sync-socket.js';
import { SyncHub } from '../sync-hub.js';
import { createFastifyApp } from './fastify-app.js';
import { startTelegramNotifications } from './telegram-lifecycle.js';

export interface ServerServices {
  projectRoot: string;
  config: SaivageConfig;
  fastify: FastifyInstance;
  scope: ResourceScope;
  eventBus: EventBus;
  eventLogger: EventLogger;
  errorLogger: ErrorLogger;
  cardStore: CardStore;
  runtimeApplication: RuntimeApplication;
  mcpManager: McpManager;
  liveSyncSocket: LiveSyncSocket;
  syncHub: SyncHub;
  telegramBot?: TelegramBot;
  stop(): Promise<void>;
}

async function stopServerResources(services: Omit<ServerServices, 'stop'>): Promise<void> {
  const { projectRoot, fastify, runtimeApplication, mcpManager, telegramBot, liveSyncSocket, syncHub } = services;
  liveSyncSocket.dispose();
  syncHub.dispose(runtimeApplication.runtimeApi);
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
      await mcpManager.stopAll();
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
}): Promise<ServerServices> {
  const { environment } = input;
  const projectRoot = environment.projectRoot;
  const config = environment.config;
  const scope = input.scope ?? createResourceScope('server');

  configureAuthPolicy({ apiToken: environment.auth.apiToken });
  const restartServerAvailable = getAuthPolicy().authEnabled;
  if (restartServerAvailable && !input.restartPort) throw new Error('Authenticated server requires an application-owned restart port.');

  const fastify = await createFastifyApp(environment);
  const eventBus = new EventBus();
  setProjectNotificationEventBus(projectRoot, eventBus);
  const saivageDir = join(projectRoot, '.saivage');
  const eventLogger = new EventLogger(saivageDir);
  const errorLogger = new ErrorLogger(saivageDir);
  const cardStore = new CardStore(projectRoot, eventBus);
  const liveSyncSocket = new LiveSyncSocket();
  const syncHub = new SyncHub(liveSyncSocket);

  const runtimeApplication = createRuntimeApplication({ projectRoot, config, eventBus, eventLogger, errorLogger, cardStore, restartServerAvailable, restartPort: restartServerAvailable ? input.restartPort : undefined });
  await runtimeApplication.runtimeApi.start();
  syncHub.wire(runtimeApplication.runtimeApi);
  fastify.log.info('Runtime application started');

  const mcpManager = new McpManager(projectRoot, { config, scope: scope.child('mcp') });
  await mcpManager.startAll();
  fastify.log.info('MCP manager started');
  runtimeApplication.setMcpManager(mcpManager);

  const telegramBot = await startTelegramNotifications({ projectRoot, saivageConfig: config, fastify, runtimeApplication });

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
    telegramBot,
  };

  scope.add({ dispose: () => stopServerResources(servicesBase) }, { name: 'server-stop' });

  async function stop(): Promise<void> {
    await scope.dispose();
  }

  return { ...servicesBase, stop };
}
