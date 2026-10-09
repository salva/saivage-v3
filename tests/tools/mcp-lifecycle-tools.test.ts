import { describe, expect, it, jest } from '@jest/globals';
import { McpServerControlArgumentsSchema, McpToolsArgumentsSchema } from '../../src/contracts/index.js';
import { BoundAgentToolSet, resolveRuntimeTool } from '../../src/tools/runtime-tool-catalog.js';
import { invokeToolForLlm } from '../../src/tools/invocation.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { testLlmToolInvocationContext, unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import type { McpToolInvocationPort } from '../../src/mcp/manager-api.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { McpServerRuntime } from '../../src/mcp/server-runtime.js';
import { createMcpToolInvocationInstallation } from '../../src/mcp/tool-invocation-installation.js';

function surface(names:string[], port:McpToolInvocationPort) {
  return new BoundAgentToolSet(names.map(name => resolveRuntimeTool('card', name))).bind({ scope: 'card', agentName: 'reviewer', projectRoot: '/', mcpToolInvocation: port } as never);
}
async function call(names:string[], port:McpToolInvocationPort, toolName:string, args:unknown) {
  const settlement = await invokeToolForLlm(surface(names, port), toolName, args, testLlmToolInvocationContext({ sessionId: 'agent:reviewer:project', toolName }));
  return settleToolActionOutcome(settlement.kind === 'executed' ? settlement.execution.providerOutcome : settlement.providerOutcome).providerResult;
}
describe('independent configured MCP admissions', () => {
  it('settles actual discovery rejection through the installed lifecycle port as executed failure with no evidence', async () => {
    const originalFetch = globalThis.fetch;
    const terminate = jest.fn(async () => ({ failed: [] }));
    const runtime = new McpServerRuntime({ name: 'one', config: { transport: 'streamable-http', url: 'http://localhost/mcp', autostart: false, disabled: false }, revision: 'r', processRunner: { closeAndTerminateDirectScope: terminate } as never, processScope: {} as never, ids: { next: () => 1 }, invocationStats: {} as never });
    const installation = createMcpToolInvocationInstallation();
    installation.installer.install({ ...unusedMcpToolInvocation, startServer: async (name, signal) => { await runtime.start(signal); return { serverName: name, status: 'running', toolCount: runtime.getTools()!.length }; } });
    globalThis.fetch = jest.fn(async (_url, init?: RequestInit) => init?.method === 'HEAD' ? new Response(null, { status: 200 }) : new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32004, message: 'secret-remote-text'.repeat(1000) } }))) as typeof fetch;
    try {
      const outcome = await invokeToolForLlm(surface(['mcp_server_control'], installation.port), 'mcp_server_control', { serverName: 'one', action: 'start' }, testLlmToolInvocationContext({ toolName: 'mcp_server_control' }));
      expect(outcome).toMatchObject({ kind: 'executed', execution: { providerOutcome: { kind: 'failed', error: expect.stringContaining('initialize rejected (code -32004)') } } });
      if (outcome.kind !== 'executed') throw new Error('Expected executor entry');
      const settled = settleToolActionOutcome(outcome.execution.providerOutcome);
      expect(settled.providerResult).toMatchObject({ success: false });
      expect(outcome.execution).toMatchObject({ evidence: { kind: 'none' } });
      const text = (settled.providerResult as { error: string }).error;
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512);
      expect(text).not.toContain('secret-remote-text');
      expect(runtime.isContained()).toBe(true); expect(runtime.getTools()).toBeUndefined();
      expect(terminate).toHaveBeenCalledTimes(1);
    } finally { globalThis.fetch = originalFetch; }
  });
  it.each(['unknown', 'cancellation'] as const)('does not convert actual %s startup failure into an ordinary failed result', async mode => {
    const originalFetch = globalThis.fetch;
    const caller = new AbortController(); const reason = new TypeError('exact unknown/caller failure');
    const runtime = new McpServerRuntime({ name: 'one', config: { transport: 'streamable-http', url: 'http://localhost/mcp', autostart: false, disabled: false }, revision: 'r', processRunner: { closeAndTerminateDirectScope: async () => ({ failed: [] }) } as never, processScope: {} as never, ids: { next: () => 1 }, invocationStats: {} as never });
    const port = { ...unusedMcpToolInvocation, startServer: async (name: string, signal?: AbortSignal) => { await runtime.start(signal); return { serverName: name, status: 'running' as const, toolCount: 0 }; } };
    globalThis.fetch = jest.fn(async () => { if (mode === 'cancellation') caller.abort(reason); throw reason; }) as typeof fetch;
    try {
      const invoked = invokeToolForLlm(surface(['mcp_server_control'], port), 'mcp_server_control', { serverName: 'one', action: 'start' }, testLlmToolInvocationContext({ toolName: 'mcp_server_control' }), caller.signal);
      if (mode === 'unknown') await expect(invoked).rejects.toBe(reason);
      else await expect(invoked).resolves.toMatchObject({ kind: 'execution_failed' });
      expect(runtime.isContained()).toBe(true);
    } finally { globalThis.fetch = originalFetch; }
  });
  it('uses compiled default role selections and rejects even explicit MCP selection for Oversight', async () => {
    const workflows = compileProjectWorkflows(DEFAULT_SAIVAGE_CONFIG as never);
    const startServer = jest.fn(async (serverName:string) => ({ serverName, status:'running' as const, toolCount:0 }));
    const port = { ...unusedMcpToolInvocation, startServer, getServerTools: () => [] };
    for (const name of ['analyst', 'executor', 'reviewer', 'oversight']) {
      const agent = workflows.agents.get(name)!;
      const selected = agent.tools.filter(tool => ['mcp_server_control', 'mcp_tools', 'mcp_tool_call'].includes(tool.name));
      const scope = agent.session === 'global' ? 'global' : 'card';
      const bound = new BoundAgentToolSet(selected).bind({ scope, agentName:name, projectRoot:'/', mcpToolInvocation:port } as never);
      const invocation = await invokeToolForLlm(bound, 'mcp_server_control', {serverName:'one',action:'start'},
        testLlmToolInvocationContext({sessionId:scope === 'global' ? `agent:${name}:global` : `agent:${name}:project`,toolName:'mcp_server_control'}));
      const result = settleToolActionOutcome(invocation.kind === 'executed' ? invocation.execution.providerOutcome : invocation.providerOutcome).providerResult;
      expect(result.success).toBe(name === 'analyst' || name === 'executor');
    }
    expect(startServer).toHaveBeenCalledTimes(2);
    for (const tool of ['mcp_server_control', 'mcp_tools', 'mcp_tool_call']) {
      const config = structuredClone(DEFAULT_SAIVAGE_CONFIG);
      config.agents.oversight!.tools.push(tool);
      expect(() => compileProjectWorkflows(config as never)).toThrow(`oversight.agent tool '${tool}' is forbidden`);
    }
    const config = structuredClone(DEFAULT_SAIVAGE_CONFIG);
    config.agents.reviewer!.tools.push('mcp_server_control', 'mcp_tools');
    const reviewer = compileProjectWorkflows(config as never).agents.get('reviewer')!;
    expect(await call(reviewer.tools.filter(tool => ['mcp_server_control', 'mcp_tools'].includes(tool.name)).map(tool => tool.name), port,
      'mcp_server_control', {serverName:'one',action:'start'})).toMatchObject({success:true});
    expect(startServer).toHaveBeenCalledTimes(3);
  });
  it('requires strict explicit nonempty control/discovery arguments', () => {
    expect(McpServerControlArgumentsSchema.safeParse({ serverName: '', action: 'start' }).success).toBe(false);
    expect(McpServerControlArgumentsSchema.safeParse({ serverName: 'one', action: 'install' }).success).toBe(false);
    expect(McpServerControlArgumentsSchema.safeParse({ serverName: 'one', action: 'start', command: 'node' }).success).toBe(false);
    expect(McpToolsArgumentsSchema.safeParse({ serverName: 'one', toolName: '' }).success).toBe(false);
    expect(McpToolsArgumentsSchema.safeParse({ serverName: 'one', args: {} }).success).toBe(false);
  });
  it('permits explicitly selected Reviewer discovery/control without granting invocation, and invocation alone grants neither', async () => {
    const startServer = jest.fn(async (serverName:string) => ({ serverName, status: 'running' as const, toolCount: 1 }));
    const schema = { type: 'object' as const, $schema: 'https://json-schema.org/draft/2020-12/schema', properties: { scale: { enum: ['css'] } }, required: ['scale'], additionalProperties: false };
    const port = { ...unusedMcpToolInvocation, startServer, getServerTools: () => [{ name: 'screenshot', description: 'Native screenshot', inputSchema: schema }] };
    expect(await call(['mcp_tools'], port, 'mcp_tools', { serverName: 'one', toolName: 'screenshot' })).toEqual({ success: true, data: { serverName: 'one', tools: [{ name: 'screenshot', description: 'Native screenshot', inputSchema: schema }] } });
    expect(await call(['mcp_server_control'], port, 'mcp_server_control', { serverName: 'one', action: 'start' })).toMatchObject({ success: true, data: { status: 'running' } });
    expect(startServer).toHaveBeenCalledTimes(1);
    for (const toolName of ['mcp_tools', 'mcp_server_control']) expect(await call(['mcp_tool_call'], port, toolName, { serverName: 'one', action: 'start' })).toMatchObject({ success: false, error: expect.stringContaining('Unsupported tool') });
    expect(await call(['mcp_tools', 'mcp_server_control'], port, 'mcp_tool_call', { serverName: 'one', toolName: 'screenshot' })).toMatchObject({ success: false, error: expect.stringContaining('Unsupported tool') });
    expect(startServer).toHaveBeenCalledTimes(1);
  });
  it('fails stopped/missing selection and an oversized schema explicitly without truncating', async () => {
    const name = 'mcp_tools';
    const stopped = { ...unusedMcpToolInvocation, getServerTools: () => undefined };
    expect(await call([name], stopped, name, { serverName: 'one' })).toMatchObject({ success: false, error: expect.stringContaining('stopped') });
    const oversized = { ...unusedMcpToolInvocation, getServerTools: () => [{ name: 'huge', inputSchema: { type: 'object' as const, description: 'X'.repeat(1024 * 1024) } }] };
    expect(await call([name], oversized, name, { serverName: 'one', toolName: 'huge' })).toMatchObject({ success: false, error: expect.stringContaining('exceeds 1 MiB') });
    expect(await call([name], oversized, name, { serverName: 'one', toolName: 'missing' })).toMatchObject({ success: false, error: 'MCP tool not found.' });
  });
});
