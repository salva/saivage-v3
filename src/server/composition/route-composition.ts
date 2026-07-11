import type { FastifyInstance } from 'fastify';
import type { SaivageConfig } from '../../agents/config-api.js';
import type { RuntimeApplication } from '../../application/runtime-composition.js';
import type { CardStore } from '../../cards/store-api.js';
import type { McpManager } from '../../mcp/manager-api.js';
import type { LiveSyncSocket } from '../live-sync-socket.js';
import type { RestartPort } from '../../boot/restart-port.js';
import { buildServerAvailability } from '../availability.js';
import { registerOperatorContractRoutes } from '../routes/operator-contracts.js';
import { registerInternalDebugRoutes } from '../routes/chats-files-debug.js';
import { registerWebSocket } from '../websocket.js';

export function registerServerRoutes(options: {
  fastify: FastifyInstance;
  projectRoot: string;
  cardStore: CardStore;
  runtimeApplication: RuntimeApplication;
  mcpManager: McpManager;
  saivageConfig: SaivageConfig;
  configWarnings: readonly string[];
  liveSyncSocket: LiveSyncSocket;
  restartPort?: RestartPort;
}): void {
  const serverAvailabilityProvider = () => buildServerAvailability({ projectRoot: options.projectRoot, runtimeApplication: options.runtimeApplication, mcpManager: options.mcpManager });

  registerOperatorContractRoutes({
    fastify: options.fastify,
    projectRoot: options.projectRoot,
    cardStore: options.cardStore,
    runtimeApplication: options.runtimeApplication,
    mcpManager: options.mcpManager,
    serverAvailabilityProvider,
    saivageConfig: options.saivageConfig,
    configWarnings: options.configWarnings,
    restartPort: options.restartPort,
  });
  registerInternalDebugRoutes(options.fastify, options.projectRoot, options.cardStore, options.runtimeApplication);
  registerWebSocket(options.fastify, options.projectRoot, {
    liveSyncSocket: options.liveSyncSocket,
    saivageConfig: options.saivageConfig,
    runtimeApplication: options.runtimeApplication,
    restartPort: options.restartPort,
  });
}
