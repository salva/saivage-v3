import { z } from 'zod';

export const ExecutorResultEnvelopeSchema = z.object({
  card_id: z.string().optional(),
  status: z.enum(['done', 'failed']),
  status_text: z.string().min(1),
  error: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  warnings: z.array(z.string()).optional().default([]),
  summary: z.string().optional(),
});

export type ExecutorResultEnvelope = z.infer<typeof ExecutorResultEnvelopeSchema>;
