import { describe, expect, it, jest } from '@jest/globals';

import { MCP_OPERATOR_CALLER as caller, type McpCaller, type McpToolInvocationPort } from '../../src/mcp/manager-api.js';
import type { NativeMcpResult } from '../../src/mcp/tool-api.js';
import {
  createMcpToolInvocationInstallation,
  McpToolInvocationAlreadyInstalledError,
  McpToolInvocationNotInstalledError,
} from '../../src/mcp/tool-invocation-installation.js';

function port(label: string): McpToolInvocationPort {
  return {
    setServerScope: jest.fn<McpToolInvocationPort['setServerScope']>((_caller, name, policy) => ({ serverName: name, policy, updated: true as const })),
    registerServer: jest.fn((_caller: McpCaller, name: string) => ({ serverName: name, registered: true as const })),
    replaceServer: jest.fn((_caller: McpCaller, name: string) => ({ serverName: name, replaced: true as const, status: 'stopped' as const })),
    unregisterServer: jest.fn(async (_caller: McpCaller, name: string) => ({
      serverName: name,
      unregistered: true as const,
      status: 'stopped' as const,
    })),
    getStatus: jest.fn(() => []),
    getServerStatus: jest.fn(() => undefined),
    startServer: jest.fn(async (_caller: McpCaller, name: string) => ({ serverName: name, status: 'running' as const, toolCount: 1 })),
    stopServer: jest.fn(async (_caller: McpCaller, name: string) => ({ serverName: name, status: 'stopped' as const, toolCount: 0 })),
    restartServer: jest.fn(async (_caller: McpCaller, name: string) => ({ serverName: name, status: 'running' as const, toolCount: 0 })),
    getServerCatalog: jest.fn(() => ({ serverName: label, bindingId: '11111111-1111-4111-8111-111111111111', catalogId: '22222222-2222-4222-8222-222222222222', tools: [] })),
    refreshServerCatalog: jest.fn(async (_caller: McpCaller, name: string, bindingId: string) => ({ serverName: name, bindingId, catalogId: '22222222-2222-4222-8222-222222222222', toolCount: 0 })),
    invokeTool: jest.fn(async (): Promise<NativeMcpResult> => ({ content: [{ type: 'text', text: label }] })),
  };
}

describe('one-shot MCP tool invocation installation', () => {
  it('throws the exact typed invariant from every operation before installation', async () => {
    const installation = createMcpToolInvocationInstallation();
    for (const operation of [
      () => installation.port.getServerCatalog(caller, 'server'),
      () => installation.port.refreshServerCatalog(caller, 'server', '11111111-1111-4111-8111-111111111111'),
      () => installation.port.startServer(caller, 'server'),
      () => installation.port.stopServer(caller, 'server'),
      () => installation.port.restartServer(caller, 'server'),
      () => installation.port.setServerScope(caller, 'server', { controllerCardId: 'project', exposure: 'subtree' }),
      () => installation.port.invokeTool(caller, 'server', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'tool', {}),
      () => installation.port.getStatus(caller),
      () => installation.port.getServerStatus(caller, 'server'),
      () => installation.port.registerServer(caller, 'server', { transport: 'stdio', command: 'node' }),
      () => installation.port.replaceServer(caller, 'server', { transport: 'stdio', command: 'node' }),
      () => installation.port.unregisterServer(caller, 'server'),
    ]) {
      expect(operation).toThrow(McpToolInvocationNotInstalledError);
      expect(operation).toThrow('MCP tool invocation authority is not installed.');
    }
  });

  it('keeps one stable facade and delegates every operation after installation', async () => {
    const installation = createMcpToolInvocationInstallation();
    const authority = port('first');
    const facade = installation.port;
    installation.installer.install(authority);

    expect(installation.port).toBe(facade);
    const connection = { transport: 'stdio' as const, command: 'node' };
    expect(facade.replaceServer(caller, 'server', connection)).toEqual({ serverName: 'server', replaced: true, status: 'stopped' });
    expect(authority.replaceServer).toHaveBeenCalledWith(caller, 'server', connection);
    expect(facade.getServerCatalog(caller, 'server')).toMatchObject({ serverName: 'first', catalogId: '22222222-2222-4222-8222-222222222222' });
    await expect(facade.refreshServerCatalog(caller, 'server', '11111111-1111-4111-8111-111111111111')).resolves.toMatchObject({ serverName: 'server', toolCount: 0 });
    expect(authority.refreshServerCatalog).toHaveBeenCalledWith(caller, 'server', '11111111-1111-4111-8111-111111111111');
    const policy = { controllerCardId: 'project', exposure: 'card' as const };
    expect(facade.setServerScope(caller, 'server', policy)).toEqual({ serverName: 'server', policy, updated: true });
    expect(authority.setServerScope).toHaveBeenCalledWith(caller, 'server', policy);
    const signal = new AbortController().signal;
    await expect(facade.restartServer(caller, 'server', { signal })).resolves.toMatchObject({ status: 'running' });
    expect(authority.restartServer).toHaveBeenCalledWith(caller, 'server', { signal });
    await expect(facade.invokeTool(caller, 'server',
        '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'tool', { value: 1 }, { timeoutMs: 2, signal })).resolves.toEqual({ content: [{ type: 'text', text: 'first' }] });
    expect(authority.invokeTool).toHaveBeenCalledWith(caller, 'server',
      '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'tool', { value: 1 }, { timeoutMs: 2, signal });
  });

  it.each(['same', 'different'] as const)('rejects a %s second authority and leaves the first installed', async (kind) => {
    const installation = createMcpToolInvocationInstallation();
    const first = port('first');
    installation.installer.install(first);
    expect(() => installation.installer.install(kind === 'same' ? first : port('second'))).toThrow(McpToolInvocationAlreadyInstalledError);
    await expect(installation.port.invokeTool(caller, 'server', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'tool', {})).resolves.toEqual({ content: [{ type: 'text', text: 'first' }] });
  });
});
