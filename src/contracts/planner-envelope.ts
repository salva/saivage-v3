import { z } from 'zod';

export const PlannerResultEnvelopeSchema = z.object({
  status: z.enum(['done', 'blocked', 'failed']),
  summary: z.string().min(1),
}).strict();

export type PlannerResultEnvelope = z.infer<typeof PlannerResultEnvelopeSchema>;
