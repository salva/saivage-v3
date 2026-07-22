import { z } from 'zod';

export const McpToolCallArgumentsSchema = z.object({
  serverName: z.string(),
  toolName: z.string(),
  args: z.record(z.unknown()).optional(),
}).strict();

const mcpToolCallSuccessSchema = z.object({
  success: z.literal(true),
  data: z.unknown().optional(),
}).strict();

const mcpToolCallFailureSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  data: z.unknown().optional(),
}).strict();

export const McpToolCallResultSchema = z.discriminatedUnion('success', [
  mcpToolCallSuccessSchema,
  mcpToolCallFailureSchema,
]);

export const McpReconcileResultSchema = z.object({
  success: z.literal(false),
  error: z.string(),
  data: z.object({
    persisted: z.boolean(),
    reconciled: z.boolean(),
  }).strict(),
}).strict();

export type McpToolCallArguments = z.infer<typeof McpToolCallArgumentsSchema>;
export type McpToolCallResult = z.infer<typeof McpToolCallResultSchema>;
export type McpReconcileResult = z.infer<typeof McpReconcileResultSchema>;
