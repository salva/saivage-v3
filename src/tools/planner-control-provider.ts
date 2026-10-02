import { z } from 'zod';
import { isRuntimeStoppedInterruption } from '../runtime/runtime-api.js';

import type { CardEditPatch, CardService, NewChildCardInput } from '../cards/store-api.js';
import {
  activateCardArgumentsSchema,
  formatActivateCardResult,
  type ActivateCardArguments,
} from '../contracts/tool-api.js';
type ReorderChildrenResult = ReturnType<CardService['reorderChildren']>;
import type { CardRecord, CardTypeName, Urgency } from '../schemas/index.js';
import type { NotificationSubmissionPort } from '../runtime/runtime-api.js';
import {
  defineToolBinder,
  executeToolAction,
  OPERATIONAL_RESULT_POLICY_TEMPLATE,
  type ToolBinder,
} from './invocation.js';
import {
  toolFailed,
  toolSucceeded,
  throwIfPublicationOutcomeUnknown,
  plannerCancelCardInputSchema,
  plannerCreateCardInputSchema,
  plannerEditCardInputSchema,
  plannerQueueNotificationInputSchema,
  plannerReopenCardInputSchema,
  plannerReorderChildInputSchema,
  type ToolActionOutcome,
} from '../contracts/index.js';
import type { LlmToolInvocationContext } from '../runtime/runtime-api.js';
import type { PlannerChildControlPort } from '../runtime/runtime-api.js';
import { cardParentId, parseAgentName } from '../schemas/index.js';
import { submitNotificationTool } from './notification-tool.js';

interface PlannerControlStore {
  read(cardId: string): CardRecord | null;
  create?(input: NewChildCardInput): CardRecord;
  editCard?(
    cardId: string,
    changes: CardEditPatch,
    agentName: import('../schemas/index.js').AgentName,
  ): CardRecord;
  reorderChildren?(parentId: string, orderedChildIds: string[]): ReorderChildrenResult;
}

export interface PlannerControlProviderContext {
  readonly agentName: import('../schemas/index.js').AgentName;
  readonly projectRoot: string;
  readonly parentCardId: string;
  readonly sessionId: string;
  readonly store: PlannerControlStore;
  readonly parentControl: PlannerChildControlPort;
  readonly submitNotification: NotificationSubmissionPort;
  readonly childCreationTypes: ReadonlySet<CardTypeName>;
  readonly childActivationTypes: ReadonlySet<CardTypeName>;
  readonly cardTypeVocabulary: readonly CardTypeName[];
}

export const plannerControlToolBinders: readonly ToolBinder<PlannerControlProviderContext, any>[] =
  Object.freeze([
    defineToolBinder({
      name: 'create_card',
      description:
        'Create a direct child card under the current planner card. The parent is inferred from the planner session and cannot be supplied.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => plannerCreateCardInputSchema,
      executor: (ctx, args) => executeToolAction('none', async () => createCard(ctx, args)),
    }),
    defineToolBinder({
      name: 'edit_card',
      description:
        'Edit one immediate child of the current planner card. The target must be a direct child; parent/depth changes are not accepted.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => plannerEditCardInputSchema,
      executor: (ctx, args) => executeToolAction('none', async () => editCard(ctx, args)),
    }),
    defineToolBinder({
      name: 'cancel_card',
      description:
        'Destructively cancel a planner-managed immediate child only when it is obsolete, duplicate, mis-scoped, or explicitly rejected; not a scheduling/defer primitive and not for avoiding actionable backlog work.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => plannerCancelCardInputSchema,
      executor: (ctx, args) => executeToolAction('none', async () => cancelCard(ctx, args)),
    }),
    defineToolBinder({
      name: 'activate_card',
      description: 'Activate one immediate child card and return its result.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => activateCardArgumentsSchema,
      executor: (ctx, args, _signal, invocation) =>
        executeToolAction('none', async () => activateCard(ctx, args, invocation)),
    }),
    defineToolBinder({
      name: 'reopen_card',
      description:
        'Reopen one done or failed immediate child for correction. The parent and its current activation authority are inferred from this planner session.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => plannerReopenCardInputSchema,
      executor: (ctx, args) => executeToolAction('none', async () => reopenCard(ctx, args)),
    }),
    defineToolBinder({
      name: 'reorder_child',
      description:
        'Reorder the immediate children of the current planner card. The parent is inferred from the planner session.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => plannerReorderChildInputSchema,
      executor: (ctx, args) => executeToolAction('none', async () => reorderChild(ctx, args)),
    }),
    defineToolBinder({
      name: 'queue_notification',
      description:
        'Queue context on a notification-capable card for its designated recipient. Urgent may interrupt exact active work or only queue without an active eligible ancestor; a self-in-scope receipt is pending, not completed. Enqueue is not delivery; pending context is not readable.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => plannerQueueNotificationInputSchema,
      executor: (ctx, args, signal) =>
        executeToolAction('none', async () => queueNotificationTool(ctx, args, signal)),
    }),
  ]);

