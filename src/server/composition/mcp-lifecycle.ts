import type { FastifyInstance } from 'fastify';
import { McpManager } from '../../mcp/manager-api.js';
import type { ResourceScope } from '../../lifecycle/index.js';
import type { StartupFailure } from './runtime-lifecycle.js';

export interface McpStartupResult {
  mcpManager?: McpManager;
  startupFailure?: StartupFailure;
}

export async function startMcpManager(options: {
  projectRoot: string;
  scope: ResourceScope;
  fastify: FastifyInstance;
}): Promise<McpStartupResult> {
  try {
    const mcpManager = new McpManager(options.projectRoot, { scope: options.scope.child('mcp') });
    await mcpManager.startAll();
    options.fastify.log.info('MCP manager started');
    return { mcpManager };
  } catch (err) {
    options.fastify.log.warn(`MCP manager initialization failed (continuing without MCP): ${err instanceof Error ? err.message : String(err)}`);
    return { startupFailure: { code: 'mcp-manager-start-failed', error: err } };
  }
}

export function attachMcpManagerToRuntime(runtimeApplication: { setMcpManager(mcpManager: McpManager): void } | undefined, mcpManager: McpManager | undefined): void {
  if (runtimeApplication && mcpManager) runtimeApplication.setMcpManager(mcpManager);
}
