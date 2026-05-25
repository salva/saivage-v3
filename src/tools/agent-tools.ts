import { z } from 'zod';

import { ANALYST_TOOL_DEFINITIONS } from '../agents/analyst-tool-schemas.js';
import {
  create_card,
  diff_card,
  edit_card,
  get_card,
  get_card_history_entry,
  get_tree,
  list_card_history,
  list_cards,
  mark_goal_needs_corrections,
  abort_goal_subtree,
  navigate_back,
  navigate_workspace,
  queue_notification,
  reconfigure,
  reorder_child,
  restart_card_or_subtree,
  restart_server,
  show_config,
  start_project,
  stop_project,
  terminate_process,
  type ToolContext,
  type ToolResult,
} from '../agents/analyst-tools.js';
import type { CardAction, CardState, PermissionRole } from '../permissions/index.js';
import { defineTool, type JsonSchemaObject, type ToolDefinition } from './runtime.js';

const toolResultSchema = z.custom<ToolResult>((value) => Boolean(value && typeof value === 'object' && 'success' in value && typeof value.success === 'boolean'));

type AnalystToolResult = ToolResult;

function actorForRole(role: PermissionRole): ToolContext['actor'] {
  return role === 'operator' ? 'planner' : role;
}

type AgentToolDefinition<Name extends string, Input> = ToolDefinition<Name, Input, AnalystToolResult>;

type AnalystExecute<Input> = (ctx: ToolContext, params: Input) => Promise<ToolResult>;

function jsonSchemaFor(name: string): { description: string; parameters: JsonSchemaObject } {
  const found = ANALYST_TOOL_DEFINITIONS.find((definition) => definition.function.name === name);
  if (!found) throw new Error(`Missing analyst tool schema for '${name}'.`);
  return { description: found.function.description, parameters: found.function.parameters as JsonSchemaObject };
}

function tool<Name extends string, Input>(options: {
  name: Name;
  input: z.ZodType<Input>;
  roles: readonly PermissionRole[];
  action?: CardAction;
  targetState?: (input: Input, projectRoot: string) => CardState | undefined;
  execute: AnalystExecute<Input>;
}): AgentToolDefinition<Name, Input> {
  const schema = jsonSchemaFor(options.name);
  return defineTool({
    name: options.name,
    description: schema.description,
    input: options.input,
    output: toolResultSchema,
    parameters: schema.parameters,
    roles: options.roles,
    action: options.action,
    targetState: (input, invocation) => options.targetState?.(input, invocation.projectRoot),
    execute: async (ctx, input) => toOutput(await options.execute({ projectRoot: ctx.projectRoot, actor: actorForRole(ctx.role), surface: ctx.surface, sessionId: ctx.sessionId }, input)),
  });
}

const stringArraySchema = z.array(z.string());
const cardStatusSchema = z.enum(['drafting', 'backlog', 'active', 'running', 'blocked', 'changed', 'done', 'failed', 'cancelled']);
const cardTypeSchema = z.enum(['project', 'goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops']);
const urgencySchema = z.enum(['low', 'normal', 'high', 'critical']);

const createCardInput = z.object({
  type: cardTypeSchema,
  parent: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  status: cardStatusSchema.optional(),
  tags: stringArraySchema.optional(),
  priority: z.number().int().optional(),
  urgency: urgencySchema.optional(),
  acceptance: z.string().optional(),
  depends_on: stringArraySchema.optional(),
  related: stringArraySchema.optional(),
  id: z.string().optional(),
}).strict();

const editCardInput = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  status: cardStatusSchema.optional(),
  tags: stringArraySchema.optional(),
  priority: z.number().int().optional(),
  urgency: urgencySchema.optional(),
  acceptance: z.string().optional(),
  depends_on: stringArraySchema.optional(),
}).strict();

const listCardsInput = z.object({ status: z.union([cardStatusSchema, z.array(cardStatusSchema)]).optional(), type: z.union([cardTypeSchema, z.array(cardTypeSchema)]).optional(), parent: z.string().optional(), tag: z.string().optional() }).strict();
const getCardInput = z.object({ id: z.string() }).strict();
const getTreeInput = z.object({ rootId: z.string().optional() }).strict();
const historyListInput = z.object({ cardId: z.string() }).strict();
const historyEntryInput = z.object({ cardId: z.string(), version_seq: z.number().int() }).strict();
const diffCardInput = z.object({ cardId: z.string(), fromSeq: z.number().int().optional(), toSeq: z.number().int().optional() }).strict();
const markGoalNeedsCorrectionsInput = z.object({ goalId: z.string(), issues: z.array(z.unknown()), note: z.string().optional() }).strict();

