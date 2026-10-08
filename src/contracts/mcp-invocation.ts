import { z } from 'zod';
import { imageMaxDimensionSchema } from './view-image.js';

export const McpToolCallArgumentsSchema = z
  .object({
    serverName: z.string(),
    toolName: z.string(),
    args: z.record(z.unknown()).optional(),
    max_dimension: imageMaxDimensionSchema.optional(),
  })
  .strict();

export type McpToolCallArguments = z.infer<typeof McpToolCallArgumentsSchema>;

export const McpServerControlArgumentsSchema = z
  .object({
    serverName: z.string().min(1),
    action: z.enum(['start', 'stop']),
  })
  .strict();
export const McpToolsArgumentsSchema = z
  .object({
    serverName: z.string().min(1),
    toolName: z.string().min(1).optional(),
  })
  .strict();
