import { createAnalystControlTools } from './analyst-tool-registry.js';
import type { ToolContext } from './analyst-tool-types.js';
import type { ToolProvider } from './invocation.js';

export function createAnalystControlProvider(ctx: ToolContext): ToolProvider {
  return {
    providerName: 'analyst',
    tools: createAnalystControlTools(ctx),
  };
}
