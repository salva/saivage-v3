import type { FastifyInstance } from 'fastify';
import type { SaivageConfig } from '../../agents/index.js';
import type { ActiveRuntime } from '../../runtime/index.js';
import type { McpManager } from '../../mcp/index.js';
import type { ServerAvailabilityInputs } from '../availability.js';
import { buildServerAvailability } from '../availability.js';
import { registerOperatorContractRoutes } from '../routes/operator-contracts.js';
import { registerRuntimeConfigNotesRoutes } from '../routes/runtime-config-notes.js';
import { registerInternalDebugRoutes } from '../routes/chats-files-debug.js';
import { registerEventsRoute } from '../routes/events.js';
import { registerProcessRoutes } from '../routes/processes.js';
import { registerWebSocket } from '../websocket.js';

export function registerServerRoutes(options: {
  fastify: FastifyInstance;
  projectRoot: string;
  activeRuntimeProvider: () => ActiveRuntime | undefined;
  mcpManagerProvider: () => McpManager | undefined;
  availabilityInputs: ServerAvailabilityInputs;
  saivageConfig: SaivageConfig;
  configWarnings: readonly string[];
  requestServerRestart: () => Promise<void>;
}): void {
  const serverAvailabilityProvider = () => buildServerAvailability(options.availabilityInputs);

  registerOperatorContractRoutes({
    fastify: options.fastify,
    projectRoot: options.projectRoot,
    activeRuntimeProvider: options.activeRuntimeProvider,
    mcpStatusProvider: options.mcpManagerProvider,
    mcpToolsProvider: options.mcpManagerProvider,
    serverAvailabilityProvider,
    requestServerRestart: options.requestServerRestart,
  });
  registerRuntimeConfigNotesRoutes(options.fastify, options.projectRoot, undefined, serverAvailabilityProvider, options.saivageConfig, options.configWarnings);
  registerInternalDebugRoutes(options.fastify, options.projectRoot);
  registerEventsRoute(options.fastify, options.projectRoot);
  registerProcessRoutes(options.fastify, options.projectRoot);
  registerWebSocket(options.fastify, options.projectRoot, options.activeRuntimeProvider(), options.requestServerRestart);
}
