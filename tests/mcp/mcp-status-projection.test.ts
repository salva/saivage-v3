import { describe, expect, it, jest } from '@jest/globals';
import { McpToolsResponseSchema } from '../../src/contracts/index.js';
import { McpToolCallArgumentsSchema } from '../../src/contracts/mcp-invocation.js';
import { decodeMcpListPage } from '../../src/mcp/catalog-discovery.js';
import { McpInvocationStatsRecorder, mcpInvocationStatsKey } from '../../src/mcp/invocation-stats.js';
import { buildMcpServerStatus, buildMcpToolsReadModel } from '../../src/mcp/status-projection.js';
import { projectMcpToolsForOutbound } from '../../src/mcp/tool-api.js';
import { PROJECT_MCP_ENTRY_POLICY, READY_PROJECT_MCP_STATUS } from '../helpers/mcp-fixture.js';

describe('MCP status/read-model projection', () => {
  it('projects independently admitted invocation pairs through the strict outbound contract', () => {
    const bindingId = '11111111-1111-4111-8111-111111111111';
    const catalogId = '22222222-2222-4222-8222-222222222222';
    const catalogs = new Map([
      ['a:b', decodeMcpListPage('a:b', {
        jsonrpc: '2.0', result: { tools: [{ name: 'c', inputSchema: { type: 'object' } }] },
      }, new Set()).tools],
      ['a', decodeMcpListPage('a', {
        jsonrpc: '2.0', result: { tools: [
          { name: 'b:c', inputSchema: { type: 'object' } },
          { name: 'unused', inputSchema: { type: 'object' } },
        ] },
      }, new Set()).tools],
    ]);
    const first = McpToolCallArgumentsSchema.parse({ serverName: 'a:b', toolName: 'c', bindingId, catalogId, args: {} });
    const second = McpToolCallArgumentsSchema.parse({ serverName: 'a', toolName: 'b:c', bindingId, catalogId, args: {} });
    const recorder = new McpInvocationStatsRecorder({ appendEventPrepared: jest.fn() } as any);
    const t1 = '2026-11-13T10:00:00.000Z';
    const t2 = '2026-11-13T10:01:00.000Z';
    const t3 = '2026-11-13T10:02:00.000Z';
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date(t1));
      recorder.record(first.serverName, first.toolName, true);
      jest.setSystemTime(new Date(t2));
      recorder.record(second.serverName, second.toolName, false);
      jest.setSystemTime(new Date(t3));
      recorder.record(first.serverName, first.toolName, true);
    } finally {
      jest.useRealTimers();
    }

    const readModel = buildMcpToolsReadModel({
      statuses: ['a:b', 'a'].map(name => ({
        name, transport: 'streamable-http', status: 'running', bindingId,
        definitionSource: 'operator', ...READY_PROJECT_MCP_STATUS,
        containmentBoundary: 'local_connection', processId: null,
      })),
      getServerTools: name => catalogs.get(name),
      invocationStats: recorder.snapshot(),
    });
    const outbound = projectMcpToolsForOutbound(readModel);
    expect(McpToolsResponseSchema.parse(outbound)).toEqual(outbound);
    expect(outbound.servers.map(({ name, tools }) => ({ name, tools }))).toEqual([
      { name: 'a:b', tools: [
        { name: 'c', stats: { total: 2, success: 2, error: 0, lastInvokedAt: t3 } },
      ] },
      { name: 'a', tools: [
        { name: 'b:c', stats: { total: 1, success: 0, error: 1, lastInvokedAt: t2 } },
        { name: 'unused', stats: { total: 0, success: 0, error: 0 } },
      ] },
    ]);
  });

  it('narrows opaque integration fields while preserving exact topology and statistics', () => {
    expect(buildMcpServerStatus({
        ready: false,
        starting: false, name: 'disabled', config: { ...PROJECT_MCP_ENTRY_POLICY, transport: 'stdio', command: 'disabled-server', disabled: true, autostart: true } })).toEqual({ name: 'disabled', transport: 'stdio', status: 'stopped' });
    const running = buildMcpServerStatus({
      name: 'ghu_server',
      ready: true,
      starting: false,
      config: { ...PROJECT_MCP_ENTRY_POLICY, transport: 'streamable-http', disabled: false, autostart: true, url: 'http://example.invalid/mcp' },
      handle: { abortController: new AbortController() },
      startedAt: '2026-01-01T00:00:00.000Z',
      tools: [{ name: 'tok_tool', title: 'opaque-title-marker', description: 'opaque-description-marker', inputSchema: { type: 'object', properties: { opaque_schema_marker: {} } }, outputSchema: { type: 'object', properties: { opaque_output_marker: {} } }, annotations: { title: 'opaque-annotation-marker', readOnlyHint: true }, _meta: { opaque_meta_marker: true } }],
    });
    expect(running).toEqual(expect.objectContaining({ name: 'ghu_server', transport: 'streamable-http', status: 'running', tools_count: 1 }));

    const readModel = buildMcpToolsReadModel({
      statuses: [
        {
          ...running,
          bindingId: '11111111-1111-4111-8111-111111111111',
          definitionSource: 'operator',
          ...READY_PROJECT_MCP_STATUS, containmentBoundary: 'local_connection',
          processId: null,
        }],
      getServerTools: () => [{ name: 'tok_tool', description: 'nested-opaque-description-marker', inputSchema: { type: 'object', properties: { nested_schema_marker: {} } }, annotations: { title: 'nested-opaque-annotation-marker' }, _meta: { nested_meta_marker: true } }],
      invocationStats: { [mcpInvocationStatsKey('ghu_server', 'tok_tool')]: { total: 7, success: 5, error: 2, lastInvokedAt: '2026-07-22T10:11:12.000Z' } },
    });
    const tools = projectMcpToolsForOutbound(readModel);
    expect(McpToolsResponseSchema.parse(tools)).toEqual(tools);
    expect(tools).toEqual({
      servers: [{ name: 'ghu_server', transport: 'streamable-http', status: 'running',
          bindingId: '11111111-1111-4111-8111-111111111111',
          definitionSource: 'operator',
          ...READY_PROJECT_MCP_STATUS, containmentBoundary: 'local_connection',
          processId: null, toolCount: 1, tools: [{ name: 'tok_tool', stats: { total: 7, success: 5, error: 2, lastInvokedAt: '2026-07-22T10:11:12.000Z' } }] }],
    });
    const serialized = JSON.stringify(tools);
    for (const marker of ['opaque-title-marker', 'opaque-description-marker', 'opaque_schema_marker', 'opaque_output_marker', 'opaque-annotation-marker', 'opaque_meta_marker', 'nested-opaque-description-marker', 'nested_schema_marker', 'nested-opaque-annotation-marker', 'nested_meta_marker']) {
      expect(serialized).not.toContain(marker);
    }
  });
});
