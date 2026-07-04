import { z } from 'zod';
import { existsSync, readFileSync, statSync } from 'node:fs';

import { PROJECT_CARD_ID } from '../cards/store-api.js';
import type { CardRecord, CardStatus, CardType } from '../schemas/index.js';
import { deriveCurrentCardId } from '../runtime/current-run.js';
import { readRuntimeState } from '../runtime/state-api.js';
import { processApi } from '../runtime/process-api.js';
import { decide } from '../permissions/index.js';
import { propagateChange } from '../runtime/changed-propagation.js';
import { orderedCardsForTree, toCardView, computeCardDisplayPath } from '../application/read-models/card-view.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import type { UnifiedToolDefinition } from './analyst-tool-definition.js';
import {
  CARD_STATUS_VALUES,
  CARD_TYPE_VALUES,
  CREATE_CARD_TYPE_VALUES,
  URGENCY_VALUES,
  cardIdArraySchema,
  cardStatusSchema,
  cardTypeSchema,
  describe,
  emptyInput,
  enumSchema,
  plannerCreateCardTypeSchema,
  urgencySchema,
} from './tool-definition.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { cardSummary, defaultParentForCreate, getStore, humanizeToolError, normalizeParentValue, preflightEnum, saivageDir, toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';
import { readRecordSlotIndex, recordPath, recordSlotDefinitions } from '../runtime/records/record-slots.js';

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

const plannerCreateCardInput = z.object({
  type: plannerCreateCardTypeSchema,
  title: describe(z.string(), 'A short title.'),
  brief: describe(z.string(), 'Full brief.md content including Goal, Instructions, and Acceptance Criteria headings.'),
  status: describe(cardStatusSchema.optional(), 'Optional initial planner status.'),
  tags: describe(z.array(describe(z.string(), 'A tag string')).optional(), 'Optional tags.'),
  priority: describe(z.number().int().optional(), 'Optional priority value (0-100).'),
  urgency: describe(urgencySchema.optional(), 'Optional urgency level.'),
  depends_on: describe(cardIdArraySchema.optional(), 'Optional dependency list.'),
  related: describe(cardIdArraySchema.optional(), 'Optional related-card list.'),
}).strict();

export async function create_card(ctx: ToolContext, params: { type: CardType; parent: string | null; title: string; brief: string; status?: CardStatus; tags?: string[]; priority?: number; urgency?: 'low' | 'normal' | 'high' | 'critical'; depends_on?: string[]; related?: string[] }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.create', safety_class: 'low', target_kind: 'card', getTargetId: () => null, run: async () => {
    try {
      const typeCheck = preflightEnum(params.type, CREATE_CARD_TYPE_VALUES, 'type', 'create_card'); if (!typeCheck.ok) return { success: false, error: typeCheck.error };
      const statusCheck = preflightEnum(params.status, CARD_STATUS_VALUES, 'status', 'create_card'); if (!statusCheck.ok) return { success: false, error: statusCheck.error };
      const urgencyCheck = preflightEnum(params.urgency, URGENCY_VALUES, 'urgency', 'create_card'); if (!urgencyCheck.ok) return { success: false, error: urgencyCheck.error };
      const store = getStore(ctx);
      const parent = normalizeParentValue(params.parent) ?? defaultParentForCreate(store, params.type);
      if (ctx.actor === 'analyst') {
        if (params.type === 'project' && parent === null) return toolFailure("Root project card already exists. Use card-management tools or record writes to update project objectives.", { id: PROJECT_CARD_ID });
        const runtimeCheck = requireMutableRuntime(ctx, 'create_card'); if (runtimeCheck) return runtimeCheck;
        const parentCard = parent ? store.read(parent) : null;
        if (!parentCard) return toolFailure(`Parent card '${parent}' does not exist.`, { parent: parent ?? null });
        const decision = decide({ role: 'analyst', action: 'card.create', targetState: parentCard.status });
        if (!decision.allowed) return toolFailure(`create_card denied for parent '${parentCard.id}' in status '${parentCard.status}' (${decision.reason}).`, { parent: parentCard.id, status: parentCard.status });
        if (params.status !== undefined && params.status !== 'backlog') return toolFailure('Analyst create_card can only create backlog child cards. Card creation does not dispatch work or set lifecycle state.', { status: params.status });
      }
      if (parent === null && params.type !== 'project') return toolFailure(`Cannot create ${params.type} card without a parent. Inspect the card tree and provide an existing parent ID.`, { field: 'parent' });
      if (parent === undefined) return toolFailure(`Cannot create ${params.type} card without a parent. Inspect the card tree and provide an existing parent ID.`, { field: 'parent' });
      if (parent !== null && parent !== PROJECT_CARD_ID && !store.read(parent)) return toolFailure(`Parent card '${parent}' does not exist.`, { parent });
      const card = store.create({ type: params.type, parent, depth: 0, title: params.title, brief: params.brief, status: params.status ?? 'backlog', tags: params.tags ?? [], priority: params.priority ?? 0, urgency: params.urgency ?? 'normal', created_by: 'analyst', depends_on: params.depends_on ?? [], related: params.related ?? [], retries: 0 });
      if (ctx.actor === 'analyst' && parent !== null) {
        try { propagateChange(store, parent, { kind: 'analyst_edit', summary: `analyst created child card ${card.id}` }, ctx.runtime?.notifyCard); } catch { /* best-effort planner notification; create result remains authoritative */ }
      }
      return { success: true, data: toCardView(store, card) };
    } catch (err) { return toolFailureFromError(err, humanizeToolError('create_card', err instanceof Error ? err.message : String(err))); }
  } });
}

