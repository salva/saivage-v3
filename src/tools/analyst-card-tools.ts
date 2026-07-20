import { z } from 'zod';

import type { CardStatus, CardType } from '../schemas/index.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import {
  CARD_STATUS_VALUES,
  CARD_TYPE_VALUES,
  CREATE_CARD_TYPE_VALUES,
  URGENCY_VALUES,
  cardIdArraySchema,
  cardStatusSchema,
  describe,
  emptyInput,
  enumSchema,
  urgencySchema,
} from './tool-definition.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { defaultParentForCreate, getStore, normalizeParentValue, preflightEnum, toolFailureFromError } from './analyst-tool-helpers.js';
import { defineTool, type ToolDefinition } from './invocation.js';

const createCardInput = z.object({
  type: enumSchema('The non-project card type.', CARD_TYPE_VALUES),
  parent: describe(z.string().nullable().optional(), "The ID of the parent card. Use null only when creating the root project card; use 'project' for top-level goals."),
  title: describe(z.string(), 'A short title.'),
  brief: describe(z.string(), 'Full brief.md content including Goal, Instructions, and Acceptance Criteria headings.'),
  status: describe(cardStatusSchema.optional(), `Optional initial status. Allowed values: ${CARD_STATUS_VALUES.join(', ')}.`),
  tags: describe(z.array(describe(z.string(), 'A tag string')).optional(), 'Optional tags.'),
  priority: describe(z.number().int().optional(), 'Optional priority value (0-100).'),
  urgency: describe(urgencySchema.optional(), 'Optional urgency level.'),
  depends_on: describe(cardIdArraySchema.optional(), 'Optional dependency list.'),
  related: describe(cardIdArraySchema.optional(), 'Optional related-card list.'),
}).strict();

export async function create_card(ctx: ToolContext, params: { type: CardType; parent: string | null; title: string; brief: string; status?: CardStatus; tags?: string[]; priority?: number; urgency?: 'low' | 'normal' | 'high' | 'critical'; depends_on?: string[]; related?: string[] }, signal?: AbortSignal): Promise<ToolResult> {
  const typeCheck = preflightEnum(params.type, CREATE_CARD_TYPE_VALUES, 'type', 'create_card'); if (!typeCheck.ok) return { success: false, error: typeCheck.error };
  const statusCheck = preflightEnum(params.status, CARD_STATUS_VALUES, 'status', 'create_card'); if (!statusCheck.ok) return { success: false, error: statusCheck.error };
  const urgencyCheck = preflightEnum(params.urgency, URGENCY_VALUES, 'urgency', 'create_card'); if (!urgencyCheck.ok) return { success: false, error: urgencyCheck.error };
  const parent = normalizeParentValue(params.parent) ?? defaultParentForCreate(getStore(ctx), params.type);
  const input = { ...params, parent } as import('../application/analyst-mutation-services.js').CreateAnalystCardInput;
  return runAuditedAnalystTool(ctx, input, { action: 'card.create', safety_class: 'low', target_kind: 'card', getTargetId: () => null, lifecycle: 'intervention_ready', mutate: (_prepared, value, mutation) => mutation.services.cards.create(value) }, signal);
}

export async function delete_card(ctx: ToolContext, params: { ids: string[] }, signal?: AbortSignal): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.delete', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.ids.join(','), lifecycle: 'intervention_ready', mutate: (_prepared, input, mutation) => mutation.services.cards.delete(input.ids) }, signal);
}

export async function cancel_card(ctx: ToolContext, params: { cardId: string; reason?: string }, signal?: AbortSignal): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.cancel', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.cardId, lifecycle: 'runtime_cancellation', mutate: (_prepared, input, mutation) => mutation.services.cards.cancel(input.cardId, input.reason) }, signal);
}

export async function get_status(ctx: ToolContext, _params: Record<string, never>): Promise<ToolResult> {
  try { const store = getStore(ctx); const runtimeStatus = ctx.runtime?.getStatus() ?? null; const runtimeSummary = runtimeStatus ? { status: runtimeStatus.status, currentCardId: runtimeStatus.currentCardId } : { status: 'stopped', currentCardId: null }; const allCards = store.list(); const runningProcesses = ctx.processRunner.list({ status: 'running' }); const statusCounts = allCards.reduce<Record<string, number>>((counts, card) => { counts[card.status] = (counts[card.status] ?? 0) + 1; return counts; }, {});
    return { success: true, data: { runtime: runtimeStatus, runtimeSummary, runningProcesses: runningProcesses.length, statusCounts, counts: { stopped: statusCounts.stopped ?? 0, done: statusCounts.done ?? 0, failed: statusCounts.failed ?? 0, blocked: statusCounts.blocked ?? 0, total: allCards.length } } };
  } catch (err) { return toolFailureFromError(err); }
}

export async function reorder_child(ctx: ToolContext, params: { parentId: string; orderedChildIds: string[] }, signal?: AbortSignal): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.reorder_child', safety_class: 'low', target_kind: 'card', getTargetId: (p) => p.parentId, lifecycle: 'intervention_ready', mutate: (_prepared, input, mutation) => mutation.services.cards.reorder(input.parentId, input.orderedChildIds) }, signal);
}

export function analystCardTools(ctx: ToolContext): readonly ToolDefinition<any>[] { return [
  defineTool({ name: 'create_card', description: `Create a card without dispatching work. Analyst use requires runtime status stopped or paused and an existing non-running parent. Analyst-created child cards must start as backlog.`, inputSchema: createCardInput, executor: (args, signal) => create_card(ctx, args as Parameters<typeof create_card>[1], signal) }),
  defineTool({ name: 'reorder_child', description: 'Reorder children of a non-running parent while runtime status is stopped or paused. Denies running parents and running children; orderedChildIds must be a permutation of the current child set.', inputSchema: z.object({ parentId: describe(z.string(), 'Parent whose children to reorder.'), orderedChildIds: describe(z.array(z.string()), 'New child id order; must be a permutation of the current child set.') }).strict(), executor: (args, signal) => reorder_child(ctx, args, signal) }),
  defineTool({ name: 'get_status', description: 'Get the overall project status.', inputSchema: emptyInput, executor: (args) => get_status(ctx, args) }),
  defineTool({ name: 'cancel_card', description: 'Cancel non-completed work. Analyst cancellation allows every status except done and cancelled, rejects the root project card, and requires exact runtime ownership for running work.', inputSchema: z.object({ cardId: describe(z.string(), 'The ID of the card to cancel.'), reason: describe(z.string().optional(), 'Optional cancellation reason.') }).strict(), executor: (args, signal) => cancel_card(ctx, args, signal) }),
  defineTool({ name: 'delete_card', description: 'Delete one or more non-running card subtrees while runtime status is stopped or paused. Deleted ids remain reserved; no card restore/archive content is produced. Denies the root project card and any running subtree member.', inputSchema: z.object({ ids: describe(z.array(z.string()).min(1), 'Card ids to delete.') }).strict(), executor: (args, signal) => delete_card(ctx, args, signal) }),
]; }
