import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import { McpToolInvocationNotInstalledError } from '../mcp/tool-invocation-installation.js';
import { defineToolBinder, executedProviderResult, MCP_RESULT_POLICY_TEMPLATE, type ToolBinder, type ToolExecutionResult } from './invocation.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import { McpToolCallArgumentsSchema } from '../contracts/mcp-invocation.js';

export interface McpProviderContext {
  readonly mcpToolInvocation: McpToolInvocationPort;
}

export const mcpToolBinders: readonly ToolBinder<McpProviderContext, any>[] = Object.freeze([
  defineToolBinder({
    name: 'mcp_tool_call',
    description: 'Call an MCP tool on a configured MCP server.',
    resultPolicyTemplate: MCP_RESULT_POLICY_TEMPLATE,
    inputSchema: () => McpToolCallArgumentsSchema,
    executor: async (ctx, args): Promise<ToolExecutionResult<'none'>> => {
      try {
        const data = await ctx.mcpToolInvocation.invokeTool(args.serverName, args.toolName, args.args ?? {});
        return executedProviderResult('none', { success: true, data });
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (error instanceof McpToolInvocationNotInstalledError) throw error;
        return executedProviderResult('none', { success: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  }),
]);
