import { z } from 'zod';

import { summarizeChangedFields } from '../cards/lifecycle.js';
import { cardIdSchema, cardRecordSchema, nonRootCardIdSchema, positiveSafeIntegerSchema, type CardRecord } from '../schemas/index.js';
import { cardVersionChangeSchema } from '../schemas/card-version-change.js';
import type { CardVersionChange } from '../schemas/card-version-change.js';
import { jsonVersionFilenameSchema, uuidV4Schema, validateHeadFields } from './version-index.js';

export { cardVersionChangeSchema } from '../schemas/card-version-change.js';

export const cardVersionEntrySchema = z.object({
  entry_id: uuidV4Schema,
  version: positiveSafeIntegerSchema,
  filename: jsonVersionFilenameSchema,
  artifact_kind: z.enum(['card-version', 'card-tombstone']),
  committed_at: z.string().datetime(),
  change: cardVersionChangeSchema.nullable(),
}).strict().superRefine((entry, ctx) => {
  if ((entry.version === 1) !== (entry.change === null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only card version 1 has a null change.', path: ['change'] });
  if (entry.change && (entry.change.entry_id !== entry.entry_id || entry.change.resulting_version !== entry.version)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Entry and change identity must agree.', path: ['change'] });
  if ((entry.artifact_kind === 'card-tombstone') !== (entry.change?.kind === 'delete')) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A tombstone entry requires exactly a delete change.', path: ['artifact_kind'] });
});

export const cardVersionIndexSchema = z.object({
  format_version: z.literal(1),
  kind: z.literal('card-version-index'),
  card_id: cardIdSchema,
  versions: z.array(cardVersionEntrySchema),
  current_version: positiveSafeIntegerSchema.nullable(),
  current_filename: jsonVersionFilenameSchema.nullable(),
}).strict().superRefine((index, ctx) => {
  validateHeadFields(index, ctx);
  const tombstones = index.versions.filter((entry) => entry.artifact_kind === 'card-tombstone');
  if (tombstones.length > 1 || (tombstones.length === 1 && index.versions.at(-1) !== tombstones[0])) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A card tombstone may occur only once as the terminal entry.', path: ['versions'] });
  if (index.card_id === 'project' && tombstones.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The project card cannot be tombstoned.', path: ['versions'] });
  for (const [position, entry] of index.versions.entries()) if (entry.change && entry.change.card_id !== index.card_id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Entry change card identity must equal index card identity.', path: ['versions', position, 'change', 'card_id'] });
});

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
export type CardVersionEntry = z.infer<typeof cardVersionEntrySchema>;
export type CardVersionIndex = z.infer<typeof cardVersionIndexSchema>;
export type CardVersionArtifact = z.infer<typeof cardVersionArtifactSchema>;
export type CardTombstoneArtifact = z.infer<typeof cardTombstoneArtifactSchema>;
export type CardArtifact = z.infer<typeof cardArtifactSchema>;

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function fail(path: string, message: string): never { throw new Error(`Card version '${path}' ${message}.`); }
function requireSame(path: string, left: unknown, right: unknown, message: string): void { if (!same(left, right)) fail(path, message); }

const BUSINESS_FIELDS = ['id', 'type', 'children', 'title', 'subtype', 'tags', 'priority', 'urgency', 'created_by', 'created_at', 'assigned_to', 'depends_on', 'related', 'lifecycle', 'metrics', 'estimate', 'started_at', 'duration_ms', 'status_text', 'status_text_updated_at', 'status_text_author_session_id', 'latest_self_report', 'metadata', 'pending_notifications'] as const satisfies ReadonlyArray<keyof CardRecord>;
function actualDelta(prior: CardRecord, next: CardRecord): string[] { return BUSINESS_FIELDS.filter((field) => !same(prior[field], next[field])); }
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
  const fields = ['lifecycle', ...(!same(prior.status_text, next.status_text) ? ['status_text'] : []), ...(!same(prior.status_text_updated_at, next.status_text_updated_at) ? ['status_text_updated_at'] : []), ...(prior.pending_notifications.length > 0 ? ['pending_notifications'] : [])];
  requireChange(path, change, fields, 'terminal lifecycle commit');
  requireSame(path, actualDelta(prior, next), fields, 'has a terminal piggyback change');
}

export function validateCardTransition(prior: CardRecord, next: CardRecord, change: CardVersionChange, path: string): void {
  if (change.card_id !== next.id || change.resulting_version !== next.version_seq || next.version_seq !== prior.version_seq + 1) fail(path, 'has inconsistent change linkage');
  for (const field of ['id', 'type', 'created_at', 'created_by', 'depends_on'] as const) if (!same(next[field], prior[field])) fail(path, `mutates immutable field '${field}'`);
  switch (change.kind) {
    case 'update': {
      if (!['backlog', 'changed', 'stopped'].includes(prior.lifecycle.status)) fail(path, 'edits a disallowed lifecycle state');
      const fields = actualDelta(prior, next);
      if (fields.length === 0 || fields.some((field) => !['title', 'tags', 'priority', 'urgency', 'related'].includes(field))) fail(path, 'has an invalid update delta');
      requireChange(path, change, fields, 'agent edit_card'); break;
    }
    case 'notification_enqueue': {
      const before = prior.pending_notifications; const after = next.pending_notifications;
      if (after.length !== before.length + 1 || !same(after.slice(0, -1), before) || before.some((item) => item.id === after.at(-1)!.id)) fail(path, 'has an invalid notification enqueue');
      requireChange(path, change, ['pending_notifications'], 'notification enqueued', 'notification enqueued'); requireSame(path, actualDelta(prior, next), ['pending_notifications'], 'has a notification enqueue piggyback change'); break;
    }
    case 'notification_remove': {
      const survivors = next.pending_notifications; const expected = prior.pending_notifications.filter((candidate) => survivors.some((survivor) => survivor.id === candidate.id));
      if (survivors.length >= prior.pending_notifications.length || !same(survivors, expected)) fail(path, 'has an invalid notification removal');
      requireChange(path, change, ['pending_notifications'], 'notifications delivered', 'notifications delivered'); requireSame(path, actualDelta(prior, next), ['pending_notifications'], 'has a notification removal piggyback change'); break;
    }
    case 'status': {
      const from = prior.lifecycle.status; const to = next.lifecycle.status; let reason: string;
      if (from === 'running' && to === 'stopped') reason = 'recovery stopped lifecycle';
      else if (from === 'stopped' && to === 'running') reason = 'STOPPED activation';
      else { const admitted = (to === 'running' && ['backlog', 'blocked', 'changed'].includes(from)) || (to === 'changed' && ['blocked', 'done', 'failed'].includes(from)) || (to === 'cancelled' && ['backlog', 'running', 'blocked', 'changed', 'stopped', 'failed'].includes(from)); if (!admitted) fail(path, 'has an invalid status transition'); reason = `status -> ${to}`; }
      const clears = to === 'cancelled' && prior.pending_notifications.length > 0; const fields = ['lifecycle', ...(clears ? ['pending_notifications'] : [])];
      if (to === 'cancelled') requireSame(path, next.pending_notifications, [], 'retained cancellation notifications'); else requireSame(path, next.pending_notifications, prior.pending_notifications, 'changed notifications during status operation');
      requireChange(path, change, fields, reason); requireSame(path, actualDelta(prior, next), fields, 'has a status piggyback change'); break;
    }
    case 'terminal': validateTerminal(path, prior, next, change); break;
    case 'child_link': { const linked = next.children.at(-1); if (!linked || prior.children.includes(linked) || !same(next.children.slice(0, -1), prior.children)) fail(path, 'has an invalid child link'); requireChange(path, change, ['children'], 'child linked', `linked child ${linked}`); requireSame(path, actualDelta(prior, next), ['children'], 'has a child-link piggyback change'); break; }
    case 'reorder': if (same(prior.children, next.children) || next.children.length !== prior.children.length || new Set(next.children).size !== next.children.length || prior.children.some((id) => !next.children.includes(id))) fail(path, 'has an invalid child reorder'); else { requireChange(path, change, ['children'], 'children reordered', 'children reordered'); requireSame(path, actualDelta(prior, next), ['children'], 'has a reorder piggyback change'); } break;
    case 'delete': fail(path, 'uses delete change on an ordinary version');
  }
}
