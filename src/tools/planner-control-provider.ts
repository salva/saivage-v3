import { z } from 'zod';
import { isRuntimeStoppedInterruption } from '../runtime/actors/runtime-stopped-interruption.js';

import type { CardActivationAdmissionProjection, CardPatch, CardService, NewCardInput } from '../cards/card-api.js';
import { canCancelCardStatus } from '../cards/status-api.js';
import {
  activateCardArgumentsSchema,
  formatActivateCardResult,
  type ActivateCardArguments,
  type CardActivationOutcome,
} from '../contracts/tool-api.js';
type ReorderChildrenResult = ReturnType<CardService['reorderChildren']>;
import { queueNotification } from '../notifications/index.js';
import { recordControlAction, stableStringify } from '../persistence/control-action-audit.js';
import { cardIdSchema, cardTypeValues, urgencyValues, type CardRecord, type CardType, type Urgency } from '../schemas/index.js';
import type { CardNotification } from '../schemas/index.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';
import { defineTool, type ToolProvider, type ToolResult } from './invocation.js';
import type { AppLogContext } from '../persistence/app-log.js';
import type { LlmToolInvocationContext, StructuralChildRelationship } from '../runtime/actors/executing-llm-snapshot.js';
import { cardProcessEntryForStatus } from '../runtime/card-process/card-process-config.js';

interface PlannerChildActor {
  activate(input: { kind: 'parent'; cardId: string; sessionId: string }, parentAdmit: () => void): Promise<CardActivationOutcome>;
  awaitSettlement(caller?: { kind: 'parent'; cardId: string; sessionId: string }): Promise<CardActivationOutcome>;
}

interface PlannerControlStore {
  read(cardId: string): CardRecord | null;
  readActivationAdmission(cardId: string): CardActivationAdmissionProjection | null;
  create?(input: NewCardInput): CardRecord;
  mutateCard?(cardId: string, changes: CardPatch, ctx: { actor: 'planner'; surface: 'runtime'; reason: string }): CardRecord;
  setStatus(cardId: string, status: 'changed' | 'running'): CardRecord;
  activateStopped(cardId: string): CardRecord;
  reorderChildren?(parentId: string, orderedChildIds: string[], ctx: { actor: 'planner'; surface: 'runtime'; reason: string }): ReorderChildrenResult;
}

export interface PlannerControlProviderContext {
  readonly projectRoot: string;
  readonly parentCardId: string;
  readonly sessionId: string;
  readonly store: PlannerControlStore;
  readonly children: { get(cardId: string): PlannerChildActor | null };
  readonly cancelCard: (cardId: string, reason: string) => Promise<{ card_id: string; status: 'cancelled'; cancelled_card_ids: string[] }>;
  readonly notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult;
  readonly appLogs: AppLogContext;
  readonly beginStructuralWait: (relationship: StructuralChildRelationship) => StructuralChildRelationship;
  readonly endStructuralWait: (relationship: StructuralChildRelationship) => void;
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
    title: requireNonEmptyString(record.title, 'title'),
    brief: requireNonEmptyString(record.brief, 'brief'),
    status: 'backlog',
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
  if (['running', 'done', 'cancelled'].includes(child.card.status)) return failure(`edit_card cannot edit ${child.card.status} child '${record.card_id}'.`);
  const patch = plannerEditablePatch(record);
  if (Object.keys(patch).length === 0) return failure('edit_card requires at least one editable field.');
  if (!ctx.store.mutateCard) throw new Error('Planner edit_card requires a mutable card store.');
  const shouldMarkChanged = child.card.status === 'failed' || child.card.status === 'blocked';
  if (shouldMarkChanged) ctx.store.setStatus(record.card_id, 'changed');
  const updated = ctx.store.mutateCard(record.card_id, patch, { actor: 'planner', surface: 'runtime', reason: 'planner edit_card' });
  return { success: true, data: { card: compactPlannerToolCard(updated) } };
}

