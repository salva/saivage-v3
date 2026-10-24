import type { FastifyInstance } from 'fastify';
import type { SaivageConfig } from '../../schemas/index.js';
import type { AppTerminalRegistration } from '../../contracts/index.js';
import type { RestartCapability, RestartPort } from '../../contracts/index.js';
import { createRuntimeApplication, type RuntimeApplication } from '../../application/index.js';
import { CardService } from '../../cards/store-api.js';
import type { Environment } from '../../config/index.js';
import { createMcpToolInvocationInstallation, McpManager } from '../../mcp/manager-api.js';
import { createEventLog, type EventLog } from '../../observability/index.js';
import { AuthPolicy } from '../auth-policy.js';
import { LiveSyncSocket } from '../live-sync-socket.js';
import { SyncHub } from '../sync-hub.js';
import { createFastifyApp } from './fastify-app.js';
import type { RuntimeProcessIdentity } from '../../runtime/runtime-api.js';
import { ManagedProcessGroupRegistry } from '../../runtime/runtime-api.js';
import { ProcessRunner } from '../../runtime/runtime-api.js';
import { bindRuntimeWorkflows } from '../../runtime/runtime-api.js';
import { settleFinalUnmatchedCall } from '../../runtime/runtime-api.js';
import { isConversationCatalogEstablished } from '../../persistence/index.js';
import { ProviderRegistry, ModelRouter } from '../../agents/execution-api.js';
import type { ApplicationFatalPort } from '../../contracts/index.js';
import { throwIfPublicationOutcomeUnknown } from '../../contracts/index.js';
import { globalAgentSessionId } from '../../schemas/index.js';
import { bindOutboundHttpLogger } from './outbound-http-logger.js';
import { createAnalystMcpServer } from '../analyst-mcp-server.js';
import { readProjectIdentity, projectIdentityDigest } from '../../persistence/index.js';
import { McpLifecycleIngress } from './mcp-lifecycle-ingress.js';

interface ServerServices {
  analystMcpEndpoint: string | null;
  projectRoot: string;
  config: SaivageConfig;
  fastify: FastifyInstance;
  eventLogger: EventLog;
  cardStore: CardService;
  runtimeApplication: RuntimeApplication;
  mcpManager: McpManager;
  mcpLifecycleIngress: McpLifecycleIngress;
  liveSyncSocket: LiveSyncSocket;
  syncHub: SyncHub;
  authPolicy: AuthPolicy;
  restartCapability: RestartCapability;
  workflows: import('../../runtime/runtime-api.js').CompiledRuntimeWorkflows;
}

