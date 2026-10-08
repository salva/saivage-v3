import type { OperatorApiSuccess } from '../../contracts/index.js';
import type { OperatorMcpProviderContext } from './operator-handler-context.js';
import { defineOperatorContractHandlers } from './operator-handler-context.js';
import { McpLifecycleError, projectMcpToolsForOutbound } from '../../mcp/tool-api.js';
import { redactTextForOutbound } from '../../redaction/index.js';

export function buildMcpOperatorContractHandlers(options: OperatorMcpProviderContext) {
  return defineOperatorContractHandlers({
    'mcp.start': async ({ params }) => {
      try {
        return { body: await options.mcpLifecycle.startServer(params.name) };
      } catch (error) {
        if (!(error instanceof McpLifecycleError)) throw error;
        return {
          statusCode: error.statusCode as 404 | 409,
          body: {
            error: error.code as 'MCP_NOT_FOUND' | 'MCP_CONFLICT',
            message: redactTextForOutbound(error.message),
          },
        };
      }
    },
    'mcp.stop': async ({ params }) => {
      try {
        return { body: await options.mcpLifecycle.stopServer(params.name) };
      } catch (error) {
        if (!(error instanceof McpLifecycleError)) throw error;
        return {
          statusCode: error.statusCode as 404 | 409,
          body: {
            error: error.code as 'MCP_NOT_FOUND' | 'MCP_CONFLICT',
            message: redactTextForOutbound(error.message),
          },
        };
      }
    },
    'mcp.tools': () => {
      const body: OperatorApiSuccess<'mcp.tools'> = projectMcpToolsForOutbound(
        options.mcpToolsProvider.getToolsReadModel(),
      );
      return { body };
    },
  });
}
