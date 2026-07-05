import { ANALYST_CONTROL_TOOLS } from './analyst-tool-registry.js';
import type { ToolContext } from './analyst-tool-types.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';

export function createAnalystControlProvider(ctx: ToolContext): ToolProvider {
  return {
    providerName: 'analyst',
    tools: ANALYST_CONTROL_TOOLS.map((tool) => defineTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input,
      executor: async (args, signal): Promise<ToolResult> => {
        if (!tool.executor) throw new Error(`Analyst tool '${tool.name}' has no executor.`);
        return tool.executor(ctx, args as Record<string, unknown>, signal);
      },
    })),
  };
}
