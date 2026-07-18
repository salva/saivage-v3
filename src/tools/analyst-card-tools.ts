import { z } from 'zod';

import { PROJECT_CARD_ID } from '../cards/card-api.js';
import type { CardRecord, CardStatus, CardType } from '../schemas/index.js';
import { orderedCardsForTree, toCardView, computeCardLogicalPath } from '../application/read-models/card-view.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import type { UnifiedToolDefinition } from './analyst-tool-definition.js';
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
  plannerCreateCardTypeSchema,
  urgencySchema,
} from './tool-definition.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { cardSummary, defaultParentForCreate, getStore, normalizeParentValue, preflightEnum, toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';
import { recordSlotDefinitions } from '../runtime/records/record-slots.js';
import { commitCancelCard, commitCreateCard, commitDeleteCards, commitReorderChildren, recheckCancelCard, recheckCreateCard, recheckDeleteCards, recheckReorderChildren } from '../application/analyst-mutation-operations.js';

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

export async function create_card(ctx: ToolContext, params: { type: CardType; parent: string | null; title: string; brief: string; status?: CardStatus; tags?: string[]; priority?: number; urgency?: 'low' | 'normal' | 'high' | 'critical'; depends_on?: string[]; related?: string[] }, signal?: AbortSignal): Promise<ToolResult> {
  const typeCheck = preflightEnum(params.type, CREATE_CARD_TYPE_VALUES, 'type', 'create_card'); if (!typeCheck.ok) return { success: false, error: typeCheck.error };
  const statusCheck = preflightEnum(params.status, CARD_STATUS_VALUES, 'status', 'create_card'); if (!statusCheck.ok) return { success: false, error: statusCheck.error };
  const urgencyCheck = preflightEnum(params.urgency, URGENCY_VALUES, 'urgency', 'create_card'); if (!urgencyCheck.ok) return { success: false, error: urgencyCheck.error };
  const parent = normalizeParentValue(params.parent) ?? defaultParentForCreate(getStore(ctx), params.type);
  const input = { ...params, parent } as import('../application/analyst-mutation-services.js').CreateAnalystCardInput;
  return runAuditedAnalystTool(ctx, input, { action: 'card.create', safety_class: 'low', target_kind: 'card', getTargetId: () => null, lifecycle: 'intervention_ready', recheck: recheckCreateCard, commit: commitCreateCard }, signal);
}

export async function delete_card(ctx: ToolContext, params: { ids: string[] }, signal?: AbortSignal): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.delete', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.ids.join(','), lifecycle: 'intervention_ready', recheck: recheckDeleteCards, commit: commitDeleteCards }, signal);
}

export async function cancel_card(ctx: ToolContext, params: { cardId: string; reason?: string }, signal?: AbortSignal): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.cancel', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.cardId, lifecycle: 'runtime_cancellation', recheck: recheckCancelCard, commit: commitCancelCard }, signal);
}

export async function list_cards(ctx: ToolContext, params: { status?: CardStatus | CardStatus[]; type?: CardType | CardType[]; parent?: string; tag?: string }): Promise<ToolResult> {
  try { const store = getStore(ctx); let cards = orderedCardsForTree(store);
    if (params.status) { const statuses = Array.isArray(params.status) ? params.status : [params.status]; cards = cards.filter((c) => statuses.includes(c.status)); }
    if (params.type) { const types = Array.isArray(params.type) ? params.type : [params.type]; cards = cards.filter((c) => types.includes(c.type)); }
    if (params.parent !== undefined) cards = params.parent === null ? cards.filter((c) => c.parent === null) : cards.filter((c) => store.listChildren(params.parent!).includes(c.id));
    if (params.tag) cards = cards.filter((c) => c.tags.includes(params.tag!));
    return { success: true, data: cards.map((c) => ({ id: c.id, logical_path: computeCardLogicalPath(store, c), type: c.type, title: c.title, status: c.status, priority: c.priority, parent: c.parent, tags: c.tags })) };
  } catch (err) { return toolFailureFromError(err); }
}

export async function get_card(ctx: ToolContext, params: { id: string }): Promise<ToolResult> {
  try { const store = getStore(ctx); const card = store.read(params.id); if (!card) return toolFailure(`Card '${params.id}' not found.`, { id: params.id });
    const children = store.listChildren(params.id).map((cid) => store.read(cid)).filter((c): c is CardRecord => c !== null).map((child) => cardSummary(child, store));
    const records = cardRecordSummaries(store, params.id);
    return { success: true, data: { ...toCardView(store, card), effective_updated_at: effectiveUpdatedAt(store, params.id), children, records, records_by_filename: Object.fromEntries(records.map((record) => [record.filename, record])) } };
  } catch (err) { return toolFailureFromError(err); }
}

function effectiveUpdatedAt(store: ReturnType<typeof getStore>, cardId: string): string | null {
  const committedTimes = [store.recordReader.cardArtifacts(cardId).current.committed_at, ...recordSlotDefinitions().filter((definition) => definition.exposed).map((definition) => { try { return store.readRecord(cardId, definition.filename).artifact.committed_at; } catch { return null; } })].filter((value): value is string => value !== null && value !== undefined);
  if (committedTimes.length === 0) return null;
  return committedTimes.sort((a, b) => Date.parse(b) - Date.parse(a))[0]!;
}

