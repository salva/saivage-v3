import { z } from 'zod';

import { getDiaryEntries } from '../cards/diary.js';
import { PROJECT_CARD_ID } from '../cards/store-api.js';
import type { CardRecord, CardStatus, CardType } from '../schemas/index.js';
import { deriveCurrentCardId } from '../runtime/current-run.js';
import { readRuntimeState } from '../runtime/state-api.js';
import { processApi } from '../runtime/process-api.js';
import { decide } from '../permissions/index.js';
import { markGoalNeedsCorrections, normalizeAnalystIssues } from '../agents/analyst-stage6.js';
import { propagateChange } from '../runtime/changed-propagation.js';
import { queueNotification } from '../notifications/index.js';
import { orderedCardsForTree, toCardView, computeCardDisplayPath } from '../application/read-models/card-view.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import {
  CARD_STATUS_VALUES,
  CARD_TYPE_VALUES,
  CREATE_CARD_TYPE_VALUES,
  URGENCY_VALUES,
  analystIssueSeveritySchema,
  cardIdArraySchema,
  cardStatusSchema,
  cardTypeSchema,
  describe,
  emptyInput,
  enumSchema,
  plannerCreateCardTypeSchema,
  stringArraySchema,
  urgencySchema,
  type UnifiedToolDefinition,
} from './tool-catalog.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { buildDeletePreview, cardSummary, defaultParentForCreate, getStore, humanizeToolError, normalizeParentValue, preflightEnum, saivageDir, toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';

const markGoalNeedsCorrectionsInput = z.object({
  goalId: describe(z.string(), 'Goal/project card ID.'),
  issues: describe(z.array(z.object({ summary: describe(z.string(), 'Issue summary.'), severity: analystIssueSeveritySchema.optional(), evidence_path: describe(z.string(), 'Optional evidence path.').optional() }).strict()), 'Canonical AnalystIssue entries.'),
  note: describe(z.string(), 'Optional note.').optional(),
}).strict();

const createCardInput = z.object({
  type: enumSchema('The non-project card type.', CARD_TYPE_VALUES),
  parent: describe(z.string().nullable().optional(), "The ID of the parent card. Use null only when creating the root project card; use 'project' for top-level goals."),
  title: describe(z.string(), 'A short title.'),
  description: describe(z.string(), 'A detailed description.'),
  status: describe(cardStatusSchema.optional(), `Optional initial status. Allowed values: ${CARD_STATUS_VALUES.join(', ')}.`),
  tags: describe(z.array(describe(z.string(), 'A tag string')).optional(), 'Optional tags.'),
  priority: describe(z.number().int().optional(), 'Optional priority value (0-100).'),
  urgency: describe(urgencySchema.optional(), 'Optional urgency level.'),
  acceptance: describe(z.string().optional(), 'Optional acceptance criteria text.'),
  depends_on: describe(cardIdArraySchema.optional(), 'Optional dependency list.'),
  related: describe(cardIdArraySchema.optional(), 'Optional related-card list.'),
}).strict();

const analystEditCardInput = z.object({
  id: describe(z.string(), 'The ID of the card to edit.'),
  title: describe(z.string().optional(), 'New title.'),
  description: describe(z.string().optional(), 'New description.'),
  tags: describe(z.array(describe(z.string(), 'A tag string')).optional(), 'New tags.'),
  priority: describe(z.number().int().optional(), 'New priority (0-100).'),
  urgency: describe(urgencySchema.optional(), 'New urgency level.'),
  acceptance: describe(z.string().optional(), 'New acceptance criteria.'),
  depends_on: describe(stringArraySchema.optional(), 'New dependency list.'),
}).strict();

const editCardInput = analystEditCardInput.extend({
  status: describe(cardStatusSchema.optional(), 'New status.'),
}).strict();

