import type { CardService } from '../cards/card-service.js';
import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import type { AppLogContext } from '../persistence/app-log.js';
import type { CardNotification } from '../schemas/index.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import type { ManagedProcessScope, ProcessRunner } from '../runtime/process-runner.js';
import type { ToolContext } from './analyst-tool-types.js';
import { createAnalystControlProvider } from './analyst-control-provider.js';
import { createCardHistoryProvider } from './card-history-provider.js';
import { createCardInspectionProvider } from './card-inspection-provider.js';
import { buildInvocationSurface, type InvocationSurface } from './invocation.js';
import { createMcpProvider } from './mcp-provider.js';
import { createPlannerControlProvider, type PlannerControlProviderContext } from './planner-control-provider.js';
import { createProcessProvider } from './process-provider.js';
import { createSkillProvider } from './skill-provider.js';
import { createWebProvider } from './web-tools.js';
import { createAnalystPatchProvider, createAnalystWorkspaceProvider, createPatchProvider, createWorkspaceProvider } from './workspace-provider.js';

type PlannerRoleSurfaceContext = {
  readonly role: 'planner';
  readonly projectRoot: string;
  readonly cardId: string;
  readonly sessionId: string;
  readonly store: CardService;
  readonly children: PlannerControlProviderContext['children'];
  readonly cancelCard: PlannerControlProviderContext['cancelCard'];
  readonly notifyCard: (cardId: string, notification: CardNotification) => NotifyCardResult;
  readonly appLogs: AppLogContext;
  readonly beginStructuralWait: PlannerControlProviderContext['beginStructuralWait'];
  readonly endStructuralWait: PlannerControlProviderContext['endStructuralWait'];
};

type ReviewerRoleSurfaceContext = {
  readonly role: 'reviewer';
  readonly projectRoot: string;
  readonly cardId: string;
  readonly store: CardService;
  readonly mcpToolInvocation: McpToolInvocationPort;
};

type ExecutorRoleSurfaceContext = {
  readonly role: 'executor';
  readonly projectRoot: string;
  readonly cardId: string;
  readonly ownerId: string;
  readonly store: CardService;
  readonly processRunner: ProcessRunner;
  readonly processScope: ManagedProcessScope;
  readonly mcpToolInvocation: McpToolInvocationPort;
};

type AnalystRoleSurfaceContext = {
  readonly role: 'analyst';
  readonly toolContext: ToolContext;
};

export type RoleSurfaceContext = PlannerRoleSurfaceContext | ReviewerRoleSurfaceContext | ExecutorRoleSurfaceContext | AnalystRoleSurfaceContext;

export function buildRoleSurface(context: RoleSurfaceContext): InvocationSurface {
  switch (context.role) {
    case 'planner':
      return buildInvocationSurface(context.role, [
        createPlannerControlProvider({ projectRoot: context.projectRoot, parentCardId: context.cardId, sessionId: context.sessionId, store: context.store, children: context.children, cancelCard: context.cancelCard, notifyCard: context.notifyCard, appLogs: context.appLogs, beginStructuralWait: context.beginStructuralWait, endStructuralWait: context.endStructuralWait }),
        createCardInspectionProvider({ store: context.store }),
        createWorkspaceProvider({ projectRoot: context.projectRoot, cardId: context.cardId, agentRole: context.role, store: context.store, notifyCard: undefined }),
        createCardHistoryProvider({ store: context.store }),
        createWebProvider({ projectRoot: context.projectRoot, cardId: context.cardId, agentRole: context.role, store: context.store, notifyCard: undefined }),
      ]);
    case 'reviewer':
      return buildInvocationSurface(context.role, [
        createWorkspaceProvider({ projectRoot: context.projectRoot, cardId: context.cardId, agentRole: context.role, store: context.store, notifyCard: undefined }),
        createCardHistoryProvider({ store: context.store }),
        createWebProvider({ projectRoot: context.projectRoot, cardId: context.cardId, agentRole: context.role, store: context.store, notifyCard: undefined }),
        createSkillProvider({ projectRoot: context.projectRoot, agentRole: context.role }),
        createMcpProvider({ mcpToolInvocation: context.mcpToolInvocation, agentRole: context.role }),
      ]);
    case 'executor':
      return buildInvocationSurface(context.role, [
        createWorkspaceProvider({ projectRoot: context.projectRoot, cardId: context.cardId, agentRole: context.role, store: context.store, notifyCard: undefined }),
        createPatchProvider({ projectRoot: context.projectRoot, cardId: context.cardId, agentRole: context.role, store: context.store }),
        createProcessProvider({ projectRoot: context.projectRoot, processRunner: context.processRunner, directScope: context.processScope, category: 'runtime_card', ownerId: context.ownerId, ownerKind: 'agent', cardId: context.cardId }),
        createCardHistoryProvider({ store: context.store }),
        createWebProvider({ projectRoot: context.projectRoot, cardId: context.cardId, agentRole: context.role, store: context.store, notifyCard: undefined }),
        createSkillProvider({ projectRoot: context.projectRoot, agentRole: context.role }),
        createMcpProvider({ mcpToolInvocation: context.mcpToolInvocation, agentRole: context.role }),
      ]);
    case 'analyst': {
      const toolContext = context.toolContext;
      return buildInvocationSurface(context.role, [
        createAnalystControlProvider(toolContext),
        createCardInspectionProvider({ store: toolContext.store }),
        createCardHistoryProvider({ store: toolContext.store }),
        createAnalystWorkspaceProvider(toolContext),
        createAnalystPatchProvider(toolContext),
        createProcessProvider({ projectRoot: toolContext.projectRoot, processRunner: toolContext.processRunner, directScope: toolContext.processScope, category: 'operator_session', ownerId: toolContext.sessionId ?? 'analyst', agentRole: context.role, ownerKind: 'operator', launchReason: 'analyst workspace run_command' }),
        createWebProvider({ projectRoot: toolContext.projectRoot, agentRole: context.role, store: toolContext.store, notifyCard: undefined, analystToolContext: toolContext }),
        createSkillProvider({ projectRoot: toolContext.projectRoot, agentRole: context.role }),
        createMcpProvider({ mcpToolInvocation: toolContext.mcpToolInvocation, agentRole: context.role }),
      ]);
    }
  }
}
