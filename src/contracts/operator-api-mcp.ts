import { z } from 'zod';
import {
  operatorSessionContract,
  UnauthorizedErrorSchema,
  UnexpectedInternalServerErrorSchema,
  ValidationErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';
const McpTransportSchema = z.enum(['stdio', 'streamable-http']);
const McpStatusStateSchema = z.enum(['running', 'stopped', 'error']);
const McpInvocationStatSchema = z
  .object({
    total: z.number().int().nonnegative(),
    success: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
    lastInvokedAt: z.string().optional(),
  })
  .strict();
const McpToolWithStatsSchema = z
  .object({
    name: z.string(),
    stats: McpInvocationStatSchema,
  })
  .strict();
const McpServerToolsSchema = z
  .object({
    name: z.string(),
    transport: McpTransportSchema,
    status: McpStatusStateSchema,
    toolCount: z.number().int().nonnegative(),
    tools: z.array(McpToolWithStatsSchema),
  })
  .strict();
export const McpToolsResponseSchema = z
  .object({
    servers: z.array(McpServerToolsSchema),
  })
  .strict();

export type McpToolsResponse = z.infer<typeof McpToolsResponseSchema>;

const LifecycleResultSchema = z
  .object({
    serverName: z.string(),
    status: z.enum(['running', 'stopped']),
    toolCount: z.number().int().nonnegative(),
  })
  .strict();
const LifecycleErrorSchema = z
  .object({ error: z.enum(['MCP_NOT_FOUND', 'MCP_CONFLICT']), message: z.string() })
  .strict();
const lifecycleContract = {
  method: 'POST',
  params: z.object({ name: z.string().min(1) }).strict(),
  body: z.object({}).strict(),
  success: LifecycleResultSchema,
  response: {
    200: LifecycleResultSchema,
    400: ValidationErrorSchema,
    401: UnauthorizedErrorSchema,
    404: LifecycleErrorSchema,
    409: LifecycleErrorSchema,
    500: UnexpectedInternalServerErrorSchema,
  },
  ...operatorSessionContract,
} as const;

export const mcpOperatorApiContracts = {
  'mcp.start': {
    ...lifecycleContract,
    operationId: 'mcp.start',
    method: 'POST',
    path: '/api/mcp/servers/:name/start',
  },
  'mcp.stop': {
    ...lifecycleContract,
    operationId: 'mcp.stop',
    method: 'POST',
    path: '/api/mcp/servers/:name/stop',
  },
  'mcp.tools': {
    operationId: 'mcp.tools',
    method: 'GET',
    path: '/api/mcp/tools',
    success: McpToolsResponseSchema,
    response: {
      200: McpToolsResponseSchema,
      401: UnauthorizedErrorSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    ...operatorSessionContract,
  },
} as const satisfies Record<string, OperatorRouteContract>;
