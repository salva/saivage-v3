import { z } from 'zod';

export const executorArtifactDefSchema = z.object({
  type: z.enum(['model', 'data', 'config', 'log', 'report', 'other']),
  description: z.string(),
  retain: z.boolean(),
  sourceFile: z.string().optional(),
  path: z.string().optional(),
});

export const executorAttachmentDefSchema = z.object({
  mime: z.string(),
  title: z.string(),
  description: z.string().optional(),
  sourceFile: z.string().optional(),
  path: z.string().optional(),
});

export const ExecutorResultEnvelopeSchema = z.object({
  card_id: z.string().optional(),
  status: z.enum(['done', 'failed']),
  status_text: z.string().min(1),
  error: z.string().optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  artifacts: z.array(executorArtifactDefSchema).optional().default([]),
  attachments: z.array(executorAttachmentDefSchema).optional().default([]),
  generated_files: z.array(z.string()).optional().default([]),
  warnings: z.array(z.string()).optional().default([]),
  summary: z.string().optional(),
});

export type ExecutorResultEnvelope = z.infer<typeof ExecutorResultEnvelopeSchema>;