function createCard(
  ctx: PlannerControlProviderContext,
  record: z.infer<typeof plannerCreateCardInputSchema>,
): ToolActionOutcome {
  const type = plannerCreatedType(record.type, ctx.cardTypeVocabulary);
  if (!type.success) return failure(type.error);
  if (!ctx.childCreationTypes.has(type.type))
    return failure(`Child type '${type.type}' is not permitted for this node.`);
  const dependsOn = record.depends_on ?? [];
  const dependencyError = validateImmediateChildDependencies(ctx, dependsOn);
  if (dependencyError) return failure(dependencyError);
  const parent = ctx.store.read(ctx.parentCardId);
  if (!parent) return failure(`Planner parent card '${ctx.parentCardId}' not found.`);
  if (!ctx.store.create) throw new Error('Planner create_card requires a mutable card store.');
  const input: NewChildCardInput = {
    type: type.type,
    parent: ctx.parentCardId,
    title: record.title,
    bootstrap_content: record.bootstrap_content,
    priority: record.priority ?? 0,
    urgency: record.urgency ?? 'normal',
    created_by: parseAgentName(ctx.sessionId.split(':')[1]),
    depends_on: dependsOn,
  };
  return toolSucceeded({ card: compactPlannerToolCard(ctx.store.create(input)) });
}

function editCard(
  ctx: PlannerControlProviderContext,
  record: z.infer<typeof plannerEditCardInputSchema>,
): ToolActionOutcome {
  if (record.card_id.length === 0) return failure('edit_card requires card_id.');
  const child = requireImmediateChild(ctx, record.card_id, 'edit_card');
  if (!child.success) return failure(child.error);
  if (['running', 'done', 'cancelled'].includes(child.card.lifecycle.status))
    return failure(
      `edit_card cannot edit ${child.card.lifecycle.status} child '${record.card_id}'.`,
    );
  const patch = plannerEditablePatch(record);
  if (Object.keys(patch).length === 0)
    return failure('edit_card requires at least one editable field.');
  if (!ctx.store.editCard) throw new Error('Planner edit_card requires a mutable card store.');
  const updated = ctx.store.editCard(record.card_id, patch, ctx.agentName);
  return toolSucceeded({ card: compactPlannerToolCard(updated) });
}

function reorderChild(
  ctx: PlannerControlProviderContext,
  record: z.infer<typeof plannerReorderChildInputSchema>,
): ToolActionOutcome {
  if (!ctx.store.reorderChildren)
    throw new Error('Planner reorder_child requires a mutable card store.');
  const result = ctx.store.reorderChildren(ctx.parentCardId, record.orderedChildIds);
  if (!result.ok)
    return failure(
      `reorder_child set mismatch: missing=${result.missing.join(',') || '(none)'} extra=${result.extra.join(',') || '(none)'}`,
    );
  return toolSucceeded({ parent_id: ctx.parentCardId, changed: result.changed });
}

async function queueNotificationTool(
  ctx: PlannerControlProviderContext,
  record: z.infer<typeof plannerQueueNotificationInputSchema>,
  signal: AbortSignal,
): Promise<ToolActionOutcome> {
  return submitNotificationTool(record, ctx.submitNotification, signal);
}

async function cancelCard(
  ctx: PlannerControlProviderContext,
  record: z.infer<typeof plannerCancelCardInputSchema>,
): Promise<ToolActionOutcome> {
  if (record.card_id.length === 0) return failure('cancel_card requires card_id.');
  if (record.card_id === 'project' || cardParentId(record.card_id) !== ctx.parentCardId)
    return failure(`cancel_card can target only immediate children of '${ctx.parentCardId}'.`);
  try {
    return toolSucceeded(
      await ctx.parentControl.cancelChild({
        childCardId: record.card_id,
        reason: record.reason ?? 'planner_cancel_card',
      }),
    );
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if (isRuntimeStoppedInterruption(error)) throw error;
    return failure(error instanceof Error ? error.message : String(error));
  }
}

