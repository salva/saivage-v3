import { describe, expect, it, jest } from '@jest/globals';

import type { McpToolInvocationPort } from '../../src/mcp/manager-api.js';
import {
  createMcpToolInvocationInstallation,
  McpToolInvocationAlreadyInstalledError,
  McpToolInvocationNotInstalledError,
} from '../../src/mcp/tool-invocation-installation.js';

function port(label: string): McpToolInvocationPort {
  return {
    getServerTools: jest.fn(() => [{ name: label, description: label, inputSchema: { type: 'object' as const } }]),
    findToolCapability: jest.fn(() => ({ serverName: label, name: label, description: label, inputSchema: { type: 'object' as const } })),
    invokeTool: jest.fn(async () => label),
  };
}

describe('one-shot MCP tool invocation installation', () => {
  it('throws the exact typed invariant from every operation before installation', async () => {
    const installation = createMcpToolInvocationInstallation();
    for (const operation of [
      () => installation.port.getServerTools('server'),
      () => installation.port.findToolCapability('server', 'tool'),
      () => installation.port.invokeTool('server', 'tool', {}),
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
    expect(facade.getServerTools('server')).toEqual([expect.objectContaining({ name: 'first' })]);
    expect(facade.findToolCapability('server', 'tool')).toEqual(expect.objectContaining({ serverName: 'first' }));
    await expect(facade.invokeTool('server', 'tool', { value: 1 }, { timeoutMs: 2 })).resolves.toBe('first');
    expect(authority.invokeTool).toHaveBeenCalledWith('server', 'tool', { value: 1 }, { timeoutMs: 2 });
  });

  it.each(['same', 'different'] as const)('rejects a %s second authority and leaves the first installed', async (kind) => {
    const installation = createMcpToolInvocationInstallation();
    const first = port('first');
    installation.installer.install(first);
    expect(() => installation.installer.install(kind === 'same' ? first : port('second'))).toThrow(McpToolInvocationAlreadyInstalledError);
    await expect(installation.port.invokeTool('server', 'tool', {})).resolves.toBe('first');
  });
});
