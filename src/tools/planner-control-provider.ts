import { z } from 'zod';
import { isRuntimeStoppedInterruption } from '../runtime/actors/runtime-stopped-interruption.js';

import type { CardEditPatch, CardService, NewChildCardInput } from '../cards/card-api.js';
import {
  activateCardArgumentsSchema,
  formatActivateCardResult,
  type ActivateCardArguments,
} from '../contracts/tool-api.js';
type ReorderChildrenResult = ReturnType<CardService['reorderChildren']>;
import { queueNotification } from '../notifications/index.js';
import { cardIdSchema, cardTypeValues, urgencyValues, type CardRecord, type CardType, type Urgency } from '../schemas/index.js';
import type { CardNotification } from '../schemas/index.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';
import type { LlmToolInvocationContext } from '../runtime/actors/executing-llm-snapshot.js';
import type { PlannerChildControlPort } from '../runtime/actors/card-activation-owner.js';
import { cardParentId } from '../schemas/card-id.js';
import { rethrowAppLogPublicationError } from '../persistence/app-log.js';

interface PlannerControlStore {
  read(cardId: string): CardRecord | null;
  create?(input: NewChildCardInput): CardRecord;
  editCard?(cardId: string, changes: CardEditPatch): CardRecord;
  setStatus(cardId: string, status: 'changed'): CardRecord;
  reorderChildren?(parentId: string, orderedChildIds: string[]): ReorderChildrenResult;
}

export interface PlannerControlProviderContext {
  readonly projectRoot: string;
  readonly parentCardId: string;
  readonly sessionId: string;
  readonly store: PlannerControlStore;
  readonly parentControl: PlannerChildControlPort;
  readonly notifyCard: (cardId: string, notification: CardNotification) => NotifyCardResult;
}

const createCardSchema = z.object({
  type: z.string(),
  title: z.string(),
  brief: z.string(),
  tags: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  urgency: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
}).strict();

const editCardSchema = z.object({
  card_id: cardIdSchema,
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  urgency: z.string().optional(),
  related: z.array(z.string()).optional(),
}).strict();

const cancelCardSchema = z.object({ card_id: cardIdSchema, reason: z.string().optional() }).strict();
const reorderChildSchema = z.object({ orderedChildIds: z.array(z.string()) }).strict();
const queueNotificationSchema = z.object({ card_id: cardIdSchema, kind: z.string().min(1), body: z.string().min(1) }).strict();

export function createPlannerControlProvider(ctx: PlannerControlProviderContext): ToolProvider {
  return {
    providerName: 'planner-control',
    tools: [
      defineTool({ name: 'create_card', description: 'Create a direct child card under the current planner card. The parent is inferred from the planner session and cannot be supplied.', inputSchema: createCardSchema, executor: async (args) => createCard(ctx, args) }),
      defineTool({ name: 'edit_card', description: 'Edit one immediate child of the current planner card. The target must be a direct child; parent/depth changes are not accepted.', inputSchema: editCardSchema, executor: async (args) => editCard(ctx, args) }),
      defineTool({ name: 'cancel_card', description: 'Destructively cancel a planner-managed immediate child only when it is obsolete, duplicate, mis-scoped, or explicitly rejected; not a scheduling/defer primitive and not for avoiding actionable backlog work.', inputSchema: cancelCardSchema, executor: async (args) => cancelCard(ctx, args) }),
      defineTool({ name: 'activate_card', description: 'Activate one immediate child card and return its result.', inputSchema: activateCardArgumentsSchema, executor: async (args, _signal, invocation) => activateCard(ctx, args, invocation) }),
      defineTool({ name: 'reorder_child', description: 'Reorder the immediate children of the current planner card. The parent is inferred from the planner session.', inputSchema: reorderChildSchema, executor: async (args) => reorderChild(ctx, args) }),
      defineTool({ name: 'queue_notification', description: 'Queue operator context on a notification-capable card for its planner or executor.', inputSchema: queueNotificationSchema, executor: async (args) => queueNotificationTool(ctx, args) }),
    ],
  };
}

