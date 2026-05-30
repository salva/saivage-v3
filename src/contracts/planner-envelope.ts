import { z } from 'zod';

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

export const PlannerResultEnvelopeSchema = z.object({
  status: z.enum(['continue', 'done', 'blocked']),
  blocked_reason: z.string().nullable().optional(),
  created_cards: z.array(plannerCardCreateSchema).optional().default([]),
  updated_cards: z.array(plannerCardUpdateSchema).optional().default([]),
  summary: z.string().optional(),
}).strict();

export type PlannerResultEnvelope = z.infer<typeof PlannerResultEnvelopeSchema>;
