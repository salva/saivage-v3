import { describe, expect, it } from '@jest/globals';

import { AgentToolCatalog } from '../../src/agents/agent-tool-catalog.js';
import { AgentToolExecutor } from '../../src/agents/agent-tool-executor.js';
import { RoleToolPolicy } from '../../src/agents/role-tool-policy.js';

describe('AgentToolCatalog', () => {
  it('is the shared authority for role policy planner tool names', () => {
    expect(RoleToolPolicy.listToolNamesForRole('planner')).toEqual(AgentToolCatalog.roleToolNames('planner'));
    expect(AgentToolCatalog.isPlannerControlTool('activate_card')).toBe(true);
    expect(AgentToolCatalog.isPlannerTool('activate_card')).toBe(true);
    expect(AgentToolCatalog.definitionFor('mcp_tool_call')?.function.name).toBe('mcp_tool_call');
  });
});

describe('AgentToolExecutor', () => {
  function executor() {
    const toolRuntime = {
      schema: () => [],
      has: () => false,
      invoke: async () => ({ ok: false, error: new Error('unused') }),
    } as any;
    const plannerControlExecutor = { execute: async () => ({ role: 'tool', kind: 'tool_result', content: '{}', tool: 'activate_card', tool_call_id: 'tc-1' }) } as any;
    return new AgentToolExecutor({
      projectRoot: '/tmp/project',
      toolRuntime,
      plannerControlExecutor,
      getMcpManager: () => undefined,
      getSkillsEngine: () => undefined,
      getContentSupervisor: () => undefined,
    });
  }

  it('rejects unknown planner tools using the shared catalog', async () => {
    const result = await executor().processToolCall({ id: 'tc-unknown', type: 'function', function: { name: 'not_a_planner_tool', arguments: '{}' } }, 'planner', 'planner:goal', { goalId: 'goal' });

    expect(result.kind).toBe('tool_error');
    expect(result.content).toBe("Unknown planner tool 'not_a_planner_tool'.");
  });
});
