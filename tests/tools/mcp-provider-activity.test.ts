import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { describe, expect, it, jest } from '@jest/globals';
import { invokeTool, invokeToolForLlm, type ToolSettlementInput } from '../../src/tools/invocation.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { mcpToolBinders, type McpProviderContext } from '../../src/tools/mcp-provider.js';
import type { LlmToolInvocationContext } from '../../src/runtime/actors/executing-llm-snapshot.js';
import { createMcpToolInvocationInstallation, McpToolInvocationNotInstalledError } from '../../src/mcp/tool-invocation-installation.js';
import { testLlmToolInvocationContext } from '../helpers/llm-test-helpers.js';

const settlementResult = (settlement: ToolSettlementInput) => settleToolActionOutcome(settlement.kind === 'executed' ? settlement.execution.providerOutcome : settlement.providerOutcome).providerResult;

describe('MCP activity segmentation', () => {
  const provider = (context: McpProviderContext) => bindToolProvider('mcp', mcpToolBinders, context);
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
    const surface = buildInvocationSurfaceFixture('executor', [provider({ mcpToolInvocation: manager })]);
    expect(settlementResult({ kind: 'executed', execution: await invokeTool(surface, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, new AbortController().signal, context) })).toEqual({ success: true, data: { result: { value: 1 }, result_complete: true, result_utf8_bytes: 11 } });
    expect(waits).toEqual({ external: 0, process: 0 });
  });

  it('preserves the fatal pre-install invariant through every tool boundary', async () => {
    const installation = createMcpToolInvocationInstallation();
    const surface = buildInvocationSurfaceFixture('executor', [provider({ mcpToolInvocation: installation.port })]);
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
    const invocationFailure = buildInvocationSurfaceFixture('executor', [provider({
      mcpToolInvocation: { getServerTools: () => [], findToolCapability: () => null, invokeTool: async () => { throw new Error('transport failed'); } },
    })]);
    expect(settlementResult(await invokeToolForLlm(invocationFailure, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' })))).toEqual({ success: false, error: 'transport failed' });

    const reviewerFailure = buildInvocationSurfaceFixture('reviewer', [provider({
      mcpToolInvocation: { getServerTools: () => [], findToolCapability: () => null, invokeTool: async () => 'unused' },
    })]);
    expect(settlementResult(await invokeToolForLlm(reviewerFailure, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' })))).toEqual({ success: true, data: { result: 'unused', result_complete: true, result_utf8_bytes: 8 } });

    const reviewerDestructive = buildInvocationSurfaceFixture('reviewer', [provider({
      mcpToolInvocation: {
        getServerTools: () => [],
        findToolCapability: () => ({ serverName: 'server', name: 'tool', description: 'tool', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: true } }),
        invokeTool: async () => 'unused',
      },
    })]);
    expect(settlementResult(await invokeToolForLlm(reviewerDestructive, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' })))).toEqual({ success: true, data: { result: 'unused', result_complete: true, result_utf8_bytes: 8 } });

    const reviewerWritable = buildInvocationSurfaceFixture('reviewer', [provider({
      mcpToolInvocation: {
        getServerTools: () => [],
        findToolCapability: () => ({ serverName: 'server', name: 'tool', description: 'tool', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } }),
        invokeTool: async () => 'unused',
      },
    })]);
    expect(settlementResult(await invokeToolForLlm(reviewerWritable, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' })))).toEqual({ success: true, data: { result: 'unused', result_complete: true, result_utf8_bytes: 8 } });
  });
});
