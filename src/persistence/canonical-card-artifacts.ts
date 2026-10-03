import { z } from 'zod';

import { isSetStatusTransition, summarizeChangedFields } from '../cards/status-api.js';
import {
  CARD_RECORD_FIELDS,
  cardIdSchema,
  cardRecordSchema,
  ordinaryCardPayloadSchema,
  cardNotificationSchema,
  cardVersionChangeSchema,
  nonRootCardIdSchema,
  positiveSafeIntegerSchema,
  uuidV4Schema,
  valuesEqual,
  type CardRecord,
  type CardVersionChange,
} from '../schemas/index.js';

export { cardVersionChangeSchema } from '../schemas/index.js';

export const cardArtifactReferenceSchema = z
  .object({ entry_id: uuidV4Schema, version: positiveSafeIntegerSchema })
  .strict();
export type CardArtifactReference = z.infer<typeof cardArtifactReferenceSchema>;
export const cardHeadSchema = z
  .object({
    format_version: z.literal(1),
    kind: z.literal('card-head'),
    card_id: cardIdSchema,
    version_seq: positiveSafeIntegerSchema,
    updated_at: z.string().datetime(),
    ordinary: cardArtifactReferenceSchema,
    pending: z.array(uuidV4Schema),
  })
  .strict()
  .superRefine((head, ctx) => {
    if (
      head.ordinary.version > head.version_seq ||
      new Set(head.pending).size !== head.pending.length
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid card head selection.' });
  });
type CardHead = z.infer<typeof cardHeadSchema>;
export const cardMailboxMessageSchema = z
  .object({
    format_version: z.literal(1),
    kind: z.literal('card-message'),
    card_id: cardIdSchema,
    notification: cardNotificationSchema,
  })
  .strict();

export function ordinaryCardPayload(card: CardRecord): z.infer<typeof ordinaryCardPayloadSchema> {
  const { version_seq, updated_at, pending_notifications, ...payload } = card;
  return payload;
}

export const cardVersionArtifactSchema = z
  .object({
    format_version: z.literal(1),
    kind: z.literal('card-version'),
    entry_id: uuidV4Schema,
    card_id: cardIdSchema,
    version: positiveSafeIntegerSchema,
    committed_at: z.string().datetime(),
    card: ordinaryCardPayloadSchema,
    predecessor: cardArtifactReferenceSchema.nullable(),
    change: cardVersionChangeSchema.nullable(),
  })
  .strict()
  .transform((artifact) => ({
    ...artifact,
    card: cardRecordSchema.parse({
      ...artifact.card,
      version_seq: artifact.version,
      updated_at: artifact.committed_at,
      pending_notifications: [],
    }),
  }))
  .superRefine((artifact, ctx) => {
    if (artifact.card.id !== artifact.card_id || artifact.card.version_seq !== artifact.version)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Artifact and card identity must agree.',
      });
    if ((artifact.version === 1) !== (artifact.change === null))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only card version 1 has a null change.',
        path: ['change'],
      });
    if (
      (artifact.version === 1) !== (artifact.predecessor === null) ||
      (artifact.predecessor !== null && artifact.predecessor.version >= artifact.version) ||
      artifact.change?.kind === 'notification_enqueue' ||
      artifact.change?.kind === 'notification_remove' ||
      artifact.change?.kind === 'delete' ||
      artifact.change?.changed_fields.includes('pending_notifications') ||
      (artifact.change !== null && artifact.change.changed_at !== artifact.committed_at)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid ordinary history linkage or change.',
      });
    if (artifact.version === 1) validateInitialCard(artifact.card, artifact.card_id);
    if (
      artifact.change &&
      (artifact.change.entry_id !== artifact.entry_id ||
        artifact.change.card_id !== artifact.card_id ||
        artifact.change.resulting_version !== artifact.version)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Artifact and change identity must agree.',
        path: ['change'],
      });
  });