async function reopenCard(
  ctx: PlannerControlProviderContext,
  record: z.infer<typeof plannerReopenCardInputSchema>,
): Promise<ToolActionOutcome> {
  if (record.card_id === 'project' || cardParentId(record.card_id) !== ctx.parentCardId)
    return failure(`reopen_card can target only immediate children of '${ctx.parentCardId}'.`);
  try {
    return toolSucceeded(ctx.parentControl.reopenChild({ childCardId: record.card_id }));
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if (isRuntimeStoppedInterruption(error)) throw error;
    return failure(error instanceof Error ? error.message : String(error));
  }
}

async function activateCard(
  ctx: PlannerControlProviderContext,
  record: ActivateCardArguments,
  invocation?: LlmToolInvocationContext,
): Promise<ToolActionOutcome> {
  if (cardParentId(record.card_id) !== ctx.parentCardId)
    return failure(`Planner can activate only immediate children of '${ctx.parentCardId}'.`);
  const child = ctx.store.read(record.card_id);
  if (!child) return failure(`Child '${record.card_id}' not found.`);
  if (!ctx.childActivationTypes.has(child.type))
    return failure(`Child type '${child.type}' is not permitted for activation by this node.`);
  if (!invocation) throw new Error('activate_card requires an LLM invocation context.');
  const lease = invocation.childInvocation.reserveChild(record.card_id);
  try {
    const activation = await ctx.parentControl.activateChild({
      childCardId: record.card_id,
      invocation: lease,
    });
    return formatActivateCardResult(record.card_id, activation);
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if (isRuntimeStoppedInterruption(error)) throw error;
    return toolFailed(error instanceof Error ? error.message : String(error));
  }
}

function requireImmediateChild(
  ctx: PlannerControlProviderContext,
  cardId: string,
  toolName: string,
): { success: true; card: CardRecord } | { success: false; error: string } {
  const child = ctx.store.read(cardId);
  if (!child) return { success: false, error: `${toolName} target child '${cardId}' not found.` };
  if (cardParentId(child.id) !== ctx.parentCardId)
    return {
      success: false,
      error: `${toolName} can target only immediate children of '${ctx.parentCardId}'.`,
    };
  if (child.type === 'project')
    return { success: false, error: `${toolName} cannot target project cards.` };
  return { success: true, card: child };
}

function validateImmediateChildDependencies(
  ctx: PlannerControlProviderContext,
  dependsOn: string[],
): string | null {
  for (const dependencyId of dependsOn) {
    const dependency = ctx.store.read(dependencyId);
    if (!dependency) return `Dependency card '${dependencyId}' not found.`;
    if (cardParentId(dependency.id) !== ctx.parentCardId)
      return `Dependency '${dependencyId}' must be an immediate child of '${ctx.parentCardId}'.`;
  }
  return null;
}

function plannerCreatedType(
  value: string,
  cardTypeVocabulary: readonly CardTypeName[],
): { success: true; type: CardTypeName } | { success: false; error: string } {
  if (!cardTypeVocabulary.includes(value))
    return {
      success: false,
      error: `create_card.type must be one of: ${cardTypeVocabulary.filter((type) => type !== 'project').join(', ')}.`,
    };
  if (value === 'project')
    return { success: false, error: 'create_card cannot create project cards.' };
  return { success: true, type: value };
}

function plannerEditablePatch(record: z.infer<typeof plannerEditCardInputSchema>): CardEditPatch {
  const patch: CardEditPatch = {};
  if (record.title !== undefined) patch.title = record.title;
  if (record.priority !== undefined) patch.priority = record.priority;
  if (record.urgency !== undefined) patch.urgency = record.urgency;
  return patch;
}

function compactPlannerToolCard(card: CardRecord): {
  id: string;
  type: CardTypeName;
  parent: string | null;
  status: CardRecord['lifecycle']['status'];
  title: string;
  depends_on: string[];
  priority: number;
  urgency: Urgency;
} {
  return {
    id: card.id,
    type: card.type,
    parent: cardParentId(card.id),
    status: card.lifecycle.status,
    title: card.title,
    depends_on: card.depends_on,
    priority: card.priority,
    urgency: card.urgency,
  };
}

function failure(error: string): ToolActionOutcome {
  return toolFailed(error);
}
