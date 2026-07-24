import type { FastifyInstance } from 'fastify';
import type { SaivageConfig } from '../../schemas/saivage-config.js';
import type { RuntimeApplication } from '../../application/runtime-composition.js';
import type { CardService } from '../../cards/card-api.js';
import type { McpManager } from '../../mcp/manager-api.js';
import type { LiveSyncSocket } from '../live-sync-socket.js';
import type { RestartPort } from '../../boot/restart-port.js';
import { buildServerAvailability } from '../availability.js';
import { registerOperatorContractRoutes } from '../routes/operator-contracts.js';
import { registerInternalDebugRoutes } from '../routes/chats-files-debug.js';
import { registerWebSocket } from '../websocket.js';
import type { AuthPolicy } from '../auth-policy.js';
import type { ResolvedConfigAuthority } from '../../config/index.js';
import type { EventLog } from '../../observability/index.js';
import type { CompiledRuntimeWorkflows } from '../../runtime/card-process/card-process-config.js';
import type { ApplicationFatalPort } from '../../contracts/index.js';

export function registerServerRoutes(options: {
  fastify: FastifyInstance;
  projectRoot: string;
  cardStore: CardService;
  runtimeApplication: RuntimeApplication;
  mcpManager: McpManager;
  saivageConfig: SaivageConfig;
  configAuthority: ResolvedConfigAuthority;
  liveSyncSocket: LiveSyncSocket;
  restartPort?: RestartPort;
  authPolicy: AuthPolicy;
  eventLogger: EventLog;
  workflows: CompiledRuntimeWorkflows;
  fatalPort: ApplicationFatalPort;
}): void {
  const serverAvailabilityProvider = () => buildServerAvailability({ projectRoot: options.projectRoot, runtimeApplication: options.runtimeApplication, mcpManager: options.mcpManager });

  registerOperatorContractRoutes({
    fastify: options.fastify,
    projectRoot: options.projectRoot,
    cardStore: options.cardStore,
    runtimeApplication: options.runtimeApplication,
    mcpManager: options.mcpManager,
    serverAvailabilityProvider,
    configAuthority: options.configAuthority,
    saivageConfig: options.saivageConfig,
    providerRoutingReadModelProvider: () => options.runtimeApplication.getProviderRoutingReadModel(),
    restartPort: options.restartPort,
    authPolicy: options.authPolicy,
    eventLogger: options.eventLogger,
    workflows: options.workflows,
    fatalPort: options.fatalPort,
  });
  registerInternalDebugRoutes(options.fastify, options.projectRoot, options.cardStore, options.authPolicy);
  registerWebSocket(options.fastify, options.projectRoot, {
    authPolicy: options.authPolicy,
    liveSyncSocket: options.liveSyncSocket,
    saivageConfig: options.saivageConfig,
    runtimeApplication: options.runtimeApplication,
    restartPort: options.restartPort,
    fatalPort: options.fatalPort,
  });
}