const plannerCreateCardInput = z.object({
  type: plannerCreateCardTypeSchema,
  title: describe(z.string(), 'A short title.'),
  description: describe(z.string(), 'A detailed description.'),
  status: describe(cardStatusSchema.optional(), 'Optional initial planner status.'),
  tags: describe(z.array(describe(z.string(), 'A tag string')).optional(), 'Optional tags.'),
  priority: describe(z.number().int().optional(), 'Optional priority value (0-100).'),
  urgency: describe(urgencySchema.optional(), 'Optional urgency level.'),
  acceptance: describe(z.string().optional(), 'Optional acceptance criteria text.'),
  depends_on: describe(cardIdArraySchema.optional(), 'Optional dependency list.'),
  related: describe(cardIdArraySchema.optional(), 'Optional related-card list.'),
}).strict();
const plannerEditCardInput = editCardInput.extend({ related: describe(stringArraySchema.optional(), 'New related-card list.') }).strict();

const listCardsInput = z.object({
  status: describe(z.union([cardStatusSchema, z.array(cardStatusSchema)]).optional(), `Filter by status. Accepts either one exact enum value or an array of exact enum values. Allowed values: ${CARD_STATUS_VALUES.join(', ')}.`),
  type: describe(z.union([cardTypeSchema, z.array(cardTypeSchema)]).optional(), `Filter by card type. Accepts either one exact enum value or an array of exact enum values. Allowed values: ${CARD_TYPE_VALUES.join(', ')}.`),
  parent: describe(z.string().optional(), 'Filter by parent card ID.'),
  tag: describe(z.string().optional(), 'Filter by tag.'),
}).strict();

export async function mark_goal_needs_corrections(ctx: ToolContext, params: { goalId: string; issues: unknown[]; note?: string }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'goal.needs_corrections', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.goalId, run: async () => {
    try { const issues = normalizeAnalystIssues(params.issues); return { success: true, data: markGoalNeedsCorrections(ctx.projectRoot, ctx.store, params.goalId, issues, params.note) }; }
    catch (err) { return toolFailureFromError(err); }
  } });
}

export async function create_card(ctx: ToolContext, params: { type: CardType; parent: string | null; title: string; description: string; status?: CardStatus; tags?: string[]; priority?: number; urgency?: 'low' | 'normal' | 'high' | 'critical'; acceptance?: string; depends_on?: string[]; related?: string[] }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.create', safety_class: 'low', target_kind: 'card', getTargetId: () => null, run: async () => {
    try {
      const typeCheck = preflightEnum(params.type, CREATE_CARD_TYPE_VALUES, 'type', 'create_card'); if (!typeCheck.ok) return { success: false, error: typeCheck.error, errorEnvelope: typeCheck.errorEnvelope };
      const statusCheck = preflightEnum(params.status, CARD_STATUS_VALUES, 'status', 'create_card'); if (!statusCheck.ok) return { success: false, error: statusCheck.error, errorEnvelope: statusCheck.errorEnvelope };
      const urgencyCheck = preflightEnum(params.urgency, URGENCY_VALUES, 'urgency', 'create_card'); if (!urgencyCheck.ok) return { success: false, error: urgencyCheck.error, errorEnvelope: urgencyCheck.errorEnvelope };
      const store = getStore(ctx);
      const parent = normalizeParentValue(params.parent) ?? defaultParentForCreate(store, params.type);
      if (parent === null && params.type !== 'project') return toolFailure('validation', `Cannot create ${params.type} card without a parent. Inspect the card tree and provide an existing parent ID.`, { field: 'parent' });
      if (parent === undefined) return toolFailure('validation', `Cannot create ${params.type} card without a parent. Inspect the card tree and provide an existing parent ID.`, { field: 'parent' });
      if (parent !== null && parent !== PROJECT_CARD_ID && !store.read(parent)) return toolFailure('not_found', `Parent card '${parent}' does not exist.`, { parent });
      const card = store.create({ type: params.type, parent, depth: 0, title: params.title, description: params.description, status: params.status ?? 'backlog', tags: params.tags ?? [], priority: params.priority ?? 0, urgency: params.urgency ?? 'normal', created_by: 'analyst', acceptance: params.acceptance ?? '', depends_on: params.depends_on ?? [], related: params.related ?? [], retries: 0 });
      return { success: true, data: toCardView(store, card) };
    } catch (err) { return toolFailureFromError(err, 'validation', humanizeToolError('create_card', err instanceof Error ? err.message : String(err))); }
  } });
}

