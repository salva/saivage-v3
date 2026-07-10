import { z } from 'zod';
import {
  ApiErrorSchema,
  ForbiddenErrorSchema,
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
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
  error: z.string().optional(),
  startedAt: z.string().optional(),
  tools_count: z.number().int().nonnegative().optional(),
});
export const McpStatusResponseSchema = z.object({
  servers: z.array(McpServerStatusSchema),
  serverAvailability: ServerAvailabilitySchema.optional(),
});
export const McpInvocationStatSchema = z.object({
  total: z.number().int().nonnegative(),
  success: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
  lastInvokedAt: z.string().optional(),
});
export const McpToolDefinitionSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.object({ type: z.literal('object') }).catchall(z.unknown()),
  outputSchema: z.object({ type: z.literal('object') }).catchall(z.unknown()).optional(),
  annotations: z.record(z.string(), z.unknown()).optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export const McpToolsResponseSchema = z.object({
  tools: z.array(McpToolDefinitionSchema),
  servers: z.array(z.string()),
  invocationStats: z.record(z.string(), McpInvocationStatSchema),
  serverDetails: z.array(z.object({
    name: z.string(),
    transport: McpTransportSchema,
    status: McpStatusStateSchema,
    toolCount: z.number().int().nonnegative(),
    tools: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.object({ type: z.literal('object') }).catchall(z.unknown()),
      stats: McpInvocationStatSchema,
    })),
  })),
});

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
    response: { 200: McpStatusResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: ApiErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'McpStatusResponse',
  },
  'mcp.tools': {
    operationId: 'mcp.tools',
    method: 'GET',
    path: '/api/mcp/tools',
    success: McpToolsResponseSchema,
    error: ApiErrorSchema,
    response: { 200: McpToolsResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 403: ForbiddenErrorSchema, 500: ApiErrorSchema },
    ...operatorSessionContract,
    successSchemaName: 'McpToolsResponse',
  },
} as const satisfies Record<string, OperatorRouteContract>;
