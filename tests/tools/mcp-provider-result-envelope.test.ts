import { describe, expect, it, jest } from '@jest/globals';
import { invokeToolForLlm } from '../../src/tools/invocation.js';
import { testLlmToolInvocationContext, unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { mcpToolBinders } from '../../src/tools/mcp-provider.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { McpInvokeError } from '../../src/mcp/errors.js';

function invocation(invokeTool: () => Promise<unknown>, signal?: AbortSignal) {
  const manager = { ...unusedMcpToolInvocation, invokeTool, findToolCapability: () => null, getServerTools: () => undefined };
  const surface = buildInvocationSurfaceFixture('executor', [bindToolProvider('mcp', mcpToolBinders, { projectRoot: '/unused', mcpToolInvocation: manager })]);
  return invokeToolForLlm(surface, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, testLlmToolInvocationContext({ sessionId: 'agent:executor:project', toolName: 'mcp_tool_call' }), signal);
}
async function result(value: unknown) {
  const execution = await invocation(async () => value);
  return settleToolActionOutcome(execution.kind === 'executed' ? execution.execution.providerOutcome : execution.providerOutcome).providerResult;
}

describe('complete native MCP envelope', () => {
  it('preserves large text and safe structured metadata without truncation', async () => {
    const content = [{ type: 'text', text: 'é'.repeat(60_000) }];
    expect(await result({ content, structuredContent: { ok: true }, _meta: { producer: 'fixture' } })).toEqual({
      success: true, content, data: { result: { structuredContent: { ok: true }, _meta: { producer: 'fixture' } }, native_content: [{ content_index: 0, type: 'text' }] },
    });
  });
  it('projects complete text and structured content; JSON-looking text stays text', async () => {
    const secret = `sk-${'x'.repeat(80)}`;
    const value = await result({ content: [{ type: 'text', text: `{"type":"image","secret":"${secret}"}` }], structuredContent: { type: 'image', data: secret } });
    expect(JSON.stringify(value)).not.toContain(secret);
    expect(value).toMatchObject({ success: true, content: [{ type: 'text' }], data: { result: { structuredContent: { type: 'image' } } } });
  });
  it('fails complete oversized projected text rather than returning a prefix', async () => {
    expect(await result({ content: [{ type: 'text', text: 'é'.repeat(530_000) }] })).toMatchObject({ success: false, error: expect.stringContaining('1 MiB') });
  });
  it.each([false, ['scalar'], { content: [{ type: 'unknown' }] }, { content: [{ type: 'text', text: 1 }] }])('rejects malformed native content %p', async (value) => {
    expect(await result(value)).toMatchObject({ success: false, error: 'Malformed native MCP tool result.' });
  });
  it('retains native errors as safe diagnostic data with no pixel selection', async () => {
    expect(await result({ isError: true, content: [{ type: 'text', text: 'failed' }, { type: 'image', data: 'not selected', mimeType: 'image/png' }] })).toEqual({
      success: false, error: 'MCP tool reported an error; effects may have occurred.', data: { result: { isError: true }, native_content: [{ content_index: 0, type: 'text' }, { content_index: 1, type: 'image', mimeType: 'image/png' }], content: [{ type: 'text', text: 'failed' }] },
    });
  });
  it('bounds ordinary projected transport errors without cutting redaction spans', async () => {
    const execution = await invocation(async () => { throw new McpInvokeError(`${'é'.repeat(220)} ${'sk-x '.repeat(100)}`, 'TRANSPORT_ERROR', 502); });
    const settled = settleToolActionOutcome(execution.kind === 'executed' ? execution.execution.providerOutcome : execution.providerOutcome).providerResult;
    expect(settled).toEqual({ success: false, error: `${'é'.repeat(220)} ${'sk-[REDACTED] '.repeat(5)}` });
  });
  it('propagates unclassified, containment and publication failures despite later cancellation', async () => {
    for (const failure of [new Error('unexpected rejection'), new Error('containment failed'), new PublicationOutcomeUnknownError()]) {
      const caller = new AbortController();
      await expect(invocation(async () => { caller.abort(new Error('later cancellation')); throw failure; }, caller.signal)).rejects.toBe(failure);
    }
  });
  it('does not swallow unexpected projection errors', async () => {
    const value = new Proxy({}, { get: () => { throw new Error('projection failed'); } });
    await expect(invocation(jest.fn(async () => value))).rejects.toThrow('projection failed');
  });
});
