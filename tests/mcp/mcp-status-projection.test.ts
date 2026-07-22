import { describe, expect, it } from '@jest/globals';
import { McpStatusResponseSchema, McpToolsResponseSchema } from '../../src/contracts/index.js';
import { buildMcpServerStatus, buildMcpToolsReadModel } from '../../src/mcp/status-projection.js';
import { redactForOutbound } from '../../src/redaction/index.js';

describe('MCP status/read-model projection', () => {
  it('narrows opaque integration fields while preserving exact topology and statistics', () => {
    expect(buildMcpServerStatus({ name: 'disabled', config: { transport: 'stdio', command: 'disabled-server', disabled: true, autostart: true } })).toEqual({ name: 'disabled', transport: 'stdio', status: 'stopped' });
    const running = buildMcpServerStatus({
      name: 'ghu_server',
      config: { transport: 'streamable-http', disabled: false, autostart: true, url: 'http://example.invalid/mcp' },
      handle: { abortController: new AbortController() },
      startedAt: '2026-01-01T00:00:00.000Z',
      tools: [{ name: 'tok_tool', title: 'opaque-title-marker', description: 'opaque-description-marker', inputSchema: { type: 'object', properties: { opaque_schema_marker: {} } }, outputSchema: { type: 'object', properties: { opaque_output_marker: {} } }, annotations: { title: 'opaque-annotation-marker', readOnlyHint: true }, _meta: { opaque_meta_marker: true } }],
    });
    expect(running).toEqual(expect.objectContaining({ name: 'ghu_server', transport: 'streamable-http', status: 'running', tools_count: 1 }));

    const readModel = buildMcpToolsReadModel({
      tools: [{ name: 'tok_tool', title: 'opaque-title-marker', description: 'opaque-description-marker', inputSchema: { type: 'object', properties: { opaque_schema_marker: {} } }, outputSchema: { type: 'object', properties: { opaque_output_marker: {} } }, annotations: { title: 'opaque-annotation-marker', readOnlyHint: true }, _meta: { opaque_meta_marker: true } }],
      servers: ['ghu_server'],
      statuses: [running],
      getServerTools: () => [{ name: 'tok_tool', description: 'nested-opaque-description-marker', inputSchema: { type: 'object', properties: { nested_schema_marker: {} } }, annotations: { title: 'nested-opaque-annotation-marker' }, _meta: { nested_meta_marker: true } }],
      invocationStats: { 'ghu_server:tok_tool': { total: 7, success: 5, error: 2, lastInvokedAt: '2026-07-22T10:11:12.000Z' } },
    });
    const status = redactForOutbound({ source: 'mcp-status', value: { servers: [{ ...running, status: 'error', error: 'opaque-status-error-marker' }] } });
    const tools = redactForOutbound({ source: 'mcp-tools', value: readModel });
    expect(McpStatusResponseSchema.parse(status)).toEqual(status);
    expect(McpToolsResponseSchema.parse(tools)).toEqual(tools);
    expect(status.servers[0]).toEqual({ name: 'ghu_server', transport: 'streamable-http', status: 'error', startedAt: '2026-01-01T00:00:00.000Z', tools_count: 1 });
    expect(tools).toEqual({
      tools: [{ name: 'tok_tool' }],
      servers: ['ghu_server'],
      invocationStats: { 'ghu_server:tok_tool': { total: 7, success: 5, error: 2, lastInvokedAt: '2026-07-22T10:11:12.000Z' } },
      serverDetails: [{ name: 'ghu_server', transport: 'streamable-http', status: 'running', toolCount: 1, tools: [{ name: 'tok_tool', stats: { total: 7, success: 5, error: 2, lastInvokedAt: '2026-07-22T10:11:12.000Z' } }] }],
    });
    const serialized = JSON.stringify({ status, tools });
    for (const marker of ['opaque-title-marker', 'opaque-description-marker', 'opaque_schema_marker', 'opaque_output_marker', 'opaque-annotation-marker', 'opaque_meta_marker', 'nested-opaque-description-marker', 'nested_schema_marker', 'nested-opaque-annotation-marker', 'nested_meta_marker', 'opaque-status-error-marker']) {
      expect(serialized).not.toContain(marker);
    }
  });
});
