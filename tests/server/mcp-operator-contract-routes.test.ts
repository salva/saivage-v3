import { afterEach, describe, expect, it } from '@jest/globals';
import Fastify from 'fastify';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { buildMcpOperatorContractHandlers } from '../../src/server/routes/operator-mcp-handlers.js';
import { mcpOperatorApiContracts } from '../../src/contracts/operator-api-mcp.js';
import type { McpToolsReadModelProvider, McpStatusProvider } from '../../src/mcp/manager-api.js';

const fastifies: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(fastifies.splice(0).map((fastify) => fastify.close()));
});

function mountRoutes(options: { mcpStatusProvider?: McpStatusProvider; mcpToolsProvider?: McpToolsReadModelProvider }) {
  const fastify = Fastify({ logger: false });
  fastifies.push(fastify);
  const runtime = new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger: {} as never });
  runtime.mount(fastify, mcpOperatorApiContracts, buildMcpOperatorContractHandlers(options));
  return fastify;
}

describe('MCP operator contract routes', () => {
  it('omits opaque integration payload while preserving exact names, topology, and stats', async () => {
    const stat = { total: 9, success: 8, error: 1, lastInvokedAt: '2026-07-22T12:00:00.000Z' };
    const tool = {
      name: 'tok_tool',
      title: 'opaque-title-marker',
      description: 'opaque-description-marker',
      inputSchema: { type: 'object' as const, properties: { opaque_input_marker: {} } },
      outputSchema: { type: 'object' as const, properties: { opaque_output_marker: {} } },
      annotations: { title: 'opaque-annotation-marker' },
      _meta: { opaque_meta_marker: true },
    };
    const fastify = mountRoutes({
      mcpStatusProvider: { getStatus: () => [{ name: 'ghu_server', transport: 'stdio', status: 'error', pid: 123, error: 'opaque-status-error-marker', startedAt: '2026-07-22T11:00:00.000Z', tools_count: 1 }] },
      mcpToolsProvider: { getToolsReadModel: () => ({
        tools: [tool],
        servers: ['ghu_server'],
        invocationStats: { 'ghu_server:tok_tool': stat },
        serverDetails: [{ name: 'ghu_server', transport: 'stdio', status: 'error', toolCount: 1, tools: [{ ...tool, stats: stat }] }],
      }) },
    });

    const status = await fastify.inject({ method: 'GET', url: '/api/mcp/status' });
    const tools = await fastify.inject({ method: 'GET', url: '/api/mcp/tools' });

    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ servers: [{ name: 'ghu_server', transport: 'stdio', status: 'error', pid: 123, startedAt: '2026-07-22T11:00:00.000Z', tools_count: 1 }] });
    expect(tools.statusCode).toBe(200);
    expect(tools.json()).toEqual({
      tools: [{ name: 'tok_tool' }],
      servers: ['ghu_server'],
      invocationStats: { 'ghu_server:tok_tool': stat },
      serverDetails: [{ name: 'ghu_server', transport: 'stdio', status: 'error', toolCount: 1, tools: [{ name: 'tok_tool', stats: stat }] }],
    });
    const serialized = `${status.body}${tools.body}`;
    for (const marker of ['opaque-title-marker', 'opaque-description-marker', 'opaque_input_marker', 'opaque_output_marker', 'opaque-annotation-marker', 'opaque_meta_marker', 'opaque-status-error-marker']) {
      expect(serialized).not.toContain(marker);
    }
  });

  it('preserves the empty MCP tools fallback', async () => {
    const response = await mountRoutes({}).inject({ method: 'GET', url: '/api/mcp/tools' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tools: [], servers: [], invocationStats: {}, serverDetails: [] });
  });
});
