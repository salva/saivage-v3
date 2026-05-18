import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import type { AgentRole } from '../../src/agents/agent-adapter.js';
import {
  LOAD_SKILL_TOOL_DEFINITION,
  LOAD_SKILL_TOOL_DEFINITIONS,
  loadSkill,
  LoadSkillError,
  PERMITTED_ROLES,
} from '../../src/agents/skill-tools.js';
import type { ToolDefinition } from '../../src/agents/llm-client.js';
import { SkillsEngine } from '../../src/agents/skills-engine.js';
import type { SkillIndexEntry, AgentRole as SchemaAgentRole } from '../../src/schemas/types.js';

function makeEntry(overrides: Partial<SkillIndexEntry> = {}): SkillIndexEntry {
  return {
    name: 'test-skill',
    file: 'test-skill.md',
    target_agents: ['executor'] as SchemaAgentRole[],
    triggers: [{ type: 'keyword', pattern: 'test' }],
    updated_at: '2025-01-15T10:00:00Z',
    ...overrides,
  };
}

function indexJson(entries: SkillIndexEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

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

function getParamProps(def: ToolDefinition): Record<string, unknown> {
  return def.function.parameters as Record<string, unknown>;
}

describe('AgentAdapter load_skill tool', () => {
  describe('LOAD_SKILL_TOOL_DEFINITION', () => {
    it('has type === "function"', () => {
      expect(LOAD_SKILL_TOOL_DEFINITION.type).toBe('function');
    });

    it('has function.name === "load_skill"', () => {
      expect(LOAD_SKILL_TOOL_DEFINITION.function.name).toBe('load_skill');
    });

    it('has function.parameters with required: ["name"]', () => {
      const props = getParamProps(LOAD_SKILL_TOOL_DEFINITION);
      expect(props.required).toEqual(['name']);
    });

    it('has function.parameters.properties.name.type === "string"', () => {
      const props = getParamProps(LOAD_SKILL_TOOL_DEFINITION);
      const properties = props.properties as Record<string, Record<string, unknown>>;
      expect(properties.name.type).toBe('string');
    });

    it('has function.parameters.additionalProperties === false', () => {
      const props = getParamProps(LOAD_SKILL_TOOL_DEFINITION);
      expect(props.additionalProperties).toBe(false);
    });

    it('has a non-empty description', () => {
      expect(LOAD_SKILL_TOOL_DEFINITION.function.description.length).toBeGreaterThan(10);
    });

    it('function.parameters.type is "object"', () => {
      const props = getParamProps(LOAD_SKILL_TOOL_DEFINITION);
      expect(props.type).toBe('object');
    });
  });

  describe('LOAD_SKILL_TOOL_DEFINITIONS', () => {
    it('is an array with one element', () => {
      expect(LOAD_SKILL_TOOL_DEFINITIONS).toHaveLength(1);
    });

    it('contains LOAD_SKILL_TOOL_DEFINITION as its only element', () => {
      expect(LOAD_SKILL_TOOL_DEFINITIONS[0]).toBe(LOAD_SKILL_TOOL_DEFINITION);
    });
  });

  describe('buildToolsForRole', () => {
    let tmpDir: string;
    let adapter: AgentAdapter;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'saivage-build-tools-test-'));
      mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
      adapter = createMinimalAdapter(tmpDir);
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function callBuildToolsForRole(role: AgentRole): ToolDefinition[] {
      return (adapter as any).buildToolsForRole(role);
    }

    it('returns authoritative §7 tools without load_skill for planner', () => {
      const tools = callBuildToolsForRole('planner');
      const names = tools.map((tool) => tool.function.name);
      expect(names).toContain('create_card');
      expect(names).toContain('activate_card');
      expect(names).not.toContain('load_skill');
    });

    it('returns tools including load_skill for executor', () => {
      const tools = callBuildToolsForRole('executor');
      expect(tools.length).toBeGreaterThanOrEqual(2);
      expect(tools[0].function.name).toBe('load_skill');
    });

    it('returns tools including load_skill for reviewer', () => {
      const tools = callBuildToolsForRole('reviewer');
      expect(tools.length).toBeGreaterThanOrEqual(2);
      expect(tools[0].function.name).toBe('load_skill');
    });

    it('returns first-class analyst history/notes/correction tools for analyst', () => {
      const toolNames = callBuildToolsForRole('analyst').map((tool) => tool.function.name);
      expect(toolNames).toEqual(expect.arrayContaining([
        'lets_dance',
        'mark_goal_needs_corrections',
        'mark_project_needs_corrections',
        'list_card_history',
        'get_card_history_entry',
        'diff_card',
        'list_notes',
        'get_note',
        'mark_note_handled',
      ]));
    });

    it('each tool in returned array has type "function"', () => {
      for (const role of ['planner', 'executor', 'reviewer', 'analyst'] as AgentRole[]) {
        const tools = callBuildToolsForRole(role);
        for (const tool of tools) {
          expect(tool.type).toBe('function');
        }
      }
    });

    it('each tool has function.name and function.parameters', () => {
      for (const role of ['planner', 'executor', 'reviewer', 'analyst'] as AgentRole[]) {
        const tools = callBuildToolsForRole(role);
        for (const tool of tools) {
          expect(tool.function.name).toBeTruthy();
          expect(tool.function.parameters).toBeTruthy();
        }
      }
    });
  });

  describe('parseToolCallsFromResponse', () => {
    let tmpDir: string;
    let adapter: AgentAdapter;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'saivage-parse-tools-test-'));
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
      return (adapter as any).parseToolCallsFromResponse(raw);
    }

    it('parses a valid tool_calls JSON payload correctly', () => {
      const toolCallsPayload = JSON.stringify({
        toolCalls: [
          {
            id: 'call_abc123',
            type: 'function',
            function: {
              name: 'load_skill',
              arguments: '{"name":"test-skill"}',
            },
          },
        ],
      });

      const result = callParseToolCalls(toolCallsPayload);
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(1);
      expect(result![0].id).toBe('call_abc123');
      expect(result![0].function.name).toBe('load_skill');
      expect(result![0].function.arguments).toBe('{"name":"test-skill"}');
    });

    it('returns null for a plain text response (no JSON)', () => {
      const result = callParseToolCalls('This is a plain text response.');
      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      const result = callParseToolCalls('{ not valid json }');
      expect(result).toBeNull();
    });

    it('returns null for JSON without toolCalls array', () => {
      const result = callParseToolCalls(JSON.stringify({ foo: 'bar' }));
      expect(result).toBeNull();
    });

    it('returns null for JSON with empty toolCalls array', () => {
      const result = callParseToolCalls(JSON.stringify({ toolCalls: [] }));
      expect(result).toBeNull();
    });

    it('returns null for non-object JSON (e.g. a number)', () => {
      const result = callParseToolCalls('42');
      expect(result).toBeNull();
    });

    it('returns null for null JSON', () => {
      const result = callParseToolCalls('null');
      expect(result).toBeNull();
    });

    it('handles multiple tool calls in a single payload', () => {
      const toolCallsPayload = JSON.stringify({
        toolCalls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'load_skill', arguments: '{"name":"alpha"}' },
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'load_skill', arguments: '{"name":"beta"}' },
          },
        ],
      });

      const result = callParseToolCalls(toolCallsPayload);
      expect(result).not.toBeNull();
      expect(result!).toHaveLength(2);
      expect(result![0].id).toBe('call_1');
      expect(result![1].id).toBe('call_2');
    });
  });

  describe('processToolCall', () => {
    let tmpDir: string;
    let adapter: AgentAdapter;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'saivage-process-tc-test-'));
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
      return (adapter as any).processToolCall(tc, role, 'test-session-id');
    }

    it('returns error when SkillsEngine is not configured', async () => {
      const tc = {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'load_skill', arguments: '{"name":"docs-guide"}' },
      };

      const result = await callProcessToolCall(tc, 'planner');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain("Unknown planner tool 'load_skill'");
    });

    it('returns error for unknown tool name', async () => {
      const tc = {
        id: 'call_2',
        type: 'function' as const,
        function: { name: 'unknown_fancy_tool', arguments: '{}' },
      };

      const result = await callProcessToolCall(tc, 'planner');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain('Unknown planner tool');
      expect(result.content).toContain('unknown_fancy_tool');
    });

    it('returns error for load_skill with invalid JSON args', async () => {
      const tc = {
        id: 'call_3',
        type: 'function' as const,
        function: { name: 'load_skill', arguments: 'not-json' },
      };

      const result = await callProcessToolCall(tc, 'planner');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain("Unknown planner tool 'load_skill'");
    });

    it('returns error for load_skill with empty arguments object', async () => {
      const tc = {
        id: 'call_4',
        type: 'function' as const,
        function: { name: 'load_skill', arguments: '{}' },
      };

      const result = await callProcessToolCall(tc, 'planner');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain("Unknown planner tool 'load_skill'");
    });
  });

  describe('loadSkill permission checks', () => {
    let tmpDir: string;
    let skillsDir: string;
    let engine: SkillsEngine;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'saivage-load-skill-perm-test-'));
      skillsDir = join(tmpDir, '.saivage', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      engine = new SkillsEngine({ projectRoot: tmpDir });

      const entry = makeEntry({ name: 'test-skill', file: 'test-skill.md' });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([entry]), 'utf-8');
      writeFileSync(join(skillsDir, 'test-skill.md'), '# Test', 'utf-8');
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('throws LoadSkillError for analyst role', async () => {
      try {
        await loadSkill('test-skill', 'analyst', engine);
        expect('should have thrown').toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(LoadSkillError);
        expect((err as LoadSkillError).message).toContain('not permitted');
      }
    });

    it('works for planner role', async () => {
      const result = await loadSkill('test-skill', 'planner', engine);
      expect(result.loaded).toBe(true);
      expect(result.skill_name).toBe('test-skill');
    });

    it('works for executor role', async () => {
      const result = await loadSkill('test-skill', 'executor', engine);
      expect(result.loaded).toBe(true);
      expect(result.skill_name).toBe('test-skill');
    });

    it('works for reviewer role', async () => {
      const result = await loadSkill('test-skill', 'reviewer', engine);
      expect(result.loaded).toBe(true);
      expect(result.skill_name).toBe('test-skill');
    });

    it('PERMITTED_ROLES contains only the three expected roles', () => {
      expect(PERMITTED_ROLES).toEqual(['planner', 'executor', 'reviewer']);
    });
  });

  describe('Integration: processToolCall + SkillsEngine', () => {
    let tmpDir: string;
    let skillsDir: string;
    let engine: SkillsEngine;
    let adapter: AgentAdapter;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'saivage-integration-test-'));
      skillsDir = join(tmpDir, '.saivage', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      engine = new SkillsEngine({ projectRoot: tmpDir });

      const entry = makeEntry({ name: 'docs-guide', file: 'docs-guide.md' });
      writeFileSync(join(skillsDir, 'index.json'), indexJson([entry]), 'utf-8');
      writeFileSync(join(skillsDir, 'docs-guide.md'), '# Docs Guide\n\nWrite good docs.', 'utf-8');

      adapter = createMinimalAdapter(tmpDir);
      adapter.setSkillsEngine(engine);
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function callBuildToolsForRole(role: AgentRole): ToolDefinition[] {
      return (adapter as any).buildToolsForRole(role);
    }

    function callParseToolCalls(raw: string): Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }> | null {
      return (adapter as any).parseToolCallsFromResponse(raw);
    }

    async function callProcessToolCall(
      tc: { id: string; type: string; function: { name: string; arguments: string } },
      role: AgentRole,
    ): Promise<{
      role: 'tool';
      kind: 'tool_result' | 'tool_error';
      content: string;
      tool: string;
    }> {
      return (adapter as any).processToolCall(tc, role, 'test-session-id');
    }

    it('builds authoritative tools for planner without load_skill', () => {
      const tools = callBuildToolsForRole('planner');
      const names = tools.map((tool) => tool.function.name);
      expect(names).toContain('create_card');
      expect(names).not.toContain('load_skill');
    });

    it('parses a tool_calls JSON for load_skill', () => {
      const payload = JSON.stringify({
        toolCalls: [
          {
            id: 'call_int_1',
            type: 'function',
            function: { name: 'load_skill', arguments: '{"name":"docs-guide"}' },
          },
        ],
      });

      const parsed = callParseToolCalls(payload);
      expect(parsed).not.toBeNull();
      expect(parsed![0].function.name).toBe('load_skill');
    });

    it('rejects planner load_skill because it is not in authoritative §7', async () => {
      const tc = {
        id: 'call_int_2',
        type: 'function' as const,
        function: { name: 'load_skill', arguments: '{"name":"docs-guide"}' },
      };

      const result = await callProcessToolCall(tc, 'planner');

      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain("Unknown planner tool 'load_skill'");
      expect(result.tool).toBe('load_skill');
    });

    it('returns tool_error for non-existent skill with real SkillsEngine', async () => {
      const tc = {
        id: 'call_int_3',
        type: 'function' as const,
        function: { name: 'load_skill', arguments: '{"name":"nonexistent-skill"}' },
      };

      const result = await callProcessToolCall(tc, 'planner');

      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain("Unknown planner tool 'load_skill'");
    });

    it('returns tool_error for analyst role with real SkillsEngine', async () => {
      const tc = {
        id: 'call_int_4',
        type: 'function' as const,
        function: { name: 'load_skill', arguments: '{"name":"docs-guide"}' },
      };

      const result = await callProcessToolCall(tc, 'analyst');

      expect(result.role).toBe('tool');
      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain('not permitted');
      expect(result.content).toContain('analyst');
    });

    it('rejects planner load_skill instead of returning delimited skill content', async () => {
      const tc = {
        id: 'call_int_5',
        type: 'function' as const,
        function: { name: 'load_skill', arguments: '{"name":"docs-guide"}' },
      };

      const result = await callProcessToolCall(tc, 'planner');

      expect(result.kind).toBe('tool_error');
      expect(result.content).toContain("Unknown planner tool 'load_skill'");
    });
  });
});
