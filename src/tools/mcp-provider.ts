import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import { McpToolInvocationNotInstalledError } from '../mcp/tool-invocation-installation.js';
import { defineTool, type ToolProvider } from './invocation.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import { McpToolCallArgumentsSchema } from '../contracts/mcp-invocation.js';

export interface McpProviderContext {
  readonly mcpToolInvocation: McpToolInvocationPort;
}

export function createMcpProvider(ctx: McpProviderContext): ToolProvider {
  return {
    providerName: 'mcp',
    tools: [
      defineTool({
        name: 'mcp_tool_call',
        description: 'Call an MCP tool on a configured MCP server.',
        inputSchema: McpToolCallArgumentsSchema,
        executor: async (args) => {
          try {
            const data = await ctx.mcpToolInvocation.invokeTool(args.serverName, args.toolName, args.args ?? {});
            return { success: true, data };
          } catch (error) {
            throwIfPublicationOutcomeUnknown(error);
            if (error instanceof McpToolInvocationNotInstalledError) throw error;
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      }),
    ],
  };
}