function createCard(ctx: PlannerControlProviderContext, record: z.infer<typeof createCardSchema>): ToolResult {
  const type = plannerCreatedType(record.type);
  if (!type.success) return type;
  const dependsOn = record.depends_on ?? [];
  const dependencyError = validateImmediateChildDependencies(ctx, dependsOn);
  if (dependencyError) return failure(dependencyError);
  const parent = ctx.store.read(ctx.parentCardId);
  if (!parent) return failure(`Planner parent card '${ctx.parentCardId}' not found.`);
  if (!ctx.store.create) throw new Error('Planner create_card requires a mutable card store.');
  const input: NewChildCardInput = {
    type: type.type,
    parent: ctx.parentCardId,
    title: requireNonEmptyString(record.title, 'title'),
    brief: requireNonEmptyString(record.brief, 'brief'),
    tags: record.tags ?? [],
    priority: record.priority ?? 0,
    urgency: optionalUrgency(record.urgency),
    created_by: 'planner',
    depends_on: dependsOn,
    related: record.related ?? [],
  };
  return { success: true, data: { card: compactPlannerToolCard(ctx.store.create(input)) } };
}

function editCard(ctx: PlannerControlProviderContext, record: z.infer<typeof editCardSchema>): ToolResult {
  if (record.card_id.length === 0) return failure('edit_card requires card_id.');
  const child = requireImmediateChild(ctx, record.card_id, 'edit_card');
  if (!child.success) return child;
  if (['running', 'done', 'cancelled'].includes(child.card.lifecycle.status)) return failure(`edit_card cannot edit ${child.card.lifecycle.status} child '${record.card_id}'.`);
  const patch = plannerEditablePatch(record);
  if (Object.keys(patch).length === 0) return failure('edit_card requires at least one editable field.');
  if (!ctx.store.editCard) throw new Error('Planner edit_card requires a mutable card store.');
  const shouldMarkChanged = child.card.lifecycle.status === 'failed' || child.card.lifecycle.status === 'blocked';
  if (shouldMarkChanged) ctx.store.setStatus(record.card_id, 'changed');
  const updated = ctx.store.editCard(record.card_id, patch);
  return { success: true, data: { card: compactPlannerToolCard(updated) } };
}

function reorderChild(ctx: PlannerControlProviderContext, record: z.infer<typeof reorderChildSchema>): ToolResult {
  if (!ctx.store.reorderChildren) throw new Error('Planner reorder_child requires a mutable card store.');
  const result = ctx.store.reorderChildren(ctx.parentCardId, record.orderedChildIds);
  if (!result.ok) return { success: false, error: `reorder_child set mismatch: missing=${result.missing.join(',') || '(none)'} extra=${result.extra.join(',') || '(none)'}` };
  return { success: true, data: { parent_id: ctx.parentCardId, changed: result.changed } };
}

function queueNotificationTool(ctx: PlannerControlProviderContext, record: z.infer<typeof queueNotificationSchema>): ToolResult {
  const queued = queueNotification(record.card_id, record.kind, record.body, { actor: 'planner', surface: 'runtime' }, ctx.notifyCard);
  if (!queued.ok && queued.reason === 'terminal_card') return { success: false, error: `Cannot queue notification for terminal card '${queued.cardId}' in status '${queued.status}'.`, data: { queued: false, reason: queued.reason, card_id: queued.cardId, status: queued.status } };
  if (!queued.ok) return { success: false, error: `Card '${queued.cardId}' not found.`, data: { queued: false, reason: queued.reason, card_id: queued.cardId } };
  return { success: true, data: { queued: true, card_id: record.card_id, notification_id: queued.notificationId } };
}

async function cancelCard(ctx: PlannerControlProviderContext, record: z.infer<typeof cancelCardSchema>): Promise<ToolResult> {
  if (record.card_id.length === 0) return failure('cancel_card requires card_id.');
  if (record.card_id === 'project' || cardParentId(record.card_id) !== ctx.parentCardId) return failure(`cancel_card can target only immediate children of '${ctx.parentCardId}'.`);
  try { return { success: true, data: await ctx.parentControl.cancelChild({ childCardId: record.card_id, reason: record.reason ?? 'planner_cancel_card' }) }; }
  catch (error) { rethrowAppLogPublicationError(error); if (isRuntimeStoppedInterruption(error)) throw error; return failure(error instanceof Error ? error.message : String(error)); }
}

