/**
 * Tests for mcp_tool_call tool registration and handling in AgentAdapter.
 *
 * Covers:
 * 1. MCP_TOOL_CALL_TOOL_DEFINITION shape
 * 2. MCP_TOOL_CALL_TOOL_DEFINITIONS array
 * 3. buildToolsForRole correctness
 * 4. parseToolCallsFromResponse with mcp_tool_call
 * 5. processToolCall without McpManager
 * 6. processToolCall with mock McpManager (success and error cases)
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import type { AgentRole } from '../../src/agents/agent-adapter.js';
import {
  MCP_TOOL_CALL_TOOL_DEFINITION,
  MCP_TOOL_CALL_TOOL_DEFINITIONS,
  ALL_TOOL_DEFINITIONS,
} from '../../src/agents/skill-tools.js';
import type { ToolDefinition } from '../../src/agents/llm-client.js';
import {
  ServerNotRunningError,
  ToolNotFoundError,
  InvalidArgumentsError,
  TransportError,
  TimeoutError,
} from '../../src/mcp/mcp-manager.js';

// ── Helpers ───────────────────────────────────────────────────

/**
 * Build a minimal AgentAdapter for testing without requiring a real
 * saivage.json config file. We pass a complete-but-empty mock config.
 */
function createMinimalAdapter(tmpDir: string): AgentAdapter {
  const minimalConfig = {
    providers: {},
    models: { routes: [] },
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      compactionThreshold: 0.8,
      maxCompactions: 3,
      recoveryDelayMs: 60000,
      maxRecoveryRetries: 3,
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

/**
 * Helper to safely navigate ToolDefinition.parameters.
 */
function getParamProps(def: ToolDefinition): Record<string, unknown> {
  return def.function.parameters as Record<string, unknown>;
}

// ── Tests ─────────────────────────────────────────────────────

describe('AgentAdapter mcp_tool_call tool', () => {
  // ═══════════════ 1. MCP_TOOL_CALL_TOOL_DEFINITION shape ═══════════════

  describe('MCP_TOOL_CALL_TOOL_DEFINITION', () => {
    it('has type === "function"', () => {
      expect(MCP_TOOL_CALL_TOOL_DEFINITION.type).toBe('function');
    });

    it('has function.name === "mcp_tool_call"', () => {
      expect(MCP_TOOL_CALL_TOOL_DEFINITION.function.name).toBe('mcp_tool_call');
    });

    it('has function.parameters.required === ["serverName", "toolName"]', () => {
      const props = getParamProps(MCP_TOOL_CALL_TOOL_DEFINITION);
      expect(props.required).toEqual(['serverName', 'toolName']);
    });

    it('has function.parameters.properties.serverName.type === "string"', () => {
      const props = getParamProps(MCP_TOOL_CALL_TOOL_DEFINITION);
      const properties = props.properties as Record<string, Record<string, unknown>>;
      expect(properties.serverName.type).toBe('string');
    });

    it('has function.parameters.properties.toolName.type === "string"', () => {
      const props = getParamProps(MCP_TOOL_CALL_TOOL_DEFINITION);
      const properties = props.properties as Record<string, Record<string, unknown>>;
      expect(properties.toolName.type).toBe('string');
    });

    it('has function.parameters.properties.args.type === "object"', () => {
      const props = getParamProps(MCP_TOOL_CALL_TOOL_DEFINITION);
      const properties = props.properties as Record<string, Record<string, unknown>>;
      expect(properties.args.type).toBe('object');
    });

    it('has function.parameters.additionalProperties === false at top level', () => {
      const props = getParamProps(MCP_TOOL_CALL_TOOL_DEFINITION);
      expect(props.additionalProperties).toBe(false);
    });

    it('has function.parameters.type === "object"', () => {
      const props = getParamProps(MCP_TOOL_CALL_TOOL_DEFINITION);
      expect(props.type).toBe('object');
    });

    it('has a non-empty description', () => {
      expect(MCP_TOOL_CALL_TOOL_DEFINITION.function.description.length).toBeGreaterThan(10);
    });
  });

  // ═══════════════ 2. MCP_TOOL_CALL_TOOL_DEFINITIONS array ═══════════════

  describe('MCP_TOOL_CALL_TOOL_DEFINITIONS', () => {
    it('has length 1', () => {
      expect(MCP_TOOL_CALL_TOOL_DEFINITIONS).toHaveLength(1);
    });

    it('contains MCP_TOOL_CALL_TOOL_DEFINITION as its only element', () => {
      expect(MCP_TOOL_CALL_TOOL_DEFINITIONS[0]).toBe(MCP_TOOL_CALL_TOOL_DEFINITION);
    });
  });

  // ═══════════════ 3. buildToolsForRole ═══════════════

  describe('buildToolsForRole', () => {
    let tmpDir: string;
    let adapter: AgentAdapter;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'saivage-mcp-build-tools-test-'));
      mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
      adapter = createMinimalAdapter(tmpDir);
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function callBuildToolsForRole(role: AgentRole): ToolDefinition[] {
      // Access private method via bracket notation
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (adapter as any).buildToolsForRole(role);
    }

    it('returns 2 tools (load_skill + mcp_tool_call) for planner', () => {
      const tools = callBuildToolsForRole('planner');
      expect(tools).toHaveLength(2);
      expect(tools[0].function.name).toBe('load_skill');
      expect(tools[1].function.name).toBe('mcp_tool_call');
    });

    it('returns 2 tools (load_skill + mcp_tool_call) for executor', () => {
      const tools = callBuildToolsForRole('executor');
      expect(tools).toHaveLength(2);
      expect(tools[0].function.name).toBe('load_skill');
      expect(tools[1].function.name).toBe('mcp_tool_call');
    });

    it('returns 2 tools (load_skill + mcp_tool_call) for reviewer', () => {
      const tools = callBuildToolsForRole('reviewer');
      expect(tools).toHaveLength(2);
      expect(tools[0].function.name).toBe('load_skill');
      expect(tools[1].function.name).toBe('mcp_tool_call');
    });

    it('returns empty array for analyst', () => {
      const tools = callBuildToolsForRole('analyst');
      expect(tools).toEqual([]);
    });

    it('each tool has type "function" and function.name/function.parameters', () => {
      for (const role of ['planner', 'executor', 'reviewer'] as AgentRole[]) {
        const tools = callBuildToolsForRole(role);
        expect(tools).toHaveLength(2);
        for (const tool of tools) {
          expect(tool.type).toBe('function');
          expect(tool.function.name).toBeTruthy();
          expect(tool.function.parameters).toBeTruthy();
        }
      }
    });
  });

  // ═══════════════ 4. parseToolCallsFromResponse ═══════════════

  describe('parseToolCallsFromResponse', () => {
    let tmpDir: string;
    let adapter: AgentAdapter;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'saivage-mcp-parse-test-'));
      mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
      adapter = createMinimalAdapter(tmpDir);
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function callParseToolCalls(raw: string): Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }> | null {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (adapter as any).parseToolCallsFromResponse(raw);
    }

    it('parses mcp_tool_call tool calls from JSON', () => {
      const toolCallsPayload = JSON.stringify({
        toolCalls: [
          {
            id: 'call_mcp1',
            type: 'function',
            function: {
              name: 'mcp_tool_call',
              arguments: '{"serverName":"git","toolName":"commit","args":{"message":"test"}}',
            },
          },
        ],
      });

      const result = callParseToolCalls(toolCallsPayload);
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(1);
      expect(result![0].id).toBe('call_mcp1');
      expect(result![0].function.name).toBe('mcp_tool_call');
      expect(result![0].function.arguments).toBe(
        '{"serverName":"git","toolName":"commit","args":{"message":"test"}}',
      );
    });

    it('returns null for plain text response', () => {
      const result = callParseToolCalls('This is plain text.');
      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      const result = callParseToolCalls('{ invalid json }');
      expect(result).toBeNull();
    });

    it('returns null for JSON without toolCalls array', () => {
      const result = callParseToolCalls(JSON.stringify({ other: 'data' }));
      expect(result).toBeNull();
    });

    it('returns null for JSON with empty toolCalls array', () => {
      const result = callParseToolCalls(JSON.stringify({ toolCalls: [] }));
      expect(result).toBeNull();
    });

    it('handles multiple tool calls (load_skill + mcp_tool_call together)', () => {
      const toolCallsPayload = JSON.stringify({
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'load_skill', arguments: '{"name":"docs-guide"}' },
          },
          {
            id: 'call_2',
            type: 'function',
            function: {
              name: 'mcp_tool_call',
              arguments: '{"serverName":"git","toolName":"status"}',
            },
          },
        ],
      });

      const result = callParseToolCalls(toolCallsPayload);
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(2);
      expect(result![0].function.name).toBe('load_skill');
      expect(result![1].function.name).toBe('mcp_tool_call');
    });
  });

  // ═══════════════ 5. processToolCall WITHOUT McpManager ═══════════════

  describe('processToolCall without McpManager', () => {
    let tmpDir: string;
    let adapter: AgentAdapter;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'saivage-mcp-proc-no-mgr-'));
      mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
      adapter = createMinimalAdapter(tmpDir);
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    async function callProcessToolCall(
      tc: { id: string; type: string; function: { name: string; arguments: string } },
      role: AgentRole,
    ): Promise<{
      role: 'tool';
      kind: 'tool_result' | 'tool_error';
      content: string;
      tool: string;
    }> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (adapter as any).processToolCall(tc, role, 'test-session-id');
    }

    it('returns tool_error with "MCP manager not configured" when no McpManager set', async () => {
      const tc = {
        id: 'call_no_mgr',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '{"serverName":"git","toolName":"status","args":{}}',
        },
      };

      const result = await callProcessToolCall(tc, 'executor');
      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain('MCP manager not configured');
    });

    it('returns tool_error for missing serverName', async () => {
      const tc = {
        id: 'call_no_server',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '{"toolName":"status","args":{}}',
        },
      };

      const result = await callProcessToolCall(tc, 'executor');
      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain('"serverName"');
    });

    it('returns tool_error for missing toolName', async () => {
      const tc = {
        id: 'call_no_tool',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '{"serverName":"git","args":{}}',
        },
      };

      const result = await callProcessToolCall(tc, 'executor');
      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain('"toolName"');
    });

    it('returns tool_error for empty arguments string ("") ', async () => {
      const tc = {
        id: 'call_empty',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '',
        },
      };

      const result = await callProcessToolCall(tc, 'executor');
      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_error');
      // Empty string can't be parsed as JSON, so serverName/toolName will be empty
      expect(result.content).toContain('"serverName"');
      expect(result.content).toContain('"toolName"');
    });
  });

  // ═══════════════ 6. processToolCall WITH mock McpManager ═══════════════

  describe('processToolCall with mock McpManager', () => {
    let tmpDir: string;
    let adapter: AgentAdapter;
    let mockMcpManager: {
      invokeTool: jest.Mock<(serverName: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>>;
    };

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'saivage-mcp-proc-mock-'));
      mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
      adapter = createMinimalAdapter(tmpDir);

      mockMcpManager = {
        invokeTool: jest.fn<
          (serverName: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>
        >(),
      };

      adapter.setMcpManager(
        mockMcpManager as unknown as import('../../src/mcp/mcp-manager.js').McpManager,
      );
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    async function callProcessToolCall(
      tc: { id: string; type: string; function: { name: string; arguments: string } },
      role: AgentRole,
    ): Promise<{
      role: 'tool';
      kind: 'tool_result' | 'tool_error';
      content: string;
      tool: string;
    }> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (adapter as any).processToolCall(tc, role, 'test-session-id');
    }

    // ── Success case ─────────────────────────────────────────

    it('success: returns tool_result with MCP response content as JSON string', async () => {
      mockMcpManager.invokeTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'hello from mcp' }],
      });

      const tc = {
        id: 'call_success',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '{"serverName":"git","toolName":"status","args":{"path":"."}}',
        },
      };

      const result = await callProcessToolCall(tc, 'executor');

      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_result');
      expect(result.content).toContain('hello from mcp');
      expect(result.tool).toBe('mcp_tool_call:git/status');
      expect(mockMcpManager.invokeTool).toHaveBeenCalledWith('git', 'status', {
        path: '.',
      });
    });

    it('success: returns string result directly as content', async () => {
      mockMcpManager.invokeTool.mockResolvedValueOnce('plain string result');

      const tc = {
        id: 'call_string',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '{"serverName":"git","toolName":"log","args":{}}',
        },
      };

      const result = await callProcessToolCall(tc, 'executor');

      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_result');
      expect(result.content).toBe('plain string result');
      expect(result.tool).toBe('mcp_tool_call:git/log');
    });

    // ── ServerNotRunningError ─────────────────────────────────

    it('returns tool_error when mock throws ServerNotRunningError', async () => {
      mockMcpManager.invokeTool.mockRejectedValueOnce(
        new ServerNotRunningError('git'),
      );

      const tc = {
        id: 'call_snr',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '{"serverName":"git","toolName":"status","args":{}}',
        },
      };

      const result = await callProcessToolCall(tc, 'executor');

      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain('MCP tool call failed');
      expect(result.content).toContain('not running');
      expect(result.tool).toBe('mcp_tool_call:git/status');
    });

    // ── ToolNotFoundError ─────────────────────────────────────

    it('returns tool_error when mock throws ToolNotFoundError', async () => {
      mockMcpManager.invokeTool.mockRejectedValueOnce(
        new ToolNotFoundError('git', 'nonexistent'),
      );

      const tc = {
        id: 'call_tnf',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '{"serverName":"git","toolName":"nonexistent","args":{}}',
        },
      };

      const result = await callProcessToolCall(tc, 'executor');

      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain('MCP tool call failed');
      expect(result.content).toContain('not found');
      expect(result.tool).toBe('mcp_tool_call:git/nonexistent');
    });

    // ── InvalidArgumentsError ─────────────────────────────────

    it('returns tool_error when mock throws InvalidArgumentsError', async () => {
      mockMcpManager.invokeTool.mockRejectedValueOnce(
        new InvalidArgumentsError('git', 'commit', { detail: 'bad' }),
      );

      const tc = {
        id: 'call_ia',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '{"serverName":"git","toolName":"commit","args":{"msg":""}}',
        },
      };

      const result = await callProcessToolCall(tc, 'executor');

      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain('MCP tool call failed');
      expect(result.content).toContain('Invalid arguments');
      expect(result.tool).toBe('mcp_tool_call:git/commit');
    });

    // ── TransportError ────────────────────────────────────────

    it('returns tool_error when mock throws TransportError', async () => {
      mockMcpManager.invokeTool.mockRejectedValueOnce(
        new TransportError('git', 'connection refused'),
      );

      const tc = {
        id: 'call_te',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '{"serverName":"git","toolName":"status","args":{}}',
        },
      };

      const result = await callProcessToolCall(tc, 'executor');

      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain('MCP tool call failed');
      expect(result.content).toContain('Transport error');
      expect(result.tool).toBe('mcp_tool_call:git/status');
    });

    // ── TimeoutError ──────────────────────────────────────────

    it('returns tool_error when mock throws TimeoutError', async () => {
      mockMcpManager.invokeTool.mockRejectedValueOnce(
        new TimeoutError('git', 'status', 30000),
      );

      const tc = {
        id: 'call_to',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '{"serverName":"git","toolName":"status","args":{}}',
        },
      };

      const result = await callProcessToolCall(tc, 'executor');

      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain('MCP tool call failed');
      expect(result.content).toContain('timed out');
      expect(result.tool).toBe('mcp_tool_call:git/status');
    });

    // ── Content-supervisor-blocked error ──────────────────────

    it('returns tool_error when callMcpTool throws a content-supervisor-blocked error', async () => {
      // The callMcpTool method throws 'blocked by content supervisor' errors
      // when the ContentSupervisor.screenContent returns status='blocked'.
      // These come through as regular Error objects from callMcpTool's catch.
      mockMcpManager.invokeTool.mockRejectedValueOnce(
        new Error('MCP tool response blocked by content supervisor: inappropriate content detected'),
      );

      const tc = {
        id: 'call_cs_block',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '{"serverName":"git","toolName":"status","args":{}}',
        },
      };

      const result = await callProcessToolCall(tc, 'executor');

      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain('MCP tool call failed');
      expect(result.content).toContain('blocked by content supervisor');
      expect(result.tool).toBe('mcp_tool_call:git/status');
    });

    // ── Generic error ─────────────────────────────────────────

    it('returns tool_error when mock throws a generic Error', async () => {
      mockMcpManager.invokeTool.mockRejectedValueOnce(new Error('Something went wrong!'));

      const tc = {
        id: 'call_ge',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '{"serverName":"git","toolName":"status","args":{}}',
        },
      };

      const result = await callProcessToolCall(tc, 'executor');

      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain('MCP tool call failed');
      expect(result.content).toContain('Something went wrong');
      expect(result.tool).toBe('mcp_tool_call:git/status');
    });

    // ── Roles ─────────────────────────────────────────────────

    it('works for planner role with mock McpManager', async () => {
      mockMcpManager.invokeTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'planner result' }],
      });

      const tc = {
        id: 'call_planner',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '{"serverName":"db","toolName":"query","args":{"sql":"SELECT 1"}}',
        },
      };

      const result = await callProcessToolCall(tc, 'planner');

      expect(result.kind).toBe('tool_result');
      expect(result.content).toContain('planner result');
      expect(result.tool).toBe('mcp_tool_call:db/query');
    });

    it('works for reviewer role with mock McpManager', async () => {
      mockMcpManager.invokeTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'reviewer result' }],
      });

      const tc = {
        id: 'call_reviewer',
        type: 'function' as const,
        function: {
          name: 'mcp_tool_call',
          arguments: '{"serverName":"db","toolName":"query","args":{}}',
        },
      };

      const result = await callProcessToolCall(tc, 'reviewer');

      expect(result.kind).toBe('tool_result');
      expect(result.content).toContain('reviewer result');
      expect(result.tool).toBe('mcp_tool_call:db/query');
    });
  });

  // ═══════════════ 7. ALL_TOOL_DEFINITIONS ═══════════════

  describe('ALL_TOOL_DEFINITIONS', () => {
    it('contains both load_skill and mcp_tool_call', () => {
      expect(ALL_TOOL_DEFINITIONS).toHaveLength(2);
      expect(ALL_TOOL_DEFINITIONS[0].function.name).toBe('load_skill');
      expect(ALL_TOOL_DEFINITIONS[1].function.name).toBe('mcp_tool_call');
    });

    it('each entry has type "function"', () => {
      for (const def of ALL_TOOL_DEFINITIONS) {
        expect(def.type).toBe('function');
      }
    });
  });
});
