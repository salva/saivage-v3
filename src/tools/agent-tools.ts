import { z } from 'zod';

import * as analystTools from '../agents/analyst-tools.js';
import { ANALYST_TOOL_DEFINITIONS } from '../agents/analyst-tool-schemas.js';
import { CardStore } from '../utils/card-store.js';
import { TOOL_TO_CARD_ACTION, type CardState, type PermissionRole } from '../permissions/card-permissions.js';
import { defineTool, type JsonSchemaObject, type ToolDefinition } from './runtime.js';

const toolResultSchema = z.custom<analystTools.ToolResult>((value) => Boolean(value && typeof value === 'object' && 'success' in value && typeof value.success === 'boolean'));

type AnalystToolResult = analystTools.ToolResult;

function actorForRole(role: PermissionRole): analystTools.ToolContext['actor'] {
  return role === 'operator' ? 'planner' : role;
}

type AgentToolDefinition<Name extends string, Input> = ToolDefinition<Name, Input, AnalystToolResult>;

type AnalystExecute<Input> = (ctx: analystTools.ToolContext, params: Input) => Promise<analystTools.ToolResult>;

function jsonSchemaFor(name: string): { description: string; parameters: JsonSchemaObject } {
  const found = ANALYST_TOOL_DEFINITIONS.find((definition) => definition.function.name === name);
  if (!found) throw new Error(`Missing analyst tool schema for '${name}'.`);
  return { description: found.function.description, parameters: found.function.parameters as JsonSchemaObject };
}

function targetStateFromId(input: { id: string }, projectRoot: string): CardState | undefined {
  const card = new CardStore(projectRoot).read(input.id);
  return card?.status as CardState | undefined;
}

function tool<Name extends string, Input>(options: {
  name: Name;
  input: z.ZodType<Input>;
  roles: readonly PermissionRole[];
  action?: typeof TOOL_TO_CARD_ACTION[keyof typeof TOOL_TO_CARD_ACTION];
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
const noteKindSchema = z.enum(['comment', 'progress', 'directive', 'escalation']);

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

const addNoteInput = z.object({ cardId: z.string(), content: z.string(), kind: noteKindSchema.optional(), author: z.enum(['user', 'analyst', 'planner', 'executor', 'reviewer', 'runtime']).optional() }).strict();
const listCardsInput = z.object({ status: z.union([cardStatusSchema, z.array(cardStatusSchema)]).optional(), type: z.union([cardTypeSchema, z.array(cardTypeSchema)]).optional(), parent: z.string().optional(), tag: z.string().optional() }).strict();
const getCardInput = z.object({ id: z.string() }).strict();
const getTreeInput = z.object({ rootId: z.string().optional() }).strict();
const historyListInput = z.object({ cardId: z.string() }).strict();
const historyEntryInput = z.object({ cardId: z.string(), version_seq: z.number().int() }).strict();
const diffCardInput = z.object({ cardId: z.string(), fromSeq: z.number().int().optional(), toSeq: z.number().int().optional() }).strict();
const listNotesInput = z.object({ cardId: z.string(), includeHandled: z.boolean().optional() }).strict();
const getNoteInput = z.object({ cardId: z.string(), noteId: z.string() }).strict();
const markNoteHandledInput = getNoteInput;
const markGoalNeedsCorrectionsInput = z.object({ goalId: z.string(), issues: z.array(z.unknown()), note: z.string().optional() }).strict();
const deleteCardInput = z.object({ id: z.string() }).strict();

const plannerAnalystRoles = ['planner', 'analyst'] as const;
const allRuntimeRoles = ['planner', 'executor', 'reviewer', 'analyst'] as const;

const toOutput = (result: analystTools.ToolResult): AnalystToolResult => result;

export const AGENT_TOOL_DEFINITIONS = [
  tool({ name: 'create_card', input: createCardInput, roles: ['planner'], execute: analystTools.create_card }),
  tool({ name: 'edit_card', input: editCardInput, roles: ['planner'], execute: analystTools.edit_card }),
  tool({ name: 'add_note', input: addNoteInput, roles: ['planner'], execute: analystTools.add_note }),
  tool({ name: 'list_cards', input: listCardsInput, roles: ['planner'], execute: analystTools.list_cards }),
  tool({ name: 'get_card', input: getCardInput, roles: ['planner'], execute: analystTools.get_card }),
  tool({ name: 'get_tree', input: getTreeInput, roles: ['planner'], execute: analystTools.get_tree }),
  tool({ name: 'list_card_history', input: historyListInput, roles: allRuntimeRoles, execute: analystTools.list_card_history }),
  tool({ name: 'get_card_history_entry', input: historyEntryInput, roles: allRuntimeRoles, execute: analystTools.get_card_history_entry }),
  tool({ name: 'diff_card', input: diffCardInput, roles: allRuntimeRoles, execute: analystTools.diff_card }),
  tool({ name: 'list_notes', input: listNotesInput, roles: ['executor', 'reviewer', 'analyst'], execute: analystTools.list_notes }),
  tool({ name: 'get_note', input: getNoteInput, roles: ['executor', 'reviewer', 'analyst'], execute: analystTools.get_note }),
  tool({ name: 'mark_note_handled', input: markNoteHandledInput, roles: ['executor', 'reviewer', 'analyst'], execute: analystTools.mark_note_handled }),
  tool({ name: 'mark_goal_needs_corrections', input: markGoalNeedsCorrectionsInput, roles: ['analyst'], execute: analystTools.mark_goal_needs_corrections }),
  defineTool({
    name: 'delete_card',
    description: jsonSchemaFor('delete_card').description,
    input: deleteCardInput,
    output: toolResultSchema,
    parameters: jsonSchemaFor('delete_card').parameters,
    roles: plannerAnalystRoles,
    action: TOOL_TO_CARD_ACTION.delete_card,
    targetState: (input, invocation) => targetStateFromId(input, invocation.projectRoot),
    execute: async (ctx, input) => toOutput(await analystTools.delete_card({ projectRoot: ctx.projectRoot, actor: actorForRole(ctx.role), surface: ctx.surface, sessionId: ctx.sessionId }, input)),
  }),
] as const;
