import {
  McpStatusResponseSchema,
  McpToolsResponseSchema,
  type McpStatusResponse,
  type McpToolsResponse,
  type ServerAvailability,
} from '../contracts/index.js';
import type { McpServerStatus } from './protocol.js';
import type { InternalMcpToolsReadModel } from './status-projection.js';

export interface InternalMcpStatusResponse {
  servers: McpServerStatus[];
  serverAvailability?: ServerAvailability;
}

export function projectMcpStatusForOutbound(value: InternalMcpStatusResponse): McpStatusResponse {
  return McpStatusResponseSchema.parse({
    servers: value.servers.map((server) => ({
      name: server.name,
      transport: server.transport,
      status: server.status,
      ...(server.pid === undefined ? {} : { pid: server.pid }),
      ...(server.startedAt === undefined ? {} : { startedAt: server.startedAt }),
      ...(server.tools_count === undefined ? {} : { tools_count: server.tools_count }),
    })),
    ...(value.serverAvailability === undefined ? {} : { serverAvailability: value.serverAvailability }),
  });
}

export function projectMcpToolsForOutbound(value: InternalMcpToolsReadModel): McpToolsResponse {
  return McpToolsResponseSchema.parse({
    tools: value.tools.map((tool) => ({ name: tool.name })),
    servers: [...value.servers],
    invocationStats: value.invocationStats,
    serverDetails: value.serverDetails.map((server) => ({
      name: server.name,
      transport: server.transport,
      status: server.status,
      toolCount: server.toolCount,
      tools: server.tools.map((tool) => ({ name: tool.name, stats: tool.stats })),
    })),
  });
}
