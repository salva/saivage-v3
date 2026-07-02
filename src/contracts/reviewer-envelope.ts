import { z } from 'zod';

export const ReviewerResultEnvelopeSchema = z.object({
  status: z.enum(['done', 'rework', 'blocked', 'failed']),
  summary: z.string().min(1),
}).strict();

export type ReviewerResultEnvelope = z.infer<typeof ReviewerResultEnvelopeSchema>;
