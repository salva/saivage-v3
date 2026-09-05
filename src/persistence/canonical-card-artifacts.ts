import { z } from 'zod';

import { isSetStatusTransition, summarizeChangedFields } from '../cards/lifecycle.js';
import { CARD_RECORD_FIELDS, cardIdSchema, cardRecordSchema, nonRootCardIdSchema, positiveSafeIntegerSchema, valuesEqual, type CardRecord } from '../schemas/index.js';
import { cardVersionChangeSchema } from '../schemas/card-version-change.js';
import type { CardVersionChange } from '../schemas/card-version-change.js';
import { uuidV4Schema } from './version-index.js';

export { cardVersionChangeSchema } from '../schemas/card-version-change.js';

export const cardVersionArtifactSchema = z.object({
  format_version: z.literal(1),
  kind: z.literal('card-version'),
  entry_id: uuidV4Schema,
  card_id: cardIdSchema,
  version: positiveSafeIntegerSchema,
  committed_at: z.string().datetime(),
  card: cardRecordSchema,
  change: cardVersionChangeSchema.nullable(),
}).strict().superRefine((artifact, ctx) => {
  if (artifact.card.id !== artifact.card_id || artifact.card.version_seq !== artifact.version) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Artifact and card identity must agree.' });
  if ((artifact.version === 1) !== (artifact.change === null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only card version 1 has a null change.', path: ['change'] });
  if (artifact.change && (artifact.change.entry_id !== artifact.entry_id || artifact.change.card_id !== artifact.card_id || artifact.change.resulting_version !== artifact.version)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Artifact and change identity must agree.', path: ['change'] });
});

export const cardTombstoneArtifactSchema = z.object({
  format_version: z.literal(1),
  kind: z.literal('card-tombstone'),
  entry_id: uuidV4Schema,
  card_id: nonRootCardIdSchema,
  version: positiveSafeIntegerSchema,
  committed_at: z.string().datetime(),
  prior_card_version: positiveSafeIntegerSchema,
  final_card: cardRecordSchema,
  change: cardVersionChangeSchema,
}).strict().superRefine((artifact, ctx) => {
  if (artifact.final_card.id !== artifact.card_id || artifact.final_card.version_seq !== artifact.prior_card_version || artifact.version !== artifact.prior_card_version + 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Tombstone version and final card identity must agree.' });
  if (artifact.change.kind !== 'delete' || artifact.change.entry_id !== artifact.entry_id || artifact.change.card_id !== artifact.card_id || artifact.change.resulting_version !== artifact.version || artifact.change.changed_at !== artifact.committed_at || artifact.change.changed_fields.length !== 1 || artifact.change.changed_fields[0] !== '__deleted__' || artifact.change.change_summary !== 'card deleted' || artifact.change.change_reason !== 'analyst subtree deletion' || artifact.change.terminal_summary !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Tombstone requires the exact delete change.', path: ['change'] });
});

export const cardArtifactSchema = z.union([cardVersionArtifactSchema, cardTombstoneArtifactSchema]);

export type { CardVersionChange } from '../schemas/card-version-change.js';
export type CardVersionArtifact = z.infer<typeof cardVersionArtifactSchema>;
export type CardTombstoneArtifact = z.infer<typeof cardTombstoneArtifactSchema>;
export type CardArtifact = z.infer<typeof cardArtifactSchema>;

export interface CardVersionListEntry {
  readonly entry_id: string;
  readonly version: number;
  readonly artifact_kind: 'card-version' | 'card-tombstone';
  readonly committed_at: string;
  readonly change: CardVersionChange | null;
}

export interface CardStreamFold {
  readonly rows: readonly CardArtifact[];
  readonly head: CardArtifact;
  readonly current: { readonly card: CardRecord; readonly committed_at: string };
  readonly tombstone: CardTombstoneArtifact | null;
}

export function cardVersionListEntry(row: CardArtifact): CardVersionListEntry {
  return Object.freeze({ entry_id: row.entry_id, version: row.version, artifact_kind: row.kind, committed_at: row.committed_at, change: row.change });
}

function fail(path: string, message: string): never { throw new Error(`Card stream '${path}' ${message}.`); }

type CardBusinessField = Exclude<keyof CardRecord, 'updated_at' | 'version_seq'>;
function isBusinessField(field: keyof CardRecord): field is CardBusinessField { return field !== 'updated_at' && field !== 'version_seq'; }
const BUSINESS_FIELDS: readonly CardBusinessField[] = CARD_RECORD_FIELDS.filter(isBusinessField);
function actualDelta(prior: CardRecord, next: CardRecord): string[] { return BUSINESS_FIELDS.filter((field) => !valuesEqual(prior[field], next[field])); }
function requireSame(path: string, left: unknown, right: unknown, message: string): void { if (!valuesEqual(left, right)) fail(path, message); }
function rowCard(row: CardArtifact): CardRecord { return row.kind === 'card-version' ? row.card : row.final_card; }

export function validateCardStream(rows: readonly CardArtifact[], path: string, cardId: string): CardStreamFold {
  if (rows.length === 0) fail(path, 'must contain at least one row.');
  for (const [index, row] of rows.entries()) {
    if (row.card_id !== cardId) fail(path, `row ${index + 1} has the wrong card identity.`);
    if (row.version !== index + 1) fail(path, 'must have contiguous ascending versions.');
    if (index > 0 && rows[index - 1]!.kind === 'card-tombstone') fail(path, 'must not continue past a tombstone row.');
  }
  const first = rows[0]!;
  if (first.kind !== 'card-version') fail(path, 'must begin with the initial card version.');
  validateInitialCard(first.card, path);
  for (const [index, row] of rows.entries()) {
    if (index === 0) continue;
    const prior = rows[index - 1]!;
    if (row.kind === 'card-tombstone') {
      if (cardId === 'project') fail(path, 'cannot tombstone the project card.');
      if (!valuesEqual(rowCard(prior), row.final_card)) fail(path, 'tombstone final card must equal the prior current card.');
      continue;
    }
    validateCardTransition(rowCard(prior), row.card, row.change!, path);
  }
  const head = rows.at(-1)!;
  const tombstone = head.kind === 'card-tombstone' ? head : null;
  return Object.freeze({ rows: Object.freeze([...rows]), head, current: { card: rowCard(head), committed_at: head.committed_at }, tombstone });
}

function requireChange(path: string, change: CardVersionChange, fields: string[], reason: string, summary = summarizeChangedFields(fields)): void {
  requireSame(path, change.changed_fields, fields, 'has the wrong changed fields');
  if (change.change_reason !== reason || change.change_summary !== summary) fail(path, 'has invalid reason or summary');
}

export function validateInitialCard(card: CardRecord, path: string): void {
  const common = card.children.length === 0 && card.version_seq === 1 && card.created_at === card.updated_at && card.subtype === null && card.assigned_to === null && card.metrics === null && card.estimate === null && card.started_at === null && card.duration_ms === null && card.status_text === null && card.status_text_updated_at === null && card.status_text_author_session_id === null && card.latest_self_report === null && card.metadata === null && card.pending_notifications.length === 0 && card.lifecycle.status === 'backlog';
  if (!common) fail(path, 'has an invalid initial card');
  if (card.id === 'project') {
    if (card.type !== 'project' || card.created_by !== 'runtime:bootstrap' || card.tags.length !== 0 || card.priority !== 0 || card.urgency !== 'normal' || card.depends_on.length !== 0 || card.related.length !== 0) fail(path, 'has an invalid initial project card');
  } else if (card.type === 'project') fail(path, 'has an invalid initial child card');
}

function validateTerminal(path: string, prior: CardRecord, next: CardRecord, change: CardVersionChange): void {
  if (prior.lifecycle.status !== 'running' || !['done', 'failed', 'blocked'].includes(next.lifecycle.status)) fail(path, 'has an invalid terminal transition');
  if (next.lifecycle.status !== 'done' && next.lifecycle.status !== 'failed' && next.lifecycle.status !== 'blocked') fail(path, 'has an invalid terminal state');
  const result = next.lifecycle.result;
  const summary = change.terminal_summary!;
  if (result.summary !== next.status_text || summary.summary !== result.summary || summary.status !== next.lifecycle.status || summary.result_kind !== result.kind || next.status_text_updated_at !== change.changed_at) fail(path, 'has inconsistent terminal summary');
  if (result.kind === 'content-policy-refusal') {
    if (!summary.content_policy || summary.content_policy.session_id !== result.session_id || summary.content_policy.marker_id !== result.marker_id || summary.content_policy.evidence_url !== result.evidence_url || summary.content_policy.blocked_at !== change.changed_at) fail(path, 'has inconsistent content-policy terminal metadata');
  }
  if (next.lifecycle.status === 'done' && (result.kind !== 'workflow-result' || result.terminal !== 'DONE' || next.lifecycle.completed_at !== change.changed_at)) fail(path, 'has invalid done terminal relationships');
  if (next.lifecycle.status === 'failed' && ((result.kind === 'workflow-result' && result.terminal !== 'FAILED') || next.lifecycle.error !== result.summary || next.lifecycle.completed_at !== change.changed_at)) fail(path, 'has invalid failed terminal relationships');
  if (next.lifecycle.status === 'blocked' && ((result.kind === 'workflow-result' && result.terminal !== 'BLOCKED') || next.lifecycle.error !== result.summary || next.lifecycle.completed_at !== null)) fail(path, 'has invalid blocked terminal relationships');
  requireSame(path, next.pending_notifications, [], 'retained terminal notifications');
  const fields = ['lifecycle', ...(!valuesEqual(prior.status_text, next.status_text) ? ['status_text'] : []), ...(!valuesEqual(prior.status_text_updated_at, next.status_text_updated_at) ? ['status_text_updated_at'] : []), ...(prior.pending_notifications.length > 0 ? ['pending_notifications'] : [])];
  requireChange(path, change, fields, 'terminal lifecycle commit');
  requireSame(path, actualDelta(prior, next), fields, 'has a terminal piggyback change');
}

export function validateCardTransition(prior: CardRecord, next: CardRecord, change: CardVersionChange, path: string): void {
  if (change.card_id !== next.id || change.resulting_version !== next.version_seq || next.version_seq !== prior.version_seq + 1) fail(path, 'has inconsistent change linkage');
  for (const field of ['id', 'type', 'created_at', 'created_by', 'depends_on'] as const) if (!valuesEqual(next[field], prior[field])) fail(path, `mutates immutable field '${field}'`);
  switch (change.kind) {
    case 'update': {
      if (!['backlog', 'changed', 'stopped'].includes(prior.lifecycle.status)) fail(path, 'edits a disallowed lifecycle state');
      const fields = actualDelta(prior, next);
      if (fields.length === 0 || fields.some((field) => !['title', 'tags', 'priority', 'urgency', 'related'].includes(field))) fail(path, 'has an invalid update delta');
      requireChange(path, change, fields, 'agent edit_card'); break;
    }
    case 'notification_enqueue': {
      const before = prior.pending_notifications; const after = next.pending_notifications;
      if (after.length !== before.length + 1 || !valuesEqual(after.slice(0, -1), before) || before.some((item) => item.id === after.at(-1)!.id)) fail(path, 'has an invalid notification enqueue');
      requireChange(path, change, ['pending_notifications'], 'notification enqueued', 'notification enqueued'); requireSame(path, actualDelta(prior, next), ['pending_notifications'], 'has a notification enqueue piggyback change'); break;
    }
    case 'notification_remove': {
      const survivors = next.pending_notifications; const expected = prior.pending_notifications.filter((candidate) => survivors.some((survivor) => survivor.id === candidate.id));
      if (survivors.length >= prior.pending_notifications.length || !valuesEqual(survivors, expected)) fail(path, 'has an invalid notification removal');
      requireChange(path, change, ['pending_notifications'], 'notifications delivered', 'notifications delivered'); requireSame(path, actualDelta(prior, next), ['pending_notifications'], 'has a notification removal piggyback change'); break;
    }
    case 'status': {
      const from = prior.lifecycle.status; const to = next.lifecycle.status; let reason: string;
      if (from === 'running' && to === 'stopped') reason = 'recovery stopped lifecycle';
      else if (from === 'stopped' && to === 'running') reason = 'STOPPED activation';
      else { if (!isSetStatusTransition(from, to)) fail(path, 'has an invalid status transition'); reason = `status -> ${to}`; }
      const clears = to === 'cancelled' && prior.pending_notifications.length > 0; const fields = ['lifecycle', ...(clears ? ['pending_notifications'] : [])];
      if (to === 'cancelled') requireSame(path, next.pending_notifications, [], 'retained cancellation notifications'); else requireSame(path, next.pending_notifications, prior.pending_notifications, 'changed notifications during status operation');
      requireChange(path, change, fields, reason); requireSame(path, actualDelta(prior, next), fields, 'has a status piggyback change'); break;
    }
    case 'terminal': validateTerminal(path, prior, next, change); break;
    case 'child_link': { const linked = next.children.at(-1); if (!linked || prior.children.includes(linked) || !valuesEqual(next.children.slice(0, -1), prior.children)) fail(path, 'has an invalid child link'); requireChange(path, change, ['children'], 'child linked', `linked child ${linked}`); requireSame(path, actualDelta(prior, next), ['children'], 'has a child-link piggyback change'); break; }
    case 'reorder': if (valuesEqual(prior.children, next.children) || next.children.length !== prior.children.length || new Set(next.children).size !== next.children.length || prior.children.some((id) => !next.children.includes(id))) fail(path, 'has an invalid child reorder'); else { requireChange(path, change, ['children'], 'children reordered', 'children reordered'); requireSame(path, actualDelta(prior, next), ['children'], 'has a reorder piggyback change'); } break;
    case 'delete': fail(path, 'uses delete change on an ordinary version');
  }
}
