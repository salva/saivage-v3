import { z } from 'zod';

export const llmUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    cached_input_tokens: z.number().int().nonnegative().optional(),
    reasoning_output_tokens: z.number().int().nonnegative().optional(),
  })
  .strict();

export type LlmUsage = z.infer<typeof llmUsageSchema>;