async function activateCard(ctx: PlannerControlProviderContext, record: ActivateCardArguments, invocation?: LlmToolInvocationContext): Promise<ToolResult> {
  if (cardParentId(record.card_id) !== ctx.parentCardId) return failure(`Planner can activate only immediate children of '${ctx.parentCardId}'.`);
  if (!invocation) throw new Error('activate_card requires an LLM invocation context.');
  const lease = invocation.childInvocation.reserveChild(record.card_id);
  try {
    const activation = await ctx.parentControl.activateChild({ childCardId: record.card_id, invocation: lease });
    return formatActivateCardResult(record.card_id, activation);
  } catch (error) {
    rethrowAppLogPublicationError(error);
    if (isRuntimeStoppedInterruption(error)) throw error;
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function requireImmediateChild(ctx: PlannerControlProviderContext, cardId: string, toolName: string): { success: true; card: CardRecord } | { success: false; error: string } {
  const child = ctx.store.read(cardId);
  if (!child) return failure(`${toolName} target child '${cardId}' not found.`);
  if (cardParentId(child.id) !== ctx.parentCardId) return failure(`${toolName} can target only immediate children of '${ctx.parentCardId}'.`);
  if (child.type === 'project') return failure(`${toolName} cannot target project cards.`);
  return { success: true, card: child };
}

function validateImmediateChildDependencies(ctx: PlannerControlProviderContext, dependsOn: string[]): string | null {
  for (const dependencyId of dependsOn) {
    const dependency = ctx.store.read(dependencyId);
    if (!dependency) return `Dependency card '${dependencyId}' not found.`;
    if (cardParentId(dependency.id) !== ctx.parentCardId) return `Dependency '${dependencyId}' must be an immediate child of '${ctx.parentCardId}'.`;
  }
  return null;
}

function plannerCreatedType(value: string): { success: true; type: Exclude<CardType, 'project'> } | { success: false; error: string } {
  if (!cardTypeValues.includes(value as CardType)) return failure(`create_card.type must be one of: ${cardTypeValues.filter((type) => type !== 'project').join(', ')}.`);
  if (value === 'project') return failure('create_card cannot create project cards.');
  return { success: true, type: value as Exclude<CardType, 'project'> };
}

function plannerEditablePatch(record: z.infer<typeof editCardSchema>): CardEditPatch {
  const patch: CardEditPatch = {};
  if (record.title !== undefined) patch.title = requireNonEmptyString(record.title, 'title');
  if (record.tags !== undefined) patch.tags = record.tags;
  if (record.priority !== undefined) patch.priority = record.priority;
  if (record.urgency !== undefined) patch.urgency = requireUrgency(record.urgency);
  if (record.related !== undefined) patch.related = record.related;
  return patch;
}

function requireNonEmptyString(value: string, field: string): string {
  if (value.trim().length === 0) throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function requireUrgency(value: string): Urgency {
  if (!urgencyValues.includes(value as Urgency)) throw new Error(`urgency must be one of: ${urgencyValues.join(', ')}.`);
  return value as Urgency;
}

function optionalUrgency(value: string | undefined): Urgency {
  return value === undefined ? 'normal' : requireUrgency(value);
}

function compactPlannerToolCard(card: CardRecord): { id: string; type: CardType; parent: string | null; status: CardRecord['lifecycle']['status']; title: string; depends_on: string[]; related: string[]; tags: string[]; priority: number; urgency: Urgency } {
  return { id: card.id, type: card.type, parent: cardParentId(card.id), status: card.lifecycle.status, title: card.title, depends_on: card.depends_on, related: card.related, tags: card.tags, priority: card.priority, urgency: card.urgency };
}

function failure(error: string): { success: false; error: string } {
  return { success: false, error };
}
