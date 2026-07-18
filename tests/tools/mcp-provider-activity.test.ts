import { describe, expect, it, jest } from '@jest/globals';
import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { createMcpProvider } from '../../src/tools/mcp-provider.js';
import type { LlmToolInvocationContext } from '../../src/runtime/actors/executing-llm-snapshot.js';

describe('MCP activity segmentation', () => {
  it('keeps the complete current MCP invocation active without calling any wait callback', async () => {
    const waits = { external: 0, process: 0, child: 0 };
    const context: LlmToolInvocationContext = {
      sessionId: 'executor:card-a', sourceInputId: '11111111-1111-4111-8111-111111111111', toolCallId: 'mcp-call', toolName: 'mcp_tool_call',
      waits: {
        waitExternal: async <T>(promise: Promise<T>) => { waits.external += 1; return promise; },
        waitProcess: async <T>(_id: string, promise: Promise<T>) => { waits.process += 1; return promise; },
        waitChild: async <T>(_relationship: unknown, promise: Promise<T>) => { waits.child += 1; return promise; },
      },
    };
    const manager = { invokeTool: jest.fn(async () => ({ value: 1 })), findToolCapability: jest.fn(() => null), getServerTools: jest.fn(() => undefined) };
    const surface = buildInvocationSurface('executor', [createMcpProvider({ agentRole: 'executor', mcpManagerProvider: () => manager })]);
    await expect(invokeTool(surface, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, new AbortController().signal, context)).resolves.toEqual({ success: true, data: { value: 1 } });
    expect(waits).toEqual({ external: 0, process: 0, child: 0 });
  });
});