export const cardTombstoneArtifactSchema = z
  .object({
    format_version: z.literal(1),
    kind: z.literal('card-tombstone'),
    entry_id: uuidV4Schema,
    card_id: nonRootCardIdSchema,
    version: positiveSafeIntegerSchema,
    committed_at: z.string().datetime(),
    prior_card_version: positiveSafeIntegerSchema,
    prior_updated_at: z.string().datetime(),
    final_card: ordinaryCardPayloadSchema,
    predecessor: cardArtifactReferenceSchema,
    change: cardVersionChangeSchema,
  })
  .strict()
  .transform((artifact) => ({
    ...artifact,
    final_card: cardRecordSchema.parse({
      ...artifact.final_card,
      version_seq: artifact.prior_card_version,
      updated_at: artifact.prior_updated_at,
      pending_notifications: [],
    }),
  }))
  .superRefine((artifact, ctx) => {
    if (
      artifact.final_card.id !== artifact.card_id ||
      artifact.final_card.version_seq !== artifact.prior_card_version ||
      artifact.version !== artifact.prior_card_version + 1 ||
      artifact.predecessor.version > artifact.prior_card_version
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Tombstone version and final card identity must agree.',
      });
    if (
      artifact.change.kind !== 'delete' ||
      artifact.change.entry_id !== artifact.entry_id ||
      artifact.change.card_id !== artifact.card_id ||
      artifact.change.resulting_version !== artifact.version ||
      artifact.change.changed_at !== artifact.committed_at ||
      artifact.change.changed_fields.length !== 1 ||
      artifact.change.changed_fields[0] !== '__deleted__' ||
      artifact.change.change_summary !== 'card deleted' ||
      artifact.change.change_reason !== 'analyst subtree deletion' ||
      artifact.change.terminal_summary !== null
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Tombstone requires the exact delete change.',
        path: ['change'],
      });
  });

export const cardArtifactSchema = z.union([cardVersionArtifactSchema, cardTombstoneArtifactSchema]);

export type { CardVersionChange } from '../schemas/index.js';
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

export interface CurrentCardSelection {
  readonly selection: CardHead;
  readonly head: CardArtifact;
  readonly current: { readonly card: CardRecord; readonly committed_at: string };
  readonly tombstone: CardTombstoneArtifact | null;
}

export function cardVersionListEntry(row: CardArtifact): CardVersionListEntry {
  return Object.freeze({
    entry_id: row.entry_id,
    version: row.version,
    artifact_kind: row.kind,
    committed_at: row.committed_at,
    change: row.change,
  });
}

function fail(path: string, message: string): never {
  throw new Error(`Card stream '${path}' ${message}.`);
}

type CardBusinessField = Exclude<keyof CardRecord, 'updated_at' | 'version_seq'>;
function isBusinessField(field: keyof CardRecord): field is CardBusinessField {
  return field !== 'updated_at' && field !== 'version_seq';
}
const BUSINESS_FIELDS: readonly CardBusinessField[] = CARD_RECORD_FIELDS.filter(isBusinessField);
function actualDelta(prior: CardRecord, next: CardRecord): string[] {
  return BUSINESS_FIELDS.filter((field) => !valuesEqual(prior[field], next[field]));
}
function requireSame(path: string, left: unknown, right: unknown, message: string): void {
  if (!valuesEqual(left, right)) fail(path, message);
}
function requireChange(
  path: string,
  change: CardVersionChange,
  fields: string[],
  reason: string,
  summary = summarizeChangedFields(fields),
): void {
  requireSame(path, change.changed_fields, fields, 'has the wrong changed fields');
  if (change.change_reason !== reason || change.change_summary !== summary)
    fail(path, 'has invalid reason or summary');
}

export function validateInitialCard(card: CardRecord, path: string): void {
  const common =
    card.child_membership.length === 0 &&
    card.active_child_order.length === 0 &&
    card.version_seq === 1 &&
    card.created_at === card.updated_at &&
    card.subtype === null &&
    card.assigned_to === null &&
    card.metrics === null &&
    card.estimate === null &&
    card.started_at === null &&
    card.duration_ms === null &&
    card.status_text === null &&
    card.status_text_updated_at === null &&
    card.status_text_author_session_id === null &&
    card.latest_self_report === null &&
    card.metadata === null &&
    card.pending_notifications.length === 0 &&
    card.lifecycle.status === 'backlog';
  if (!common) fail(path, 'has an invalid initial card');
  if (card.id === 'project') {
    if (
      card.type !== 'project' ||
      card.created_by !== 'runtime:bootstrap' ||
      card.priority !== 0 ||
      card.urgency !== 'normal' ||
      card.depends_on.length !== 0
    )
      fail(path, 'has an invalid initial project card');
  } else if (card.type === 'project') fail(path, 'has an invalid initial child card');
}

