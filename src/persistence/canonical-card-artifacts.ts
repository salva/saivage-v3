import { z } from 'zod';
import { cardHistoryEntrySchema, cardRecordSchema, type CardHistoryEntry, type CardRecord } from '../schemas/index.js';
import { cardIdSchema, cardParentId } from '../schemas/card-id.js';
import { summarizeChangedFields } from '../cards/lifecycle.js';

export const cardVersionArtifactSchema = z.object({
  kind: z.literal('card-version'), format_version: z.literal(2), card_id: cardIdSchema,
  version: z.number().int().safe().positive(), committed_at: z.string().datetime(),
  card: cardRecordSchema, history: cardHistoryEntrySchema.nullable(),
}).strict();
export const cardTombstoneSchema = z.object({
  kind: z.literal('card-tombstone'), format_version: z.literal(2), card_id: cardIdSchema,
  deleted_at: z.string().datetime(), final_card: cardRecordSchema, deletion_history: cardHistoryEntrySchema,
}).strict();
export const cardStreamRowSchema = z.discriminatedUnion('kind', [cardVersionArtifactSchema, cardTombstoneSchema]);
export type CardVersionArtifact = z.infer<typeof cardVersionArtifactSchema>;
export type CardTombstone = z.infer<typeof cardTombstoneSchema>;
export type CardStreamRow = z.infer<typeof cardStreamRowSchema>;

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function fail(path: string, message: string): never { throw new Error(`Card stream '${path}' ${message}.`); }
function requireSame(path: string, left: unknown, right: unknown, message: string): void { if (!same(left, right)) fail(path, message); }

const BUSINESS_FIELDS = ['id', 'type', 'children', 'title', 'subtype', 'tags', 'priority', 'urgency', 'created_by', 'created_at', 'assigned_to', 'depends_on', 'related', 'lifecycle', 'metrics', 'estimate', 'started_at', 'duration_ms', 'status_text', 'status_text_updated_at', 'status_text_author_session_id', 'latest_self_report', 'metadata', 'pending_notifications'] as const satisfies ReadonlyArray<keyof CardRecord>;
function actualDelta(prior: CardRecord, next: CardRecord): string[] { return BUSINESS_FIELDS.filter((field) => !same(prior[field], next[field])); }
function requireHistory(path: string, history: CardHistoryEntry, fields: string[], reason: string, summary = summarizeChangedFields(fields)): void {
  if (new Set(history.changed_fields).size !== history.changed_fields.length) fail(path, 'history has duplicate changed fields');
  requireSame(path, history.changed_fields, fields, 'history has the wrong changed fields');
  if (history.change_reason !== reason || history.change_summary !== summary) fail(path, 'history has invalid reason or summary');
}

function validateInitial(card: CardRecord, path: string): void {
  const common = card.children.length === 0 && card.version_seq === 1 && card.created_at === card.updated_at
    && card.subtype === null && card.assigned_to === null && card.metrics === null && card.estimate === null
    && card.started_at === null && card.duration_ms === null && card.status_text === null
    && card.status_text_updated_at === null && card.status_text_author_session_id === null
    && card.latest_self_report === null && card.metadata === null && card.pending_notifications.length === 0
    && card.lifecycle.status === 'backlog';
  if (!common) fail(path, 'has an invalid initial card');
  if (card.id === 'project') {
    if (card.type !== 'project' || card.created_by !== 'analyst' || card.tags.length !== 0 || card.priority !== 0
      || card.urgency !== 'normal' || card.depends_on.length !== 0 || card.related.length !== 0) fail(path, 'has an invalid initial project card');
  } else if (card.type === 'project' || cardParentId(card.id) === null) fail(path, 'has an invalid initial child card');
}

