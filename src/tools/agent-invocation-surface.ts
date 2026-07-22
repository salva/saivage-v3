import type { CardService } from '../cards/card-service.js';
import type { McpToolInvocationPort } from '../mcp/mcp-manager.js';
import type { AgentName, CardNotification } from '../schemas/index.js';
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

export interface AgentSurfaceContext {
  readonly agentName: AgentName;
  readonly toolNames: readonly string[];
  readonly projectRoot: string;
  readonly store: CardService;
  readonly cardId?: string;
  readonly sessionId?: string;
  readonly parentControl?: PlannerControlProviderContext['parentControl'];
  readonly childCreationTypes?:ReadonlySet<import('../schemas/index.js').CardType>;
  readonly childActivationTypes?:ReadonlySet<import('../schemas/index.js').CardType>;
  readonly notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult;
  readonly processRunner?: ProcessRunner;
  readonly processScope?: ManagedProcessScope;
  readonly processOwnerId?: string;
  readonly mcpToolInvocation?: McpToolInvocationPort;
  readonly analystToolContext?: ToolContext;
}

function any(names: ReadonlySet<string>, candidates: readonly string[]): boolean { return candidates.some((name) => names.has(name)); }

export function buildAgentSurface(context: AgentSurfaceContext): InvocationSurface {
  const requested = new Set(context.toolNames);
  const providers: ToolProvider[] = [];
  if (context.analystToolContext) providers.push(createAnalystControlProvider(context.analystToolContext));
  if (any(requested, ['create_card','edit_card','cancel_card','activate_card','reorder_child','queue_notification']) && !context.analystToolContext) {
    if (!context.cardId || !context.sessionId || !context.parentControl || !context.notifyCard) throw new Error(`Agent '${context.agentName}' child tools require a current card control context.`);
    providers.push(createPlannerControlProvider({agentName:context.agentName,projectRoot:context.projectRoot,parentCardId:context.cardId,sessionId:context.sessionId,store:context.store,parentControl:context.parentControl,notifyCard:context.notifyCard,childCreationTypes:context.childCreationTypes??new Set(),childActivationTypes:context.childActivationTypes??new Set()}));
  }
  if (any(requested,['list_cards','get_card','get_tree'])) providers.push(createCardInspectionProvider({store:context.store}));
  if (any(requested,['list_card_history','get_card_history_entry','diff_card'])) providers.push(createCardHistoryProvider({store:context.store}));
  if (any(requested,['read','write','edit','glob','grep'])) providers.push(context.analystToolContext?createAnalystWorkspaceProvider(context.analystToolContext):createWorkspaceProvider({projectRoot:context.projectRoot,cardId:context.cardId!,agentName:context.agentName,filesystemWrite:requested.has('write')||requested.has('edit'),store:context.store,notifyCard:context.notifyCard}));
  if (requested.has('apply_patch')) providers.push(context.analystToolContext?createAnalystPatchProvider(context.analystToolContext):createPatchProvider({projectRoot:context.projectRoot,cardId:context.cardId!,agentName:context.agentName,filesystemWrite:true,store:context.store}));
  if (any(requested,['run_command','wait_process','kill_process'])) {
    if (!context.processRunner || !context.processScope || !context.processOwnerId) throw new Error(`Agent '${context.agentName}' process tools require a bound process scope.`);
    providers.push(createProcessProvider({projectRoot:context.projectRoot,processRunner:context.processRunner,directScope:context.processScope,category:context.analystToolContext?'operator_session':'runtime_card',ownerId:context.processOwnerId,ownerKind:context.analystToolContext?'operator':'agent',...(context.cardId?{cardId:context.cardId}:{})}));
  }
  if (any(requested,['websearch','webfetch'])) providers.push(createWebProvider({projectRoot:context.projectRoot,cardId:context.cardId,agentName:context.agentName,filesystemWrite:requested.has('write')||requested.has('edit'),store:context.store,notifyCard:context.notifyCard,analystToolContext:context.analystToolContext}));
  if (requested.has('skill')) providers.push(createSkillProvider({projectRoot:context.projectRoot,agentName:context.agentName}));
  if (requested.has('mcp_tool_call')) { if(!context.mcpToolInvocation)throw new Error(`Agent '${context.agentName}' MCP tool requires the MCP invocation port.`);providers.push(createMcpProvider({mcpToolInvocation:context.mcpToolInvocation})); }
  return composeInvocationSurface(context.agentName,context.toolNames,providers);
}