const emptyInput = z.object({}).strict();
const deleteCardInput = z.object({ ids: z.array(z.string()).min(1) }).strict();
const processInput = z.object({ processId: z.string() }).strict();
const abortGoalInput = z.object({ goalId: z.string() }).strict();
const restartCardInput = z.object({ id: z.string() }).strict();
const queueNotificationInput = z.object({ recipient: z.string(), kind: z.string(), body: z.string() }).strict();
const reorderChildInput = z.object({ parentId: z.string(), orderedChildIds: z.array(z.string()) }).strict();
const navigateWorkspaceInput = z.object({ target: z.object({ kind: z.enum(['card','transcript','process','plan_diary','process_list','agent_session_list','config']), id: z.string().optional(), refinement: z.string().optional() }).strict() }).strict();
const reconfigureInput = z.object({ action: z.enum(['set_role_routing','set_failover_order','mcp_add','mcp_edit','mcp_remove','set_runtime_setting','set_server_setting']), role: z.string().optional(), model_candidate: z.string().optional(), ordered_providers: z.array(z.string()).optional(), name: z.string().optional(), command: z.string().optional(), args: z.array(z.string()).optional(), env: z.record(z.string()).optional(), key: z.string().optional(), value: z.unknown().optional() }).strict();

const allRuntimeRoles = ['planner', 'executor', 'reviewer', 'analyst'] as const;

const toOutput = (result: ToolResult): AnalystToolResult => result;

export const AGENT_TOOL_DEFINITIONS = [
  tool({ name: 'create_card', input: createCardInput, roles: ['planner'], execute: create_card }),
  tool({ name: 'edit_card', input: editCardInput, roles: ['planner'], execute: edit_card }),
  tool({ name: 'list_cards', input: listCardsInput, roles: ['planner'], execute: list_cards }),
  tool({ name: 'get_card', input: getCardInput, roles: ['planner'], execute: get_card }),
  tool({ name: 'get_tree', input: getTreeInput, roles: ['planner'], execute: get_tree }),
  tool({ name: 'list_card_history', input: historyListInput, roles: allRuntimeRoles, execute: list_card_history }),
  tool({ name: 'get_card_history_entry', input: historyEntryInput, roles: allRuntimeRoles, execute: get_card_history_entry }),
  tool({ name: 'diff_card', input: diffCardInput, roles: allRuntimeRoles, execute: diff_card }),

  tool({ name: 'start_project', input: emptyInput, roles: ['analyst'], execute: start_project }),
  tool({ name: 'stop_project', input: emptyInput, roles: ['analyst'], execute: stop_project }),
  tool({ name: 'terminate_process', input: processInput, roles: ['analyst'], execute: terminate_process }),
  tool({ name: 'abort_goal_subtree', input: abortGoalInput, roles: ['analyst'], execute: abort_goal_subtree }),
  tool({ name: 'restart_card_or_subtree', input: restartCardInput, roles: ['analyst'], execute: restart_card_or_subtree }),
  tool({ name: 'queue_notification', input: queueNotificationInput, roles: ['analyst'], execute: queue_notification }),
  tool({ name: 'reorder_child', input: reorderChildInput, roles: ['analyst'], execute: reorder_child }),
  tool({ name: 'navigate_workspace', input: navigateWorkspaceInput, roles: ['analyst'], execute: navigate_workspace }),
  tool({ name: 'navigate_back', input: emptyInput, roles: ['analyst'], execute: navigate_back }),
  tool({ name: 'show_config', input: emptyInput, roles: ['analyst'], execute: show_config }),
  tool({ name: 'restart_server', input: emptyInput, roles: ['analyst'], execute: restart_server }),
  tool({ name: 'reconfigure', input: reconfigureInput, roles: ['analyst'], execute: reconfigure }),
  tool({ name: 'mark_goal_needs_corrections', input: markGoalNeedsCorrectionsInput, roles: ['analyst'], execute: mark_goal_needs_corrections }),
] as const;
