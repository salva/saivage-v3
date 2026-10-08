import { afterEach, describe, expect, it } from '@jest/globals';
import Fastify from 'fastify';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { buildMcpOperatorContractHandlers } from '../../src/server/routes/operator-mcp-handlers.js';
import { mcpOperatorApiContracts } from '../../src/contracts/operator-api-mcp.js';
import type { McpToolsReadModelProvider } from '../../src/mcp/manager-api.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { McpLifecycleError } from '../../src/mcp/errors.js';

const fastifies: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(fastifies.splice(0).map((fastify) => fastify.close()));
});

function mountRoutes(options: { mcpToolsProvider: McpToolsReadModelProvider }) {
  const fastify = Fastify({ logger: false });
  fastifies.push(fastify);
  const runtime = new ContractRuntime({ authPolicy: new AuthPolicy(), eventLogger: {} as never, fatalPort: testApplicationFatalPort });
  runtime.mount(fastify, mcpOperatorApiContracts, buildMcpOperatorContractHandlers({ ...options, mcpLifecycle: unusedMcpToolInvocation }));
  return fastify;
}

describe('MCP operator contract routes', () => {
  it('authenticates before strict empty-body validation and maps only lifecycle conflicts', async () => {
    const fastify = Fastify({ logger: false }); fastifies.push(fastify);
    const calls: string[] = [];
    const handlers = buildMcpOperatorContractHandlers({ mcpToolsProvider: { getToolsReadModel: () => ({ servers: [] }) }, mcpLifecycle: {
      startServer: async name => { calls.push(name); if (name === 'missing') throw new McpLifecycleError('Unknown', 404); if (name === 'disabled') throw new McpLifecycleError('Disabled', 409); if (name === 'failure') throw new Error('private failure'); return { serverName: name, status: 'running', toolCount: 2 }; },
      stopServer: async name => ({ serverName: name, status: 'stopped', toolCount: 0 }),
    } });
    new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'test-token' }), eventLogger: { appendEventPrepared() {} } as never, fatalPort: testApplicationFatalPort }).mount(fastify, mcpOperatorApiContracts, handlers);
    const headers = { authorization: 'Bearer test-token' };
    for (const action of ['start', 'stop']) {
      const url = `/api/mcp/servers/browser/${action}`;
      const before = calls.length;
      expect((await fastify.inject({ method: 'POST', url, payload: { command: 'forbidden' } })).statusCode).toBe(401);
      expect(calls).toHaveLength(before);
      expect((await fastify.inject({ method: 'POST', url, headers, payload: { command: 'forbidden' } })).statusCode).toBe(400);
      const response = await fastify.inject({ method: 'POST', url, headers, payload: {} });
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ serverName: 'browser', status: action === 'start' ? 'running' : 'stopped', toolCount: action === 'start' ? 2 : 0 });
    }
    for (const [name, status] of [['missing', 404], ['disabled', 409], ['failure', 500]] as const)
      expect((await fastify.inject({ method: 'POST', url: `/api/mcp/servers/${name}/start`, headers, payload: {} })).statusCode).toBe(status);
  });
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
      mcpToolsProvider: { getToolsReadModel: () => ({
        servers: [{ name: 'ghu_server', transport: 'stdio', status: 'error', toolCount: 1, tools: [{ ...tool, stats: stat }] }],
      }) },
    });

    const tools = await fastify.inject({ method: 'GET', url: '/api/mcp/tools' });

    expect(tools.statusCode).toBe(200);
    expect(tools.json()).toEqual({
      servers: [{ name: 'ghu_server', transport: 'stdio', status: 'error', toolCount: 1, tools: [{ name: 'tok_tool', stats: stat }] }],
    });
    const serialized = tools.body;
    for (const marker of ['opaque-title-marker', 'opaque-description-marker', 'opaque_input_marker', 'opaque_output_marker', 'opaque-annotation-marker', 'opaque_meta_marker']) {
      expect(serialized).not.toContain(marker);
    }
  });

  it('preserves an empty MCP tools read model', async () => {
    const response = await mountRoutes({ mcpToolsProvider: { getToolsReadModel: () => ({ servers: [] }) } }).inject({ method: 'GET', url: '/api/mcp/tools' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ servers: [] });
  });
});
