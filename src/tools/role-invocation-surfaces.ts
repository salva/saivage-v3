import type { AgentRole } from '../schemas/index.js';
import type { CardService } from '../cards/card-service.js';
import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import type { ManagedProcessScope, ProcessRunner } from '../runtime/process-runner.js';
import type { CardNotification } from '../schemas/index.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import type { ToolContext } from './analyst-tool-types.js';
import { createAnalystControlProvider } from './analyst-control-provider.js';
import { createCardHistoryProvider } from './card-history-provider.js';
import { createCardInspectionProvider } from './card-inspection-provider.js';
import { buildInvocationSurface, type InvocationSurface, type ToolProvider } from './invocation.js';
import { createMcpProvider } from './mcp-provider.js';
import { createPlannerControlProvider, type PlannerControlProviderContext } from './planner-control-provider.js';
import { createProcessProvider } from './process-provider.js';
import { createSkillProvider } from './skill-provider.js';
import { createWebProvider } from './web-tools.js';
import { createAnalystPatchProvider, createAnalystWorkspaceProvider, createPatchProvider, createWorkspaceProvider } from './workspace-provider.js';
import type { AppLogContext } from '../persistence/app-log.js';

export type RoleSurfaceRole = Extract<AgentRole, 'planner' | 'reviewer' | 'executor' | 'analyst'>;
type ProviderName = 'plannerControl' | 'analystControl' | 'cardInspection' | 'workspace' | 'patch' | 'process' | 'cardHistory' | 'web' | 'skill' | 'mcp';
type SkillMcpRole = Extract<RoleSurfaceRole, 'reviewer' | 'executor' | 'analyst'>;

export interface RoleSurfaceContext {
  projectRoot: string;
  cardId?: string;
  sessionId?: string;
  store: CardService;
  processRunner?: ProcessRunner;
  ownerId?: string;
  processScope?: ManagedProcessScope;
  mcpManagerProvider?: () => McpToolInvocationPort | undefined;
  children?: PlannerControlProviderContext['children'];
  cancelCard?: PlannerControlProviderContext['cancelCard'];
  notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult;
  toolContext?: ToolContext;
  appLogs?: AppLogContext;
}

export const ROLE_PROVIDER_ORDER: Readonly<Record<RoleSurfaceRole, readonly ProviderName[]>> = {
  planner: ['plannerControl', 'cardInspection', 'workspace', 'cardHistory', 'web'],
  reviewer: ['workspace', 'cardHistory', 'web', 'skill', 'mcp'],
  executor: ['workspace', 'patch', 'process', 'cardHistory', 'web', 'skill', 'mcp'],
  analyst: ['analystControl', 'cardInspection', 'cardHistory', 'workspace', 'patch', 'process', 'web', 'skill', 'mcp'],
};

const PROVIDER_CONSTRUCTORS: Readonly<Record<ProviderName, (ctx: RoleSurfaceContext, role: RoleSurfaceRole) => ToolProvider>> = {
  plannerControl: (ctx) => createPlannerControlProvider({
    projectRoot: ctx.projectRoot,
    parentCardId: ctx.cardId!,
    sessionId: ctx.sessionId!,
    store: ctx.store,
    children: ctx.children!,
    cancelCard: ctx.cancelCard!,
    notifyCard: ctx.notifyCard,
    appLogs: ctx.appLogs!,
  }),
  analystControl: (ctx) => createAnalystControlProvider(ctx.toolContext!),
  cardInspection: (ctx, role) => createCardInspectionProvider({
    projectRoot: ctx.projectRoot,
    store: ctx.store,
    agentRole: role,
  }),
  workspace: (ctx, role) => role === 'analyst' ? createAnalystWorkspaceProvider(ctx.toolContext!) : createWorkspaceProvider({
    projectRoot: ctx.projectRoot,
    cardId: ctx.cardId,
    agentRole: role,
    store: ctx.store,
    notifyCard: undefined,
  }),
  patch: (ctx, role) => role === 'analyst' ? createAnalystPatchProvider(ctx.toolContext!) : createPatchProvider({
    projectRoot: ctx.projectRoot,
    cardId: ctx.cardId,
    agentRole: role,
    store: ctx.store,
  }),
  process: (ctx, role) => role === 'analyst'
    ? createProcessProvider({ projectRoot: ctx.projectRoot, processRunner: ctx.processRunner!, directScope: ctx.processScope!, category: 'operator_session', ownerId: ctx.ownerId ?? ctx.sessionId ?? 'analyst', agentRole: 'analyst', ownerKind: 'operator', launchReason: 'analyst workspace run_command' })
    : createProcessProvider({ projectRoot: ctx.projectRoot, processRunner: ctx.processRunner!, directScope: ctx.processScope!, category: 'runtime_card', ownerId: ctx.ownerId ?? ctx.sessionId!, ownerKind: 'agent', cardId: ctx.cardId }),
  cardHistory: (ctx, role) => createCardHistoryProvider({
    projectRoot: ctx.projectRoot,
    store: ctx.store,
    sessionId: ctx.sessionId,
    agentRole: role,
  }),
  web: (ctx, role) => createWebProvider({
    projectRoot: ctx.projectRoot,
    cardId: ctx.cardId,
    agentRole: role,
    store: ctx.store,
    notifyCard: undefined,
    analystToolContext: role === 'analyst' ? ctx.toolContext : undefined,
  }),
  skill: (ctx, role) => createSkillProvider({ projectRoot: ctx.projectRoot, agentRole: role as SkillMcpRole }),
  mcp: (ctx, role) => createMcpProvider({ mcpManagerProvider: ctx.mcpManagerProvider!, agentRole: role as SkillMcpRole }),
};

export function buildRoleSurface(role: RoleSurfaceRole, ctx: RoleSurfaceContext): InvocationSurface {
  const providers = ROLE_PROVIDER_ORDER[role].map((name) => PROVIDER_CONSTRUCTORS[name](ctx, role));
  return buildInvocationSurface(role, providers);
}