function cardRecordSummaries(store: ReturnType<typeof getStore>, cardId: string): Array<Record<string, unknown>> {
  return recordSlotDefinitions()
    .filter((definition) => definition.exposed)
    .map((definition) => {
      try {
        const record = store.readRecord(cardId, definition.filename);
        const content = record.artifact.content; const max = 4000;
        return { filename: definition.filename, path: `record:///${definition.filename}`, url: record.recordUrl, latest: record.version, format: definition.format, schema: definition.schema, writers: definition.writers, size: Buffer.byteLength(content), modifiedAt: record.artifact.committed_at, writer: record.artifact.writer, inline: { content: content.slice(0, max), truncated: content.length > max } };
      } catch { return { filename: definition.filename, path: `record:///${definition.filename}`, url: `record:///${definition.filename}?card=${encodeURIComponent(cardId)}`, latest: null, format: definition.format, schema: definition.schema, writers: definition.writers, size: null, modifiedAt: null, writer: null }; }
    });
}

interface TreeNode { id: string; type: string; title: string; status: string; logical_path: string | null; children: TreeNode[]; }
function buildNode(store: import('../cards/card-api.js').CardService, id: string): TreeNode | null {
  const card = store.read(id); if (!card) return null;
  return { id: card.id, logical_path: computeCardLogicalPath(store, card), type: card.type, title: card.title, status: card.status, children: store.listChildren(id).map((cid) => buildNode(store, cid)).filter((n): n is TreeNode => n !== null) };
}

export async function get_tree(ctx: ToolContext, params: { rootId?: string }): Promise<ToolResult> {
  try { const store = getStore(ctx); const rootId = params.rootId ?? PROJECT_CARD_ID; if (!store.read(rootId)) return toolFailure(`Root card '${rootId}' not found.`, { rootId }); const tree = buildNode(store, rootId); if (!tree) return toolFailure(`Failed to build tree from '${rootId}'.`); return { success: true, data: tree }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function get_status(ctx: ToolContext, _params: Record<string, never>): Promise<ToolResult> {
  try { const store = getStore(ctx); const runtimeStatus = ctx.runtime?.getStatus() ?? null; const runtimeSummary = runtimeStatus ? { status: runtimeStatus.status, currentCardId: runtimeStatus.currentCardId } : { status: 'stopped', currentCardId: null }; const allCards = store.list(); const runningProcesses = ctx.processRunner.list({ status: 'running' }); const statusCounts = allCards.reduce<Record<string, number>>((counts, card) => { counts[card.status] = (counts[card.status] ?? 0) + 1; return counts; }, {});
    return { success: true, data: { runtime: runtimeStatus, runtimeSummary, runningProcesses: runningProcesses.length, statusCounts, counts: { stopped: statusCounts.stopped ?? 0, done: statusCounts.done ?? 0, failed: statusCounts.failed ?? 0, blocked: statusCounts.blocked ?? 0, total: allCards.length } } };
  } catch (err) { return toolFailureFromError(err); }
}

export async function reorder_child(ctx: ToolContext, params: { parentId: string; orderedChildIds: string[] }, signal?: AbortSignal): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.reorder_child', safety_class: 'low', target_kind: 'card', getTargetId: (p) => p.parentId, lifecycle: 'intervention_ready', recheck: recheckReorderChildren, commit: commitReorderChildren }, signal);
}

export const analystCardTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'create_card', description: `Create a card without dispatching work. Analyst use requires runtime status stopped or paused and an existing non-running parent. Analyst-created child cards must start as backlog.`, input: createCardInput, roles: ['analyst', 'planner'], executor: create_card, plannerInput: plannerCreateCardInput, plannerDescription: 'Create a direct child card under the current planner card. The parent is inferred from the planner session and cannot be supplied.' },
  { name: 'reorder_child', description: 'Reorder children of a non-running parent while runtime status is stopped or paused. Denies running parents and running children; orderedChildIds must be a permutation of the current child set.', input: z.object({ parentId: describe(z.string(), 'Parent whose children to reorder.'), orderedChildIds: describe(z.array(z.string()), 'New child id order; must be a permutation of the current child set.') }).strict(), roles: ['analyst', 'planner'], executor: reorder_child, plannerInput: z.object({ orderedChildIds: z.array(z.string()) }).strict(), plannerDescription: 'Reorder the immediate children of the current planner card. orderedChildIds must be a permutation of that child set.' },
  { name: 'get_status', description: 'Get the overall project status.', input: emptyInput, roles: ['analyst'], executor: get_status },
  { name: 'cancel_card', description: 'Cancel dormant work while runtime status is stopped or paused. Analyst cancellation allows backlog, changed, blocked, and stopped cards; denies running, done, failed, cancelled, and the root project card.', input: z.object({ cardId: describe(z.string(), 'The ID of the card to cancel.'), reason: describe(z.string().optional(), 'Optional cancellation reason.') }).strict(), roles: ['analyst', 'planner'], executor: cancel_card, plannerInput: z.object({ cardId: describe(z.string(), 'The ID of the card to cancel.') }).strict(), plannerDescription: 'Destructively cancel a planner-managed immediate child only when it is obsolete, duplicate, mis-scoped, or explicitly rejected; not a scheduling/defer primitive and not for avoiding actionable backlog work.' },
  { name: 'delete_card', description: 'Delete one or more non-running card subtrees while runtime status is stopped or paused. Deleted ids remain reserved; no card restore/archive content is produced. Denies the root project card and any running subtree member.', input: z.object({ ids: describe(z.array(z.string()).min(1), 'Card ids to delete.') }).strict(), roles: ['analyst'], executor: delete_card },
] as const;
