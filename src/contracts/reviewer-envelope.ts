import { z } from 'zod';
import { reviewerResultSchema } from '../schemas/index.js';

export const ReviewerResultEnvelopeSchema = z.object({
  assessment: reviewerResultSchema,
}).strict();

export type ReviewerResultEnvelope = z.infer<typeof ReviewerResultEnvelopeSchema>;
