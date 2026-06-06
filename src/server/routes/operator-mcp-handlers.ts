import type {
  OperatorAvailabilityContext,
  OperatorContractHandlerMap,
  OperatorMcpProviderContext,
} from './operator-handler-context.js';

export function buildMcpOperatorContractHandlers(options: OperatorMcpProviderContext & OperatorAvailabilityContext): OperatorContractHandlerMap {
  return {
    'mcp.status': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      return { body: { servers: options.mcpStatusProvider?.getStatus() ?? [], ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'mcp.tools': () => ({ body: options.mcpToolsProvider?.getToolsReadModel() ?? { tools: [], servers: [], invocationStats: {}, serverDetails: [] } }),
  };
}
