import { McpManager, MCP_OPERATIONS, type McpCaller } from '../../src/mcp/manager-api.js';
import { readCanonicalLiveCardPath } from '../../src/persistence/index.js';
import { initProjectTree } from './canonical-project.js';

export const PROJECT_MCP_ENTRY_POLICY = {
  format_version: 1,
  get policy() { return { controllerCardId: 'project', exposure: 'subtree' as const }; },
} as const;

export const READY_PROJECT_MCP_STATUS = {
  policy: { controllerCardId: 'project', exposure: 'subtree' as const },
  availableActions: [], ready: true, containment: 'open' as const,
  failureReason: null, containmentBoundary: 'local_process_group' as const,
};

type BoundMethod<T> = T extends (caller: McpCaller, ...args: infer A) => infer R ? (...args: A) => R : never;
type McpTestParticipant = {
  [K in 'registerServer' | 'replaceServer' | 'unregisterServer' | 'setServerScope' |
  'startServer' | 'stopServer' | 'restartServer' | 'getStatus' | 'getServerStatus' |
  'getServerCatalog' | 'refreshServerCatalog' | 'invokeTool' | 'getToolsReadModel']: BoundMethod<McpManager[K]>
} & Pick<McpManager, 'getInvocationStats' | 'reconcilePersistedConfig' | 'closeAdmission' |
  'cleanupForApplicationStop' | 'hasPendingReconciliation' | 'hasWorkGcBlocker'> & { owner: McpManager };

/** Explicit root-card participant for tests concerned with transports rather than grants. */
export function createRootCardMcpFixture(options: Omit<ConstructorParameters<typeof McpManager>[0], 'readCanonicalLivePath'>): McpTestParticipant {
  const root = options.processRunner.projectRoot;
  initProjectTree(root);
  const manager = new McpManager({ ...options,
    readCanonicalLivePath: (id) => readCanonicalLiveCardPath(root, id),
  });
  const caller: McpCaller = { principal: { kind: 'card', cardId: 'project' }, operations: MCP_OPERATIONS };
  return bindMcpTestCaller(manager, caller);
}

/** Explicit test participant; never installed as an invocation port. */
export function bindMcpTestCaller(manager: McpManager, caller: McpCaller): McpTestParticipant {
  return {
    owner: manager,
    registerServer: manager.registerServer.bind(manager, caller),
    replaceServer: manager.replaceServer.bind(manager, caller),
    unregisterServer: manager.unregisterServer.bind(manager, caller),
    setServerScope: manager.setServerScope.bind(manager, caller),
    startServer: manager.startServer.bind(manager, caller),
    stopServer: manager.stopServer.bind(manager, caller),
    restartServer: manager.restartServer.bind(manager, caller),
    getStatus: manager.getStatus.bind(manager, caller),
    getServerStatus: manager.getServerStatus.bind(manager, caller),
    getServerCatalog: manager.getServerCatalog.bind(manager, caller),
    refreshServerCatalog: manager.refreshServerCatalog.bind(manager, caller),
    invokeTool: manager.invokeTool.bind(manager, caller),
    getInvocationStats: manager.getInvocationStats.bind(manager),
    getToolsReadModel: manager.getToolsReadModel.bind(manager, {
      principal: { kind: 'operator' }, operations: MCP_OPERATIONS,
    }),
    reconcilePersistedConfig: manager.reconcilePersistedConfig.bind(manager),
    closeAdmission: manager.closeAdmission.bind(manager),
    cleanupForApplicationStop: manager.cleanupForApplicationStop.bind(manager),
    hasPendingReconciliation: manager.hasPendingReconciliation.bind(manager),
    hasWorkGcBlocker: manager.hasWorkGcBlocker.bind(manager),
  };
}