const ANALYST_ALLOWED_EDIT_FIELDS = new Set(['title', 'description', 'tags', 'priority', 'urgency', 'acceptance', 'depends_on']);
const PLANNER_ALLOWED_EDIT_FIELDS = new Set(['title', 'description', 'status', 'tags', 'priority', 'urgency', 'acceptance', 'depends_on', 'related', 'estimate', 'subtype', 'assigned_to', 'result', 'metrics', 'started_at', 'completed_at', 'duration_ms', 'error', 'parent', 'type', 'instructions_file']);

export async function edit_card(ctx: ToolContext, params: { id: string } & Record<string, unknown>): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.update', safety_class: 'high', target_kind: 'card', getTargetId: (p) => p.id, preview: () => ({ type: 'edit_card', summary: `Edit card '${params.id}'.`, affectedCards: getStore(ctx).read(params.id) ? [cardSummary(getStore(ctx).read(params.id)!)] : [], affectedProcesses: [], warnings: [] }), run: async () => {
    try {
      const statusCheck = preflightEnum(params.status, CARD_STATUS_VALUES, 'status', 'edit_card'); if (!statusCheck.ok) return { success: false, error: statusCheck.error, errorEnvelope: statusCheck.errorEnvelope };
      const urgencyCheck = preflightEnum(params.urgency, URGENCY_VALUES, 'urgency', 'edit_card'); if (!urgencyCheck.ok) return { success: false, error: urgencyCheck.error, errorEnvelope: urgencyCheck.errorEnvelope };
      const typeCheck = preflightEnum(params.type, CARD_TYPE_VALUES, 'type', 'edit_card'); if (!typeCheck.ok) return { success: false, error: typeCheck.error, errorEnvelope: typeCheck.errorEnvelope };
      const store = getStore(ctx); const card = store.read(params.id); if (!card) return toolFailure('not_found', `Card '${params.id}' not found.`, { id: params.id });
      const allowedFields = ctx.actor === 'analyst' ? ANALYST_ALLOWED_EDIT_FIELDS : PLANNER_ALLOWED_EDIT_FIELDS;
      const changes: Record<string, unknown> = {}; const rejected: string[] = [];
      for (const [key, value] of Object.entries(params)) { if (key === 'id') continue; if (allowedFields.has(key)) changes[key] = value; else rejected.push(key); }
      if (Object.keys(changes).length === 0) return toolFailure('validation', `edit_card failed: no allowed fields to update. Rejected fields: ${rejected.join(', ') || '(none)'}. Allowed fields include: ${Array.from(allowedFields).join(', ')}. See the 'edit_card' tool's parameter schema.`, { rejected });
      const updated = store.mutateCard(params.id, changes as Partial<CardRecord>, { actor: ctx.actor, surface: ctx.surface, reason: 'analyst edit' });
      if (ctx.actor === 'analyst') {
        const summary = `analyst edited card fields: ${Object.keys(changes).join(', ')}`;
        try { queueNotification(ctx.projectRoot, { kind: 'card', cardId: params.id }, 'analyst_edit', summary, { actor: 'analyst', surface: ctx.surface }, store); } catch { /* best-effort notification; edit result remains authoritative */ }
        try { propagateChange(ctx.projectRoot, store, params.id, { kind: 'analyst_edit', summary }); } catch { /* best-effort planner notification; edit result remains authoritative */ }
      }
      return { success: true, data: updated };
    } catch (err) { return toolFailureFromError(err, 'validation', humanizeToolError('edit_card', err instanceof Error ? err.message : String(err))); }
  } });
}

