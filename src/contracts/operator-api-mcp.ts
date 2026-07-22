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
import { ServerAvailabilitySchema } from './operator-api-availability.js';

export const McpTransportSchema = z.enum(['stdio', 'streamable-http']);
export const McpStatusStateSchema = z.enum(['running', 'stopped', 'error']);
export const McpServerStatusSchema = z.object({
  name: z.string(),
  transport: McpTransportSchema,
  status: McpStatusStateSchema,
  pid: z.number().int().positive().optional(),
  startedAt: z.string().optional(),
  tools_count: z.number().int().nonnegative().optional(),
}).strict();
export const McpStatusResponseSchema = z.object({
  servers: z.array(McpServerStatusSchema),
  serverAvailability: ServerAvailabilitySchema.optional(),
}).strict();
export const McpInvocationStatSchema = z.object({
  total: z.number().int().nonnegative(),
  success: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
  lastInvokedAt: z.string().optional(),
}).strict();
export const McpToolDefinitionSchema = z.object({
  name: z.string(),
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
  tools: z.array(McpToolDefinitionSchema),
  servers: z.array(z.string()),
  invocationStats: z.record(z.string(), McpInvocationStatSchema),
  serverDetails: z.array(McpServerToolsSchema),
}).strict();

export type McpTransport = z.infer<typeof McpTransportSchema>;
export type McpStatusState = z.infer<typeof McpStatusStateSchema>;
export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;
export type McpStatusResponse = z.infer<typeof McpStatusResponseSchema>;
export type McpInvocationStat = z.infer<typeof McpInvocationStatSchema>;
export type McpToolDefinition = z.infer<typeof McpToolDefinitionSchema>;
export type McpToolsResponse = z.infer<typeof McpToolsResponseSchema>;

export const mcpOperatorApiContracts = {
  'mcp.status': {
    operationId: 'mcp.status',
    method: 'GET',
    path: '/api/mcp/status',
    success: McpStatusResponseSchema,
    error: ApiErrorSchema,
    response: { 200: McpStatusResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: UnexpectedInternalServerErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'McpStatusResponse',
  },
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
