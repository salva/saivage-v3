import { describe, expect, it } from '@jest/globals';
import { buildMcpServerStatus, buildMcpToolsReadModel } from '../../src/mcp/status-projection.js';

describe('MCP status/read-model projection', () => {
  it('projects disabled, stopped, running, and tool read-model details without a manager', () => {
    expect(buildMcpServerStatus({ name: 'disabled', config: { transport: 'stdio', disabled: true, autostart: true } })).toEqual({ name: 'disabled', transport: 'stdio', status: 'stopped' });
    const running = buildMcpServerStatus({
      name: 'stream',
      config: { transport: 'sse', disabled: false, autostart: true, url: 'http://example.invalid/mcp' },
      handle: { abortController: new AbortController() },
      startedAt: '2026-01-01T00:00:00.000Z',
      tools: [{ name: 'query', description: 'Query', inputSchema: { type: 'object' } }],
    });
    expect(running).toEqual(expect.objectContaining({ name: 'stream', transport: 'sse', status: 'running', tools_count: 1 }));

    const readModel = buildMcpToolsReadModel({
      tools: [{ name: 'query', description: 'Query', inputSchema: { type: 'object' } }],
      servers: ['stream'],
      statuses: [running],
      getServerTools: () => [{ name: 'query', description: 'Query', inputSchema: { type: 'object' } }],
      invocationStats: { 'stream:query': { total: 1, success: 1, error: 0 } },
    });
    expect(readModel.serverDetails[0]).toEqual(expect.objectContaining({ name: 'stream', toolCount: 1, tools: [expect.objectContaining({ name: 'query', stats: { total: 1, success: 1, error: 0 } })] }));
  });
});
