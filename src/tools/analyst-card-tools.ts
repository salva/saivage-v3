import { z } from 'zod';

import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import { analystCancelCardInputSchema, createAnalystCreateCardInputSchema, analystDeleteCardInputSchema, analystReopenCardInputSchema, analystReorderChildInputSchema, type AnalystCreateCardInput } from '../contracts/builtin-tool-inputs.js';
import {
  URGENCY_VALUES,
  emptyInput,
} from './tool-definition.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { defaultParentForCreate, getStore, normalizeParentValue, preflightEnum, toolFailureFromError } from './analyst-tool-helpers.js';
import { defineToolBinder, executedProviderResult, executeToolAction, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE, type ToolBinder, type ToolExecutionResult } from './invocation.js';

export async function create_card(ctx: ToolContext, params: AnalystCreateCardInput, signal?: AbortSignal): Promise<ToolExecutionResult<'none'>> {
  const typeCheck = preflightEnum(params.type, ctx.cardTypeVocabulary, 'type', 'create_card'); if (!typeCheck.ok) return executedProviderResult('none', { success: false, error: typeCheck.error });
  const urgencyCheck = preflightEnum(params.urgency, URGENCY_VALUES, 'urgency', 'create_card'); if (!urgencyCheck.ok) return executedProviderResult('none', { success: false, error: urgencyCheck.error });
  const parent = normalizeParentValue(params.parent) ?? defaultParentForCreate(getStore(ctx), typeCheck.value!) ?? null;
  const input: import('../application/analyst-mutation-services.js').CreateAnalystCardInput = { type: typeCheck.value!, parent, title: params.title, bootstrap_content: params.bootstrap_content, tags: params.tags, priority: params.priority, urgency: urgencyCheck.value, depends_on: params.depends_on, related: params.related };
  return runAuditedAnalystTool(ctx, input, { action: 'card.create', safety_class: 'low', target_kind: 'card', getTargetId: () => null, lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' }, mutate: (_prepared, value, mutation) => mutation.services.cards.create(value) }, signal);
}

export async function delete_card(ctx: ToolContext, params: { ids: string[] }, signal?: AbortSignal): Promise<ToolExecutionResult<'none'>> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.delete', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.ids.join(','), lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' }, mutate: (_prepared, input, mutation) => mutation.services.cards.delete(input.ids) }, signal);
}

export async function cancel_card(ctx: ToolContext, params: { cardId: string; reason?: string }, signal?: AbortSignal): Promise<ToolExecutionResult<'none'>> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.cancel', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.cardId, lifecycle: { kind: 'runtime_cancellation' }, mutate: (_prepared, input, mutation) => mutation.services.cards.cancel(input.cardId, input.reason) }, signal);
}

export async function get_status(ctx: ToolContext, _params: Record<string, never>): Promise<ToolResult> {
  try { const store = getStore(ctx); const runtimeStatus = ctx.runtime.getStatus(); const runtimeSummary = { status: runtimeStatus.status, currentCardId: runtimeStatus.currentCardId }; const allCards = store.list(); const runningProcesses = ctx.processRunner.list({ status: 'running' }); const statusCounts = allCards.reduce<Record<string, number>>((counts, card) => { counts[card.lifecycle.status] = (counts[card.lifecycle.status] ?? 0) + 1; return counts; }, {});
    return { success: true, data: { runtime: runtimeStatus, runtimeSummary, runningProcesses: runningProcesses.length, statusCounts, counts: { stopped: statusCounts.stopped ?? 0, done: statusCounts.done ?? 0, failed: statusCounts.failed ?? 0, blocked: statusCounts.blocked ?? 0, total: allCards.length } } };
  } catch (err) { return toolFailureFromError(err); }
}

export async function reorder_child(ctx: ToolContext, params: { parentId: string; orderedChildIds: string[] }, signal?: AbortSignal): Promise<ToolExecutionResult<'none'>> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.reorder_child', safety_class: 'low', target_kind: 'card', getTargetId: (p) => p.parentId, lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' }, mutate: (_prepared, input, mutation) => mutation.services.cards.reorder(input.parentId, input.orderedChildIds) }, signal);
}

export async function reopen_card(ctx: ToolContext, params: z.infer<typeof analystReopenCardInputSchema>, signal?: AbortSignal): Promise<ToolExecutionResult<'none'>> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.reopen', safety_class: 'low', target_kind: 'card', getTargetId: (p) => p.cardId, lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' }, mutate: (_prepared, input, mutation) => mutation.services.cards.reopen(input.cardId) }, signal);
}

export const analystCardToolBinders: readonly ToolBinder<ToolContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'create_card', description: `Create a card without dispatching work. Analyst use requires runtime status stopped or paused and an existing non-running parent. Every created child receives backlog lifecycle.`, resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: (ctx) => createAnalystCreateCardInputSchema(ctx.cardTypeVocabulary), executor: (ctx, args, signal) => create_card(ctx, args, signal) }),
  defineToolBinder({ name: 'reorder_child', description: 'Reorder children of a non-running parent while runtime status is stopped or paused. Denies running parents and running children; orderedChildIds must be a permutation of the current child set.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => analystReorderChildInputSchema, executor: (ctx, args, signal) => reorder_child(ctx, args, signal) }),
  defineToolBinder({ name: 'reopen_card', description: 'Reopen a done, failed, or blocked card without editing its content while Analyst intervention is ready (runtime stopped or settled paused). Changes the target and eligible resting ancestors through normal changed propagation.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => analystReopenCardInputSchema, executor: (ctx, args, signal) => reopen_card(ctx, args, signal) }),
  defineToolBinder({ name: 'get_status', description: 'Get the overall project status.', resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => emptyInput, executor: (ctx, args) => executeToolAction('observational_query', () => get_status(ctx, args)) }),
  defineToolBinder({ name: 'cancel_card', description: 'Cancel non-completed work. Analyst cancellation allows every status except done and cancelled, rejects the root project card, and requires exact runtime ownership for running work.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => analystCancelCardInputSchema, executor: (ctx, args, signal) => cancel_card(ctx, args, signal) }),
  defineToolBinder({ name: 'delete_card', description: 'Delete one or more non-running card subtrees while runtime status is stopped or paused. Deleted ids remain reserved; no card restore/archive content is produced. Denies the root project card and any running subtree member.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => analystDeleteCardInputSchema, executor: (ctx, args, signal) => delete_card(ctx, args, signal) }),
]);
