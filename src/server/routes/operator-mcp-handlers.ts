import type { OperatorApiSuccess } from '../../contracts/index.js';
import type { OperatorMcpProviderContext } from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';
import { projectMcpToolsForOutbound } from '../../mcp/tool-api.js';

export function buildMcpOperatorContractHandlers(options: OperatorMcpProviderContext) {
  return defineOperatorContractHandlers({
    'mcp.tools': () => {
      const body: OperatorApiSuccess<'mcp.tools'> = projectMcpToolsForOutbound(
        options.mcpToolsProvider.getToolsReadModel(),
      );
      return { body };
    },
  });
}
