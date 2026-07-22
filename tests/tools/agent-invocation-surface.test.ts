import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_AGENTS, DEFAULT_SAIVAGE_CONFIG } from '../../src/agents/default-workflow-config.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { buildAgentSurface } from '../../src/tools/agent-invocation-surface.js';
import { surfaceToolDefinitions } from '../../src/tools/invocation.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

const expected = {
  analyst: ['create_card', 'reorder_child', 'queue_notification', 'get_status', 'start_project', 'pause_runtime', 'resume_runtime', 'stop_project', 'restart_server', 'navigate_workspace', 'navigate_back', 'show_config', 'reconfigure', 'mcp_reconcile', 'read_runtime_events', 'read_runtime_errors', 'read_control_actions', 'list_processes_tool', 'list_agent_sessions', 'read_agent_session', 'cancel_card', 'delete_card', 'list_cards', 'get_card', 'get_tree', 'list_card_history', 'get_card_history_entry', 'diff_card', 'read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'websearch', 'webfetch', 'skill', 'mcp_tool_call'],
  planner: ['create_card', 'edit_card', 'cancel_card', 'activate_card', 'reorder_child', 'queue_notification', 'list_cards', 'get_card', 'get_tree', 'read', 'write', 'edit', 'glob', 'grep', 'list_card_history', 'get_card_history_entry', 'diff_card', 'websearch', 'webfetch'],
  reviewer: ['read', 'write', 'edit', 'glob', 'grep', 'list_card_history', 'get_card_history_entry', 'diff_card', 'websearch', 'webfetch', 'skill'],
  executor: ['read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'list_card_history', 'get_card_history_entry', 'diff_card', 'websearch', 'webfetch', 'skill', 'mcp_tool_call'],
} as const;

describe('named-agent inventories and composition', () => {
  it('compiles the exact default named inventory in declared order', () => {
    const workflows = compileProjectWorkflows(DEFAULT_SAIVAGE_CONFIG as never);
    expect([...workflows.agents.keys()]).toEqual(['analyst', 'planner', 'reviewer', 'executor']);
    for (const [name, tools] of Object.entries(expected)) {
      expect(DEFAULT_AGENTS[name as keyof typeof DEFAULT_AGENTS].tools).toEqual(tools);
      expect(workflows.agents.get(name as never)?.tools).toEqual(tools);
    }
  });

  it('compiles nine independent card-type workflow artifacts', () => {
    const workflows = compileProjectWorkflows(DEFAULT_SAIVAGE_CONFIG as never);
    expect([...workflows.cardTypes.keys()]).toEqual(['project', 'goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops']);
    expect(workflows.cardTypes.get('project')).not.toBe(workflows.cardTypes.get('goal'));
    expect(workflows.cardTypes.get('code')).not.toBe(workflows.cardTypes.get('test'));
  });

  it('composes Reviewer exactly and omits MCP when the named agent does not declare it', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-named-reviewer-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const surface = buildAgentSurface({
      agentName: 'reviewer',
      toolNames: expected.reviewer,
      projectRoot,
      store: new CardService(projectRoot),
      cardId: 'project',
    });
    expect([...surface.tools.keys()]).toEqual(expected.reviewer);
    expect(surfaceToolDefinitions(surface).map((tool) => tool.function.name)).toEqual(expected.reviewer);
    expect(surface.providers.map((provider) => provider.providerName)).toEqual(['card-history', 'workspace', 'web', 'skill']);
    expect(surface.tools.has('mcp_tool_call')).toBe(false);
  });

  it('grants configured MCP solely from the named tool declaration without an agent-name or annotation policy',()=>{
    const projectRoot=mkdtempSync(join(tmpdir(),'saivage-configured-mcp-'));roots.push(projectRoot);initProjectTree(projectRoot);
    const surface=buildAgentSurface({agentName:'reviewer',toolNames:['mcp_tool_call'],projectRoot,store:new CardService(projectRoot),mcpToolInvocation:{getServerTools:()=>[],findToolCapability:()=>null,invokeTool:()=>Promise.resolve({})}});
    expect([...surface.tools.keys()]).toEqual(['mcp_tool_call']);
    expect(surface.providers.map((provider)=>provider.providerName)).toEqual(['mcp']);
  });
});
