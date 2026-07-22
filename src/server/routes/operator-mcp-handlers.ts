import type {
  OperatorApiSuccess,
} from '../../contracts/index.js';
import type {
  OperatorAvailabilityContext,
  OperatorMcpProviderContext,
} from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';
import { redactForOutbound } from '../../redaction/index.js';

export function buildMcpOperatorContractHandlers(options: OperatorMcpProviderContext & OperatorAvailabilityContext) {
  return defineOperatorContractHandlers({
    'mcp.status': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      const body: OperatorApiSuccess<'mcp.status'> = redactForOutbound({ source: 'mcp-status', value: {
        servers: options.mcpStatusProvider?.getStatus() ?? [],
        ...(serverAvailability ? { serverAvailability } : {}),
      } });
      return { body };
    },
    'mcp.tools': () => {
      const body: OperatorApiSuccess<'mcp.tools'> = redactForOutbound({
        source: 'mcp-tools',
        value: options.mcpToolsProvider?.getToolsReadModel()
          ?? { tools: [], servers: [], invocationStats: {}, serverDetails: [] },
      });
      return { body };
    },
  });
}
