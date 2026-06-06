import type { FastifyInstance } from 'fastify';
import { McpManager } from '../../mcp/manager-api.js';
import type { ResourceScope } from '../../lifecycle/index.js';

export async function startMcpManager(options: {
  projectRoot: string;
  scope: ResourceScope;
  fastify: FastifyInstance;
}): Promise<McpManager> {
  const mcpManager = new McpManager(options.projectRoot, { scope: options.scope.child('mcp') });
  await mcpManager.startAll();
  options.fastify.log.info('MCP manager started');
  return mcpManager;
}

export function attachMcpManagerToRuntime(runtimeApplication: { setMcpManager(mcpManager: McpManager): void }, mcpManager: McpManager): void {
  runtimeApplication.setMcpManager(mcpManager);
}
