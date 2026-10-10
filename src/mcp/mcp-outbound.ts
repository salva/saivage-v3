import { McpToolsResponseSchema, type McpToolsResponse } from '../contracts/index.js';
import type { InternalMcpToolsReadModel } from './status-projection.js';

export function projectMcpToolsForOutbound(value: InternalMcpToolsReadModel): McpToolsResponse {
  return McpToolsResponseSchema.parse({
    servers: value.servers.map((server) => ({
      name: server.name,
      transport: server.transport,
      status: server.status,
      bindingId: server.bindingId,
      definitionSource: server.definitionSource,
      containmentFailed: server.containmentFailed,
      processId: server.processId,
      toolCount: server.toolCount,
      tools: server.tools.map((tool) => ({ name: tool.name, stats: tool.stats })),
    })),
  });
}
