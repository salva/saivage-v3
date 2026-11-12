import { z } from 'zod';
import { mcpAccessPolicySchema } from '../schemas/index.js';
import {
  operatorSessionContract,
  UnauthorizedErrorSchema,
  UnexpectedInternalServerErrorSchema,
  ValidationErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';
const McpTransportSchema = z.enum(['stdio', 'streamable-http']);
const McpStatusStateSchema = z.enum(['starting', 'running', 'stopping', 'stopped', 'error']);
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
    bindingId: z.string().uuid().nullable(),
    definitionSource: z.enum(['operator', 'agent']).nullable(),
    policy: mcpAccessPolicySchema,
    availableActions: z.array(
      z.enum([
        'mcp_server_control',
        'mcp_server_replace',
        'mcp_server_unregister',
        'mcp_catalog_refresh',
        'mcp_server_set_scope',
      ]),
    ),
    ready: z.boolean(),
    containment: z.enum(['not_started', 'open', 'pending', 'contained', 'failed']),
    failureReason: z
      .enum(['startup_failed', 'transport_closed', 'process_unavailable', 'containment_failed'])
      .nullable(),
    containmentBoundary: z.enum(['local_process_group', 'local_connection']),
    processId: z.string().nullable(),
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
const ScopeResultSchema = z
  .object({ serverName: z.string(), policy: mcpAccessPolicySchema, updated: z.literal(true) })
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
    409: z.union([LifecycleErrorSchema, WorkGcBusyErrorSchema]),
    500: UnexpectedInternalServerErrorSchema,
  },
  ...operatorSessionContract,
} as const;

export const mcpOperatorApiContracts = {
  'mcp.scope': {
    ...lifecycleContract,
    operationId: 'mcp.scope',
    path: '/api/mcp/servers/:name/scope',
    body: z.object({ policy: mcpAccessPolicySchema }).strict(),
    success: ScopeResultSchema,
    response: {
      ...lifecycleContract.response,
      200: ScopeResultSchema,
    },
  },
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
  'mcp.restart': {
    ...lifecycleContract,
    operationId: 'mcp.restart',
    method: 'POST',
    path: '/api/mcp/servers/:name/restart',
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
import { WorkGcBusyErrorSchema } from './work-gc.js';
