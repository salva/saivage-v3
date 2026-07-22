import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import { McpToolInvocationNotInstalledError } from '../mcp/tool-invocation-installation.js';
import { defineTool, type ToolProvider } from './invocation.js';
import { rethrowAppLogPublicationError } from '../persistence/app-log.js';
import { McpToolCallArgumentsSchema } from '../contracts/mcp-invocation.js';

export interface McpProviderContext {
  readonly mcpToolInvocation: McpToolInvocationPort;
  readonly agentRole: 'executor' | 'reviewer' | 'analyst';
}

function assertReviewerMayCall(ctx: McpProviderContext, serverName: string, toolName: string, manager: McpToolInvocationPort): void {
  if (ctx.agentRole !== 'reviewer') return;
  const capability = manager.findToolCapability(serverName, toolName);
  if (!capability?.annotations) throw new Error(`MCP tool '${serverName}/${toolName}' is missing metadata required for reviewer access.`);
  if (capability.annotations.destructiveHint === true) throw new Error(`Reviewer cannot call destructive MCP tool '${serverName}/${toolName}'.`);
  if (capability.annotations.readOnlyHint !== true) throw new Error(`Reviewer can only call read-only MCP tool '${serverName}/${toolName}'.`);
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
            assertReviewerMayCall(ctx, args.serverName, args.toolName, ctx.mcpToolInvocation);
            const data = await ctx.mcpToolInvocation.invokeTool(args.serverName, args.toolName, args.args ?? {});
            return { success: true, data };
          } catch (error) {
            rethrowAppLogPublicationError(error);
            if (error instanceof McpToolInvocationNotInstalledError) throw error;
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      }),
    ],
  };
}
