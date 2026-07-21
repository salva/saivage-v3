import type { CardService } from '../../src/cards/card-service.js';
import type { McpToolInvocationPort } from '../../src/mcp/mcp-manager.js';
import type { ManagedProcessScope, ProcessRunner } from '../../src/runtime/process-runner.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { createPlannerControlProvider } from '../../src/tools/planner-control-provider.js';
import { buildRoleSurface } from '../../src/tools/role-invocation-surfaces.js';

export function roleSurfaceCompileContracts(values: { store: CardService; processRunner: ProcessRunner; processScope: ManagedProcessScope; mcpToolInvocation: McpToolInvocationPort; toolContext: ToolContext }): void {
  const planner = { role: 'planner' as const, projectRoot: '/project', cardId: 'project', sessionId: 'planner:project', store: values.store, children: { get: () => null }, cancelCard: async (cardId: string) => ({ card_id: cardId, status: 'cancelled' as const, cancelled_card_ids: [cardId] }), notifyCard: () => ({ ok: true as const, notificationId: 'notification' }), beginStructuralWait: <T>(relationship: T) => relationship, endStructuralWait: () => undefined };
  buildRoleSurface(planner);
  buildRoleSurface({ role: 'reviewer', projectRoot: '/project', cardId: 'project', store: values.store, mcpToolInvocation: values.mcpToolInvocation });
  buildRoleSurface({ role: 'executor', projectRoot: '/project', cardId: 'project', ownerId: 'owner', store: values.store, processRunner: values.processRunner, processScope: values.processScope, mcpToolInvocation: values.mcpToolInvocation });
  buildRoleSurface({ role: 'analyst', toolContext: values.toolContext });

  // @ts-expect-error Planner notification capability is mandatory.
  buildRoleSurface({ ...planner, notifyCard: undefined });
  // @ts-expect-error Reviewer MCP invocation authority is mandatory.
  buildRoleSurface({ role: 'reviewer', projectRoot: '/project', cardId: 'project', store: values.store });
  // @ts-expect-error Executor process scope is mandatory.
  buildRoleSurface({ role: 'executor', projectRoot: '/project', cardId: 'project', ownerId: 'owner', store: values.store, processRunner: values.processRunner, mcpToolInvocation: values.mcpToolInvocation });
  // @ts-expect-error Executor process runner is mandatory.
  buildRoleSurface({ role: 'executor', projectRoot: '/project', cardId: 'project', ownerId: 'owner', store: values.store, processScope: values.processScope, mcpToolInvocation: values.mcpToolInvocation });
  // @ts-expect-error Analyst tool context is mandatory.
  buildRoleSurface({ role: 'analyst' });
  // @ts-expect-error Reviewer does not accept autonomous session identity.
  buildRoleSurface({ role: 'reviewer', projectRoot: '/project', cardId: 'project', sessionId: 'reviewer:project', store: values.store, mcpToolInvocation: values.mcpToolInvocation });
  // @ts-expect-error Planner provider notification capability is mandatory.
  createPlannerControlProvider({ projectRoot: '/project', parentCardId: 'project', sessionId: 'planner:project', store: values.store, children: planner.children, cancelCard: planner.cancelCard, beginStructuralWait: planner.beginStructuralWait, endStructuralWait: planner.endStructuralWait });
  // @ts-expect-error Planner provider has no app-log dependency.
  createPlannerControlProvider({ projectRoot: '/project', parentCardId: 'project', sessionId: 'planner:project', store: values.store, children: planner.children, cancelCard: planner.cancelCard, notifyCard: planner.notifyCard, appLogs: { projectRoot: '/project' }, beginStructuralWait: planner.beginStructuralWait, endStructuralWait: planner.endStructuralWait });
}