export async function createServerServices(input: {
  environment: Environment;
  terminal: AppTerminalRegistration;
  processIdentity: RuntimeProcessIdentity;
  fatalPort: ApplicationFatalPort;
  restartPort?: RestartPort;
  onOversightOwnerFailure(error: unknown): void;
  onExternalAnalystOwnerFailure(error: unknown): void;
}): Promise<ServerServices> {
  const { environment, terminal } = input;
  const projectRoot = environment.projectRoot;
  const config = environment.config;
  const authPolicy = new AuthPolicy({ apiToken: environment.auth.apiToken });
  const restartPort = input.restartPort;
  let restartCapability: RestartCapability;
  if (authPolicy.authEnabled) {
    if (!restartPort)
      throw new Error('Authenticated server requires an application-owned restart port.');
    restartCapability = Object.freeze({
      available: true,
      port: {
        schedule() {
          runtimeApplication.cancelWorkGc(new Error('Server restart requested.'));
          restartPort.schedule();
        },
        acknowledge: restartPort.acknowledge.bind(restartPort),
      },
    });
  } else {
    restartCapability = Object.freeze({ available: false });
  }

  const providerRegistry = new ProviderRegistry(config);
  const workflows = bindRuntimeWorkflows(
    environment.workflows,
    new ModelRouter(providerRegistry),
    providerRegistry,
    config.compaction.context_utilization_fraction,
    { internalAnalystEnabled: environment.analyst.mode !== 'external' },
  );
  const analystSessionId = globalAgentSessionId(workflows.analyst.name);

  const fastify = await createFastifyApp(environment, input.fatalPort);
  const outboundHttp = bindOutboundHttpLogger(fastify.log);
  terminal.registerCleanupLeaf('fastify', () => fastify.close());
  fastify.addHook('onRequest', async (_request, reply) => {
    if (terminal.isApplicationClosing())
      await reply.code(503).send({ error: 'application_closing' });
  });

  const liveSyncSocket = new LiveSyncSocket();
  terminal.registerAdmissionCloser('websocket-admission', () => liveSyncSocket.closeAdmission());
  const syncHub = new SyncHub(liveSyncSocket);
  const eventLogger = createEventLog(projectRoot);
  const cardStore = new CardService(projectRoot, workflows, syncHub);

  const processRegistry = new ManagedProcessGroupRegistry();
  const runtimeProcessRootScope = processRegistry.createContainerScope(
    processRegistry.rootScope,
    'runtime-cards',
  );
  const analystProcessRootScope = processRegistry.createContainerScope(
    processRegistry.rootScope,
    'analyst-sessions',
  );
  const mcpProcessRootScope = processRegistry.createContainerScope(
    processRegistry.rootScope,
    'mcp-servers',
  );
  const processRunner = new ProcessRunner(projectRoot, processRegistry, input.fatalPort);
  const mcpToolInvocationInstallation = createMcpToolInvocationInstallation();
  const externalProjectIdentity =
    environment.analyst.mode === 'internal' ? null : readProjectIdentity(projectRoot);
  if (environment.analyst.mode !== 'internal' && externalProjectIdentity === null)
    throw new Error('External Analyst requires an established project identity.');
  const runtimeApplication = createRuntimeApplication({
    assertWorkGcEntryIdle() {
      if (mcpLifecycleIngress.hasActiveLifecycleCall() || mcpManager.hasPendingReconciliation())
        throw new Error(
          'MCP lifecycle or reconciliation is active; work garbage collection refused.',
        );
    },
    assertWorkGcReady() {
      if (mcpLifecycleIngress.hasActiveLifecycleCall() || mcpManager.hasWorkGcBlocker())
        throw new Error('MCP activity or surviving service prevents work garbage collection.');
    },
    analystStartup: environment.analyst,
    externalProjectIdentityDigest:
      externalProjectIdentity === null ? null : projectIdentityDigest(externalProjectIdentity),
    onExternalAnalystOwnerFailure: input.onExternalAnalystOwnerFailure,
    outboundHttp,
    failedProviderDiagnostics: environment.failedProviderDiagnostics,
    projectRoot,
    processIdentity: input.processIdentity,
    config,
    workflows,
    providerRegistry,
    configAuthority: environment.configAuthority,
    cardStore,
    freshness: syncHub,
    processRunner,
    runtimeProcessRootScope,
    analystProcessRootScope,
    mcpToolInvocation: mcpToolInvocationInstallation.port,
    restartCapability,
    fatalPort: input.fatalPort,
    analystSessionId,
    onOversightOwnerFailure: input.onOversightOwnerFailure,
  });
  terminal.registerAdmissionCloser('runtime', () => runtimeApplication.closeRuntimeAdmission());
  terminal.registerAdmissionCloser('process-admission', () =>
    runtimeApplication.processRunner.closeLaunchAdmission(),
  );
  terminal.registerAdmissionCloser('analyst', () => runtimeApplication.closeAnalystAdmission());
  terminal.registerAdmissionCloser('oversight', () => runtimeApplication.closeOversightAdmission());
  terminal.registerCleanupLeaf('runtime', async () => {
    await Promise.all([
      runtimeApplication.cleanupRuntimeForApplicationStop(),
      runtimeApplication.cleanupWorkGc(),
    ]);
  });
  terminal.registerCleanupLeaf('analyst', () =>
    runtimeApplication.cleanupAnalystForApplicationStop(),
  );
  terminal.registerCleanupLeaf('oversight', () =>
    runtimeApplication.cleanupOversightForApplicationStop(),
  );
  let analystMcp: ReturnType<typeof createAnalystMcpServer> | null = null;
  if (environment.analyst.mode !== 'internal') {
    const operations = runtimeApplication.externalAnalystOperations;
    if (operations === null || externalProjectIdentity === null)
      throw new Error('External Analyst composition is incomplete.');
    analystMcp = createAnalystMcpServer({
      startup: environment.analyst,
      operations,
      fatalPort: input.fatalPort,
      onOwnerFailure: input.onExternalAnalystOwnerFailure,
      binding: {
        project_identity_digest: projectIdentityDigest(externalProjectIdentity),
        project_name: externalProjectIdentity.name,
        analyst_policy: workflows.analyst.name,
        principal: environment.analyst.principal,
      },
      context: () => ({
        mode: environment.analyst.mode,
        principal: environment.analyst.mode === 'internal' ? null : environment.analyst.principal,
        project_identity_digest: projectIdentityDigest(externalProjectIdentity),
        card_types: workflows.cardTypeVocabulary,
        runtime: runtimeApplication.runtimeApi.getStatus(),
      }),
    });
    const listener = analystMcp;
    terminal.registerAdmissionCloser('analyst-mcp', () => {
      operations.closeAdmission();
      listener.closeAdmission();
    });
    terminal.registerCleanupLeaf('analyst-mcp', async () => {
      const results = await Promise.allSettled([
        operations.cleanupForApplicationStop(),
        listener.cleanupForApplicationStop(),
      ]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    });
  }

  const mcpManager = new McpManager({
    outboundHttp,
    configAuthority: environment.configAuthority,
    processRunner,
    mcpProcessRootScope,
    eventLogger,
  });
  const mcpLifecycleIngress = new McpLifecycleIngress(
    mcpManager,
    runtimeApplication.assertWorkGcIngressAllowed,
    input.fatalPort,
  );
  terminal.registerAdmissionCloser('mcp', () => mcpManager.closeAdmission());
  terminal.registerCleanupLeaf('mcp', () => mcpManager.cleanupForApplicationStop());
  terminal.registerCleanupLeaf('sync-hub', () => syncHub.dispose());
  terminal.registerCleanupLeaf('live-sync', () => liveSyncSocket.dispose());

  const settleStartupGlobal = (sessionId: typeof analystSessionId): void => {
    try {
      settleFinalUnmatchedCall({ projectRoot }, sessionId);
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      throw new Error(
        `Strict startup global conversation '${sessionId}' is unavailable or invalid. Keep the service stopped, disable restarts, verify no owner, preserve a complete fresh stopped-project backup, then use separately consented exact-target repair where supported and restart separately. No automatic rollback or replacement history is created.`,
        { cause: error },
      );
    }
  };
  settleStartupGlobal(analystSessionId);
  const oversightSessionId = globalAgentSessionId(workflows.oversight.name);
  if (isConversationCatalogEstablished(projectRoot, oversightSessionId))
    settleStartupGlobal(oversightSessionId);
  await runtimeApplication.runtimeApi.start();
  fastify.log.info('Runtime application started');
  const mcpReconciliation = await mcpManager.reconcilePersistedConfig();
  if (!mcpReconciliation.converged)
    throw new Error('MCP startup did not converge to persisted configuration.');
  fastify.log.info('MCP manager started');
  mcpToolInvocationInstallation.installer.install(mcpManager);
  await analystMcp?.listen();

  return {
    analystMcpEndpoint: analystMcp?.endpoint ?? null,
    projectRoot,
    config,
    fastify,
    eventLogger,
    cardStore,
    runtimeApplication,
    mcpManager,
    mcpLifecycleIngress,
    liveSyncSocket,
    syncHub,
    authPolicy,
    restartCapability,
    workflows,
  };
}
