import { z } from 'zod';

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema),
]));

const evidenceSchema = z.discriminatedUnion('flavor', [
  z.object({ flavor: z.literal('stash'), url: z.string(), label: z.string(), bytes: z.number().int().nonnegative().optional() }).strict(),
  z.object({ flavor: z.literal('process_stdout'), url: z.string(), label: z.string(), bytes: z.number().int().nonnegative().optional() }).strict(),
  z.object({ flavor: z.literal('process_stderr'), url: z.string(), label: z.string(), bytes: z.number().int().nonnegative().optional() }).strict(),
  z.object({ flavor: z.literal('source_recallable'), tool: z.string(), args: jsonValueSchema, label: z.string() }).strict(),
]);

const summaryRoundSchema = z.object({
  complete: z.boolean(),
  segments: z.array(z.object({
    kind: z.enum(['initial', 'repair']),
    source_message_ids: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
}).strict();

const summaryGroupSchema = z.object({
  kind: z.enum(['merged', 'individual']),
  rounds: z.array(summaryRoundSchema).min(1),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  summary_text: z.string().min(1),
  evidence: z.array(evidenceSchema),
}).strict();

export const contextCompactionContentSchema = z.object({
  boundary: z.enum(['round', 'repair', 'exchange', 'message']),
  retained_static_message_ids: z.array(z.string().min(1)),
  summaries: z.array(summaryGroupSchema).min(1),
  applied_policy: z.object({
    mode: z.enum(['normal', 'escalated', 'hard_limit_fallback']), band: z.enum(['normal', 'escalated']),
    input_budget_tokens: z.number().int().positive(), canonical_estimated_static_tokens: z.number().int().nonnegative(),
    requested_completion_tokens: z.number().int().positive(), canonical_message_hard_ceiling: z.number().int().positive(),
    trigger_line_tokens: z.number().int().nonnegative(), trigger_message_threshold: z.number().int().positive(),
    trigger_fraction: z.number(), completion_reserve_fraction: z.number(), merge_line_fraction: z.number(), summary_line_fraction: z.number(),
    tail_budget_tokens: z.number().int().nonnegative(), middle_budget_tokens: z.number().int().nonnegative(),
    snap: z.enum(['keep_straddler_verbatim', 'compact_straddler']),
  }).strict(),
}).strict().superRefine((payload, ctx) => {
  const mergedIndexes = payload.summaries.flatMap((group, index) => group.kind === 'merged' ? [index] : []);
  if (mergedIndexes.length > 1 || mergedIndexes.some((index) => index !== 0)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A merged summary group may occur only once and first.', path: ['summaries'] });
  const sourceIds = payload.summaries.flatMap((group) => group.rounds.flatMap((round) => round.segments.flatMap((segment) => segment.source_message_ids)));
  if (new Set(sourceIds).size !== sourceIds.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Compaction source message ids must be globally unique.', path: ['summaries'] });
  payload.summaries.forEach((group, groupIndex) => {
    if (group.kind === 'individual' && group.rounds.length !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An individual summary group must contain exactly one round.', path: ['summaries', groupIndex, 'rounds'] });
    group.rounds.forEach((round, roundIndex) => {
      if (group.kind === 'merged' && !round.complete) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Merged summary rounds must be complete.', path: ['summaries', groupIndex, 'rounds', roundIndex, 'complete'] });
      if (!round.complete && (payload.applied_policy.mode !== 'hard_limit_fallback' || group.kind !== 'individual' || groupIndex !== payload.summaries.length - 1)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only the final individual group in hard fallback may contain a partial round.', path: ['summaries', groupIndex, 'rounds', roundIndex, 'complete'] });
    });
  });
});

export type ContextCompactionContent = z.infer<typeof contextCompactionContentSchema>;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

export function parseCanonicalContextCompaction(content: string): ContextCompactionContent {
  const parsed = contextCompactionContentSchema.parse(JSON.parse(content));
  if (content !== canonicalJson(parsed)) throw new Error('context_compaction content must be canonical JSON.');
  return parsed;
}