export async function delete_card(ctx: ToolContext, params: { ids: string[] }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.delete', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.ids.join(','), preview: () => {
    const store = getStore(ctx); const previews = params.ids.map((id) => buildDeletePreview(ctx.projectRoot, store, id));
    return { type: 'delete_card', summary: `Delete ${params.ids.length} card target(s) and their descendants.`, affectedCards: previews.flatMap((preview) => preview.affectedCards), affectedProcesses: previews.flatMap((preview) => preview.affectedProcesses), warnings: previews.flatMap((preview) => preview.warnings) };
  }, permissionCheck: () => {
    if (params.ids.length > 1) return { allowed: true };
    const store = getStore(ctx);
    for (const targetId of params.ids) {
      const root = store.read(targetId);
      if (!root) continue;
      const cards = [targetId, ...store.getDescendantIds(targetId)].map((id) => store.read(id)).filter((c): c is CardRecord => c !== null);
      for (const card of cards) {
        const decision = decide({ role: 'analyst', action: 'card.delete', targetState: card.status });
        if (!decision.allowed) return decision;
      }
    }
    return { allowed: true };
  }, run: async () => {
    const store = getStore(ctx); const deletedTopLevel: string[] = []; const deletedAll: string[] = []; const failures: Array<{ id: string; reason: string }> = [];
    for (const targetId of params.ids) {
      try {
        const card = store.read(targetId); if (!card) { failures.push({ id: targetId, reason: `Card '${targetId}' not found.` }); continue; }
        const cards = [targetId, ...store.getDescendantIds(targetId)].map((id) => store.read(id)).filter((c): c is CardRecord => c !== null).sort((a, b) => b.depth - a.depth);
        const denied = cards.map((c) => decide({ role: 'analyst', action: 'card.delete', targetState: c.status })).find((decision) => !decision.allowed);
        if (denied) { failures.push({ id: targetId, reason: 'delete_card denied by permission matrix' }); continue; }
        for (const c of cards) { store.delete(c.id); deletedAll.push(c.id); }
        deletedTopLevel.push(targetId);
      } catch (err) { failures.push({ id: targetId, reason: err instanceof Error ? err.message : String(err) }); }
    }
    if (deletedTopLevel.length > 0 && failures.length > 0) return { success: true, data: { partial: true, total: params.ids.length, succeeded: deletedTopLevel.length, failures } };
    if (failures.length > 0) return { ...toolFailure(failures.every((failure) => failure.reason.toLowerCase().includes('not found')) ? 'not_found' : 'conflict', failures.map((failure) => `${failure.id}: ${failure.reason}`).join('; '), { failures }), data: { failures } };
    return { success: true, data: { deleted: deletedAll, top_level_deleted: deletedTopLevel } };
  } });
}

export async function list_cards(ctx: ToolContext, params: { status?: CardStatus | CardStatus[]; type?: CardType | CardType[]; parent?: string; tag?: string }): Promise<ToolResult> {
  try { const store = getStore(ctx); let cards = orderedCardsForTree(store);
    if (params.status) { const statuses = Array.isArray(params.status) ? params.status : [params.status]; cards = cards.filter((c) => statuses.includes(c.status)); }
    if (params.type) { const types = Array.isArray(params.type) ? params.type : [params.type]; cards = cards.filter((c) => types.includes(c.type)); }
    if (params.parent !== undefined) cards = params.parent === null ? cards.filter((c) => c.parent === null) : cards.filter((c) => store.listChildren(params.parent!).includes(c.id));
    if (params.tag) cards = cards.filter((c) => c.tags.includes(params.tag!));
    return { success: true, data: cards.map((c) => ({ id: c.id, display_path: computeCardDisplayPath(store, c), type: c.type, title: c.title, status: c.status, priority: c.priority, parent: c.parent, tags: c.tags })) };
  } catch (err) { return toolFailureFromError(err); }
}

export async function get_card(ctx: ToolContext, params: { id: string }): Promise<ToolResult> {
  try { const store = getStore(ctx); const card = store.read(params.id); if (!card) return toolFailure('not_found', `Card '${params.id}' not found.`, { id: params.id });
    const children = store.listChildren(params.id).map((cid) => store.read(cid)).filter((c): c is CardRecord => c !== null).map((child) => cardSummary(child, store));
    return { success: true, data: { ...toCardView(store, card), children } };
  } catch (err) { return toolFailureFromError(err); }
}

