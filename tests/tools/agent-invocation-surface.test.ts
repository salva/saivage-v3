import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { BoundAgentToolSet, buildRuntimeToolCatalog, resolveRuntimeTool } from '../../src/tools/runtime-tool-catalog.js';
import { cleanupInvocationSurface, surfaceToolDefinitions } from '../../src/tools/invocation.js';
import { cardInspectionToolBinders } from '../../src/tools/card-inspection-provider.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

const expected = {
  analyst: ['create_card', 'reorder_child', 'reopen_card', 'queue_notification', 'get_status', 'start_project', 'pause_runtime', 'resume_runtime', 'stop_project', 'restart_server', 'navigate_workspace', 'navigate_back', 'show_config', 'reconfigure', 'mcp_reconcile', 'read_runtime_events', 'read_runtime_errors', 'read_control_actions', 'list_processes_tool', 'list_agent_sessions', 'read_agent_session', 'cancel_card', 'delete_card', 'list_cards', 'get_card', 'get_tree', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'websearch', 'webfetch', 'skill', 'mcp_tool_call'],
  planner: ['create_card', 'edit_card', 'cancel_card', 'activate_card', 'reorder_child', 'queue_notification', 'list_cards', 'get_card', 'get_tree', 'read', 'write', 'edit', 'glob', 'grep', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'websearch', 'webfetch'],
  reviewer: ['read', 'write', 'edit', 'glob', 'grep', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'websearch', 'webfetch', 'skill'],
  executor: ['read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'websearch', 'webfetch', 'skill', 'mcp_tool_call'],
} as const;

describe('named-agent inventories and composition', () => {
  it('compiles the exact default named inventory in declared order', () => {
    const workflows = compileProjectWorkflows(DEFAULT_SAIVAGE_CONFIG as never);
    expect([...workflows.agents.keys()]).toEqual(['analyst', 'planner', 'reviewer', 'executor']);
    for (const [name, tools] of Object.entries(expected)) {
      expect(DEFAULT_SAIVAGE_CONFIG.agents[name as keyof typeof DEFAULT_SAIVAGE_CONFIG.agents]!.tools).toEqual(tools);
      expect(workflows.agents.get(name as never)?.tools.map((tool)=>tool.name)).toEqual(tools);
    }
  });

  it('compiles nine independent card-type workflow artifacts', () => {
    const workflows = compileProjectWorkflows(DEFAULT_SAIVAGE_CONFIG as never);
    expect([...workflows.cardTypes.keys()]).toEqual(['project', 'goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops']);
    expect(workflows.cardTypes.get('project')).not.toBe(workflows.cardTypes.get('goal'));
    expect(workflows.cardTypes.get('code')).not.toBe(workflows.cardTypes.get('test'));
  });

  it('keeps global/card same-name authority distinct and rejects duplicate scope/name catalog entries',()=>{
    expect(resolveRuntimeTool('global','reopen_card').name).toBe('reopen_card');
    expect(()=>resolveRuntimeTool('card','reopen_card')).toThrow("unknown tool 'reopen_card' for card session scope");
    const globalCancel=resolveRuntimeTool('global','cancel_card');
    const cardCancel=resolveRuntimeTool('card','cancel_card');
    expect(globalCancel.providerGroupId).not.toBe(cardCancel.providerGroupId);
    expect(globalCancel.description).not.toBe(cardCancel.description);
    const group=(key:string)=>({key,providerName:key,scope:'card' as const,binders:[cardInspectionToolBinders[0]!],context:()=>({store:{}})});
    expect(()=>buildRuntimeToolCatalog([group('one'),group('two')] as never)).toThrow("Duplicate runtime tool catalog entry 'card/list_cards'.");
    expect((buildRuntimeToolCatalog([group('one')] as never) as Map<string,unknown>).set).toBeUndefined();
  });

  it('aggregates provider-owned binders without synthetic or broad provider construction',()=>{
    const source=readFileSync(new URL('../../src/tools/runtime-tool-catalog.ts',import.meta.url),'utf8');
    expect(source).not.toMatch(/prototypeProvider|\binert\b|create[A-Za-z]+Provider/);
    expect(source).toContain('selected.map((entry) => entry.binder.bind(context))');
  });

  it('composes Reviewer exactly and omits MCP when the named agent does not declare it', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-named-reviewer-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const toolSet = new BoundAgentToolSet(expected.reviewer.map((name)=>resolveRuntimeTool('card',name)));
    const surface = toolSet.bind({
      scope:'card',
      agentName: 'reviewer',
      projectRoot,
      store: new CardService(projectRoot),
      cardId: 'project',
      sessionId:'agent:reviewer:project',parentControl:{} as never,childCreationTypes:new Set(),childActivationTypes:new Set(),cardTypeVocabulary:['project','goal','architecture','code','test','doc','data','research','ops'],notifyCard:()=>({ok:false,reason:'missing_card',cardId:'project'}),processRunner:{} as never,mcpToolInvocation:{} as never,
    });
    expect([...surface.tools.keys()]).toEqual(expected.reviewer);
    expect(surfaceToolDefinitions(surface).map((tool) => tool.function.name)).toEqual(expected.reviewer);
    expect(surface.providers.map((provider) => provider.providerName)).toEqual(['card-version', 'workspace', 'web', 'skill']);
    expect(surface.tools.has('mcp_tool_call')).toBe(false);
  });

  it('grants configured MCP solely from the named tool declaration without an agent-name or annotation policy',()=>{
    const projectRoot=mkdtempSync(join(tmpdir(),'saivage-configured-mcp-'));roots.push(projectRoot);initProjectTree(projectRoot);
    const surface=new BoundAgentToolSet([resolveRuntimeTool('card','mcp_tool_call')]).bind({scope:'card',agentName:'reviewer',projectRoot,store:new CardService(projectRoot),cardId:'project',sessionId:'agent:reviewer:project',parentControl:{} as never,childCreationTypes:new Set(),childActivationTypes:new Set(),cardTypeVocabulary:['project','goal','architecture','code','test','doc','data','research','ops'],notifyCard:()=>({ok:false,reason:'missing_card',cardId:'project'}),processRunner:{} as never,mcpToolInvocation:{getServerTools:()=>[],findToolCapability:()=>null,invokeTool:()=>Promise.resolve({})}});
    expect([...surface.tools.keys()]).toEqual(['mcp_tool_call']);
    expect(surface.providers.map((provider)=>provider.providerName)).toEqual(['mcp']);
  });

  it('binds only selected process definitions and cleans the shared selected group once',async()=>{
    const closeAndTerminateDirectScope=jest.fn(async()=>({failed:[]}));
    const toolSet=new BoundAgentToolSet(['wait_process','kill_process'].map((name)=>resolveRuntimeTool('card',name)));
    const surface=toolSet.bind({scope:'card',agentName:'executor',projectRoot:'/',store:{} as never,cardId:'project',sessionId:'agent:executor:project',parentControl:{} as never,childCreationTypes:new Set(),childActivationTypes:new Set(),cardTypeVocabulary:['project','goal','architecture','code','test','doc','data','research','ops'],notifyCard:()=>({ok:false,reason:'missing_card',cardId:'project'}),processRunner:{closeAndTerminateDirectScope} as never,processScope:{} as never,processOwnerId:'activation',mcpToolInvocation:{} as never});
    expect(surface.providers).toHaveLength(1);
    expect(surface.providers[0]!.tools.map((tool)=>tool.name)).toEqual(['wait_process','kill_process']);
    expect(surface.providers[0]!.cleanup).toEqual(expect.any(Function));
    await cleanupInvocationSurface(surface,{kind:'activation_settled',status:'done'});
    expect(closeAndTerminateDirectScope).toHaveBeenCalledTimes(1);
  });
});
