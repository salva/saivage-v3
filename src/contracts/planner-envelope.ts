import { z } from 'zod';

export const PlannerResultEnvelopeSchema = z.object({
  status: z.enum(['continue', 'done', 'blocked']),
  blocked_reason: z.string().nullable().optional(),
  summary: z.string().optional(),
}).strict();

export type PlannerResultEnvelope = z.infer<typeof PlannerResultEnvelopeSchema>;
