import { describe, expect, it, jest } from '@jest/globals';
import { buildInvocationSurface, invokeTool, invokeToolForLlm } from '../../src/tools/invocation.js';
import { createMcpProvider } from '../../src/tools/mcp-provider.js';
import type { LlmToolInvocationContext } from '../../src/runtime/actors/executing-llm-snapshot.js';
import { createMcpToolInvocationInstallation, McpToolInvocationNotInstalledError } from '../../src/mcp/tool-invocation-installation.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';

describe('MCP activity segmentation', () => {
  it('keeps the complete current MCP invocation active without calling any wait callback', async () => {
    const waits = { external: 0, process: 0 };
    const base = testLlmToolInvocationContext({ toolCallId: 'mcp-call', toolName: 'mcp_tool_call' });
    const context: LlmToolInvocationContext = {
      ...base,
      waits: {
        waitExternal: async <T>(promise: Promise<T>) => { waits.external += 1; return promise; },
        waitProcess: async <T>(_id: string, promise: Promise<T>) => { waits.process += 1; return promise; },
      },
    };
    const manager = { invokeTool: jest.fn(async () => ({ value: 1 })), findToolCapability: jest.fn(() => null), getServerTools: jest.fn(() => undefined) };
    const surface = buildInvocationSurface('executor', [createMcpProvider({ mcpToolInvocation: manager })]);
    await expect(invokeTool(surface, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, new AbortController().signal, context)).resolves.toEqual({ success: true, data: { value: 1 } });
    expect(waits).toEqual({ external: 0, process: 0 });
  });

  it('preserves the fatal pre-install invariant through every tool boundary', async () => {
    const installation = createMcpToolInvocationInstallation();
    const surface = buildInvocationSurface('executor', [createMcpProvider({ mcpToolInvocation: installation.port })]);
    const args = { serverName: 'server', toolName: 'tool' };
    for (const invoke of [
      () => invokeTool(surface, 'mcp_tool_call', args),
      () => invokeToolForLlm(surface, 'mcp_tool_call', args, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' })),
    ]) {
      const invocation = invoke();
      await expect(invocation).rejects.toBeInstanceOf(McpToolInvocationNotInstalledError);
      await expect(invocation).rejects.toThrow('MCP tool invocation authority is not installed.');
    }
  });

  it('keeps invocation failures as failed results and never derives authority from annotations or agent names', async () => {
    const invocationFailure = buildInvocationSurface('executor', [createMcpProvider({
      mcpToolInvocation: { getServerTools: () => [], findToolCapability: () => null, invokeTool: async () => { throw new Error('transport failed'); } },
    })]);
    await expect(invokeToolForLlm(invocationFailure, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' }))).resolves.toEqual({ success: false, error: 'transport failed' });

    const reviewerFailure = buildInvocationSurface('reviewer', [createMcpProvider({
      mcpToolInvocation: { getServerTools: () => [], findToolCapability: () => null, invokeTool: async () => 'unused' },
    })]);
    await expect(invokeToolForLlm(reviewerFailure, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' }))).resolves.toEqual({ success: true, data:'unused' });

    const reviewerDestructive = buildInvocationSurface('reviewer', [createMcpProvider({
      mcpToolInvocation: {
        getServerTools: () => [],
        findToolCapability: () => ({ serverName: 'server', name: 'tool', description: 'tool', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: true } }),
        invokeTool: async () => 'unused',
      },
    })]);
    await expect(invokeToolForLlm(reviewerDestructive, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' }))).resolves.toEqual({ success: true, data:'unused' });

    const reviewerWritable = buildInvocationSurface('reviewer', [createMcpProvider({
      mcpToolInvocation: {
        getServerTools: () => [],
        findToolCapability: () => ({ serverName: 'server', name: 'tool', description: 'tool', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }),
        invokeTool: async () => 'unused',
      },
    })]);
    await expect(invokeToolForLlm(reviewerWritable, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' }))).resolves.toEqual({ success: true, data:'unused' });
  });
});