function requireMutableRuntime(ctx: ToolContext, toolName: string): ToolResult | null {
  const runtimeState = readRuntimeState(ctx.projectRoot);
  if (runtimeState?.status === 'stopped' || runtimeState?.status === 'paused') return null;
  return toolFailure(`${toolName} requires runtime status stopped or paused before the Analyst mutates card state. Current runtime status is ${runtimeState?.status ?? 'unknown'}.`, { status: runtimeState?.status ?? 'unknown' });
}

function subtreeCards(store: ReturnType<typeof getStore>, rootId: string): CardRecord[] {
  return [rootId, ...store.getDescendantIds(rootId)].map((id) => store.read(id)).filter((card): card is CardRecord => card !== null);
}

export async function delete_card(ctx: ToolContext, params: { ids: string[] }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.delete', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.ids.join(','), permissionCheck: () => {
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
      if (ctx.actor === 'analyst') { const runtimeCheck = requireMutableRuntime(ctx, 'delete_card'); if (runtimeCheck) return runtimeCheck; }
    const store = getStore(ctx); const deletedTopLevel: string[] = []; const deletedAll: string[] = []; const failures: Array<{ id: string; reason: string }> = [];
    for (const targetId of params.ids) {
      try {
        const card = store.read(targetId); if (!card) { failures.push({ id: targetId, reason: `Card '${targetId}' not found.` }); continue; }
        if (ctx.actor === 'analyst' && card.id === PROJECT_CARD_ID) { failures.push({ id: targetId, reason: 'delete_card cannot delete the root project card.' }); continue; }
        const cards = subtreeCards(store, targetId).sort((a, b) => b.depth - a.depth);
        const denied = cards.map((c) => decide({ role: 'analyst', action: 'card.delete', targetState: c.status })).find((decision) => !decision.allowed);
        if (denied) { failures.push({ id: targetId, reason: 'delete_card denied by permission matrix' }); continue; }
        store.archiveAndDeleteSubtree(cards.map((c) => c.id));
        for (const c of cards) deletedAll.push(c.id);
        if (ctx.actor === 'analyst' && card.parent) {
          try { propagateChange(store, card.parent, { kind: 'analyst_edit', summary: `analyst deleted card subtree ${targetId}` }, ctx.runtime?.notifyCard); } catch { /* best-effort planner notification; delete result remains authoritative */ }
        }
        deletedTopLevel.push(targetId);
      } catch (err) { failures.push({ id: targetId, reason: err instanceof Error ? err.message : String(err) }); }
    }
    if (deletedTopLevel.length > 0 && failures.length > 0) return { success: true, data: { partial: true, total: params.ids.length, succeeded: deletedTopLevel.length, failures } };
    if (failures.length > 0) return toolFailure(failures.map((failure) => `${failure.id}: ${failure.reason}`).join('; '), { failures });
    return { success: true, data: { deleted: deletedAll, top_level_deleted: deletedTopLevel } };
  } });
}

