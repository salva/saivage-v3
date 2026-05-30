import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import type { AgentRole } from '../../src/agents/agent-adapter.js';
import type { ToolDefinition } from '../../src/agents/llm-contracts.js';
import type { McpToolInvocationPort } from '../../src/mcp/manager-api.js';
import {
  ServerNotRunningError,
  ToolNotFoundError,
  InvalidArgumentsError,
  TransportError,
  TimeoutError,
} from '../../src/mcp/protocol-api.js';

function createMinimalAdapter(tmpDir: string): AgentAdapter {
  const minimalConfig = {
    providers: {},
    models: { routes: [] },
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      compactionThreshold: 0.8,
      maxCompactions: 3,
      recoveryDelayMs: 60000,
      maxRecoveryRetries: 3, maxToolTurns: 16,
      selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 },
    },
    security: {},
    supervisor: {},
  } as unknown as import('../../src/agents/config-schema.js').SaivageConfig;

  return new AgentAdapter({
    projectRoot: tmpDir,
    saivageDir: join(tmpDir, '.saivage'),
    config: minimalConfig,
  });
}

describe('AgentAdapter role tool + MCP policy', () => {
  let tmpDir: string;
  let adapter: AgentAdapter;
  let mockMcpManager: {
    invokeTool: jest.Mock<(serverName: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>>;
    getServerTools: jest.Mock<(serverName: string) => Array<{ name: string; annotations?: Record<string, unknown> }> | undefined>;
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-mcp-tool-policy-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    adapter = createMinimalAdapter(tmpDir);
    mockMcpManager = {
      invokeTool: jest.fn(),
      getServerTools: jest.fn(),
    };
    adapter.setMcpManager(mockMcpManager as unknown as McpToolInvocationPort);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function callBuildToolsForRole(role: AgentRole): ToolDefinition[] {
    return (adapter as any).buildToolsForRole(role);
  }

  async function callProcessToolCall(
    tc: { id: string; type: string; function: { name: string; arguments: string } },
    role: AgentRole,
  ) {
    return (adapter as any).processToolCall(tc, role, 'test-session-id');
  }

  it('planner gets the authoritative §7 workspace tools and no MCP tool', () => {
    const tools = callBuildToolsForRole('planner').map((tool) => tool.function.name);
    expect(tools).toEqual(expect.arrayContaining(['list_project_files', 'read_project_file', 'write_project_file', 'start_and_wait', 'run_project_command', 'wait_for_process', 'kill_process']));
    expect(tools).not.toContain('load_skill');
    expect(tools).not.toContain('mcp_tool_call');
  });

  it('reviewer gets read-only workspace tools but not write/run tools', () => {
    const tools = callBuildToolsForRole('reviewer').map((tool) => tool.function.name);
    expect(tools).toEqual(expect.arrayContaining(['load_skill', 'list_project_files', 'read_project_file', 'mcp_tool_call']));
    expect(tools).not.toContain('write_project_file');
    expect(tools).not.toContain('run_project_command');
  });

  it('executor gets workspace mutation tools', () => {
    const tools = callBuildToolsForRole('executor').map((tool) => tool.function.name);
    expect(tools).toEqual(expect.arrayContaining([
      'load_skill',
      'list_project_files',
      'read_project_file',
      'write_project_file',
      'run_project_command',
      'mcp_tool_call',
    ]));
  });

  it('planner MCP call is rejected as a non-authoritative planner tool', async () => {
    mockMcpManager.getServerTools.mockReturnValue([{ name: 'mutate', annotations: { readOnlyHint: false, destructiveHint: true } }]);
    const tc = {
      id: 'call-planner-denied',
      type: 'function' as const,
      function: { name: 'mcp_tool_call', arguments: JSON.stringify({ serverName: 'svc', toolName: 'mutate', args: {} }) },
    };
    const result = await callProcessToolCall(tc, 'planner');
    expect(result.kind).toBe('tool_error');
    expect(result.content).toContain("Unknown planner tool 'mcp_tool_call'");
    expect(mockMcpManager.invokeTool).not.toHaveBeenCalled();
  });

  it('reviewer MCP call is denied when annotations are absent', async () => {
    mockMcpManager.getServerTools.mockReturnValue([{ name: 'unknown' }]);
    const tc = {
      id: 'call-reviewer-denied',
      type: 'function' as const,
      function: { name: 'mcp_tool_call', arguments: JSON.stringify({ serverName: 'svc', toolName: 'unknown', args: {} }) },
    };
    const result = await callProcessToolCall(tc, 'reviewer');
    expect(result.kind).toBe('tool_error');
    expect(result.content).toContain("Role 'reviewer' is not permitted");
    expect(mockMcpManager.invokeTool).not.toHaveBeenCalled();
  });

  it('planner MCP call is not allowed even for read-only annotated tools', async () => {
    mockMcpManager.getServerTools.mockReturnValue([{ name: 'query', annotations: { readOnlyHint: true, destructiveHint: false } }]);
    mockMcpManager.invokeTool.mockResolvedValueOnce({ ok: true });
    const tc = {
      id: 'call-planner-allowed',
      type: 'function' as const,
      function: { name: 'mcp_tool_call', arguments: JSON.stringify({ serverName: 'svc', toolName: 'query', args: { q: 1 } }) },
    };
    const result = await callProcessToolCall(tc, 'planner');
    expect(result.kind).toBe('tool_error');
    expect(result.content).toContain("Unknown planner tool 'mcp_tool_call'");
    expect(mockMcpManager.invokeTool).not.toHaveBeenCalled();
  });

  it('executor MCP call remains allowed', async () => {
    mockMcpManager.getServerTools.mockReturnValue([{ name: 'mutate', annotations: { destructiveHint: true } }]);
    mockMcpManager.invokeTool.mockResolvedValueOnce({ ok: true });
    const tc = {
      id: 'call-executor-allowed',
      type: 'function' as const,
      function: { name: 'mcp_tool_call', arguments: JSON.stringify({ serverName: 'svc', toolName: 'mutate', args: { q: 1 } }) },
    };
    const result = await callProcessToolCall(tc, 'executor');
    expect(result.kind).toBe('tool_result');
    expect(mockMcpManager.invokeTool).toHaveBeenCalledWith('svc', 'mutate', { q: 1 });
  });

  it('typed MCP errors still surface as tool_error content', async () => {
    mockMcpManager.getServerTools.mockReturnValue([{ name: 'query', annotations: { readOnlyHint: true, destructiveHint: false } }]);
    mockMcpManager.invokeTool.mockRejectedValueOnce(new InvalidArgumentsError('svc', 'query', { bad: true }));
    const tc = {
      id: 'call-invalid-args',
      type: 'function' as const,
      function: { name: 'mcp_tool_call', arguments: JSON.stringify({ serverName: 'svc', toolName: 'query', args: {} }) },
    };
    const result = await callProcessToolCall(tc, 'planner');
    expect(result.kind).toBe('tool_error');
    expect(result.content).toContain("Unknown planner tool 'mcp_tool_call'");
  });

  it('other typed MCP failures still surface as tool_error content', async () => {
    mockMcpManager.getServerTools.mockReturnValue([{ name: 'query', annotations: { readOnlyHint: true, destructiveHint: false } }]);
    mockMcpManager.invokeTool.mockRejectedValueOnce(new ServerNotRunningError('svc'));
    const tc = {
      id: 'call-server-error',
      type: 'function' as const,
      function: { name: 'mcp_tool_call', arguments: JSON.stringify({ serverName: 'svc', toolName: 'query', args: {} }) },
    };
    const result = await callProcessToolCall(tc, 'planner');
    expect(result.kind).toBe('tool_error');
    expect(result.content).toContain("Unknown planner tool 'mcp_tool_call'");
  });

  it('preserves coverage for other typed MCP errors', async () => {
    mockMcpManager.getServerTools.mockReturnValue([{ name: 'query', annotations: { readOnlyHint: true, destructiveHint: false } }]);
    const errors = [
      new ToolNotFoundError('svc', 'query'),
      new TransportError('svc', 'connection refused'),
      new TimeoutError('svc', 'query', 30000),
    ];
    for (const error of errors) {
      mockMcpManager.invokeTool.mockRejectedValueOnce(error);
      const result = await callProcessToolCall({
        id: `call-${error.name}`,
        type: 'function',
        function: { name: 'mcp_tool_call', arguments: JSON.stringify({ serverName: 'svc', toolName: 'query', args: {} }) },
      }, 'planner');
      expect(result.kind).toBe('tool_error');
    }
  });
});
