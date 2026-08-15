import { createHash } from 'node:crypto';
import { z } from 'zod';

import { agentNameSchema, cardIdSchema, positiveSafeIntegerSchema, recordNameSchema, type AgentName, type RecordName } from '../schemas/index.js';
import { jsonVersionFilenameSchema, uuidV4Schema, validateHeadFields } from './version-index.js';

const nonEmptyStringSchema = z.string().min(1);
const nonNegativeSafeIntegerSchema = z.number().int().safe().nonnegative();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const writerSchema = z.union([agentNameSchema, z.literal('runtime:bootstrap')]);

export function recordContentSha256(content: string): string { return createHash('sha256').update(content, 'utf8').digest('hex'); }
export function isEmptyRecordContent(content: string): boolean { return content.trim().length === 0; }

const acceptedRecordSnapshotShape = {
  source_version: positiveSafeIntegerSchema,
  source_entry_id: uuidV4Schema,
  committed_at: z.string().datetime(),
  writer_agent: writerSchema,
  card_version_seq: positiveSafeIntegerSchema,
  content: z.string(),
  content_sha256: sha256Schema,
  size_bytes: nonNegativeSafeIntegerSchema,
} as const;
export const acceptedRecordSnapshotSchema = z.object(acceptedRecordSnapshotShape).strict().superRefine((accepted, ctx) => {
  if (isEmptyRecordContent(accepted.content)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Accepted record content must not be empty.', path: ['content'] });
  if (recordContentSha256(accepted.content) !== accepted.content_sha256) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Accepted content hash does not match content.', path: ['content_sha256'] });
  if (Buffer.byteLength(accepted.content, 'utf8') !== accepted.size_bytes) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Accepted content size does not match content.', path: ['size_bytes'] });
});

const openRecordDraftShape = { opened_at: z.string().datetime(), updated_at: z.string().datetime(), content: z.string(), content_sha256: sha256Schema } as const;
export const openRecordDraftSchema = z.object(openRecordDraftShape).strict().superRefine((draft, ctx) => {
  if (recordContentSha256(draft.content) !== draft.content_sha256) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Draft content hash does not match content.', path: ['content_sha256'] });
});
export const discardedRecordStateSchema = z.object({ discarded_at: z.string().datetime(), reason: nonEmptyStringSchema }).strict();

const { content: _acceptedContent, ...acceptedMetadataShape } = acceptedRecordSnapshotShape;
const { content: _draftContent, ...draftMetadataBaseShape } = openRecordDraftShape;
const acceptedMetadataSchema = z.object(acceptedMetadataShape).strict();
const draftMetadataSchema = z.object({ ...draftMetadataBaseShape, size_bytes: nonNegativeSafeIntegerSchema }).strict();

export const recordVersionEntrySchema = z.object({
  entry_id: uuidV4Schema,
  version: positiveSafeIntegerSchema,
  filename: jsonVersionFilenameSchema,
  state: z.enum(['open', 'closed', 'discarded']),
  published_at: z.string().datetime(),
  accepted: acceptedMetadataSchema.nullable(),
  draft: draftMetadataSchema.nullable(),
  discarded: discardedRecordStateSchema.nullable(),
}).strict().superRefine((entry, ctx) => refineRecordState(entry, ctx));

export const authoredRecordVersionIndexSchema = z.object({
  format_version: z.literal(1), kind: z.literal('authored-record-version-index'), card_id: cardIdSchema,
  record_name: recordNameSchema, record_format: z.literal('markdown'), schema: nonEmptyStringSchema,
  versions: z.array(recordVersionEntrySchema), current_version: positiveSafeIntegerSchema.nullable(), current_filename: jsonVersionFilenameSchema.nullable(),
}).strict().superRefine((index, ctx) => {
  validateHeadFields(index, ctx);
  for (const [position, entry] of index.versions.entries()) {
    if (entry.state === 'closed') {
      if (!entry.accepted || entry.accepted.source_version !== entry.version || entry.accepted.source_entry_id !== entry.entry_id || entry.accepted.committed_at !== entry.published_at) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Closed entry accepted source must identify itself.', path: ['versions', position, 'accepted'] });
    }
    if (entry.accepted) {
      const source = index.versions[entry.accepted.source_version - 1];
      if (!source || source.state !== 'closed' || source.entry_id !== entry.accepted.source_entry_id || !source.accepted || source.accepted.source_version !== source.version || source.accepted.source_entry_id !== source.entry_id || !sameAcceptedMetadata(source.accepted, entry.accepted)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Accepted baseline must match its closed source entry.', path: ['versions', position, 'accepted'] });
    }
  }
});

export const authoredRecordVersionArtifactSchema = z.object({
  format_version: z.literal(1), kind: z.literal('authored-record-version'), entry_id: uuidV4Schema,
  card_id: cardIdSchema, record_name: recordNameSchema, record_format: z.literal('markdown'), schema: nonEmptyStringSchema,
  version: positiveSafeIntegerSchema, published_at: z.string().datetime(), state: z.enum(['open', 'closed', 'discarded']),
  accepted: acceptedRecordSnapshotSchema.nullable(), draft: openRecordDraftSchema.nullable(), discarded: discardedRecordStateSchema.nullable(),
}).strict().superRefine((artifact, ctx) => {
  refineRecordState(artifact, ctx);
  if (artifact.state === 'closed' && (!artifact.accepted || artifact.accepted.source_version !== artifact.version || artifact.accepted.source_entry_id !== artifact.entry_id || artifact.accepted.committed_at !== artifact.published_at)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Closed accepted source must identify this artifact.', path: ['accepted'] });
});

function refineRecordState(value: { state: 'open' | 'closed' | 'discarded'; accepted: unknown; draft: unknown; discarded: unknown }, ctx: z.RefinementCtx): void {
  if (value.state === 'open') { if (value.draft === null || value.discarded !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Open state requires draft and forbids discarded metadata.' }); }
  else if (value.state === 'closed') { if (value.accepted === null || value.draft !== null || value.discarded !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Closed state requires accepted content only.' }); }
  else if (value.draft !== null || value.discarded === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Discarded state requires discarded metadata and forbids draft.' });
}

function sameAcceptedMetadata(left: z.infer<typeof acceptedMetadataSchema>, right: z.infer<typeof acceptedMetadataSchema>): boolean { return JSON.stringify(left) === JSON.stringify(right); }

export type AcceptedRecordSnapshot = z.infer<typeof acceptedRecordSnapshotSchema>;
export type OpenRecordDraft = z.infer<typeof openRecordDraftSchema>;
export type DiscardedRecordState = z.infer<typeof discardedRecordStateSchema>;
export type RecordVersionEntry = z.infer<typeof recordVersionEntrySchema>;
export type AuthoredRecordVersionIndex = z.infer<typeof authoredRecordVersionIndexSchema>;
export type AuthoredRecordVersionArtifact = z.infer<typeof authoredRecordVersionArtifactSchema>;
export type RecordArtifactDefinition = Readonly<{ filename: RecordName; format: 'markdown'; schema: string; bootstrap: boolean; declared: boolean }>;

export function recordEntryFromArtifact(artifact: AuthoredRecordVersionArtifact, filename: string): RecordVersionEntry {
  return recordVersionEntrySchema.parse({
    entry_id: artifact.entry_id, version: artifact.version, filename, state: artifact.state, published_at: artifact.published_at,
    accepted: artifact.accepted && { source_version: artifact.accepted.source_version, source_entry_id: artifact.accepted.source_entry_id, committed_at: artifact.accepted.committed_at, writer_agent: artifact.accepted.writer_agent, card_version_seq: artifact.accepted.card_version_seq, content_sha256: artifact.accepted.content_sha256, size_bytes: artifact.accepted.size_bytes },
    draft: artifact.draft && { opened_at: artifact.draft.opened_at, updated_at: artifact.draft.updated_at, content_sha256: artifact.draft.content_sha256, size_bytes: Buffer.byteLength(artifact.draft.content, 'utf8') },
    discarded: artifact.discarded,
  });
}

export function validateRecordArtifactIdentity(artifact: AuthoredRecordVersionArtifact, index: AuthoredRecordVersionIndex, entry: RecordVersionEntry, definition: RecordArtifactDefinition): void {
  if (artifact.card_id !== index.card_id || artifact.record_name !== index.record_name || artifact.record_name !== definition.filename || artifact.record_format !== index.record_format || artifact.record_format !== definition.format || artifact.schema !== index.schema || artifact.schema !== definition.schema || artifact.entry_id !== entry.entry_id || artifact.version !== entry.version || artifact.published_at !== entry.published_at || artifact.state !== entry.state || JSON.stringify(recordEntryFromArtifact(artifact, entry.filename)) !== JSON.stringify(entry)) throw new Error('Authored-record artifact does not match its index entry and configured definition.');
}

export function effectiveRecordContent(artifact: AuthoredRecordVersionArtifact): { content: string; source: 'draft' | 'accepted'; modifiedAt: string; writer: AgentName | 'runtime:bootstrap' | null; version: number } | null {
  if (artifact.state === 'open' && artifact.draft) return { content: artifact.draft.content, source: 'draft', modifiedAt: artifact.draft.updated_at, writer: null, version: artifact.version };
  if (artifact.accepted) return { content: artifact.accepted.content, source: 'accepted', modifiedAt: artifact.accepted.committed_at, writer: artifact.accepted.writer_agent, version: artifact.accepted.source_version };
  return null;
}
