import type {
  OperatorApiSuccess,
} from '../../contracts/index.js';
import type {
  OperatorMcpProviderContext,
} from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';
import { redactForOutbound } from '../../redaction/index.js';

export function buildMcpOperatorContractHandlers(options: OperatorMcpProviderContext) {
  return defineOperatorContractHandlers({
    'mcp.tools': () => {
      const body: OperatorApiSuccess<'mcp.tools'> = redactForOutbound({
        source: 'mcp-tools',
        value: options.mcpToolsProvider?.getToolsReadModel()
          ?? { servers: [] },
      });
      return { body };
    },
  });
}