function reorderChild(ctx: PlannerControlProviderContext, record: z.infer<typeof reorderChildSchema>): ToolResult {
  if (!ctx.store.reorderChildren) throw new Error('Planner reorder_child requires a mutable card store.');
  const result = ctx.store.reorderChildren(ctx.parentCardId, record.orderedChildIds, { actor: 'planner', surface: 'runtime', reason: 'planner reorder_child' });
  recordControlAction(ctx.appLogs, {
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
  if (!ctx.notifyCard) throw new Error('Planner queue_notification requires the runtime card notification port.');
  const queued = queueNotification(record.card_id, record.kind, record.body, { actor: 'planner', surface: 'runtime' }, ctx.notifyCard);
  recordControlAction(ctx.appLogs, {
    actor: 'planner',
    surface: 'runtime',
    action: 'notification.queue',
    target_kind: 'card',
    target_id: record.card_id,
    params_summary: stableStringify({ card_id: record.card_id, kind: record.kind, sessionId: ctx.sessionId }),
    outcome: queued.ok ? 'ok' : 'error',
    outcome_summary: queued.ok ? record.kind : queued.reason,
    ...(queued.ok ? {} : { error: queued.reason }),
  });
  if (!queued.ok && queued.reason === 'terminal_card') return { success: false, error: `Cannot queue notification for terminal card '${queued.cardId}' in status '${queued.status}'.`, data: { queued: false, reason: queued.reason, card_id: queued.cardId, status: queued.status } };
  if (!queued.ok) return { success: false, error: `Card '${queued.cardId}' not found.`, data: { queued: false, reason: queued.reason, card_id: queued.cardId } };
  return { success: true, data: { queued: true, card_id: record.card_id, notification_id: queued.notificationId } };
}

async function cancelCard(ctx: PlannerControlProviderContext, record: z.infer<typeof cancelCardSchema>): Promise<ToolResult> {
  if (record.card_id.length === 0) return failure('cancel_card requires card_id.');
  const child = requireImmediateChild(ctx, record.card_id, 'cancel_card');
  if (!child.success) return child;
  if (!canCancelCardStatus(child.card.status)) return failure(`cancel_card cannot cancel ${child.card.status === 'cancelled' ? 'already-cancelled' : child.card.status} child '${record.card_id}'.`);
  try { return { success: true, data: await ctx.cancelCard(record.card_id, record.reason ?? 'planner_cancel_card') }; }
  catch (error) { if (isRuntimeStoppedInterruption(error)) throw error; return failure(error instanceof Error ? error.message : String(error)); }
}

async function activateCard(ctx: PlannerControlProviderContext, record: ActivateCardArguments, invocation?: LlmToolInvocationContext): Promise<ToolResult> {
  const admission = ctx.store.readActivationAdmission(record.card_id);
  if (!admission) return failure(`Child card '${record.card_id}' not found.`);
  const child = admission.child;
  if (child.parent !== ctx.parentCardId) return failure(`Planner can activate only immediate children of '${ctx.parentCardId}'.`);
  const incomplete = admission.dependencies.filter(({ status }) => status !== 'done');
  if (incomplete.length > 0) {
    return failure(`Child card '${record.card_id}' has incomplete dependencies: ${incomplete.map(({ id, status }) => `${id} (${status})`).join(', ')}.`);
  }
  if (child.status !== 'running' && cardProcessEntryForStatus(child.status) === null) {
    return failure(`Card '${record.card_id}' in status '${child.status}' is not activatable.`);
  }
  const actor = ctx.children.get(record.card_id);
  if (!actor) return failure(`No CardActor is registered for child '${record.card_id}'.`);
  try {
    let pending: Promise<CardActivationOutcome>;
    if (child.status === 'running') {
      pending = actor.awaitSettlement({ kind: 'parent', cardId: ctx.parentCardId, sessionId: ctx.sessionId });
    } else {
      pending = actor.activate(
        { kind: 'parent', cardId: ctx.parentCardId, sessionId: ctx.sessionId },
        () => { if (child.status === 'stopped') ctx.store.activateStopped(record.card_id); else ctx.store.setStatus(record.card_id, 'running'); },
      );
    }
    let activation: CardActivationOutcome;
    if (invocation) {
      const relationship = ctx.beginStructuralWait({ sessionId: invocation.sessionId, sourceInputId: invocation.sourceInputId, toolCallId: invocation.toolCallId, toolName: invocation.toolName, childCardId: record.card_id });
      try { activation = await invocation.waits.waitChild(relationship, pending); }
      finally { ctx.endStructuralWait(relationship); }
    } else activation = await pending;
    return formatActivateCardResult(record.card_id, activation);
  } catch (error) {
    if (isRuntimeStoppedInterruption(error)) throw error;
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
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

function plannerEditablePatch(record: z.infer<typeof editCardSchema>): CardPatch {
  const patch: CardPatch = {};
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
