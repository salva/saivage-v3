import type { McpStatusProvider, McpToolsReadModelProvider } from '../../mcp/manager-api.js';
import { buildServerAvailability } from '../availability.js';
import type { ContractHandler } from '../contract-runtime.js';
import type { operatorApiContracts } from '../../contracts/index.js';

export function buildMcpOperatorContractHandlers(options: {
  mcpStatusProvider?: () => McpStatusProvider | undefined;
  mcpToolsProvider?: () => McpToolsReadModelProvider | undefined;
  serverAvailabilityProvider?: () => ReturnType<typeof buildServerAvailability>;
}): Partial<Record<keyof typeof operatorApiContracts, ContractHandler>> {
  return {
    'mcp.status': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      const provider = options.mcpStatusProvider?.();
      return { body: { servers: provider?.getStatus() ?? [], ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'mcp.tools': () => ({ body: options.mcpToolsProvider?.()?.getToolsReadModel() ?? { tools: [], servers: [], invocationStats: {}, serverDetails: [] } }),
  };
}
