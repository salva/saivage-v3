import type { z } from 'zod';
import { PlannerResultEnvelopeSchema } from '../contracts/planner-envelope.js';
import {
  ExecutorResultEnvelopeSchema,
  executorArtifactDefSchema,
  executorAttachmentDefSchema,
} from '../contracts/executor-envelope.js';
import { ReviewerResultEnvelopeSchema } from '../contracts/reviewer-envelope.js';

export const PlannerResultSchema = PlannerResultEnvelopeSchema;
export const ExecutorResultSchema = ExecutorResultEnvelopeSchema;
export const ReviewerResultSchema = ReviewerResultEnvelopeSchema;

export { executorArtifactDefSchema, executorAttachmentDefSchema };

export type EnvelopeBearingRole = 'planner' | 'executor' | 'reviewer';

export const ENVELOPE_SCHEMAS: Record<EnvelopeBearingRole, z.ZodTypeAny> = {
  planner: PlannerResultSchema,
  executor: ExecutorResultSchema,
  reviewer: ReviewerResultSchema,
};