function validateStatus(path: string, prior: CardRecord, next: CardRecord, history: CardHistoryEntry): void {
  const from = prior.lifecycle.status; const to = next.lifecycle.status;
  let reason: string;
  if (from === 'running' && to === 'stopped') reason = 'recovery stopped lifecycle';
  else if (from === 'stopped' && to === 'running') reason = 'STOPPED activation';
  else {
    const admitted = (to === 'running' && ['backlog', 'blocked', 'changed'].includes(from))
      || (to === 'changed' && ['blocked', 'done', 'failed'].includes(from))
      || (to === 'cancelled' && ['backlog', 'running', 'blocked', 'changed', 'stopped', 'failed'].includes(from));
    if (!admitted) fail(path, 'has an invalid status transition');
    reason = `status -> ${to}`;
  }
  const clears = to === 'cancelled' && prior.pending_notifications.length > 0;
  if (to === 'cancelled') requireSame(path, next.pending_notifications, [], 'cancellation retained notifications');
  else requireSame(path, next.pending_notifications, prior.pending_notifications, 'status operation changed notifications');
  const fields = ['lifecycle', ...(clears ? ['pending_notifications'] : [])];
  requireHistory(path, history, fields, reason);
  requireSame(path, actualDelta(prior, next), fields, 'status row has a piggyback change');
}

function validateTerminal(path: string, prior: CardRecord, next: CardRecord, history: CardHistoryEntry): void {
  if (prior.lifecycle.status !== 'running' || (next.lifecycle.status !== 'done' && next.lifecycle.status !== 'failed' && next.lifecycle.status !== 'blocked')) fail(path, 'has an invalid terminal transition');
  const result = next.lifecycle.result;
  if (result.summary !== next.status_text || next.status_text === null || next.status_text_updated_at === null) fail(path, 'has inconsistent terminal summary');
  if (next.lifecycle.status === 'done') {
    if (result.kind !== 'done' || next.lifecycle.error !== null || next.lifecycle.completed_at !== next.status_text_updated_at) fail(path, 'has invalid done terminal relationships');
  } else if (next.lifecycle.status === 'failed') {
    if (result.kind !== 'failed' || next.lifecycle.error !== next.status_text || next.lifecycle.completed_at !== next.status_text_updated_at) fail(path, 'has invalid failed terminal relationships');
  } else if (result.kind !== 'blocked' || next.lifecycle.error !== next.status_text || next.lifecycle.completed_at !== null) fail(path, 'has invalid blocked terminal relationships');
  requireSame(path, next.pending_notifications, [], 'terminal row retained notifications');
  const fields = ['lifecycle', ...(!same(prior.status_text, next.status_text) ? ['status_text'] : []), ...(!same(prior.status_text_updated_at, next.status_text_updated_at) ? ['status_text_updated_at'] : []), ...(prior.pending_notifications.length > 0 ? ['pending_notifications'] : [])];
  requireHistory(path, history, fields, 'terminal lifecycle commit');
  requireSame(path, actualDelta(prior, next), fields, 'terminal row has a piggyback change');
}

