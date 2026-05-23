import { z } from 'zod';

export const exchangeRequestMetaSchema = z.object({
  endpoint: z.string(),
  method: z.string(),
  headers: z.record(z.string()),
  body: z.unknown(),
});

export const exchangeResponseMetaSchema = z.object({
  status: z.number().int(),
  headers: z.record(z.string()).optional(),
  bodyRaw: z.string().nullable(),
  bodyParsed: z.unknown().nullable(),
});

export const exchangeErrorMetaSchema = z.object({
  errorName: z.string(),
  message: z.string(),
  status: z.number().int().optional(),
  bodyRaw: z.string().nullable(),
});

export const exchangeAttemptSchema = z.object({
  attempt: z.number().int().nonnegative(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  status: z.enum(['in-progress', 'ok', 'error']),
  request: exchangeRequestMetaSchema,
  response: exchangeResponseMetaSchema.optional(),
  error: exchangeErrorMetaSchema.optional(),
});

export const llmExchangeSchema = z.object({
  sessionId: z.string(),
  capturedAt: z.string(),
  transport: z.enum(['generic', 'codex']),
  candidate: z.object({
    provider: z.string(),
    model: z.string(),
    account: z.string().optional(),
  }),
  attempts: z.array(exchangeAttemptSchema).min(1),
});

export type LlmExchange = z.infer<typeof llmExchangeSchema>;
export type ExchangeRequestMeta = z.infer<typeof exchangeRequestMetaSchema>;
export type ExchangeResponseMeta = z.infer<typeof exchangeResponseMetaSchema>;
export type ExchangeErrorMeta = z.infer<typeof exchangeErrorMetaSchema>;
export type ExchangeAttempt = z.infer<typeof exchangeAttemptSchema>;