export async function cancel_card(ctx: ToolContext, params: { cardId: string; reason?: string }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.cancel', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.cardId, run: async () => {
    try {
      if (ctx.actor === 'analyst') { const runtimeCheck = requireMutableRuntime(ctx, 'cancel_card'); if (runtimeCheck) return runtimeCheck; }
      const store = getStore(ctx); const card = store.read(params.cardId); if (!card) return toolFailure(`Card '${params.cardId}' not found.`, { cardId: params.cardId });
      if (ctx.actor === 'analyst' && card.id === PROJECT_CARD_ID) return toolFailure('cancel_card cannot cancel the root project card.', { cardId: card.id });
      const cards = subtreeCards(store, params.cardId);
      const denied = cards.map((c) => ({ card: c, decision: decide({ role: ctx.actor === 'analyst' ? 'analyst' : 'planner', action: 'card.cancel', targetState: c.status }) })).find((entry) => !entry.decision.allowed);
      if (denied) {
        const reason = denied.decision.allowed ? 'not_authorized' : denied.decision.reason;
        return toolFailure(`cancel_card denied for '${denied.card.id}' in status '${denied.card.status}' (${reason}).`, { cardId: denied.card.id, status: denied.card.status });
      }
      const updatedCards = cards
        .sort((a, b) => b.depth - a.depth)
        .map((c) => store.setStatus(c.id, 'cancelled'));
      if (ctx.actor === 'analyst') {
        const summary = params.reason ? `analyst cancelled card: ${params.reason}` : 'analyst cancelled card';
        const propagationAnchor = card.parent ?? params.cardId;
        try { propagateChange(store, propagationAnchor, { kind: 'analyst_edit', summary }, ctx.runtime?.notifyCard); } catch { /* best-effort planner notification; cancel result remains authoritative */ }
      }
      return { success: true, data: { cancelled: updatedCards.map((c) => c.id), root: params.cardId } };
    } catch (err) { return toolFailureFromError(err, humanizeToolError('cancel_card', err instanceof Error ? err.message : String(err))); }
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
  try { const store = getStore(ctx); const card = store.read(params.id); if (!card) return toolFailure(`Card '${params.id}' not found.`, { id: params.id });
    const children = store.listChildren(params.id).map((cid) => store.read(cid)).filter((c): c is CardRecord => c !== null).map((child) => cardSummary(child, store));
    const records = cardRecordSummaries(ctx.projectRoot, params.id);
    return { success: true, data: { ...toCardView(store, card), effective_updated_at: effectiveUpdatedAt(ctx.projectRoot, params.id), children, records, records_by_filename: Object.fromEntries(records.map((record) => [record.filename, record])) } };
  } catch (err) { return toolFailureFromError(err); }
}

function effectiveUpdatedAt(projectRoot: string, cardId: string): string | null {
  const committedTimes: string[] = [];
  for (const slot of ['card', ...recordSlotDefinitions().filter((definition) => definition.exposed).map((definition) => definition.slot)]) {
    const index = readRecordSlotIndex(projectRoot, cardId, slot);
    if (index.latest === null) continue;
    const committedAt = index.versions[String(index.latest)]?.committed_at;
    if (committedAt) committedTimes.push(committedAt);
  }
  if (committedTimes.length === 0) return null;
  return committedTimes.sort((a, b) => Date.parse(b) - Date.parse(a))[0]!;
}

function cardRecordSummaries(projectRoot: string, cardId: string): Array<Record<string, unknown>> {
  return recordSlotDefinitions()
    .filter((definition) => definition.exposed)
    .map((definition) => {
      const index = readRecordSlotIndex(projectRoot, cardId, definition.slot);
      if (index.latest === null) return { filename: definition.filename, path: `record://${definition.filename}`, url: `record://${definition.filename}?card=${encodeURIComponent(cardId)}`, latest: null, format: definition.format, schema: definition.schema, writers: definition.writers, size: null, modifiedAt: null, writer: null };
      const entry = index.versions[String(index.latest)];
      const url = entry?.url ?? `record://${definition.filename}?card=${encodeURIComponent(cardId)}&v=${index.latest}`;
      const summary: Record<string, unknown> = { filename: definition.filename, path: `record://${definition.filename}`, url, latest: index.latest, format: definition.format, schema: definition.schema, writers: definition.writers, size: entry?.size ?? null, modifiedAt: entry?.committed_at ?? null, writer: entry?.writer ?? null };
      const path = recordPath(projectRoot, cardId, definition.slot, index.latest, definition.filename).absolutePath;
      if (existsSync(path)) {
        const max = 4000;
        const content = readFileSync(path, 'utf-8');
        summary.inline = { content: content.slice(0, max), truncated: statSync(path).size > Buffer.byteLength(content.slice(0, max), 'utf-8') };
      }
      return summary;
    });
}

