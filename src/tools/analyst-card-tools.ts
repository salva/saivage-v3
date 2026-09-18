import { z } from 'zod';

import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import { analystCancelCardInputSchema, createAnalystCreateCardInputSchema, analystDeleteCardInputSchema, analystReopenCardInputSchema, analystReorderChildInputSchema, type AnalystCreateCardInput } from '../contracts/builtin-tool-inputs.js';
import type { ToolContext } from './analyst-tool-types.js';
import { defineToolBinder, OPERATIONAL_RESULT_POLICY_TEMPLATE, type ToolBinder, type ToolExecutionResult } from './invocation.js';

async function create_card(ctx: ToolContext, params: AnalystCreateCardInput, signal?: AbortSignal): Promise<ToolExecutionResult<'none'>> {
  const input: import('../application/analyst-mutation-services.js').CreateAnalystCardInput = { type: params.type, parent: params.parent, title: params.title, bootstrap_content: params.bootstrap_content, priority: params.priority, urgency: params.urgency, depends_on: params.depends_on };
  return runAuditedAnalystTool(ctx, input, { action: 'card.create', safety_class: 'low', target_kind: 'card', getTargetId: () => null, lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' }, mutate: (_prepared, value, mutation) => mutation.services.cards.create(value) }, signal);
}

async function delete_card(ctx: ToolContext, params: { ids: string[] }, signal?: AbortSignal): Promise<ToolExecutionResult<'none'>> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.delete', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.ids.join(','), lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' }, mutate: (_prepared, input, mutation) => mutation.services.cards.delete(input.ids) }, signal);
}

async function cancel_card(ctx: ToolContext, params: { cardId: string; reason?: string }, signal?: AbortSignal): Promise<ToolExecutionResult<'none'>> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.cancel', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.cardId, lifecycle: { kind: 'runtime_cancellation' }, mutate: (_prepared, input, mutation) => mutation.services.cards.cancel(input.cardId, input.reason) }, signal);
}

export async function reorder_child(ctx: ToolContext, params: { parentId: string; orderedChildIds: string[] }, signal?: AbortSignal): Promise<ToolExecutionResult<'none'>> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.reorder_child', safety_class: 'low', target_kind: 'card', getTargetId: (p) => p.parentId, lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' }, mutate: (_prepared, input, mutation) => mutation.services.cards.reorder(input.parentId, input.orderedChildIds) }, signal);
}

async function reopen_card(ctx: ToolContext, params: z.infer<typeof analystReopenCardInputSchema>, signal?: AbortSignal): Promise<ToolExecutionResult<'none'>> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.reopen', safety_class: 'low', target_kind: 'card', getTargetId: (p) => p.cardId, lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' }, mutate: (_prepared, input, mutation) => mutation.services.cards.reopen(input.cardId) }, signal);
}

export const analystCardToolBinders: readonly ToolBinder<ToolContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'create_card', description: `Create a card without dispatching work. Analyst use requires runtime status stopped or paused and requires an explicit existing non-running parent card ID argument. Every created child receives backlog lifecycle.`, resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: (ctx) => createAnalystCreateCardInputSchema(ctx.cardTypeVocabulary), executor: (ctx, args, signal) => create_card(ctx, args, signal) }),
  defineToolBinder({ name: 'reorder_child', description: 'Reorder children of a non-running parent while runtime status is stopped or paused. Denies running parents and running children; orderedChildIds must be a permutation of the current child set.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => analystReorderChildInputSchema, executor: (ctx, args, signal) => reorder_child(ctx, args, signal) }),
  defineToolBinder({ name: 'reopen_card', description: 'Reopen a done, failed, or blocked card without editing its content while Analyst intervention is ready (runtime stopped or settled paused). Changes the target and eligible resting ancestors through normal changed propagation.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => analystReopenCardInputSchema, executor: (ctx, args, signal) => reopen_card(ctx, args, signal) }),
  defineToolBinder({ name: 'cancel_card', description: 'Cancel non-completed work. Analyst cancellation allows every status except done and cancelled, rejects the root project card, and requires exact runtime ownership for running work.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => analystCancelCardInputSchema, executor: (ctx, args, signal) => cancel_card(ctx, args, signal) }),
  defineToolBinder({ name: 'delete_card', description: 'Delete one or more non-running card subtrees while runtime status is stopped or paused. Deleted ids remain reserved; no card restore/archive content is produced. Denies the root project card and any running subtree member.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => analystDeleteCardInputSchema, executor: (ctx, args, signal) => delete_card(ctx, args, signal) }),
]);
