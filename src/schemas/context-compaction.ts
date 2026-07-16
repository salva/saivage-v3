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

const summarizedRoundSchema = z.object({
  round_id: z.string().min(1), complete: z.boolean(), through_message_id: z.string().min(1),
  source_message_ids: z.array(z.string().min(1)).min(1), content_hash: z.string().regex(/^[0-9a-f]{64}$/),
  summary_text: z.string().min(1), evidence: z.array(evidenceSchema),
}).strict();

export const contextCompactionContentSchema = z.object({
  cutoff: z.object({ round_id: z.string().min(1), through_message_id: z.string().min(1), boundary: z.enum(['round', 'repair', 'exchange', 'message']) }).strict(),
  retained_static_message_ids: z.array(z.string().min(1)),
  merged_history: z.object({ round_ids: z.array(z.string().min(1)).min(1), source_message_ids: z.array(z.string().min(1)).min(1), content_hash: z.string().regex(/^[0-9a-f]{64}$/), summary_text: z.string().min(1), evidence: z.array(evidenceSchema) }).strict().nullable(),
  individual_rounds: z.array(summarizedRoundSchema),
  round_coverage: z.array(z.object({
    round_id: z.string().min(1), complete: z.boolean(), through_message_id: z.string().min(1),
    segments: z.array(z.object({ kind: z.enum(['initial', 'repair']), anchor_message_id: z.string().min(1).nullable(), source_message_ids: z.array(z.string().min(1)).min(1) }).strict()).min(1),
  }).strict()),
  rendered_context: z.string().min(1),
  applied_policy: z.object({
    mode: z.enum(['normal', 'escalated', 'hard_limit_fallback']), band: z.enum(['normal', 'escalated']),
    input_budget_tokens: z.number().int().positive(), canonical_estimated_static_tokens: z.number().int().nonnegative(),
    requested_completion_tokens: z.number().int().positive(), canonical_message_hard_ceiling: z.number().int().positive(),
    trigger_line_tokens: z.number().int().nonnegative(), trigger_message_threshold: z.number().int().positive(),
    trigger_fraction: z.number(), completion_reserve_fraction: z.number(), merge_line_fraction: z.number(), summary_line_fraction: z.number(),
    tail_budget_tokens: z.number().int().nonnegative(), middle_budget_tokens: z.number().int().nonnegative(),
    snap: z.enum(['keep_straddler_verbatim', 'compact_straddler']),
  }).strict(),
}).strict();

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
