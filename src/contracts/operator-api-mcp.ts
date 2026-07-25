import { z } from 'zod';
import {
  ApiErrorSchema,
  ForbiddenErrorSchema,
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';
export const McpTransportSchema = z.enum(['stdio', 'streamable-http']);
export const McpStatusStateSchema = z.enum(['running', 'stopped', 'error']);
export const McpInvocationStatSchema = z.object({
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

export type McpTransport = z.infer<typeof McpTransportSchema>;
export type McpStatusState = z.infer<typeof McpStatusStateSchema>;
export type McpInvocationStat = z.infer<typeof McpInvocationStatSchema>;
export type McpToolsResponse = z.infer<typeof McpToolsResponseSchema>;

export const mcpOperatorApiContracts = {
  'mcp.tools': {
    operationId: 'mcp.tools',
    method: 'GET',
    path: '/api/mcp/tools',
    success: McpToolsResponseSchema,
    error: ApiErrorSchema,
    response: { 200: McpToolsResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'McpToolsResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
