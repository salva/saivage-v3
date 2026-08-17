import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import { McpToolInvocationNotInstalledError } from '../mcp/tool-invocation-installation.js';
import { defineToolBinder, noneToolExecution, type ToolBinder } from './invocation.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import { McpToolCallArgumentsSchema } from '../contracts/mcp-invocation.js';
import { MCP_TOOL_RESULT_POLICY_TEMPLATE } from '../runtime/actors/llm-invocation.js';

export interface McpProviderContext {
  readonly mcpToolInvocation: McpToolInvocationPort;
}

export const mcpToolBinders: readonly ToolBinder<McpProviderContext, any>[] = Object.freeze([
  defineToolBinder({
    name: 'mcp_tool_call',
    description: 'Call an MCP tool on a configured MCP server.',
    inputSchema: () => McpToolCallArgumentsSchema,
    resultPolicyTemplate: MCP_TOOL_RESULT_POLICY_TEMPLATE,
    executor: async (ctx, args) => {
      try {
        const data = await ctx.mcpToolInvocation.invokeTool(args.serverName, args.toolName, args.args ?? {});
        return noneToolExecution({ success: true, data });
      } catch (error) {
        throwIfPublicationOutcomeUnknown(error);
        if (error instanceof McpToolInvocationNotInstalledError) throw error;
        return noneToolExecution({ success: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  }),
]);
