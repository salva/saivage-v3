import { z } from 'zod';

export const ResultEnvelopeSchema = z.object({
  status: z.enum(['done', 'blocked', 'failed', 'rework']),
  summary: z.string().min(1),
}).strict();

export type ResultEnvelope = z.infer<typeof ResultEnvelopeSchema>;

export const TERMINAL_RESULT_TOOL_NAME = 'emit_result' as const;
