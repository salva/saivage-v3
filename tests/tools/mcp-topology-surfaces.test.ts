import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BoundAgentToolSet, resolveRuntimeTool } from '../../src/tools/runtime-tool-catalog.js';
import { invokeToolForLlm } from '../../src/tools/invocation.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { projectMcpRegistrationForOutbound } from '../../src/tools/mcp-invocation-outbound.js';
import {
  testLlmToolInvocationContext,
  unusedMcpToolInvocation,
} from '../helpers/llm-test-helpers.js';
import type { McpToolInvocationPort } from '../../src/mcp/manager-api.js';
import {
  PublicationOutcomeUnknownError,
  McpServerRegisterArgumentsSchema,
  McpToolCallArgumentsSchema,
} from '../../src/contracts/index.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { WorkspaceFileReadModelService } from '../../src/application/read-models/workspace-file-read-model.js';

const bindingId = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function invoke(
  names: string[],
  port: McpToolInvocationPort,
  toolName: string,
  args: unknown,
) {
  const surface = new BoundAgentToolSet(names.map((name) => resolveRuntimeTool('card', name))).bind(
    { scope: 'card', agentName: 'reviewer', projectRoot: '/', mcpToolInvocation: port } as never,
  );
  const settlement = await invokeToolForLlm(
    surface,
    toolName,
    args,
    testLlmToolInvocationContext({ sessionId: 'agent:reviewer:project', toolName }),
  );
  return settleToolActionOutcome(
    settlement.kind === 'executed'
      ? settlement.execution.providerOutcome
      : settlement.providerOutcome,
  ).providerResult;
}

