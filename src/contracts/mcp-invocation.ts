import { z } from 'zod';

export const McpToolCallArgumentsSchema = z.object({
  serverName: z.string(),
  toolName: z.string(),
  args: z.record(z.unknown()).optional(),
}).strict();

export type McpToolCallArguments = z.infer<typeof McpToolCallArgumentsSchema>;