interface TreeNode { id: string; type: string; title: string; status: string; display_path: string | null; children: TreeNode[]; }
function buildNode(store: import('../cards/store-api.js').CardStore, id: string): TreeNode | null {
  const card = store.read(id); if (!card) return null;
  return { id: card.id, display_path: computeCardDisplayPath(store, card), type: card.type, title: card.title, status: card.status, children: store.listChildren(id).map((cid) => buildNode(store, cid)).filter((n): n is TreeNode => n !== null) };
}

export async function get_tree(ctx: ToolContext, params: { rootId?: string }): Promise<ToolResult> {
  try { const store = getStore(ctx); const rootId = params.rootId ?? PROJECT_CARD_ID; if (!store.read(rootId)) return toolFailure('not_found', `Root card '${rootId}' not found.`, { rootId }); const tree = buildNode(store, rootId); if (!tree) return toolFailure('internal', `Failed to build tree from '${rootId}'.`); return { success: true, data: tree }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function get_plan_diary(ctx: ToolContext, params: { goalId: string }): Promise<ToolResult> {
  try { const store = getStore(ctx); const goal = store.read(params.goalId); if (!goal || (goal.type !== 'goal' && goal.type !== 'project')) return toolFailure('not_found', `Goal '${params.goalId}' not found.`, { goalId: params.goalId }); return { success: true, data: getDiaryEntries(saivageDir(ctx.projectRoot), params.goalId) }; }
  catch (err) { return toolFailureFromError(err, 'io'); }
}

export async function get_card_output(ctx: ToolContext, params: { cardId: string; lines?: number; processId?: string }): Promise<ToolResult> {
  try { const store = getStore(ctx); if (!store.read(params.cardId)) return toolFailure('not_found', `Card '${params.cardId}' not found.`, { cardId: params.cardId }); const numLines = params.lines ?? 50;
    const processes = processApi(ctx.projectRoot);
    if (params.processId) { const proc = processes.getForRuntime(params.processId); if (!proc) return toolFailure('not_found', `Process '${params.processId}' not found.`, { processId: params.processId }); if (proc.card_id !== params.cardId) return toolFailure('conflict', `Process '${params.processId}' is not associated with card '${params.cardId}'.`, { processId: params.processId, cardId: params.cardId }); return { success: true, data: { process: processes.getForAgent(proc.id), output: processes.tail(params.processId, numLines) } }; }
    return { success: true, data: processes.listForAgent({ cardId: params.cardId }).map((proc) => ({ ...proc, output: processes.tail(proc.id, numLines) })) };
  } catch (err) { return toolFailureFromError(err, 'io'); }
}

export async function get_status(ctx: ToolContext, _params: Record<string, never>): Promise<ToolResult> {
  try { const store = getStore(ctx); const runtimeState = readRuntimeState(ctx.projectRoot); const allCards = store.list(); const runningProcesses = processApi(ctx.projectRoot).listForRuntime().filter((p) => p.status === 'running'); const statusCounts = allCards.reduce<Record<string, number>>((counts, card) => { counts[card.status] = (counts[card.status] ?? 0) + 1; return counts; }, {}); const activeCardRun = runtimeState?.active_card_run ?? null; const runtimeIntent = runtimeState?.runtime_intent ?? null; const runtimeRuns = runtimeState?.runtime_runs ?? []; const activationRecords = runtimeState?.runtime_activations ?? [];
    return { success: true, data: { runtime: runtimeState, runtimeSummary: { status: runtimeState?.status ?? 'unknown', paused: runtimeState?.paused ?? false, currentCardId: deriveCurrentCardId(runtimeState), activeCardRun, runtimeIntent, projectRuns: runtimeRuns.map((run) => ({ run_id: run.run_id, kind: run.kind, card_id: run.card_id, phase: run.phase, runtime_status: run.runtime_status, started_at: run.started_at, finished_at: run.finished_at ?? null })), activations: activationRecords.map((activation) => ({ activation_id: activation.activation_id, parent_card_id: activation.parent_card_id, child_card_id: activation.child_card_id, status: activation.status, requested_at: activation.requested_at, runtime_run_id: activation.runtime_run_id ?? null })) }, runningProcesses: runningProcesses.length, statusCounts, counts: { done: statusCounts.done ?? 0, failed: statusCounts.failed ?? 0, blocked: statusCounts.blocked ?? 0, total: allCards.length } } };
  } catch (err) { return toolFailureFromError(err); }
}

export async function list_card_history(ctx: ToolContext, params: { cardId: string }): Promise<ToolResult> {
  try { const store = getStore(ctx); if (!store.read(params.cardId)) return toolFailure('not_found', `Card '${params.cardId}' not found.`, { cardId: params.cardId }); const entries = store.listCardHistory(params.cardId).map((entry) => ({ card_id: entry.card_id, version_seq: entry.version_seq, changed_at: entry.changed_at, changed_by_actor: entry.changed_by_actor, changed_by_surface: entry.changed_by_surface, change_reason: entry.change_reason, changed_fields: entry.changed_fields, change_summary: entry.change_summary })); return { success: true, data: entries }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function get_card_history_entry(ctx: ToolContext, params: { cardId: string; version_seq: number }): Promise<ToolResult> {
  try { const store = getStore(ctx); const entry = store.listCardHistory(params.cardId).find((candidate) => candidate.version_seq === params.version_seq); if (!entry) return toolFailure('not_found', `Card '${params.cardId}' has no history entry for version ${params.version_seq}.`, { cardId: params.cardId, version_seq: params.version_seq }); return { success: true, data: entry }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function diff_card(ctx: ToolContext, params: { cardId: string; fromSeq?: number; toSeq?: number }): Promise<ToolResult> {
  try { const store = getStore(ctx); const card = store.read(params.cardId); if (!card) return toolFailure('not_found', `Card '${params.cardId}' not found.`, { cardId: params.cardId }); const toSeq = params.toSeq ?? card.version_seq; const fromSeq = params.fromSeq ?? Math.max(1, toSeq - 1); return { success: true, data: { card_id: params.cardId, from_version_seq: fromSeq, to_version_seq: toSeq, diff: store.diffCard(params.cardId, fromSeq, toSeq) } }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function reorder_child(ctx: ToolContext, params: { parentId: string; orderedChildIds: string[] }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.reorder_child', safety_class: 'low', target_kind: 'card', getTargetId: (p) => p.parentId, run: async () => {
    try { const store = getStore(ctx); const r = store.reorderChildren(params.parentId, params.orderedChildIds, { actor: 'analyst', surface: ctx.surface, reason: 'analyst reorder_child' }); if (r.ok) return { success: true, data: { parent_id: params.parentId, changed: r.changed } }; return { ...toolFailure('conflict', 'reorder_set_mismatch', { reason: 'reorder_set_mismatch', missing: r.missing, extra: r.extra, parent_id: params.parentId }), data: { reason: 'reorder_set_mismatch', missing: r.missing, extra: r.extra, parent_id: params.parentId } }; }
    catch (err) { return toolFailureFromError(err); }
  } });
}

export const analystCardTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'mark_goal_needs_corrections', description: 'Mark a goal/project subtree as needing corrections using canonical AnalystIssue entries.', input: markGoalNeedsCorrectionsInput, roles: [], executor: mark_goal_needs_corrections },
  { name: 'create_card', description: `Create a new card in the card tree. The first root project card must be created with type 'project' and parent null; after that, use edit_card with id 'project' to change project instructions. Use parent 'project' for top-level goals. Status defaults to 'backlog'. Card status is planner metadata only; it does not start runtime work. There is no 'ready' status.`, input: createCardInput, roles: ['planner'], executor: create_card, plannerControl: true, plannerInput: plannerCreateCardInput, plannerDescription: 'Create a direct child card under the current planner card. The parent is inferred from the planner session and cannot be supplied.' },
  { name: 'edit_card', description: `Edit the objectives/instructions of any existing card. Analyst edits are limited to objective text and metadata fields; they automatically queue change context to the edited card and upstream planner chain until active work observes it. Card status, type, parent, outputs, artifacts, and attachments are not directly editable by the Analyst.`, input: analystEditCardInput, roles: ['analyst', 'planner'], executor: edit_card, plannerControl: true, plannerInput: plannerEditCardInput, plannerDescription: 'Edit one immediate child of the current planner card. The target must be a direct child; parent/depth changes are not accepted.' },
  { name: 'reorder_child', description: 'Reorder the children of a parent card.', input: z.object({ parentId: describe(z.string(), 'Parent whose children to reorder.'), orderedChildIds: describe(z.array(z.string()), 'New child id order; must be a permutation of the current child set.') }).strict(), roles: ['planner'], executor: reorder_child, plannerControl: true, plannerInput: z.object({ orderedChildIds: z.array(z.string()) }).strict(), plannerDescription: 'Reorder the immediate children of the current planner card. orderedChildIds must be a permutation of that child set.' },
  { name: 'list_cards', description: 'List and filter cards in the project.', input: listCardsInput, roles: ['analyst', 'planner'], executor: list_cards },
  { name: 'get_card', description: 'Get full details of a single card.', input: z.object({ id: describe(z.string(), 'The ID of the card to retrieve.') }).strict(), roles: ['analyst', 'planner'], executor: get_card },
  { name: 'get_tree', description: 'Show the card tree.', input: z.object({ rootId: describe(z.string().optional(), 'Optional root card ID.') }).strict(), roles: ['analyst', 'planner'], executor: get_tree },
  { name: 'get_plan_diary', description: 'Read a goal planning diary.', input: z.object({ goalId: describe(z.string(), 'The ID of the goal card.') }).strict(), roles: ['analyst'], executor: get_plan_diary },
  { name: 'get_card_output', description: 'Get output of processes associated with a card.', input: z.object({ cardId: describe(z.string(), 'The ID of the card.'), lines: describe(z.number().int().optional(), 'Number of lines to show.'), processId: describe(z.string().optional(), 'Optional specific process ID.') }).strict(), roles: ['analyst'], executor: get_card_output },
  { name: 'get_status', description: 'Get the overall project status.', input: emptyInput, roles: ['analyst'], executor: get_status },
  { name: 'list_card_history', description: 'List card history headers for a card.', input: z.object({ cardId: describe(z.string(), 'The ID of the card whose history to list.') }).strict(), roles: ['planner', 'executor', 'reviewer', 'analyst'], executor: list_card_history },
  { name: 'get_card_history_entry', description: 'Get a specific card history entry snapshot.', input: z.object({ cardId: describe(z.string(), 'The ID of the card.'), version_seq: describe(z.number().int(), 'The historical version sequence to retrieve.') }).strict(), roles: ['planner', 'executor', 'reviewer', 'analyst'], executor: get_card_history_entry },
  { name: 'diff_card', description: 'Get a field-level diff between two card versions.', input: z.object({ cardId: describe(z.string(), 'The ID of the card.'), fromSeq: describe(z.number().int().optional(), 'Optional source version sequence. Defaults to previous version.'), toSeq: describe(z.number().int().optional(), 'Optional target version sequence. Defaults to current version.') }).strict(), roles: ['planner', 'executor', 'reviewer', 'analyst'], executor: diff_card },
  { name: 'delete_card', description: 'Delete one or more cards (and all their descendants) in a single call.', input: z.object({ ids: describe(z.array(z.string()).min(1), 'Card ids to delete.') }).strict(), roles: ['planner'], executor: delete_card, plannerControl: true, plannerInput: z.object({ cardId: z.string() }).strict(), plannerDescription: 'Delete a backlog or terminal card and cascade through descendants.' },
] as const;
