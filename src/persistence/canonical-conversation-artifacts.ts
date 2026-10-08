import { z } from 'zod';

import {
  agentMessageSchema,
  compactedHistorySchema,
  ConversationSessionIdSchema,
  positiveSafeIntegerSchema,
  uuidV4Schema,
} from '../schemas/index.js';
const jsonlVersionFilenameSchema = z
  .string()
  .regex(
    /^[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/,
  );

export function versionFilename(version: number, id: string): string {
  positiveSafeIntegerSchema.parse(version);
  uuidV4Schema.parse(id);
  return `${version}-${id}.jsonl`;
}

function validateHeadFields(
  value: {
    readonly versions: readonly { readonly version: number; readonly filename: string }[];
    readonly current_version: number | null;
    readonly current_filename: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.versions.length === 0) {
    if (value.current_version !== null || value.current_filename !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'An empty version catalog requires null current fields.',
      });
    }
    return;
  }
  const filenames = new Set<string>();
  for (const [index, entry] of value.versions.entries()) {
    if (entry.version !== index + 1)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Version catalog entries must be contiguous and ascending.',
        path: ['versions', index, 'version'],
      });
    const prefix = Number(entry.filename.slice(0, entry.filename.indexOf('-')));
    if (prefix !== entry.version)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Version filename prefix must equal entry version.',
        path: ['versions', index, 'filename'],
      });
    if (filenames.has(entry.filename))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Version filenames must be unique.',
        path: ['versions', index, 'filename'],
      });
    filenames.add(entry.filename);
  }
  const head = value.versions.at(-1)!;
  if (value.current_version !== head.version || value.current_filename !== head.filename) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Current version and filename must equal the catalog head.',
    });
  }
}

const activationInputIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const conversationContinuationSchema = z.union([
  z.object({ kind: z.literal('between_rounds') }).strict(),
  z
    .object({
      kind: z.literal('inherited_open_round'),
      activation: z
        .object({ marker_id: z.string().min(1), input_id: activationInputIdSchema })
        .strict(),
      active_segment_kind: z.enum(['initial', 'repair']),
    })
    .strict(),
]);
const compactedEntryGenesisSchema = z
  .object({
    kind: z.literal('compacted'),
    source_version: positiveSafeIntegerSchema,
    source_filename: jsonlVersionFilenameSchema,
    covered_through_message_id: z.string().min(1),
  })
  .strict();
const conversationVersionEntrySchema = z
  .object({
    entry_id: uuidV4Schema,
    version: positiveSafeIntegerSchema,
    filename: jsonlVersionFilenameSchema,
    created_at: z.string().datetime(),
    genesis: z.union([
      z.object({ kind: z.literal('ordinary') }).strict(),
      compactedEntryGenesisSchema,
    ]),
  })
  .strict();
export const conversationVersionIndexSchema = z
  .object({
    format_version: z.literal(6),
    kind: z.literal('conversation-version-index'),
    session_id: ConversationSessionIdSchema,
    created_at: z.string().datetime(),
    versions: z.array(conversationVersionEntrySchema),
    current_version: positiveSafeIntegerSchema.nullable(),
    current_filename: jsonlVersionFilenameSchema.nullable(),
  })
  .strict()
  .superRefine((index, ctx) => {
    validateHeadFields(index, ctx);
    for (const [offset, entry] of index.versions.entries()) {
      if (
        entry.version === 1 ? entry.genesis.kind !== 'ordinary' : entry.genesis.kind !== 'compacted'
      )
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['versions', offset, 'genesis'],
          message: 'Conversation genesis kind must match segment version.',
        });
      if (entry.genesis.kind === 'compacted') {
        const prior = index.versions[offset - 1];
        if (
          !prior ||
          entry.genesis.source_version !== prior.version ||
          entry.genesis.source_filename !== prior.filename
        )
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['versions', offset, 'genesis', 'source_version'],
            message: 'Compacted source must be the predecessor entry.',
          });
      }
    }
  });
const genesisBase = {
  format_version: z.literal(6),
  id: uuidV4Schema,
  entry_id: uuidV4Schema,
  session_id: ConversationSessionIdSchema,
  segment_version: positiveSafeIntegerSchema,
  timestamp: z.string().datetime(),
} as const;
const ordinaryConversationGenesisSchema = z
  .object({ kind: z.literal('ordinary_segment_genesis'), ...genesisBase })
  .strict();
const compactedConversationGenesisSchema = z
  .object({
    kind: z.literal('compacted_segment_genesis'),
    ...genesisBase,
    source: z
      .object({
        version: positiveSafeIntegerSchema,
        filename: jsonlVersionFilenameSchema,
        covered_through_message_id: z.string().min(1),
      })
      .strict(),
    compaction: compactedHistorySchema,
    continuation: conversationContinuationSchema,
  })
  .strict();
const conversationSegmentGenesisSchema = z.union([
  ordinaryConversationGenesisSchema,
  compactedConversationGenesisSchema,
]);
const conversationSegmentRowSchema = z.union([
  conversationSegmentGenesisSchema,
  agentMessageSchema,
]);
export const conversationSegmentEnvelopeSchema = z
  .object({
    version: z.literal(6),
    type: z.literal('conversation-segment'),
    rows: z.array(conversationSegmentRowSchema).min(1),
  })
  .strict();

export type ConversationVersionEntry = z.infer<typeof conversationVersionEntrySchema>;
export type ConversationVersionIndex = z.infer<typeof conversationVersionIndexSchema>;
export type ConversationSegmentGenesis = z.infer<typeof conversationSegmentGenesisSchema>;
export type ConversationContinuation = z.infer<typeof conversationContinuationSchema>;