interface TreeNode { id: string; type: string; title: string; status: string; display_path: string | null; children: TreeNode[]; }
function buildNode(store: import('../cards/store-api.js').CardStore, id: string): TreeNode | null {
  const card = store.read(id); if (!card) return null;
  return { id: card.id, display_path: computeCardDisplayPath(store, card), type: card.type, title: card.title, status: card.status, children: store.listChildren(id).map((cid) => buildNode(store, cid)).filter((n): n is TreeNode => n !== null) };
}

export async function get_tree(ctx: ToolContext, params: { rootId?: string }): Promise<ToolResult> {
  try { const store = getStore(ctx); const rootId = params.rootId ?? PROJECT_CARD_ID; if (!store.read(rootId)) return toolFailure(`Root card '${rootId}' not found.`, { rootId }); const tree = buildNode(store, rootId); if (!tree) return toolFailure(`Failed to build tree from '${rootId}'.`); return { success: true, data: tree }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function get_status(ctx: ToolContext, _params: Record<string, never>): Promise<ToolResult> {
  try { const store = getStore(ctx); const runtimeState = readRuntimeState(ctx.projectRoot); const allCards = store.list(); const runningProcesses = processApi(ctx.projectRoot).listForRuntime().filter((p) => p.status === 'running'); const statusCounts = allCards.reduce<Record<string, number>>((counts, card) => { counts[card.status] = (counts[card.status] ?? 0) + 1; return counts; }, {}); const activeCardRun = runtimeState?.active_card_run ?? null; const runtimeRuns = runtimeState?.runtime_runs ?? []; const activationRecords = runtimeState?.runtime_activations ?? [];
    return { success: true, data: { runtime: runtimeState, runtimeSummary: { status: runtimeState?.status ?? 'unknown', currentCardId: deriveCurrentCardId(runtimeState), activeCardRun, projectRuns: runtimeRuns.map((run) => ({ run_id: run.run_id, kind: run.kind, card_id: run.card_id, phase: run.phase, runtime_status: run.runtime_status, started_at: run.started_at, finished_at: run.finished_at ?? null })), activations: activationRecords.map((activation) => ({ activation_id: activation.activation_id, parent_card_id: activation.parent_card_id, child_card_id: activation.child_card_id, status: activation.status, requested_at: activation.requested_at, runtime_run_id: activation.runtime_run_id ?? null })) }, runningProcesses: runningProcesses.length, statusCounts, counts: { done: statusCounts.done ?? 0, failed: statusCounts.failed ?? 0, blocked: statusCounts.blocked ?? 0, total: allCards.length } } };
  } catch (err) { return toolFailureFromError(err); }
}

export async function list_card_history(ctx: ToolContext, params: { cardId: string }): Promise<ToolResult> {
  try { const store = getStore(ctx); if (!store.read(params.cardId)) return toolFailure(`Card '${params.cardId}' not found.`, { cardId: params.cardId }); const entries = store.listCardHistory(params.cardId).map((entry) => ({ card_id: entry.card_id, version_seq: entry.version_seq, changed_at: entry.changed_at, changed_by_actor: entry.changed_by_actor, changed_by_surface: entry.changed_by_surface, change_reason: entry.change_reason, changed_fields: entry.changed_fields, change_summary: entry.change_summary })); return { success: true, data: entries }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function get_card_history_entry(ctx: ToolContext, params: { cardId: string; version_seq: number }): Promise<ToolResult> {
  try { const store = getStore(ctx); const entry = store.listCardHistory(params.cardId).find((candidate) => candidate.version_seq === params.version_seq); if (!entry) return toolFailure(`Card '${params.cardId}' has no history entry for version ${params.version_seq}.`, { cardId: params.cardId, version_seq: params.version_seq }); return { success: true, data: entry }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function diff_card(ctx: ToolContext, params: { cardId: string; fromSeq?: number; toSeq?: number }): Promise<ToolResult> {
  try { const store = getStore(ctx); const card = store.read(params.cardId); if (!card) return toolFailure(`Card '${params.cardId}' not found.`, { cardId: params.cardId }); const toSeq = params.toSeq ?? card.version_seq; const fromSeq = params.fromSeq ?? Math.max(1, toSeq - 1); return { success: true, data: { card_id: params.cardId, from_version_seq: fromSeq, to_version_seq: toSeq, diff: store.diffCard(params.cardId, fromSeq, toSeq) } }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function reorder_child(ctx: ToolContext, params: { parentId: string; orderedChildIds: string[] }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.reorder_child', safety_class: 'low', target_kind: 'card', getTargetId: (p) => p.parentId, run: async () => {
    try { if (ctx.actor === 'analyst') { const runtimeCheck = requireMutableRuntime(ctx, 'reorder_child'); if (runtimeCheck) return runtimeCheck; }
      const store = getStore(ctx); const parent = store.read(params.parentId); if (!parent) return toolFailure(`Parent card '${params.parentId}' not found.`, { parentId: params.parentId });
      if (ctx.actor === 'analyst') {
        const parentDecision = decide({ role: 'analyst', action: 'card.reorder_child', targetState: parent.status });
        if (!parentDecision.allowed) return toolFailure(`reorder_child denied for parent '${parent.id}' in status '${parent.status}' (${parentDecision.reason}).`, { parentId: parent.id, status: parent.status });
        for (const childId of params.orderedChildIds) {
          const child = store.read(childId); if (!child) continue;
          const blockedDescendant = subtreeCards(store, child.id).find((candidate) => !decide({ role: 'analyst', action: 'card.reorder_child', targetState: candidate.status }).allowed);
          if (blockedDescendant) return toolFailure(`reorder_child denied for child subtree '${child.id}' because '${blockedDescendant.id}' is in status '${blockedDescendant.status}'.`, { childId: child.id, blockedCardId: blockedDescendant.id, status: blockedDescendant.status });
        }
      }
      const r = store.reorderChildren(params.parentId, params.orderedChildIds, { actor: ctx.actor, surface: ctx.surface, reason: `${ctx.actor} reorder_child` });
      if (r.ok) {
        if (ctx.actor === 'analyst') {
          try { propagateChange(store, params.parentId, { kind: 'analyst_edit', summary: `analyst reordered children of ${params.parentId}` }, ctx.runtime?.notifyCard); } catch { /* best-effort planner notification; reorder result remains authoritative */ }
        }
        return { success: true, data: { parent_id: params.parentId, changed: r.changed } };
      }
      return toolFailure('reorder_set_mismatch', { reason: 'reorder_set_mismatch', missing: r.missing, extra: r.extra, parent_id: params.parentId }); }
    catch (err) { return toolFailureFromError(err); }
  } });
}

export const analystCardTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'create_card', description: `Create a card without dispatching work. Analyst use requires runtime status stopped or paused and an existing non-running parent. Analyst-created child cards must start as backlog.`, input: createCardInput, roles: ['analyst', 'planner'], executor: create_card, plannerInput: plannerCreateCardInput, plannerDescription: 'Create a direct child card under the current planner card. The parent is inferred from the planner session and cannot be supplied.' },
  { name: 'reorder_child', description: 'Reorder children of a non-running parent while runtime status is stopped or paused. Denies running parents and running children; orderedChildIds must be a permutation of the current child set.', input: z.object({ parentId: describe(z.string(), 'Parent whose children to reorder.'), orderedChildIds: describe(z.array(z.string()), 'New child id order; must be a permutation of the current child set.') }).strict(), roles: ['analyst', 'planner'], executor: reorder_child, plannerInput: z.object({ orderedChildIds: z.array(z.string()) }).strict(), plannerDescription: 'Reorder the immediate children of the current planner card. orderedChildIds must be a permutation of that child set.' },
  { name: 'get_status', description: 'Get the overall project status.', input: emptyInput, roles: ['analyst'], executor: get_status },
  { name: 'cancel_card', description: 'Cancel dormant work while runtime status is stopped or paused. Analyst cancellation allows backlog, changed, blocked, and needs_verification cards; denies running, done, failed, cancelled, and the root project card.', input: z.object({ cardId: describe(z.string(), 'The ID of the card to cancel.'), reason: describe(z.string().optional(), 'Optional cancellation reason.') }).strict(), roles: ['analyst', 'planner'], executor: cancel_card, plannerInput: z.object({ cardId: describe(z.string(), 'The ID of the card to cancel.') }).strict(), plannerDescription: 'Destructively cancel a planner-managed immediate child only when it is obsolete, duplicate, mis-scoped, or explicitly rejected; not a scheduling/defer primitive and not for avoiding actionable backlog work.' },
  { name: 'delete_card', description: 'Delete one or more non-running card subtrees while runtime status is stopped or paused using archive-backed removal. Denies the root project card and any running subtree member.', input: z.object({ ids: describe(z.array(z.string()).min(1), 'Card ids to delete.') }).strict(), roles: ['analyst'], executor: delete_card },
] as const;
