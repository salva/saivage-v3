import { z } from 'zod';
import { cardIdSchema } from '../schemas/card-id.js';

import { agentRoleSchema, type AgentRole } from '../schemas/index.js';

export const authoredRecordSlotValues = ['brief', 'status', 'review'] as const;
export type AuthoredRecordSlot = (typeof authoredRecordSlotValues)[number];

const authoredRecordSlotSchema = z.enum(authoredRecordSlotValues);
const recordStateSchema = z.enum(['open', 'closed', 'discarded']);
const recordFormatSchema = z.enum(['markdown', 'json']);
const nullableTimestampSchema = z.string().datetime().nullable();

export const recordVersionArtifactSchema = z
  .object({
    kind: z.literal('record-revision'),
    format_version: z.literal(1),
    card_id: cardIdSchema,
    slot: authoredRecordSlotSchema,
    version: z.number().int().safe().positive(),
    revision_seq: z.number().int().safe().positive(),
    state: recordStateSchema,
    opened_at: z.string().datetime(),
    committed_at: nullableTimestampSchema,
    closed_at: nullableTimestampSchema,
    discarded_at: nullableTimestampSchema,
    reason: z.string().min(1).nullable(),
    writer: agentRoleSchema.nullable(),
    format: recordFormatSchema,
    schema: z.string().min(1),
    card_version_seq: z.number().int().safe().positive().nullable(),
    content: z.string(),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.state === 'open') {
      for (const field of ['committed_at', 'closed_at', 'discarded_at', 'reason', 'writer', 'card_version_seq'] as const) {
        if (artifact[field] !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'must be null while open' });
      }
      return;
    }

    if (artifact.state === 'closed') {
      if (artifact.content.trim().length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: 'must be non-empty when closed' });
      if (artifact.committed_at === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['committed_at'], message: 'is required when closed' });
      if (artifact.closed_at === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['closed_at'], message: 'is required when closed' });
      if (artifact.committed_at !== artifact.closed_at) context.addIssue({ code: z.ZodIssueCode.custom, path: ['committed_at'], message: 'must equal closed_at' });
      if (artifact.discarded_at !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['discarded_at'], message: 'must be null when closed' });
      if (artifact.reason !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'must be null when closed' });
      if (artifact.writer === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['writer'], message: 'is required when closed' });
      if (artifact.card_version_seq === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['card_version_seq'], message: 'is required when closed' });
      return;
    }

    if (artifact.committed_at !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['committed_at'], message: 'must be null when discarded' });
    if (artifact.closed_at !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['closed_at'], message: 'must be null when discarded' });
    if (artifact.discarded_at === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['discarded_at'], message: 'is required when discarded' });
    if (artifact.reason === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'is required when discarded' });
    if (artifact.writer !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['writer'], message: 'must be null when discarded' });
    if (artifact.card_version_seq !== null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['card_version_seq'], message: 'must be null when discarded' });
  });

export type RecordVersionArtifact = z.infer<typeof recordVersionArtifactSchema>;

export type RecordArtifactDefinition = Readonly<{
  slot: AuthoredRecordSlot;
  writers: readonly AgentRole[];
  format: RecordVersionArtifact['format'];
  schema: string;
  bootstrap: boolean;
}>;

function parseWithPath<T>(schema: z.ZodType<T>, raw: unknown, path: string, kind: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${kind} at '${path}' is invalid: ${parsed.error.message}`);
  return parsed.data;
}

export function parseRecordVersionArtifact(
  raw: unknown,
  path: string,
  expected: { cardId: string; definition: RecordArtifactDefinition; version?: number },
): RecordVersionArtifact {
  const artifact = parseWithPath(recordVersionArtifactSchema, raw, path, 'Record version artifact');
  if (artifact.card_id !== expected.cardId || artifact.slot !== expected.definition.slot || (expected.version !== undefined && artifact.version !== expected.version)) {
    throw new Error(`Record version artifact at '${path}' does not match its card, slot, and version path.`);
  }
  if (artifact.format !== expected.definition.format || artifact.schema !== expected.definition.schema) throw new Error(`Record version artifact at '${path}' does not match its record definition.`);
  if (artifact.state === 'closed' && (artifact.writer === null || !expected.definition.writers.includes(artifact.writer))) throw new Error(`Record version artifact at '${path}' has a writer that is not allowed by its record definition.`);
  return artifact;
}

export function validateRecordStream(rows: readonly RecordVersionArtifact[], path: string, cardId: string, definition: RecordArtifactDefinition): RecordVersionArtifact[] {
  if (rows.length === 0) throw new Error(`Record stream '${path}' is empty.`);
  for (const [index, row] of rows.entries()) {
    parseRecordVersionArtifact(row, path, { cardId, definition });
    if (row.revision_seq !== index + 1) throw new Error(`Record stream '${path}' has a revision sequence gap.`);
    const prior = rows[index - 1];
    if (!prior) {
      if (row.version !== 1 || (definition.bootstrap ? row.state !== 'closed' : row.state !== 'open')) throw new Error(`Record stream '${path}' has an invalid first revision.`);
      continue;
    }
    if (prior.state === 'open') {
      if (row.version !== prior.version || row.opened_at !== prior.opened_at || row.format !== prior.format || row.schema !== prior.schema) throw new Error(`Record stream '${path}' has an invalid open revision.`);
      if (row.state === 'open' && row.content === prior.content) throw new Error(`Record stream '${path}' edit revision must change content.`);
      if (row.state !== 'open' && row.content !== prior.content) throw new Error(`Record stream '${path}' terminal revision must preserve open content.`);
    } else if (row.version !== prior.version + 1 || row.state !== 'open') throw new Error(`Record stream '${path}' has an invalid logical-version transition.`);
  }
  return [...rows];
}
