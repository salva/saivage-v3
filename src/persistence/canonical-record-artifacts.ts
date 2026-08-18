import { createHash } from 'node:crypto';
import { z } from 'zod';

import { agentNameSchema, cardIdSchema, positiveSafeIntegerSchema, recordNameSchema, type AgentName, type RecordName } from '../schemas/index.js';
import { uuidV4Schema } from './version-index.js';

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

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function fail(path: string, message: string): never { throw new Error(`Authored-record stream '${path}' ${message}.`); }

export type AcceptedRecordSnapshot = z.infer<typeof acceptedRecordSnapshotSchema>;
export type OpenRecordDraft = z.infer<typeof openRecordDraftSchema>;
export type DiscardedRecordState = z.infer<typeof discardedRecordStateSchema>;
export type AuthoredRecordVersionArtifact = z.infer<typeof authoredRecordVersionArtifactSchema>;
export type RecordArtifactDefinition = Readonly<{ filename: RecordName; format: 'markdown'; schema: string; bootstrap: boolean; declared: boolean }>;

export interface RecordStreamFold {
  readonly rows: readonly AuthoredRecordVersionArtifact[];
  readonly head: AuthoredRecordVersionArtifact;
}

export function validateRecordStream(rows: readonly AuthoredRecordVersionArtifact[], path: string, cardId: string, definition: RecordArtifactDefinition): RecordStreamFold {
  if (rows.length === 0) fail(path, 'must contain at least one row.');
  for (const [index, row] of rows.entries()) {
    if (row.card_id !== cardId || row.record_name !== definition.filename || row.record_format !== definition.format || row.schema !== definition.schema) fail(path, `row ${index + 1} does not match the exact record identity.`);
    if (row.version !== index + 1) fail(path, 'must have contiguous ascending versions.');
  }
  const first = rows[0]!;
  if (definition.bootstrap) {
    if (first.state !== 'closed' || first.accepted?.writer_agent !== 'runtime:bootstrap') fail(path, 'must begin with the runtime:bootstrap closed version.');
  } else if (first.state !== 'open' || first.accepted !== null || first.draft?.content !== '' || first.draft.opened_at !== first.published_at || first.draft.updated_at !== first.published_at) fail(path, 'must begin with the exact open-empty version.');
  for (const [index, row] of rows.entries()) {
    if (index === 0) continue;
    const prior = rows[index - 1]!;
    if (row.state === 'open') {
      if (prior.state === 'open') {
        if (!prior.draft || !row.draft || row.draft.opened_at !== prior.draft.opened_at) fail(path, 'has an open edit that does not continue the prior draft session.');
      } else if (prior.state === 'closed' || prior.state === 'discarded') {
        if (!row.draft || row.draft.content !== '' || row.draft.opened_at !== row.published_at || row.draft.updated_at !== row.published_at) fail(path, 'has a fresh open that is not the exact open-empty version.');
      } else fail(path, 'has an unreachable prior state.');
      if (!same(prior.accepted, row.accepted)) fail(path, 'has an open version that changes the carried accepted baseline.');
    } else if (row.state === 'closed') {
      if (prior.state !== 'open' || !prior.draft || !row.accepted || row.accepted.content !== prior.draft.content || row.accepted.content_sha256 !== prior.draft.content_sha256) fail(path, 'has a close that does not accept the prior open draft content.');
    } else {
      if (prior.state !== 'open') fail(path, 'has a discard without a prior open draft.');
      if (!same(prior.accepted, row.accepted)) fail(path, 'has a discard that changes the carried accepted baseline.');
    }
  }
  for (const row of rows) {
    if (row.state === 'closed' || !row.accepted) continue;
    const source = rows[row.accepted.source_version - 1];
    if (!source || source.state !== 'closed' || source.entry_id !== row.accepted.source_entry_id || !source.accepted || !same(source.accepted, row.accepted)) fail(path, `version ${row.version} carries an accepted baseline that does not match its closed source version.`);
  }
  return Object.freeze({ rows: Object.freeze([...rows]), head: rows.at(-1)! });
}

export function effectiveRecordContent(artifact: AuthoredRecordVersionArtifact): { content: string; source: 'draft' | 'accepted'; modifiedAt: string; writer: AgentName | 'runtime:bootstrap' | null; version: number } | null {
  if (artifact.state === 'open' && artifact.draft) return { content: artifact.draft.content, source: 'draft', modifiedAt: artifact.draft.updated_at, writer: null, version: artifact.version };
  if (artifact.accepted) return { content: artifact.accepted.content, source: 'accepted', modifiedAt: artifact.accepted.committed_at, writer: artifact.accepted.writer_agent, version: artifact.accepted.source_version };
  return null;
}