describe('dynamic MCP ordinary surfaces', () => {
  it('compiles independent management selections for custom card participants without default or Oversight grants', () => {
    const tools = ['mcp_server_register', 'mcp_server_unregister', 'mcp_servers'];
    for (const name of ['planner', 'executor', 'reviewer']) {
      const config = structuredClone(DEFAULT_SAIVAGE_CONFIG);
      config.agents[name]!.tools.push(...tools);
      expect(
        compileProjectWorkflows(config as never)
          .agents.get(name)!
          .tools.map((t) => t.name),
      ).toEqual(expect.arrayContaining(tools));
    }
    for (const tool of tools) {
      const config = structuredClone(DEFAULT_SAIVAGE_CONFIG);
      config.agents.oversight!.tools.push(tool);
      expect(() => compileProjectWorkflows(config as never)).toThrow(
        `oversight.agent tool '${tool}' is forbidden`,
      );
      expect(Object.values(DEFAULT_SAIVAGE_CONFIG.agents).some((a) => a.tools.includes(tool))).toBe(
        false,
      );
    }
  });

  it('registration publishes only its own fact and each permission remains separate', async () => {
    const registerServer = jest.fn((serverName: string) => ({
      serverName,
      registered: true as const,
    }));
    const unregisterServer = jest.fn(async (serverName: string) => ({
      serverName,
      unregistered: true as const,
      status: 'stopped' as const,
    }));
    const port = { ...unusedMcpToolInvocation, registerServer, unregisterServer };
    const args = {
      serverName: 'one',
      connection: { transport: 'stdio', command: 'node', env: { CUSTOM: 'opaque-env-secret' } },
    };
    expect(await invoke(['mcp_server_register'], port, 'mcp_server_register', args)).toEqual({
      success: true,
      data: { serverName: 'one', registered: true },
    });
    expect(
      await invoke(['mcp_server_unregister'], port, 'mcp_server_unregister', { serverName: 'one' }),
    ).toMatchObject({ success: true, data: { unregistered: true, status: 'stopped' } });
    for (const selected of ['mcp_tool_call', 'mcp_tools', 'mcp_servers']) {
      expect(await invoke([selected], port, 'mcp_server_register', args)).toMatchObject({
        success: false,
        error: expect.stringContaining('Unsupported tool'),
      });
    }
    expect(registerServer).toHaveBeenCalledTimes(1);
    expect(unregisterServer).toHaveBeenCalledTimes(1);
    expect(
      await invoke(['mcp_server_register'], port, 'mcp_tool_call', {
        serverName: 'one',
        bindingId,
        toolName: 'ping',
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining('Unsupported tool') });
    for (const selected of ['mcp_tools', 'mcp_servers']) {
      expect(
        await invoke([selected], port, 'mcp_tool_call', {
          serverName: 'one',
          bindingId,
          toolName: 'ping',
          args: {},
        }),
      ).toMatchObject({ success: false, error: expect.stringContaining('Unsupported tool') });
    }
    expect(
      await invoke(['mcp_tool_call'], port, 'mcp_server_control', {
        serverName: 'one',
        action: 'start',
      }),
    ).toMatchObject({ success: false, error: expect.stringContaining('Unsupported tool') });
  });

  it('does not convert publication uncertainty into a result or subsequent observation', async () => {
    const error = new PublicationOutcomeUnknownError(new Error('private publication cause'));
    const getStatus = jest.fn(() => []);
    const port = {
      ...unusedMcpToolInvocation,
      getStatus,
      registerServer: () => {
        throw error;
      },
      unregisterServer: async () => {
        throw error;
      },
    };
    await expect(
      invoke(['mcp_server_register'], port, 'mcp_server_register', {
        serverName: 'one',
        connection: { transport: 'stdio', command: 'node' },
      }),
    ).rejects.toBe(error);
    await expect(
      invoke(['mcp_server_unregister'], port, 'mcp_server_unregister', { serverName: 'one' }),
    ).rejects.toBe(error);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('observes starting and removed retained owners without exposing runtime diagnostics or connection secrets', async () => {
    const getStatus = () => [
      {
        name: 'one',
        transport: 'stdio' as const,
        status: 'starting' as const,
        definitionSource: 'agent' as const,
        bindingId,
        containmentFailed: false,
        processId: 'launch-1',
        error: 'opaque-private-error',
      },
      {
        name: 'old',
        transport: 'streamable-http' as const,
        status: 'error' as const,
        definitionSource: null,
        bindingId,
        containmentFailed: true,
        processId: null,
      },
    ];
    const port = {
      ...unusedMcpToolInvocation,
      getStatus,
      getServerStatus: (name: string) => getStatus().find((s) => s.name === name),
    };
    const result = await invoke(['mcp_servers'], port, 'mcp_servers', {});
    expect(result).toMatchObject({
      success: true,
      data: {
        servers: [
          { name: 'one', status: 'starting', processId: 'launch-1' },
          { name: 'old', definitionSource: null, containmentFailed: true },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('opaque-private-error');
    expect(await invoke(['mcp_servers'], port, 'mcp_servers', { serverName: 'old' })).toMatchObject(
      { success: true, data: { servers: [{ name: 'old' }] } },
    );
  });

  it('suppresses arbitrary env values even in rejected registration input and redacts URL/command text', () => {
    for (const env of [
      { CUSTOM: 'opaque-env-secret', OBJECT: { value: 'opaque-env-secret' } },
      'opaque-env-secret',
    ]) {
      const result = projectMcpRegistrationForOutbound({
        serverName: 'one',
        connection: {
          transport: 'stdio',
          command: 'node token=command-secret',
          args: ['token=arg-secret'],
          env,
          extra: true,
        },
      });
      const text = JSON.stringify(result);
      for (const secret of ['opaque-env-secret', 'command-secret', 'arg-secret'])
        expect(text).not.toContain(secret);
    }
    expect(
      JSON.stringify(
        projectMcpRegistrationForOutbound({
          connection: {
            transport: 'streamable-http',
            url: 'https://user:password@host.invalid/mcp?token=query-secret',
          },
        }),
      ),
    ).not.toMatch(/password|query-secret/);
    expect(
      McpServerRegisterArgumentsSchema.safeParse({
        serverName: 'one',
        connection: { transport: 'stdio', command: 'node', autostart: true },
      }).success,
    ).toBe(false);
    expect(
      McpToolCallArgumentsSchema.safeParse({ serverName: 'one', toolName: 'ping' }).success,
    ).toBe(false);
  });

  it('fails oversized server observations and refuses altered discovery schemas rather than advertising them', async () => {
    const status = {
      name: 'one',
      transport: 'stdio' as const,
      status: 'running' as const,
      definitionSource: 'agent' as const,
      bindingId,
      containmentFailed: false,
      processId: null,
    };
    const port = {
      ...unusedMcpToolInvocation,
      getStatus: () => [{ ...status, name: 'X'.repeat(1024 * 1024) }],
      getServerStatus: () => status,
      getServerTools: () => [
        {
          name: 'ping',
          inputSchema: {
            type: 'object' as const,
            properties: { apiKey: { const: 'token=opaque-schema-secret' } },
          },
        },
      ],
    };
    expect(await invoke(['mcp_servers'], port, 'mcp_servers', {})).toMatchObject({
      success: false,
      error: expect.stringContaining('exact serverName'),
    });
    const discovery = await invoke(['mcp_tools'], port, 'mcp_tools', { serverName: 'one' });
    expect(discovery).toMatchObject({
      success: false,
      error: expect.stringContaining('without alteration'),
    });
    expect(JSON.stringify(discovery)).not.toContain('opaque-schema-secret');
  });

  it('refuses exact definition Files reads and resolved aliases before parsing malformed secret bytes', async () => {
    const root = mkdtempSync('/home/salva/g/ml/tmp/mcp-files-surface-');
    roots.push(root);
    mkdirSync(join(root, '.saivage', 'config'), { recursive: true });
    writeFileSync(
      join(root, '.saivage', 'config', 'mcp-servers.json'),
      'invalid opaque-env-secret',
    );
    symlinkSync(join(root, '.saivage', 'config', 'mcp-servers.json'), join(root, 'alias.json'));
    const files = new WorkspaceFileReadModelService(
      root,
      () => {
        throw new Error('Unexpected records');
      },
      {} as never,
    );
    for (const path of ['.saivage/config/mcp-servers.json', 'alias.json']) {
      const result = await files.readFileContent(path);
      expect(result.statusCode).toBe(403);
      expect(JSON.stringify(result)).not.toContain('opaque-env-secret');
    }
  });
});
