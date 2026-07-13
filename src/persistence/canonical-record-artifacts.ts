import { z } from 'zod';

import { agentRoleSchema, type AgentRole } from '../schemas/index.js';

export const authoredRecordSlotValues = ['brief', 'status', 'review'] as const;
export type AuthoredRecordSlot = (typeof authoredRecordSlotValues)[number];

const authoredRecordSlotSchema = z.enum(authoredRecordSlotValues);
const recordStateSchema = z.enum(['open', 'closed', 'discarded']);
const recordFormatSchema = z.enum(['markdown', 'json']);
const nullableTimestampSchema = z.string().datetime().nullable();

const slotRegistry = Object.freeze({
  brief: Object.freeze({ format: 'markdown' as const, schema: 'record.brief.markdown.v1', writers: ['analyst', 'planner'] as readonly AgentRole[] }),
  status: Object.freeze({ format: 'markdown' as const, schema: 'record.status.markdown.v1', writers: ['planner', 'executor'] as readonly AgentRole[] }),
  review: Object.freeze({ format: 'markdown' as const, schema: 'record.review.markdown.v1', writers: ['reviewer'] as readonly AgentRole[] }),
});

export const recordVersionArtifactSchema = z
  .object({
    kind: z.literal('record-version'),
    format_version: z.literal(1),
    card_id: z.string().min(1),
    slot: authoredRecordSlotSchema,
    version: z.number().int().safe().positive(),
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
    const definition = slotRegistry[artifact.slot];
    if (artifact.format !== definition.format) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['format'], message: `must be '${definition.format}' for ${artifact.slot}` });
    }
    if (artifact.schema !== definition.schema) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['schema'], message: `must be '${definition.schema}' for ${artifact.slot}` });
    }

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
      if (artifact.writer === null || !definition.writers.includes(artifact.writer)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['writer'], message: `must be an allowed ${artifact.slot} writer` });
      }
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

const recordVersionIndexEntrySchema = z
  .object({
    version: z.number().int().safe().positive(),
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
    size: z.number().int().nonnegative(),
  })
  .strict();

export const recordSlotIndexSchema = z
  .object({
    kind: z.literal('record-slot-index'),
    format_version: z.literal(1),
    card_id: z.string().min(1),
    slot: authoredRecordSlotSchema,
    latest: z.number().int().safe().positive().nullable(),
    open: z.number().int().safe().positive().nullable(),
    versions: z.record(recordVersionIndexEntrySchema),
  })
  .strict();

export type RecordSlotIndexArtifact = z.infer<typeof recordSlotIndexSchema>;

function parseWithPath<T>(schema: z.ZodType<T>, raw: unknown, path: string, kind: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${kind} at '${path}' is invalid: ${parsed.error.message}`);
  return parsed.data;
}

export function parseRecordVersionArtifact(
  raw: unknown,
  path: string,
  expected?: { cardId: string; slot: AuthoredRecordSlot; version: number },
): RecordVersionArtifact {
  const artifact = parseWithPath(recordVersionArtifactSchema, raw, path, 'Record version artifact');
  if (expected && (artifact.card_id !== expected.cardId || artifact.slot !== expected.slot || artifact.version !== expected.version)) {
    throw new Error(`Record version artifact at '${path}' does not match its card, slot, and version path.`);
  }
  return artifact;
}

export function parseRecordSlotIndex(
  raw: unknown,
  path: string,
  expected?: { cardId: string; slot: AuthoredRecordSlot },
): RecordSlotIndexArtifact {
  const index = parseWithPath(recordSlotIndexSchema, raw, path, 'Record slot index');
  if (expected && (index.card_id !== expected.cardId || index.slot !== expected.slot)) {
    throw new Error(`Record slot index at '${path}' does not match its card and slot path.`);
  }
  let openCount = 0;
  for (const [key, entry] of Object.entries(index.versions)) {
    if (key !== String(entry.version)) throw new Error(`Record slot index at '${path}' has mismatched version key '${key}'.`);
    const definition = slotRegistry[index.slot];
    if (entry.format !== definition.format || entry.schema !== definition.schema) {
      throw new Error(`Record slot index at '${path}' version ${entry.version} does not match the ${index.slot} registry.`);
    }
    const projectedArtifact = recordVersionArtifactSchema.safeParse({
      kind: 'record-version',
      format_version: 1,
      card_id: index.card_id,
      slot: index.slot,
      version: entry.version,
      state: entry.state,
      opened_at: entry.opened_at,
      committed_at: entry.committed_at,
      closed_at: entry.closed_at,
      discarded_at: entry.discarded_at,
      reason: entry.reason,
      writer: entry.writer,
      format: entry.format,
      schema: entry.schema,
      card_version_seq: entry.card_version_seq,
      content: entry.state === 'closed' ? 'indexed content' : '',
    });
    if (!projectedArtifact.success) {
      throw new Error(`Record slot index at '${path}' version ${entry.version} has invalid state metadata: ${projectedArtifact.error.message}`);
    }
    if (entry.state === 'open') openCount += 1;
  }
  if (openCount > 1) throw new Error(`Record slot index at '${path}' contains more than one open version.`);
  if (index.open !== null && index.versions[String(index.open)]?.state !== 'open') {
    throw new Error(`Record slot index at '${path}' open pointer does not name an open version.`);
  }
  if (index.open === null && openCount !== 0) throw new Error(`Record slot index at '${path}' omits its open version pointer.`);
  if (index.latest !== null && index.versions[String(index.latest)]?.state !== 'closed') {
    throw new Error(`Record slot index at '${path}' latest pointer does not name a closed version.`);
  }
  const entries = Object.values(index.versions);
  const highestVersion = entries.length === 0 ? null : Math.max(...entries.map((entry) => entry.version));
  if (index.open !== null && index.open !== highestVersion) {
    throw new Error(`Record slot index at '${path}' contains an older orphan open version.`);
  }
  const closedVersions = entries.filter((entry) => entry.state === 'closed').map((entry) => entry.version);
  const expectedLatest = closedVersions.length === 0 ? null : Math.max(...closedVersions);
  if (index.latest !== expectedLatest) throw new Error(`Record slot index at '${path}' latest is not its greatest closed version.`);
  return index;
}