function validateVersion(path: string, prior: CardRecord, next: CardRecord, history: CardHistoryEntry): void {
  requireSame(path, history.snapshot, prior, 'history does not snapshot the prior card');
  if (history.card_id !== next.id || history.version_seq !== prior.version_seq || next.version_seq !== prior.version_seq + 1) fail(path, 'has inconsistent history linkage');
  for (const field of ['id', 'type', 'created_at', 'created_by', 'depends_on'] as const) if (!same(next[field], prior[field])) fail(path, `mutates immutable field '${field}'`);
  switch (history.kind) {
    case 'update': {
      if (!['backlog', 'changed', 'stopped'].includes(prior.lifecycle.status)) fail(path, 'edits a disallowed lifecycle state');
      const fields = actualDelta(prior, next);
      if (fields.length === 0 || fields.some((field) => !['title', 'tags', 'priority', 'urgency', 'related'].includes(field))) fail(path, 'has an invalid update delta');
      requireHistory(path, history, fields, 'planner edit_card');
      break;
    }
    case 'notification_enqueue': {
      const before = prior.pending_notifications; const after = next.pending_notifications;
      if (after.length !== before.length + 1 || !same(after.slice(0, -1), before) || before.some((item) => item.id === after.at(-1)!.id)) fail(path, 'has an invalid notification enqueue');
      requireHistory(path, history, ['pending_notifications'], 'notification enqueued', 'notification enqueued');
      requireSame(path, actualDelta(prior, next), ['pending_notifications'], 'notification enqueue has a piggyback change');
      break;
    }
    case 'notification_remove': {
      const survivors = next.pending_notifications;
      const expectedSurvivors = prior.pending_notifications.filter((candidate) => survivors.some((survivor) => survivor.id === candidate.id));
      if (survivors.length >= prior.pending_notifications.length || !same(survivors, expectedSurvivors)) fail(path, 'has an invalid notification removal');
      requireHistory(path, history, ['pending_notifications'], 'notifications delivered', 'notifications delivered');
      requireSame(path, actualDelta(prior, next), ['pending_notifications'], 'notification removal has a piggyback change');
      break;
    }
    case 'status': validateStatus(path, prior, next, history); break;
    case 'terminal': validateTerminal(path, prior, next, history); break;
    case 'child_link': {
      const linked = next.children.at(-1);
      if (!linked || cardParentId(linked) !== next.id || prior.children.includes(linked) || !same(next.children.slice(0, -1), prior.children)) fail(path, 'has an invalid child link');
      requireHistory(path, history, ['children'], 'child linked', `linked child ${linked}`);
      requireSame(path, actualDelta(prior, next), ['children'], 'child link has a piggyback change');
      break;
    }
    case 'reorder': {
      if (same(prior.children, next.children) || next.children.length !== prior.children.length || new Set(next.children).size !== next.children.length || prior.children.some((id) => !next.children.includes(id))) fail(path, 'has an invalid child reorder');
      requireHistory(path, history, ['children'], 'children reordered', 'children reordered');
      requireSame(path, actualDelta(prior, next), ['children'], 'child reorder has a piggyback change');
      break;
    }
    case 'delete': fail(path, 'uses delete history on a version row');
  }
}

export function validateCardStream(rows: readonly CardStreamRow[], path: string, cardId: string): { artifacts: CardVersionArtifact[]; tombstone: CardTombstone | null; current: CardVersionArtifact } {
  if (rows.length === 0) fail(path, 'is empty');
  const artifacts: CardVersionArtifact[] = []; let tombstone: CardTombstone | null = null;
  for (const [index, row] of rows.entries()) {
    if (row.kind === 'card-tombstone') {
      if (cardId === 'project' || index !== rows.length - 1 || artifacts.length === 0) fail(path, 'has an invalid tombstone position');
      const prior = artifacts.at(-1)!.card; const history = row.deletion_history;
      if (row.card_id !== cardId || !same(row.final_card, prior) || history.kind !== 'delete' || !same(history.snapshot, prior)
        || history.card_id !== cardId || history.changed_at !== row.deleted_at || history.version_seq !== prior.version_seq) fail(path, 'has an invalid tombstone');
      requireHistory(path, history, ['__deleted__'], 'analyst subtree deletion', 'card deleted');
      tombstone = row; continue;
    }
    if (tombstone || row.card_id !== cardId || row.card.id !== cardId || row.version !== artifacts.length + 1 || row.card.version_seq !== row.version) fail(path, 'has inconsistent version identity');
    if ((row.version === 1) !== (row.history === null)) fail(path, 'has invalid history presence');
    const prior = artifacts.at(-1)?.card;
    if (prior) validateVersion(path, prior, row.card, row.history!); else validateInitial(row.card, path);
    artifacts.push(row);
  }
  return { artifacts, tombstone, current: artifacts.at(-1)! };
}
