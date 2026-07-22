import { z } from 'zod';

import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import { analystCancelCardInputSchema, analystCreateCardInputSchema, analystDeleteCardInputSchema, analystReorderChildInputSchema } from '../contracts/builtin-tool-inputs.js';
import {
  CARD_TYPE_VALUES,
  CREATE_CARD_TYPE_VALUES,
  URGENCY_VALUES,
  emptyInput,
} from './tool-definition.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { defaultParentForCreate, getStore, normalizeParentValue, preflightEnum, toolFailureFromError } from './analyst-tool-helpers.js';
import { defineTool, type ToolDefinition } from './invocation.js';

export async function create_card(ctx: ToolContext, params: z.infer<typeof analystCreateCardInputSchema>, signal?: AbortSignal): Promise<ToolResult> {
  const typeCheck = preflightEnum(params.type, CREATE_CARD_TYPE_VALUES, 'type', 'create_card'); if (!typeCheck.ok) return { success: false, error: typeCheck.error };
  const urgencyCheck = preflightEnum(params.urgency, URGENCY_VALUES, 'urgency', 'create_card'); if (!urgencyCheck.ok) return { success: false, error: urgencyCheck.error };
  const parent = normalizeParentValue(params.parent) ?? defaultParentForCreate(getStore(ctx), typeCheck.value!) ?? null;
  const input: import('../application/analyst-mutation-services.js').CreateAnalystCardInput = { type: typeCheck.value!, parent, title: params.title, brief: params.brief, tags: params.tags, priority: params.priority, urgency: urgencyCheck.value, depends_on: params.depends_on, related: params.related };
  return runAuditedAnalystTool(ctx, input, { action: 'card.create', safety_class: 'low', target_kind: 'card', getTargetId: () => null, lifecycle: 'intervention_ready', mutate: (_prepared, value, mutation) => mutation.services.cards.create(value) }, signal);
}

export async function delete_card(ctx: ToolContext, params: { ids: string[] }, signal?: AbortSignal): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.delete', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.ids.join(','), lifecycle: 'intervention_ready', mutate: (_prepared, input, mutation) => mutation.services.cards.delete(input.ids) }, signal);
}

export async function cancel_card(ctx: ToolContext, params: { cardId: string; reason?: string }, signal?: AbortSignal): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.cancel', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.cardId, lifecycle: 'runtime_cancellation', mutate: (_prepared, input, mutation) => mutation.services.cards.cancel(input.cardId, input.reason) }, signal);
}

export async function get_status(ctx: ToolContext, _params: Record<string, never>): Promise<ToolResult> {
  try { const store = getStore(ctx); const runtimeStatus = ctx.runtime?.getStatus() ?? null; const runtimeSummary = runtimeStatus ? { status: runtimeStatus.status, currentCardId: runtimeStatus.currentCardId } : { status: 'stopped', currentCardId: null }; const allCards = store.list(); const runningProcesses = ctx.processRunner.list({ status: 'running' }); const statusCounts = allCards.reduce<Record<string, number>>((counts, card) => { counts[card.lifecycle.status] = (counts[card.lifecycle.status] ?? 0) + 1; return counts; }, {});
    return { success: true, data: { runtime: runtimeStatus, runtimeSummary, runningProcesses: runningProcesses.length, statusCounts, counts: { stopped: statusCounts.stopped ?? 0, done: statusCounts.done ?? 0, failed: statusCounts.failed ?? 0, blocked: statusCounts.blocked ?? 0, total: allCards.length } } };
  } catch (err) { return toolFailureFromError(err); }
}

export async function reorder_child(ctx: ToolContext, params: { parentId: string; orderedChildIds: string[] }, signal?: AbortSignal): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.reorder_child', safety_class: 'low', target_kind: 'card', getTargetId: (p) => p.parentId, lifecycle: 'intervention_ready', mutate: (_prepared, input, mutation) => mutation.services.cards.reorder(input.parentId, input.orderedChildIds) }, signal);
}

export function analystCardTools(ctx: ToolContext): readonly ToolDefinition<any>[] { return [
  defineTool({ name: 'create_card', description: `Create a card without dispatching work. Analyst use requires runtime status stopped or paused and an existing non-running parent. Every created child receives backlog lifecycle.`, inputSchema: analystCreateCardInputSchema, executor: (args, signal) => create_card(ctx, args, signal) }),
  defineTool({ name: 'reorder_child', description: 'Reorder children of a non-running parent while runtime status is stopped or paused. Denies running parents and running children; orderedChildIds must be a permutation of the current child set.', inputSchema: analystReorderChildInputSchema, executor: (args, signal) => reorder_child(ctx, args, signal) }),
  defineTool({ name: 'get_status', description: 'Get the overall project status.', inputSchema: emptyInput, executor: (args) => get_status(ctx, args) }),
  defineTool({ name: 'cancel_card', description: 'Cancel non-completed work. Analyst cancellation allows every status except done and cancelled, rejects the root project card, and requires exact runtime ownership for running work.', inputSchema: analystCancelCardInputSchema, executor: (args, signal) => cancel_card(ctx, args, signal) }),
  defineTool({ name: 'delete_card', description: 'Delete one or more non-running card subtrees while runtime status is stopped or paused. Deleted ids remain reserved; no card restore/archive content is produced. Denies the root project card and any running subtree member.', inputSchema: analystDeleteCardInputSchema, executor: (args, signal) => delete_card(ctx, args, signal) }),
]; }
