import type { CardService } from '../cards/card-service.js';
import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import type { CardNotification } from '../schemas/index.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import type { ManagedProcessScope, ProcessRunner } from '../runtime/process-runner.js';
import type { ToolContext } from './analyst-tool-types.js';
import { createAnalystControlProvider } from './analyst-control-provider.js';
import { createCardHistoryProvider } from './card-history-provider.js';
import { createCardInspectionProvider } from './card-inspection-provider.js';
import { composeInvocationSurface, type InvocationSurface, type ToolProvider } from './invocation.js';
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
  readonly parentControl: PlannerControlProviderContext['parentControl'];
  readonly notifyCard: (cardId: string, notification: CardNotification) => NotifyCardResult;
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

const roleToolNames = Object.freeze({
  planner: Object.freeze(['create_card', 'edit_card', 'cancel_card', 'activate_card', 'reorder_child', 'queue_notification', 'list_cards', 'get_card', 'get_tree', 'read', 'write', 'edit', 'glob', 'grep', 'list_card_history', 'get_card_history_entry', 'diff_card', 'websearch', 'webfetch']),
  reviewer: Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'list_card_history', 'get_card_history_entry', 'diff_card', 'websearch', 'webfetch', 'skill', 'mcp_tool_call']),
  executor: Object.freeze(['read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'list_card_history', 'get_card_history_entry', 'diff_card', 'websearch', 'webfetch', 'skill', 'mcp_tool_call']),
  analyst: Object.freeze(['create_card', 'reorder_child', 'queue_notification', 'get_status', 'start_project', 'pause_runtime', 'resume_runtime', 'stop_project', 'navigate_workspace', 'navigate_back', 'show_config', 'reconfigure', 'mcp_reconcile', 'read_runtime_events', 'read_runtime_errors', 'read_control_actions', 'list_processes_tool', 'list_agent_sessions', 'read_agent_session', 'cancel_card', 'delete_card', 'list_cards', 'get_card', 'get_tree', 'list_card_history', 'get_card_history_entry', 'diff_card', 'read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'websearch', 'webfetch', 'skill', 'mcp_tool_call']),
} satisfies Record<RoleSurfaceContext['role'], readonly string[]>);

function composeRoleSurface(role: RoleSurfaceContext['role'], providers: readonly ToolProvider[]): InvocationSurface {
  return composeInvocationSurface(role, roleToolNames[role], providers);
}

function currentAnalystToolNames(restartServerAvailable: boolean): readonly string[] {
  if (!restartServerAvailable) return roleToolNames.analyst;
  const insertion = roleToolNames.analyst.indexOf('stop_project') + 1;
  return [...roleToolNames.analyst.slice(0, insertion), 'restart_server', ...roleToolNames.analyst.slice(insertion)];
}

export function buildRoleSurface(context: RoleSurfaceContext): InvocationSurface {
  switch (context.role) {
    case 'planner':
      return composeRoleSurface(context.role, [
        createPlannerControlProvider({ projectRoot: context.projectRoot, parentCardId: context.cardId, sessionId: context.sessionId, store: context.store, parentControl: context.parentControl, notifyCard: context.notifyCard }),
        createCardInspectionProvider({ store: context.store }),
        createWorkspaceProvider({ projectRoot: context.projectRoot, cardId: context.cardId, agentRole: context.role, store: context.store, notifyCard: undefined }),
        createCardHistoryProvider({ store: context.store }),
        createWebProvider({ projectRoot: context.projectRoot, cardId: context.cardId, agentRole: context.role, store: context.store, notifyCard: undefined }),
      ]);
    case 'reviewer':
      return composeRoleSurface(context.role, [
        createWorkspaceProvider({ projectRoot: context.projectRoot, cardId: context.cardId, agentRole: context.role, store: context.store, notifyCard: undefined }),
        createCardHistoryProvider({ store: context.store }),
        createWebProvider({ projectRoot: context.projectRoot, cardId: context.cardId, agentRole: context.role, store: context.store, notifyCard: undefined }),
        createSkillProvider({ projectRoot: context.projectRoot, agentRole: context.role }),
        createMcpProvider({ mcpToolInvocation: context.mcpToolInvocation, agentRole: context.role }),
      ]);
    case 'executor':
      return composeRoleSurface(context.role, [
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
      const providers = [
        createAnalystControlProvider(toolContext),
        createCardInspectionProvider({ store: toolContext.store }),
        createCardHistoryProvider({ store: toolContext.store }),
        createAnalystWorkspaceProvider(toolContext),
        createAnalystPatchProvider(toolContext),
        createProcessProvider({ projectRoot: toolContext.projectRoot, processRunner: toolContext.processRunner, directScope: toolContext.processScope, category: 'operator_session', ownerId: toolContext.sessionId ?? 'analyst', ownerKind: 'operator' }),
        createWebProvider({ projectRoot: toolContext.projectRoot, agentRole: context.role, store: toolContext.store, notifyCard: undefined, analystToolContext: toolContext }),
        createSkillProvider({ projectRoot: toolContext.projectRoot, agentRole: context.role }),
        createMcpProvider({ mcpToolInvocation: toolContext.mcpToolInvocation, agentRole: context.role }),
      ];
      return composeInvocationSurface(context.role, currentAnalystToolNames(toolContext.restartServerAvailable), providers);
    }
  }
}
