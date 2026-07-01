import type { ControlActionSurface } from '../schemas/index.js';
import type { ToolContext } from './analyst-tool-types.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';
import { TOOL_DEFINITIONS } from './definitions/index.js';
import { toolFailureFromError } from './analyst-tool-helpers.js';
import { RoleToolPolicy } from '../agents/role-tool-policy.js';

export interface AnalystProviderContext {
  readonly toolContext: ToolContext;
  readonly surface: ControlActionSurface;
}

export function createAnalystProvider(ctx: AnalystProviderContext): ToolProvider {
  return {
    providerName: 'analyst',
    tools: TOOL_DEFINITIONS
      .filter((tool) => tool.roles.includes('analyst') && !tool.workspace)
      .filter((tool) => RoleToolPolicy.assertAnalystSurfaceTool(tool.name, ctx.surface).allowed)
      .map((tool) => defineTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.input,
        executor: async (args): Promise<ToolResult> => {
          if (!tool.executor) throw new Error(`Analyst tool '${tool.name}' has no executor.`);
          try {
            const result = await tool.executor(ctx.toolContext, args as Record<string, unknown>);
            if (result.success) return { success: true, data: result.data, preview: result.preview };
            return { success: false, error: result.error ?? result.errorEnvelope?.message ?? 'Tool failed.', data: result.data, preview: result.preview, errorEnvelope: result.errorEnvelope };
          } catch (error) {
            const result = toolFailureFromError(error);
            return { success: false, error: result.error ?? result.errorEnvelope?.message ?? 'Tool failed.', data: result.data, preview: result.preview, errorEnvelope: result.errorEnvelope };
          }
        },
      })),
  };
}
