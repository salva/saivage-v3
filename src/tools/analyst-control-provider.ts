import { createAnalystControlTools } from './analyst-tool-registry.js';
import { evaluateAuthz } from '../agents/authz.js';
import type { ToolContext } from './analyst-tool-types.js';
import type { ToolProvider } from './invocation.js';

export function createAnalystControlProvider(ctx: ToolContext): ToolProvider {
  return {
    providerName: 'analyst',
    tools: createAnalystControlTools(ctx).filter((tool) => tool.name !== 'restart_server'
      || (ctx.restartServerAvailable && evaluateAuthz({ actor: ctx.actor, surface: ctx.surface, safety_class: 'destructive' }) === 'allow')),
  };
}