function validateTerminal(
  path: string,
  prior: CardRecord,
  next: CardRecord,
  change: CardVersionChange,
): void {
  if (
    prior.lifecycle.status !== 'running' ||
    !['done', 'failed', 'blocked'].includes(next.lifecycle.status)
  )
    fail(path, 'has an invalid terminal transition');
  const result = next.lifecycle.result!;
  const summary = change.terminal_summary!;
  if (
    result.summary !== next.status_text ||
    summary.summary !== result.summary ||
    summary.status !== next.lifecycle.status ||
    summary.result_kind !== result.kind ||
    next.status_text_updated_at !== change.changed_at
  )
    fail(path, 'has inconsistent terminal summary');
  if (result.kind === 'content-policy-refusal') {
    if (
      !summary.content_policy ||
      summary.content_policy.session_id !== result.session_id ||
      summary.content_policy.marker_id !== result.marker_id ||
      summary.content_policy.evidence_url !== result.evidence_url ||
      summary.content_policy.blocked_at !== change.changed_at
    )
      fail(path, 'has inconsistent content-policy terminal metadata');
  }
  if (
    next.lifecycle.status === 'done' &&
    (result.kind !== 'workflow-result' ||
      result.terminal !== 'DONE' ||
      next.lifecycle.completed_at !== change.changed_at)
  )
    fail(path, 'has invalid done terminal relationships');
  if (
    next.lifecycle.status === 'failed' &&
    ((result.kind === 'workflow-result' && result.terminal !== 'FAILED') ||
      next.lifecycle.error !== result.summary ||
      next.lifecycle.completed_at !== change.changed_at)
  )
    fail(path, 'has invalid failed terminal relationships');
  if (
    next.lifecycle.status === 'blocked' &&
    ((result.kind === 'workflow-result' && result.terminal !== 'BLOCKED') ||
      next.lifecycle.error !== result.summary ||
      next.lifecycle.completed_at !== null)
  )
    fail(path, 'has invalid blocked terminal relationships');
  requireSame(path, next.pending_notifications, [], 'retained terminal notifications');
  const fields = [
    'lifecycle',
    ...(!valuesEqual(prior.status_text, next.status_text) ? ['status_text'] : []),
    ...(!valuesEqual(prior.status_text_updated_at, next.status_text_updated_at)
      ? ['status_text_updated_at']
      : []),
    ...(prior.pending_notifications.length > 0 ? ['pending_notifications'] : []),
  ];
  requireChange(path, change, fields, 'terminal lifecycle commit');
  requireSame(path, actualDelta(prior, next), fields, 'has a terminal piggyback change');
}

