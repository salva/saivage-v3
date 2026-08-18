import { createHash } from 'node:crypto';
import { z } from 'zod';

import { agentMessageSchema, canonicalJson, compactedHistorySchema, ConversationSessionIdSchema, positiveSafeIntegerSchema } from '../schemas/index.js';
import { jsonlVersionFilenameSchema, uuidV4Schema, validateHeadFields } from './version-index.js';

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const nonNegativeSafeIntegerSchema = z.number().int().safe().nonnegative();
export const activationInputIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const conversationContinuationSchema = z.union([
  z.object({ kind: z.literal('between_rounds') }).strict(),
  z.object({ kind: z.literal('inherited_open_round'), activation: z.object({ marker_id: z.string().min(1), input_id: activationInputIdSchema }).strict(), active_segment_kind: z.enum(['initial', 'repair']) }).strict(),
]);
const compactedEntryGenesisSchema = z.object({ kind: z.literal('compacted'), source_version: positiveSafeIntegerSchema, source_filename: jsonlVersionFilenameSchema, source_sha256: sha256Schema, covered_through_message_id: z.string().min(1), compaction_payload_sha256: sha256Schema, continuation_sha256: sha256Schema, retained_rows_sha256: sha256Schema }).strict();
export const conversationVersionEntrySchema = z.object({ entry_id: uuidV4Schema, version: positiveSafeIntegerSchema, filename: jsonlVersionFilenameSchema, created_at: z.string().datetime(), genesis: z.union([z.object({ kind: z.literal('ordinary') }).strict(), compactedEntryGenesisSchema]) }).strict();
export const conversationVersionIndexSchema = z.object({ format_version: z.literal(1), kind: z.literal('conversation-version-index'), session_id: ConversationSessionIdSchema, created_at: z.string().datetime(), versions: z.array(conversationVersionEntrySchema), current_version: positiveSafeIntegerSchema.nullable(), current_filename: jsonlVersionFilenameSchema.nullable() }).strict().superRefine((index, ctx) => {
  validateHeadFields(index, ctx);
  for (const [offset, entry] of index.versions.entries()) {
    if (entry.version === 1 ? entry.genesis.kind !== 'ordinary' : entry.genesis.kind !== 'compacted') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['versions', offset, 'genesis'], message: 'Conversation genesis kind must match segment version.' });
    if (entry.genesis.kind === 'compacted') {
      const prior = index.versions[offset - 1];
      if (!prior || entry.genesis.source_version !== prior.version || entry.genesis.source_filename !== prior.filename) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['versions', offset, 'genesis', 'source_version'], message: 'Compacted source must be the predecessor entry.' });
    }
  }
});
const genesisBase = { format_version: z.literal(1), id: uuidV4Schema, entry_id: uuidV4Schema, session_id: ConversationSessionIdSchema, segment_version: positiveSafeIntegerSchema, timestamp: z.string().datetime() } as const;
export const ordinaryConversationGenesisSchema = z.object({ kind: z.literal('ordinary_segment_genesis'), ...genesisBase }).strict();
export const compactedConversationGenesisSchema = z.object({ kind: z.literal('compacted_segment_genesis'), ...genesisBase, source: z.object({ version: positiveSafeIntegerSchema, filename: jsonlVersionFilenameSchema, sha256: sha256Schema, covered_through_message_id: z.string().min(1) }).strict(), compaction: compactedHistorySchema, continuation: conversationContinuationSchema, retained_rows: z.object({ first_message_id: z.string().min(1).nullable(), last_message_id: z.string().min(1).nullable(), row_count: nonNegativeSafeIntegerSchema, sha256: sha256Schema }).strict() }).strict().superRefine((genesis, ctx) => {
  const retained = genesis.retained_rows;
  if ((retained.row_count === 0) !== (retained.first_message_id === null && retained.last_message_id === null))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['retained_rows'], message: 'Retained tail-row metadata is inconsistent.' });
  if (genesis.compaction.coverageCommitment.coveredThroughMessageId !== genesis.source.covered_through_message_id)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['compaction', 'coverageCommitment', 'coveredThroughMessageId'], message: 'Compacted history coverage cutoff must match the genesis source cutoff.' });
  if (genesis.compaction.coverageCommitment.sourceVersion !== genesis.source.version)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['compaction', 'coverageCommitment', 'sourceVersion'], message: 'Compacted history coverage source version must match the genesis source version.' });
});
export const conversationSegmentGenesisSchema = z.union([ordinaryConversationGenesisSchema, compactedConversationGenesisSchema]);
export const conversationSegmentRowSchema = z.union([conversationSegmentGenesisSchema, agentMessageSchema]);
export const conversationSegmentEnvelopeSchema = z.object({ version: z.literal(1), type: z.literal('conversation-segment'), rows: z.array(conversationSegmentRowSchema).min(1) }).strict();

export type ConversationVersionEntry = z.infer<typeof conversationVersionEntrySchema>;
export type ConversationVersionIndex = z.infer<typeof conversationVersionIndexSchema>;
export type ConversationSegmentGenesis = z.infer<typeof conversationSegmentGenesisSchema>;
export type CompactedConversationGenesis = z.infer<typeof compactedConversationGenesisSchema>;
export type ConversationContinuation = z.infer<typeof conversationContinuationSchema>;

export function conversationSha256(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
export function canonicalValueSha256(value: unknown): string { return conversationSha256(canonicalJson(value)); }
