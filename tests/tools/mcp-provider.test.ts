import { describe, expect, it } from '@jest/globals';

import type { McpToolInvocationPort } from '../../src/mcp/mcp-manager.js';
import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { createMcpProvider } from '../../src/tools/mcp-provider.js';
import { issueCompositionMutationAuthority } from '../../src/application/mutation-authority.js';

function manager(input: { annotations?: Record<string, unknown>; result?: unknown } = {}): McpToolInvocationPort {
  return {
    getServerTools: () => [],
    findToolCapability: (serverName, toolName) => ({ serverName, name: toolName, description: 'tool', inputSchema: { type: 'object' }, annotations: input.annotations as never, stats: { total: 0, success: 0, error: 0 } }),
    invokeTool: async (_authority, serverName, toolName, args) => input.result ?? { serverName, toolName, args },
  } as McpToolInvocationPort;
}

describe('McpProvider', () => {
  it('invokes MCP tools for executor sessions', async () => {
    const surface = buildInvocationSurface('executor', [createMcpProvider({ agentRole: 'executor', mcpManagerProvider: () => manager(), mutationAuthority: issueCompositionMutationAuthority })]);
    await expect(invokeTool(surface, 'mcp_tool_call', { serverName: 'svc', toolName: 'list', args: { limit: 1 } })).resolves.toEqual({ success: true, data: { serverName: 'svc', toolName: 'list', args: { limit: 1 } } });
  });

  it('returns a model-visible error when MCP manager is unavailable', async () => {
    const surface = buildInvocationSurface('executor', [createMcpProvider({ agentRole: 'executor', mcpManagerProvider: () => undefined, mutationAuthority: issueCompositionMutationAuthority })]);
    await expect(invokeTool(surface, 'mcp_tool_call', { serverName: 'svc', toolName: 'list' })).resolves.toEqual({ success: false, error: 'MCP manager is not available for this runtime.' });
  });

  it('requires reviewer MCP tools to be read-only and non-destructive', async () => {
    const allowed = buildInvocationSurface('reviewer', [createMcpProvider({ agentRole: 'reviewer', mcpManagerProvider: () => manager({ annotations: { readOnlyHint: true, destructiveHint: false } }), mutationAuthority: issueCompositionMutationAuthority })]);
    await expect(invokeTool(allowed, 'mcp_tool_call', { serverName: 'svc', toolName: 'read' })).resolves.toEqual(expect.objectContaining({ success: true }));

    const destructive = buildInvocationSurface('reviewer', [createMcpProvider({ agentRole: 'reviewer', mcpManagerProvider: () => manager({ annotations: { readOnlyHint: true, destructiveHint: true } }), mutationAuthority: issueCompositionMutationAuthority })]);
    const result = await invokeTool(destructive, 'mcp_tool_call', { serverName: 'svc', toolName: 'write' });
    expect(result).toEqual({ success: false, error: "Reviewer cannot call destructive MCP tool 'svc/write'." });
  });
});