export function validateCardTransition(
  prior: CardRecord,
  next: CardRecord,
  change: CardVersionChange,
  path: string,
  linkage: 'live' | 'history' = 'live',
): void {
  if (
    change.card_id !== next.id ||
    change.resulting_version !== next.version_seq ||
    change.changed_at !== next.updated_at ||
    (linkage === 'live'
      ? next.version_seq !== prior.version_seq + 1
      : next.version_seq <= prior.version_seq)
  )
    fail(path, 'has inconsistent change linkage');
  for (const field of ['id', 'type', 'created_at', 'created_by', 'depends_on'] as const)
    if (!valuesEqual(next[field], prior[field])) fail(path, `mutates immutable field '${field}'`);
  switch (change.kind) {
    case 'update': {
      if (!['backlog', 'changed', 'stopped'].includes(prior.lifecycle.status))
        fail(path, 'edits a disallowed lifecycle state');
      const fields = actualDelta(prior, next);
      if (
        fields.length === 0 ||
        fields.some((field) => !['title', 'priority', 'urgency'].includes(field))
      )
        fail(path, 'has an invalid update delta');
      requireChange(path, change, fields, 'agent edit_card');
      break;
    }
    case 'notification_enqueue': {
      const before = prior.pending_notifications;
      const after = next.pending_notifications;
      if (
        after.length !== before.length + 1 ||
        !valuesEqual(after.slice(0, -1), before) ||
        before.includes(after.at(-1)!)
      )
        fail(path, 'has an invalid notification enqueue');
      requireChange(
        path,
        change,
        ['pending_notifications'],
        'notification enqueued',
        'notification enqueued',
      );
      requireSame(
        path,
        actualDelta(prior, next),
        ['pending_notifications'],
        'has a notification enqueue piggyback change',
      );
      break;
    }
    case 'notification_remove': {
      const survivors = next.pending_notifications;
      const expected = prior.pending_notifications.filter((candidate) =>
        survivors.includes(candidate),
      );
      if (
        survivors.length >= prior.pending_notifications.length ||
        !valuesEqual(survivors, expected)
      )
        fail(path, 'has an invalid notification removal');
      requireChange(
        path,
        change,
        ['pending_notifications'],
        'notifications delivered',
        'notifications delivered',
      );
      requireSame(
        path,
        actualDelta(prior, next),
        ['pending_notifications'],
        'has a notification removal piggyback change',
      );
      break;
    }
    case 'status': {
      const from = prior.lifecycle.status;
      const to = next.lifecycle.status;
      let reason: string;
      if (from === 'running' && to === 'stopped') reason = 'recovery stopped lifecycle';
      else if (from === 'stopped' && to === 'running') reason = 'STOPPED activation';
      else {
        if (!isSetStatusTransition(from, to)) fail(path, 'has an invalid status transition');
        reason = `status -> ${to}`;
      }
      const clears = to === 'cancelled' && prior.pending_notifications.length > 0;
      const fields = ['lifecycle', ...(clears ? ['pending_notifications'] : [])];
      if (to === 'cancelled')
        requireSame(path, next.pending_notifications, [], 'retained cancellation notifications');
      else
        requireSame(
          path,
          next.pending_notifications,
          prior.pending_notifications,
          'changed notifications during status operation',
        );
      requireChange(path, change, fields, reason);
      requireSame(path, actualDelta(prior, next), fields, 'has a status piggyback change');
      break;
    }
    case 'terminal':
      validateTerminal(path, prior, next, change);
      break;
    case 'child_link': {
      const linked = next.child_membership.at(-1);
      if (
        !linked ||
        prior.child_membership.includes(linked) ||
        prior.active_child_order.includes(linked) ||
        !valuesEqual(next.child_membership.slice(0, -1), prior.child_membership) ||
        !valuesEqual(next.active_child_order.slice(0, -1), prior.active_child_order) ||
        next.active_child_order.at(-1) !== linked
      )
        fail(path, 'has an invalid child link');
      requireChange(
        path,
        change,
        ['child_membership', 'active_child_order'],
        'child linked',
        `linked child ${linked}`,
      );
      requireSame(
        path,
        actualDelta(prior, next),
        ['child_membership', 'active_child_order'],
        'has a child-link piggyback change',
      );
      break;
    }
    case 'reorder':
      if (
        !valuesEqual(prior.child_membership, next.child_membership) ||
        valuesEqual(prior.active_child_order, next.active_child_order) ||
        next.active_child_order.length !== prior.active_child_order.length ||
        new Set(next.active_child_order).size !== next.active_child_order.length ||
        prior.active_child_order.some((id) => !next.active_child_order.includes(id))
      )
        fail(path, 'has an invalid child reorder');
      else {
        requireChange(
          path,
          change,
          ['active_child_order'],
          'children reordered',
          'children reordered',
        );
        requireSame(
          path,
          actualDelta(prior, next),
          ['active_child_order'],
          'has a reorder piggyback change',
        );
      }
      break;
    case 'delete':
      fail(path, 'uses delete change on an ordinary version');
  }
}
