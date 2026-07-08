import { z } from 'zod';

import type { CardStore, NewCardInput } from '../cards/store-api.js';
import type { ReorderChildrenResult } from '../cards/card-store.js';
import { queueNotification, resolveRecipient } from '../notifications/index.js';
import { recordControlAction, stableStringify } from '../persistence/control-action-audit.js';
import { cardTypeValues, urgencyValues, type CardRecord, type CardType, type Urgency } from '../schemas/index.js';
import type { CardNotification } from '../runtime/actors/card-actor.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';

interface PlannerChildActor {
  activate(input: { kind: 'parent'; cardId: string; sessionId: string }): Promise<{ status: string; summary: string; result?: unknown }>;
  recoverCurrentCardState(): void;
  awaitSettlement(): Promise<{ status: string; summary: string; result?: unknown }>;
  cancel(input: { reason: string; cancelled_at: string }): void;
  markChanged?(): void;
}

interface PlannerControlStore {
  read(cardId: string): CardRecord | null;
  create?(input: NewCardInput): CardRecord;
  mutateCard?(cardId: string, changes: Partial<CardRecord>, ctx: { actor: 'planner'; surface: 'runtime'; reason: string }): CardRecord;
  setStatus(cardId: string, status: 'changed'): CardRecord;
  reorderChildren?(parentId: string, orderedChildIds: string[], ctx: { actor: 'planner'; surface: 'runtime'; reason: string }): ReorderChildrenResult;
}

export interface PlannerControlProviderContext {
  readonly projectRoot: string;
  readonly parentCardId: string;
  readonly sessionId: string;
  readonly store: PlannerControlStore;
  readonly children: { get(cardId: string): PlannerChildActor | null };
  readonly notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult;
}

const createCardSchema = z.object({
  type: z.string(),
  title: z.string(),
  brief: z.string(),
  status: z.string().optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  urgency: z.string().optional(),
  depends_on: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
}).strict();

