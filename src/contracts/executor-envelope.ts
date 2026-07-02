import { z } from 'zod';

export const ExecutorResultEnvelopeSchema = z.object({
  status: z.enum(['done', 'failed']),
  summary: z.string().min(1),
}).strict();

export type ExecutorResultEnvelope = z.infer<typeof ExecutorResultEnvelopeSchema>;
