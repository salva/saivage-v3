import { describe, expect, it, jest } from '@jest/globals';

import type { McpToolInvocationPort } from '../../src/mcp/manager-api.js';
import type { NativeMcpResult } from '../../src/mcp/tool-api.js';
import {
  createMcpToolInvocationInstallation,
  McpToolInvocationAlreadyInstalledError,
  McpToolInvocationNotInstalledError,
} from '../../src/mcp/tool-invocation-installation.js';

function port(label: string): McpToolInvocationPort {
  return {
    registerServer: jest.fn((name: string) => ({ serverName: name, registered: true as const })),
    unregisterServer: jest.fn(async (name: string) => ({
      serverName: name,
      unregistered: true as const,
      status: 'stopped' as const,
    })),
    getStatus: jest.fn(() => []),
    getServerStatus: jest.fn(() => undefined),
    startServer: jest.fn(async (name: string) => ({ serverName: name, status: 'running' as const, toolCount: 1 })),
    stopServer: jest.fn(async (name: string) => ({ serverName: name, status: 'stopped' as const, toolCount: 0 })),
    restartServer: jest.fn(async (name: string) => ({ serverName: name, status: 'running' as const, toolCount: 0 })),
    getServerCatalog: jest.fn(() => ({ serverName: label, bindingId: '11111111-1111-4111-8111-111111111111', catalogId: '22222222-2222-4222-8222-222222222222', tools: [] })),
    refreshServerCatalog: jest.fn(async (name: string, bindingId: string) => ({ serverName: name, bindingId, catalogId: '22222222-2222-4222-8222-222222222222', toolCount: 0 })),
    findToolCapability: jest.fn(() => ({ serverName: label,
      bindingId: '11111111-1111-4111-8111-111111111111', catalogId: '22222222-2222-4222-8222-222222222222', name: label, description: label, inputSchema: { type: 'object' as const } })),
    invokeTool: jest.fn(async (): Promise<NativeMcpResult> => ({ content: [{ type: 'text', text: label }] })),
  };
}

describe('one-shot MCP tool invocation installation', () => {
  it('throws the exact typed invariant from every operation before installation', async () => {
    const installation = createMcpToolInvocationInstallation();
    for (const operation of [
      () => installation.port.getServerCatalog('server'),
      () => installation.port.refreshServerCatalog('server', '11111111-1111-4111-8111-111111111111'),
      () => installation.port.startServer('server'),
      () => installation.port.stopServer('server'),
      () => installation.port.restartServer('server'),
      () => installation.port.findToolCapability('server', 'tool'),
      () => installation.port.invokeTool('server', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'tool', {}),
      () => installation.port.getStatus(),
      () => installation.port.getServerStatus('server'),
      () => installation.port.registerServer('server', { transport: 'stdio', command: 'node' }),
      () => installation.port.unregisterServer('server'),
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
    expect(facade.getServerCatalog('server')).toMatchObject({ serverName: 'first', catalogId: '22222222-2222-4222-8222-222222222222' });
    await expect(facade.refreshServerCatalog('server', '11111111-1111-4111-8111-111111111111')).resolves.toMatchObject({ serverName: 'server', toolCount: 0 });
    expect(authority.refreshServerCatalog).toHaveBeenCalledWith('server', '11111111-1111-4111-8111-111111111111', undefined);
    expect(facade.findToolCapability('server', 'tool')).toEqual(expect.objectContaining({ serverName: 'first' }));
    const signal = new AbortController().signal;
    await expect(facade.restartServer('server', { signal })).resolves.toMatchObject({ status: 'running' });
    expect(authority.restartServer).toHaveBeenCalledWith('server', { signal });
    await expect(facade.invokeTool('server',
        '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'tool', { value: 1 }, { timeoutMs: 2, signal })).resolves.toEqual({ content: [{ type: 'text', text: 'first' }] });
    expect(authority.invokeTool).toHaveBeenCalledWith('server',
      '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'tool', { value: 1 }, { timeoutMs: 2, signal });
  });

  it.each(['same', 'different'] as const)('rejects a %s second authority and leaves the first installed', async (kind) => {
    const installation = createMcpToolInvocationInstallation();
    const first = port('first');
    installation.installer.install(first);
    expect(() => installation.installer.install(kind === 'same' ? first : port('second'))).toThrow(McpToolInvocationAlreadyInstalledError);
    await expect(installation.port.invokeTool('server', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'tool', {})).resolves.toEqual({ content: [{ type: 'text', text: 'first' }] });
  });
});
