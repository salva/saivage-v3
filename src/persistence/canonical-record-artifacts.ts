import { z } from 'zod';
import {
  sha256Hex,
  agentNameSchema,
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
  format_version: z.literal(1),
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
    writer_agent: z.union([agentNameSchema, z.literal('runtime:bootstrap')]),
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
    opened_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    content: z.string(),
    content_sha256: hash,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (sha256Hex(value.content) !== value.content_sha256)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Draft content hash mismatch.' });
  });
export const recordHeadSchema = z
  .object({
    ...identity,
    kind: z.literal('record-head'),
    revision: positiveSafeIntegerSchema,
    draft: openRecordDraftSchema.nullable(),
    accepted: acceptedRecordReferenceSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.accepted && value.accepted.version > value.revision)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Accepted selection exceeds record revision.',
      });
  });
export const authoredRecordVersionArtifactSchema = z
  .object({
    ...identity,
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
    if (value.predecessor && value.predecessor.version >= value.version)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Accepted predecessor must decrease.' });
  });
export type AcceptedRecordSnapshot = z.infer<typeof acceptedRecordSnapshotSchema>;
export type AuthoredRecordVersionArtifact = z.infer<typeof authoredRecordVersionArtifactSchema>;
export type RecordHead = z.infer<typeof recordHeadSchema>;
export type OpenRecordDraft = z.infer<typeof openRecordDraftSchema>;
export type AcceptedRecordReference = z.infer<typeof acceptedRecordReferenceSchema>;

export function effectiveRecordContent(record: {
  revision: number;
  draft: OpenRecordDraft | null;
  accepted: AcceptedRecordSnapshot | null;
}) {
  if (record.draft)
    return {
      content: record.draft.content,
      source: 'draft' as const,
      modifiedAt: record.draft.updated_at,
      writer: null,
      version: record.revision,
    };
  if (record.accepted)
    return {
      content: record.accepted.content,
      source: 'accepted' as const,
      modifiedAt: record.accepted.committed_at,
      writer: record.accepted.writer_agent,
      version: record.accepted.source_version,
    };
  return null;
}
