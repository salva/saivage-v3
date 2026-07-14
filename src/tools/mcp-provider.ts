import { z } from 'zod';

import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import { defineTool, type ToolProvider } from './invocation.js';

export interface McpProviderContext {
  readonly mcpManagerProvider: () => McpToolInvocationPort | undefined;
  readonly agentRole: 'executor' | 'reviewer' | 'analyst';
}

const mcpToolCallSchema = z.object({
  serverName: z.string(),
  toolName: z.string(),
  args: z.record(z.unknown()).optional(),
}).strict();

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
        inputSchema: mcpToolCallSchema,
        executor: async (args) => {
          try {
            const manager = ctx.mcpManagerProvider();
            if (!manager) return { success: false, error: 'MCP manager is not available for this runtime.' };
            assertReviewerMayCall(ctx, args.serverName, args.toolName, manager);
            return { success: true, data: await manager.invokeTool(args.serverName, args.toolName, args.args ?? {}) };
          } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      }),
    ],
  };
}