const editCardSchema = z.object({
  card_id: z.string(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  urgency: z.string().optional(),
  related: z.array(z.string()).optional(),
}).strict();

const cancelCardSchema = z.object({ card_id: z.string(), reason: z.string().optional() }).strict();
const activateCardSchema = z.object({ card_id: z.string() }).strict();
const reorderChildSchema = z.object({ orderedChildIds: z.array(z.string()) }).strict();
const queueNotificationSchema = z.object({ recipient: z.string(), kind: z.string(), body: z.string() }).strict();

export function createPlannerControlProvider(ctx: PlannerControlProviderContext): ToolProvider {
  return {
    providerName: 'planner-control',
    tools: [
      defineTool({ name: 'create_card', description: 'Create a direct child card under the current planner card. The parent is inferred from the planner session and cannot be supplied.', inputSchema: createCardSchema, executor: async (args) => createCard(ctx, args) }),
      defineTool({ name: 'edit_card', description: 'Edit one immediate child of the current planner card. The target must be a direct child; parent/depth changes are not accepted.', inputSchema: editCardSchema, executor: async (args) => editCard(ctx, args) }),
      defineTool({ name: 'cancel_card', description: 'Destructively cancel a planner-managed immediate child only when it is obsolete, duplicate, mis-scoped, or explicitly rejected; not a scheduling/defer primitive and not for avoiding actionable backlog work.', inputSchema: cancelCardSchema, executor: async (args) => cancelCard(ctx, args) }),
      defineTool({ name: 'activate_card', description: 'Activate one immediate child card and return its result.', inputSchema: activateCardSchema, executor: async (args) => activateCard(ctx, args), replay: async (args) => replayActivateCard(ctx, args) }),
      defineTool({ name: 'reorder_child', description: 'Reorder the immediate children of the current planner card. The parent is inferred from the planner session.', inputSchema: reorderChildSchema, executor: async (args) => reorderChild(ctx, args) }),
      defineTool({ name: 'queue_notification', description: 'Queue a notification for delivery into the next matching agent session.', inputSchema: queueNotificationSchema, executor: async (args) => queueNotificationTool(ctx, args) }),
    ],
  };
}

function createCard(ctx: PlannerControlProviderContext, record: z.infer<typeof createCardSchema>): ToolResult {
  const type = plannerCreatedType(record.type);
  if (!type.success) return type;
  if (record.status !== undefined && record.status !== 'backlog') return failure('create_card.status may only be backlog for planner-created child cards.');
  const dependsOn = record.depends_on ?? [];
  const dependencyError = validateImmediateChildDependencies(ctx, dependsOn);
  if (dependencyError) return failure(dependencyError);
  const parent = ctx.store.read(ctx.parentCardId);
  if (!parent) return failure(`Planner parent card '${ctx.parentCardId}' not found.`);
  if (!ctx.store.create) throw new Error('Planner create_card requires a mutable card store.');
  const input: NewCardInput = {
    type: type.type,
    parent: ctx.parentCardId,
    depth: parent.depth + 1,
    title: requireNonEmptyString(record.title, 'title'),
    brief: requireNonEmptyString(record.brief, 'brief'),
    status: 'backlog',
    tags: record.tags ?? [],
    priority: record.priority ?? 0,
    urgency: optionalUrgency(record.urgency),
    created_by: 'planner',
    depends_on: dependsOn,
    related: record.related ?? [],
    retries: 0,
  };
  return { success: true, data: { card: compactPlannerToolCard(ctx.store.create(input)) } };
}

function editCard(ctx: PlannerControlProviderContext, record: z.infer<typeof editCardSchema>): ToolResult {
  if (record.card_id.length === 0) return failure('edit_card requires card_id.');
  const child = requireImmediateChild(ctx, record.card_id, 'edit_card');
  if (!child.success) return child;
  if (['running', 'done', 'cancelled'].includes(child.card.status)) return failure(`edit_card cannot edit ${child.card.status} child '${record.card_id}'.`);
  const patch = plannerEditablePatch(record);
  if (Object.keys(patch).length === 0) return failure('edit_card requires at least one editable field.');
  if (!ctx.store.mutateCard) throw new Error('Planner edit_card requires a mutable card store.');
  const shouldMarkChanged = child.card.status === 'failed' || child.card.status === 'blocked';
  if (shouldMarkChanged) ctx.store.setStatus(record.card_id, 'changed');
  const updated = ctx.store.mutateCard(record.card_id, patch, { actor: 'planner', surface: 'runtime', reason: 'planner edit_card' });
  if (shouldMarkChanged) ctx.children.get(record.card_id)?.markChanged?.();
  return { success: true, data: { card: compactPlannerToolCard(updated) } };
}

function reorderChild(ctx: PlannerControlProviderContext, record: z.infer<typeof reorderChildSchema>): ToolResult {
  if (!ctx.store.reorderChildren) throw new Error('Planner reorder_child requires a mutable card store.');
  const result = ctx.store.reorderChildren(ctx.parentCardId, record.orderedChildIds, { actor: 'planner', surface: 'runtime', reason: 'planner reorder_child' });
  recordControlAction(ctx.projectRoot, {
    actor: 'planner',
    surface: 'runtime',
    action: 'card.reorder_child',
    target_kind: 'card',
    target_id: ctx.parentCardId,
    params_summary: stableStringify({ orderedChildIds: record.orderedChildIds, sessionId: ctx.sessionId }),
    outcome: result.ok ? 'ok' : 'error',
    outcome_summary: result.ok ? 'mutation applied' : 'reorder_set_mismatch',
    ...(result.ok ? {} : { error: 'reorder_set_mismatch' }),
  });
  if (!result.ok) return { success: false, error: `reorder_child set mismatch: missing=${result.missing.join(',') || '(none)'} extra=${result.extra.join(',') || '(none)'}` };
  return { success: true, data: { parent_id: ctx.parentCardId, changed: result.changed } };
}

function queueNotificationTool(ctx: PlannerControlProviderContext, record: z.infer<typeof queueNotificationSchema>): ToolResult {
  const recipient = resolveRecipient(ctx.projectRoot, ctx.store as CardStore, record.recipient);
  if (recipient === null) return { success: false, error: `Unknown notification recipient '${record.recipient}'.` };
  const queued = queueNotification(ctx.projectRoot, recipient, record.kind, record.body, { actor: 'planner', surface: 'runtime' }, ctx.store as CardStore, ctx.notifyCard);
  const targetId = recipient.kind === 'card' ? recipient.cardId : recipient.kind === 'role' ? recipient.role : recipient.sessionId;
  const missingCards = queued.cardDeliveries.filter((delivery) => !delivery.result.ok && delivery.result.reason === 'missing_card').map((delivery) => delivery.cardId);
  recordControlAction(ctx.projectRoot, {
    actor: 'planner',
    surface: 'runtime',
    action: 'notification.queue',
    target_kind: 'session',
    target_id: targetId,
    params_summary: stableStringify({ recipient, kind: record.kind, sessionId: ctx.sessionId }),
    outcome: queued.ok ? 'ok' : 'error',
    outcome_summary: queued.ok ? record.kind : `missing_card: ${missingCards.join(', ')}`,
    ...(queued.ok ? {} : { error: `Notification delivery failed for missing card(s): ${missingCards.join(', ')}` }),
  });
  if (!queued.ok) return { success: false, error: `Notification delivery failed for missing card(s): ${missingCards.join(', ')}`, data: { queued: false, recipient: targetId, delivery: queued } };
  return { success: true, data: { queued: true, recipient: targetId } };
}

function cancelCard(ctx: PlannerControlProviderContext, record: z.infer<typeof cancelCardSchema>): ToolResult {
  if (record.card_id.length === 0) return failure('cancel_card requires card_id.');
  const child = requireImmediateChild(ctx, record.card_id, 'cancel_card');
  if (!child.success) return child;
  if (['done', 'cancelled'].includes(child.card.status)) return failure(`cancel_card cannot cancel ${child.card.status === 'cancelled' ? 'already-cancelled' : child.card.status} child '${record.card_id}'.`);
  const actor = ctx.children.get(record.card_id);
  if (!actor) return failure(`No CardActor is registered for child '${record.card_id}'.`);
  actor.cancel({ reason: record.reason ?? 'planner_cancel_card', cancelled_at: new Date().toISOString() });
  const updated = ctx.store.read(record.card_id);
  if (!updated) return failure(`Child card '${record.card_id}' not found after cancellation.`);
  return { success: true, data: { card_id: record.card_id, status: updated.status, summary: updated.status === 'running' ? 'Cancellation requested.' : 'Cancelled.' } };
}

async function activateCard(ctx: PlannerControlProviderContext, record: z.infer<typeof activateCardSchema>): Promise<ToolResult> {
  if (record.card_id.length === 0) return failure('activate_card requires card_id.');
  const child = ctx.store.read(record.card_id);
  if (!child) return failure(`Child card '${record.card_id}' not found.`);
  if (child.parent !== ctx.parentCardId) return failure(`Planner can activate only immediate children of '${ctx.parentCardId}'.`);
  const actor = ctx.children.get(record.card_id);
  if (!actor) return failure(`No CardActor is registered for child '${record.card_id}'.`);
  try {
    let activation;
    if (child.status === 'running') {
      actor.recoverCurrentCardState();
      activation = await actor.awaitSettlement();
    } else {
      activation = await actor.activate({ kind: 'parent', cardId: ctx.parentCardId, sessionId: ctx.sessionId });
    }
    if (activation.status === 'cancelled') return failure(`Child card '${record.card_id}' activation was cancelled.`);
    return { success: true, data: { card_id: record.card_id, outcome: activation.status, summary: activation.summary, result: activation.result ?? null } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function replayActivateCard(ctx: PlannerControlProviderContext, record: z.infer<typeof activateCardSchema>) {
  const child = ctx.store.read(record.card_id);
  if (!child) return { kind: 'settled' as const, result: failure(`Child card '${record.card_id}' not found.`) };
  if (child.parent !== ctx.parentCardId) return { kind: 'settled' as const, result: failure(`Planner can activate only immediate children of '${ctx.parentCardId}'.`) };
  if (child.status === 'done' || child.status === 'failed' || child.status === 'blocked') {
    return { kind: 'settled' as const, result: { success: true as const, data: { card_id: child.id, outcome: child.status, summary: cardLifecycleSummary(child), result: child.lifecycle?.result ?? null } } };
  }
  if (child.status === 'cancelled') return { kind: 'settled' as const, result: failure(`Child card '${record.card_id}' was cancelled.`) };
  return { kind: 'redispatch' as const };
}

function requireImmediateChild(ctx: PlannerControlProviderContext, cardId: string, toolName: string): { success: true; card: CardRecord } | { success: false; error: string } {
  const child = ctx.store.read(cardId);
  if (!child) return failure(`${toolName} target child '${cardId}' not found.`);
  if (child.parent !== ctx.parentCardId) return failure(`${toolName} can target only immediate children of '${ctx.parentCardId}'.`);
  if (child.type === 'project') return failure(`${toolName} cannot target project cards.`);
  return { success: true, card: child };
}

function validateImmediateChildDependencies(ctx: PlannerControlProviderContext, dependsOn: string[]): string | null {
  for (const dependencyId of dependsOn) {
    const dependency = ctx.store.read(dependencyId);
    if (!dependency) return `Dependency card '${dependencyId}' not found.`;
    if (dependency.parent !== ctx.parentCardId) return `Dependency '${dependencyId}' must be an immediate child of '${ctx.parentCardId}'.`;
  }
  return null;
}

function plannerCreatedType(value: string): { success: true; type: Exclude<CardType, 'project'> } | { success: false; error: string } {
  if (!cardTypeValues.includes(value as CardType)) return failure(`create_card.type must be one of: ${cardTypeValues.filter((type) => type !== 'project').join(', ')}.`);
  if (value === 'project') return failure('create_card cannot create project cards.');
  return { success: true, type: value as Exclude<CardType, 'project'> };
}

function plannerEditablePatch(record: z.infer<typeof editCardSchema>): Partial<CardRecord> {
  const patch: Partial<CardRecord> = {};
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

function compactPlannerToolCard(card: CardRecord): Pick<CardRecord, 'id' | 'type' | 'parent' | 'status' | 'title' | 'depends_on' | 'related' | 'tags' | 'priority' | 'urgency'> {
  return { id: card.id, type: card.type, parent: card.parent, status: card.status, title: card.title, depends_on: card.depends_on, related: card.related, tags: card.tags, priority: card.priority, urgency: card.urgency };
}

function failure(error: string): { success: false; error: string } {
  return { success: false, error };
}

function cardLifecycleSummary(card: CardRecord): string {
  const summary = card.lifecycle?.result?.summary;
  if (typeof summary === 'string' && summary.length > 0) return summary;
  if (typeof card.status_text === 'string' && card.status_text.length > 0) return card.status_text;
  return `Child card '${card.id}' finished with status '${card.status}'.`;
}
