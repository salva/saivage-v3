import type { FastifyInstance } from 'fastify';
import type { SaivageConfig } from '../../agents/config-api.js';
import type { RuntimeApplication } from '../../application/runtime-composition.js';
import type { McpManager } from '../../mcp/manager-api.js';
import type { ServerAvailabilityInputs } from '../availability.js';
import { buildServerAvailability } from '../availability.js';
import { registerOperatorContractRoutes } from '../routes/operator-contracts.js';
import { registerInternalDebugRoutes } from '../routes/chats-files-debug.js';
import { registerWebSocket } from '../websocket.js';

export function registerServerRoutes(options: {
  fastify: FastifyInstance;
  projectRoot: string;
  runtimeApplicationProvider: () => RuntimeApplication | undefined;
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
    runtimeApplicationProvider: options.runtimeApplicationProvider,
    mcpStatusProvider: options.mcpManagerProvider,
    mcpToolsProvider: options.mcpManagerProvider,
    serverAvailabilityProvider,
    requestServerRestart: options.requestServerRestart,
    saivageConfig: options.saivageConfig,
    configWarnings: options.configWarnings,
  });
  registerInternalDebugRoutes(options.fastify, options.projectRoot);
  registerWebSocket(options.fastify, options.projectRoot, options.runtimeApplicationProvider(), options.requestServerRestart);
}
