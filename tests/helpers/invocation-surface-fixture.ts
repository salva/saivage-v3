import type { AgentName } from '../../src/schemas/index.js';
import type { InvocationSurface, ToolDefinition, ToolProvider } from '../../src/tools/invocation.js';

export function buildInvocationSurfaceFixture(agentName: AgentName, providers: readonly ToolProvider[]): InvocationSurface {
  const tools = new Map<string, ToolDefinition<any>>();
  for (const provider of providers) {
    for (const tool of provider.tools) tools.set(tool.name, tool);
  }
  return { agentName, tools, providers };
}
