import { z } from 'zod';
import { reviewerResultSchema } from '../schemas/index.js';

const plannerCardCreateSchema = z.object({
  type: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  status: z.string(),
  depends_on: z.array(z.string()),
  priority: z.number().int(),
  tags: z.array(z.string()).optional(),
  id: z.string().optional(),
});

const plannerCardUpdateSchema = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  acceptance: z.string().optional(),
});

export const PlannerResultSchema = z.object({
  status: z.enum(['continue', 'done', 'blocked']),
  blocked_reason: z.string().nullable().optional(),
  created_cards: z.array(plannerCardCreateSchema).optional().default([]),
  updated_cards: z.array(plannerCardUpdateSchema).optional().default([]),
  summary: z.string().optional(),
}).strict();

const executorArtifactDefSchema = z.object({
  type: z.enum(['model', 'data', 'config', 'log', 'report', 'other']),
  description: z.string(),
  retain: z.boolean(),
  sourceFile: z.string().optional(),
  path: z.string().optional(),
});

const executorAttachmentDefSchema = z.object({
  mime: z.string(),
  title: z.string(),
  description: z.string().optional(),
  sourceFile: z.string().optional(),
  path: z.string().optional(),
});

export { executorArtifactDefSchema, executorAttachmentDefSchema };

export const ExecutorResultSchema = z.object({
  card_id: z.string().optional(),
  status: z.enum(['done', 'failed']),
  status_text: z.string().min(1),
  error: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  artifacts: z.array(executorArtifactDefSchema).optional().default([]),
  attachments: z.array(executorAttachmentDefSchema).optional().default([]),
  summary: z.string().optional(),
});

export const ReviewerResultSchema = z.object({
  assessment: reviewerResultSchema,
}).strict();

export type EnvelopeBearingRole = 'planner' | 'executor' | 'reviewer';

export const ENVELOPE_SCHEMAS: Record<EnvelopeBearingRole, z.ZodTypeAny> = {
  planner: PlannerResultSchema,
  executor: ExecutorResultSchema,
  reviewer: ReviewerResultSchema,
};
