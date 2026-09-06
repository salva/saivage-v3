import { z } from 'zod';
import {
  operatorSessionContract,
  UnauthorizedErrorSchema,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';
const McpTransportSchema = z.enum(['stdio', 'streamable-http']);
const McpStatusStateSchema = z.enum(['running', 'stopped', 'error']);
const McpInvocationStatSchema = z.object({
  total: z.number().int().nonnegative(),
  success: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
  lastInvokedAt: z.string().optional(),
}).strict();
const McpToolWithStatsSchema = z.object({
  name: z.string(),
  stats: McpInvocationStatSchema,
}).strict();
const McpServerToolsSchema = z.object({
  name: z.string(),
  transport: McpTransportSchema,
  status: McpStatusStateSchema,
  toolCount: z.number().int().nonnegative(),
  tools: z.array(McpToolWithStatsSchema),
}).strict();
export const McpToolsResponseSchema = z.object({
  servers: z.array(McpServerToolsSchema),
}).strict();

export type McpToolsResponse = z.infer<typeof McpToolsResponseSchema>;

export const mcpOperatorApiContracts = {
  'mcp.tools': {
    operationId: 'mcp.tools',
    method: 'GET',
    path: '/api/mcp/tools',
    success: McpToolsResponseSchema,
    response: { 200: McpToolsResponseSchema, 401: UnauthorizedErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
  },
} as const satisfies Record<string, OperatorRouteContract>;
