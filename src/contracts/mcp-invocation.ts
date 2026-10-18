import { z } from 'zod';
import { imageMaxDimensionSchema } from './image-normalization.js';
import { mcpConnectionSchema } from '../schemas/index.js';

export const McpServerRegisterArgumentsSchema = z
  .object({
    serverName: z.string().min(1),
    connection: mcpConnectionSchema,
  })
  .strict();
export const McpServerUnregisterArgumentsSchema = z
  .object({
    serverName: z.string().min(1),
  })
  .strict();
export const McpServersArgumentsSchema = z
  .object({
    serverName: z.string().min(1).optional(),
  })
  .strict();

export const McpToolCallArgumentsSchema = z
  .object({
    serverName: z.string(),
    bindingId: z.string().uuid(),
    catalogId: z.string().uuid(),
    toolName: z.string(),
    args: z.record(z.unknown()).optional(),
    max_dimension: imageMaxDimensionSchema.optional(),
  })
  .strict();

export type McpToolCallArguments = z.infer<typeof McpToolCallArgumentsSchema>;

export const McpCatalogRefreshArgumentsSchema = z
  .object({ serverName: z.string().min(1), bindingId: z.string().uuid() })
  .strict();

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
