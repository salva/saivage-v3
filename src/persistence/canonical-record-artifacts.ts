import { z } from 'zod';
import {
  sha256Hex,
  recordAuthorSchema,
  cardIdSchema,
  positiveSafeIntegerSchema,
  recordNameSchema,
  uuidV4Schema,
} from '../schemas/index.js';
import { cardArtifactReferenceSchema } from './canonical-card-artifacts.js';

export function isEmptyRecordContent(content: string): boolean {
  return content.trim().length === 0;
}
const acceptedRecordReferenceSchema = z
  .object({ entry_id: uuidV4Schema, version: positiveSafeIntegerSchema })
  .strict();
const identity = {
  card_id: cardIdSchema,
  record_name: recordNameSchema,
  record_format: z.literal('markdown'),
  schema: z.string().min(1),
};
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const acceptedRecordSnapshotSchema = z
  .object({
    source_version: positiveSafeIntegerSchema,
    source_entry_id: uuidV4Schema,
    committed_at: z.string().datetime(),
    author: recordAuthorSchema,
    card_version_seq: positiveSafeIntegerSchema,
    card_history: cardArtifactReferenceSchema,
    content: z.string(),
    content_sha256: hash,
    size_bytes: z.number().int().safe().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      isEmptyRecordContent(value.content) ||
      sha256Hex(value.content) !== value.content_sha256 ||
      Buffer.byteLength(value.content) !== value.size_bytes
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid accepted content, hash or size.',
      });
    if (value.card_history.version > value.card_version_seq)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ordinary provenance exceeds observed card revision.',
      });
  });
const openRecordDraftSchema = z
  .object({
    version: z.number().int().safe().nonnegative(),
    target_version: positiveSafeIntegerSchema,
    opened_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    content: z.string(),
    content_sha256: hash,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (sha256Hex(value.content) !== value.content_sha256)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Draft content hash mismatch.' });
    if (
      value.version !== value.target_version &&
      !(value.version === 0 && value.target_version === 1)
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid draft document version.' });
    if (value.version === 0 && isEmptyRecordContent(value.content))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Draft0 must retain nonempty baseline content.',
      });
  });
const recordBaselineSchema = z
  .object({
    version: z.literal(0),
    created_at: z.string().datetime(),
    content: z.string(),
    content_sha256: hash,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (isEmptyRecordContent(value.content) || sha256Hex(value.content) !== value.content_sha256)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid baseline content or hash.' });
  });
export const recordHeadSchema = z
  .object({
    ...identity,
    format_version: z.literal(3),
    kind: z.literal('record-head'),
    head_id: uuidV4Schema,
    revision: positiveSafeIntegerSchema,
    baseline: recordBaselineSchema.nullable(),
    draft: openRecordDraftSchema.nullable(),
    accepted: acceptedRecordReferenceSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.baseline && (value.draft || value.accepted))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Baseline cannot coexist with authored state.',
      });
    if (
      value.draft &&
      (value.draft.target_version !== (value.accepted?.version ?? 0) + 1 ||
        (value.draft.version === 0 && value.accepted))
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Draft target disagrees with accepted backing.',
      });
    if (value.accepted && value.accepted.version > value.revision)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Accepted selection exceeds record revision.',
      });
  });
export const authoredRecordVersionArtifactSchema = z
  .object({
    ...identity,
    format_version: z.literal(3),
    kind: z.literal('accepted-record'),
    entry_id: uuidV4Schema,
    version: positiveSafeIntegerSchema,
    published_at: z.string().datetime(),
    accepted: acceptedRecordSnapshotSchema,
    predecessor: acceptedRecordReferenceSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.entry_id !== value.accepted.source_entry_id ||
      value.version !== value.accepted.source_version ||
      value.published_at !== value.accepted.committed_at
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Accepted source identity mismatch.' });
    if (value.version !== (value.predecessor?.version ?? 0) + 1)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Accepted document versions must be consecutive.',
      });
    if (
      value.accepted.author.kind === 'runtime' &&
      value.accepted.author.purpose === 'repair' &&
      (value.version !== 1 ||
        value.predecessor !== null ||
        value.accepted.card_version_seq !== 1 ||
        value.accepted.card_history.version !== 1)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid synthetic repair acceptance origin.',
      });
  });
export type AcceptedRecordSnapshot = z.infer<typeof acceptedRecordSnapshotSchema>;
export type AuthoredRecordVersionArtifact = z.infer<typeof authoredRecordVersionArtifactSchema>;
export type RecordHead = z.infer<typeof recordHeadSchema>;
export type OpenRecordDraft = z.infer<typeof openRecordDraftSchema>;
export type AcceptedRecordReference = z.infer<typeof acceptedRecordReferenceSchema>;
export type RecordBaseline = z.infer<typeof recordBaselineSchema>;

/** Effective drafts never borrow eligibility from accepted backing. */
export function isEligibleRecordContent(record: {
  draft: OpenRecordDraft | null;
  accepted: AcceptedRecordSnapshot | null;
}): boolean {
  return record.draft
    ? record.draft.version > 0 && !isEmptyRecordContent(record.draft.content)
    : record.accepted !== null && !isEmptyRecordContent(record.accepted.content);
}

export function effectiveRecordContent(record: {
  baseline: RecordBaseline | null;
  draft: OpenRecordDraft | null;
  accepted: AcceptedRecordSnapshot | null;
}) {
  if (record.draft)
    return {
      content: record.draft.content,
      source: 'draft' as const,
      modifiedAt: record.draft.updated_at,
      author: null,
      version: record.draft.version,
      targetVersion: record.draft.target_version,
    };
  if (record.baseline)
    return {
      content: record.baseline.content,
      source: 'baseline' as const,
      modifiedAt: record.baseline.created_at,
      author: null,
      version: 0,
    };
  if (record.accepted)
    return {
      content: record.accepted.content,
      source: 'accepted' as const,
      modifiedAt: record.accepted.committed_at,
      author: record.accepted.author,
      version: record.accepted.source_version,
    };
  return null;
}
