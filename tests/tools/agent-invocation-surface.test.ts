import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SAIVAGE_CONFIG, SYSTEM_TEMPLATES } from '../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/index.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { BoundAgentToolSet, buildRuntimeToolCatalog, resolveRuntimeTool } from '../../src/tools/runtime-tool-catalog.js';
import { cleanupInvocationSurface, executeToolAction, invokeToolForLlm, surfaceToolDefinitions, syntheticToolSettlement } from '../../src/tools/invocation.js';
import { testLlmToolInvocationContext, unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { cardInspectionToolBinders } from '../../src/tools/card-inspection-provider.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import type { PlannerChildControlPort } from '../../src/runtime/actors/card-activation-owner.js';
import { submitNotificationTool } from '../../src/tools/notification-tool.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });
const unusedParentControl: PlannerChildControlPort = {
  activateChild() { throw new Error('unused parent control'); },
  cancelChild() { throw new Error('unused parent control'); },
  reopenChild() { throw new Error('unused parent control'); },
};

const expected = {
  analyst: ['create_card', 'reorder_child', 'reopen_card', 'queue_notification', 'get_status', 'start_project', 'pause_runtime', 'resume_runtime', 'stop_project', 'restart_server', 'navigate_workspace', 'navigate_back', 'show_config', 'reconfigure', 'read_runtime_events', 'read_runtime_errors', 'read_control_actions', 'list_processes_tool', 'list_agent_sessions', 'read_agent_session', 'cancel_card', 'delete_card', 'list_cards', 'get_card', 'get_tree', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'read', 'view_image', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'websearch', 'webfetch', 'skill', 'mcp_tool_call', 'mcp_server_control', 'mcp_tools'],
  oversight: ['get_status', 'list_cards', 'get_card', 'get_tree', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'read', 'glob', 'grep', 'read_runtime_events', 'read_runtime_errors', 'list_processes_tool', 'list_agent_sessions', 'read_agent_session', 'queue_notification'],
  planner: ['create_card', 'edit_card', 'cancel_card', 'activate_card', 'reopen_card', 'reorder_child', 'queue_notification', 'list_cards', 'get_card', 'get_tree', 'read', 'write', 'edit', 'glob', 'grep', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'websearch', 'webfetch'],
  reviewer: ['read', 'view_image', 'write', 'edit', 'glob', 'grep', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'websearch', 'webfetch', 'skill'],
  executor: ['read', 'view_image', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'list_card_versions', 'get_card_version', 'diff_card_versions', 'read_record_version', 'websearch', 'webfetch', 'skill', 'mcp_tool_call', 'mcp_server_control', 'mcp_tools'],
} as const;

describe('named-agent inventories and composition', () => {
  it.each(SYSTEM_TEMPLATES)('compiles the exact $name named inventory in declared order without MCP reconcile', (template) => {
    const config = effectiveSaivageConfigSchema.parse(structuredClone(template.config));
    const workflows = compileProjectWorkflows(config as never, { defaultPromptRoot: template.promptRoot });
    expect([...workflows.agents.keys()]).toEqual(['analyst', 'oversight', 'planner', 'reviewer', 'executor']);
    for (const [name, tools] of Object.entries(expected)) {
      expect(config.agents[name]!.tools).toEqual(tools);
      expect(workflows.agents.get(name as never)?.tools.map((tool)=>tool.name)).toEqual(tools);
      expect(new Set(tools).size).toBe(tools.length);
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
    const plannerReopen=resolveRuntimeTool('card','reopen_card');
    expect(plannerReopen.name).toBe('reopen_card');
    expect(plannerReopen.providerGroupId).not.toBe(resolveRuntimeTool('global','reopen_card').providerGroupId);
    const globalCancel=resolveRuntimeTool('global','cancel_card');
    const cardCancel=resolveRuntimeTool('card','cancel_card');
    expect(globalCancel.providerGroupId).not.toBe(cardCancel.providerGroupId);
    expect(globalCancel.description).not.toBe(cardCancel.description);
    const inspectionStore={
      listCardInspectionRows:()=>[],
      readCardInspectionTree:()=>{throw new Error('unused store stub');},
      getCardDetail:()=>{throw new Error('unused store stub');},
      getCardChildren:()=>{throw new Error('unused store stub');},
      listDeclaredRecordMetadata:()=>{throw new Error('unused store stub');},
    };
    const group=(key:string)=>({key,providerName:key,scope:'card' as const,binders:[cardInspectionToolBinders[0]!],context:()=>({store:inspectionStore})});
    expect(()=>buildRuntimeToolCatalog([group('one'),group('two')] as never)).toThrow("Duplicate runtime tool catalog entry 'card/list_cards'.");
    expect((buildRuntimeToolCatalog([group('one')] as never) as Map<string,unknown>).set).toBeUndefined();
  });

  it('binds Planner reopen only when explicitly selected, independently of the configured agent name', () => {
    const reopenChild=jest.fn(({childCardId}:{childCardId:string})=>({card_id:childCardId,status:'changed' as const}));
    const runtime={scope:'card' as const,agentName:'project-planner' as never,projectRoot:'/',store:{} as never,cardId:'project',sessionId:'agent:project-planner:project',parentControl:{...unusedParentControl,reopenChild},childCreationTypes:new Set<string>(),childActivationTypes:new Set<string>(),cardTypeVocabulary:['project','goal','architecture','code','test','doc','data','research','ops'] as const,notifyCard:()=>({ok:false as const,reason:'missing_card' as const,cardId:'project'}),submitNotification:async()=>({queued:false as const,reason:'missing_card' as const,cardId:'project'}),processRunner:{} as never,mcpToolInvocation:{} as never};
    const selected=new BoundAgentToolSet([resolveRuntimeTool('card','reopen_card')]).bind(runtime);
    expect([...selected.tools.keys()]).toEqual(['reopen_card']);
    expect(selected.providers.map(({providerName})=>providerName)).toEqual(['planner-control']);
    const omitted=new BoundAgentToolSet([]).bind(runtime);
    expect(omitted.tools.has('reopen_card')).toBe(false);
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
      sessionId:'agent:reviewer:project',parentControl:unusedParentControl,childCreationTypes:new Set(),childActivationTypes:new Set(),cardTypeVocabulary:['project','goal','architecture','code','test','doc','data','research','ops'],notifyCard:()=>({ok:false,reason:'missing_card',cardId:'project'}),submitNotification:async()=>({queued:false as const,reason:'missing_card' as const,cardId:'project'}),processRunner:{} as never,mcpToolInvocation:{} as never,
    });
    expect([...surface.tools.keys()]).toEqual(expected.reviewer);
    expect(surfaceToolDefinitions(surface).map((tool) => tool.function.name)).toEqual(expected.reviewer);
    expect(surface.providers.map((provider) => provider.providerName)).toEqual(['card-version', 'workspace', 'web', 'skill']);
    expect(surface.tools.has('mcp_tool_call')).toBe(false);
  });

  it('binds Oversight notification execution from its explicit narrow authority', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-oversight-surface-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const store = new CardService(projectRoot);
    const processRunner = { list: () => [] } as never;
    const submitNotification=jest.fn(async(_cardId:string,notification:{id:string})=>({queued:true as const,cardId:'project',notificationId:notification.id,interruption:{status:'not_requested' as const}}));
    const observationToolContext = {
      agentName: 'oversight',
      projectRoot,
      store,
      processRunner,
      eventQueries: {} as never,
      runtime: { getStatus: () => ({ status: 'stopped' as const, currentCardId: null, pid: 1, startedAt: '2026-09-14T00:00:00.000Z' }) },
      queueNotification: (input:Parameters<typeof submitNotificationTool>[0],signal:AbortSignal) => executeToolAction('none',()=>submitNotificationTool(input,submitNotification,signal)),
      captureExecutingLlmSnapshots: () => new Map(),
      currentProcessPosition: () => null,
    };
    const surface = new BoundAgentToolSet(expected.oversight.map((name) => resolveRuntimeTool('global', name))).bind({
      scope: 'global', agentName: 'oversight', projectRoot, store, processRunner,
      mcpToolInvocation: {} as never, observationToolContext,
      cardTypeVocabulary: ['project','goal','architecture','code','test','doc','data','research','ops'],
    });
    expect([...surface.tools.keys()]).toEqual(expected.oversight);
    expect(surface.providers.map(({ providerName }) => providerName)).toEqual([
      'observation', 'workspace', 'card-inspection', 'card-version',
    ]);
    for (const forbidden of ['write','edit','apply_patch','run_command','kill_process','mcp_tool_call','mcp_server_control','mcp_tools','skill','webfetch'])
      expect(surface.tools.has(forbidden)).toBe(false);
    const notification=surface.tools.get('queue_notification');if(!notification)throw new Error('missing queue_notification');
    const result=await notification.executor({card_id:'project',kind:'finding',body:'evidence',urgency:'normal'},new AbortController().signal);
    expect(result.providerOutcome).toEqual({kind:'succeeded',data:{queued:true,card_id:'project',notification_id:submitNotification.mock.calls[0]![1].id,body:'evidence',interruption:{status:'not_requested'}}});
    expect(submitNotification).toHaveBeenCalledTimes(1);
  });

  it('grants functional configured MCP and treats the removed name as ordinary unsupported input',async()=>{
    const projectRoot=mkdtempSync(join(tmpdir(),'saivage-configured-mcp-'));roots.push(projectRoot);initProjectTree(projectRoot);
    const surface=new BoundAgentToolSet([resolveRuntimeTool('card','mcp_tool_call')]).bind({scope:'card',agentName:'reviewer',projectRoot,store:new CardService(projectRoot),cardId:'project',sessionId:'agent:reviewer:project',parentControl:unusedParentControl,childCreationTypes:new Set(),childActivationTypes:new Set(),cardTypeVocabulary:['project','goal','architecture','code','test','doc','data','research','ops'],notifyCard:()=>({ok:false,reason:'missing_card',cardId:'project'}),submitNotification:async()=>({queued:false as const,reason:'missing_card' as const,cardId:'project'}),processRunner:{} as never,mcpToolInvocation:{...unusedMcpToolInvocation,getServerTools:()=>[],findToolCapability:()=>null,invokeTool:()=>Promise.resolve({})}});
    expect([...surface.tools.keys()]).toEqual(['mcp_tool_call']);
    expect(surface.providers.map((provider)=>provider.providerName)).toEqual(['mcp']);
    await expect(invokeToolForLlm(surface, 'mcp_reconcile', {}, testLlmToolInvocationContext({ sessionId: 'agent:reviewer:project', toolName: 'mcp_reconcile' }))).resolves.toEqual(syntheticToolSettlement('unsupported_tool', "Unsupported tool 'mcp_reconcile' for agent 'reviewer'."));
    const outcome = await invokeToolForLlm(surface, 'mcp_tool_call', { serverName: 'server', toolName: 'tool' }, testLlmToolInvocationContext({ sessionId: 'agent:reviewer:project', toolName: 'mcp_tool_call' }));
    expect(outcome.kind).toBe('executed');
  });

  it('binds only selected process definitions and cleans the shared selected group once',async()=>{
    const closeAndTerminateDirectScope=jest.fn(async()=>({failed:[]}));
    const toolSet=new BoundAgentToolSet(['wait_process','kill_process'].map((name)=>resolveRuntimeTool('card',name)));
    const surface=toolSet.bind({scope:'card',agentName:'executor',projectRoot:'/',store:{} as never,cardId:'project',sessionId:'agent:executor:project',parentControl:unusedParentControl,childCreationTypes:new Set(),childActivationTypes:new Set(),cardTypeVocabulary:['project','goal','architecture','code','test','doc','data','research','ops'],notifyCard:()=>({ok:false,reason:'missing_card',cardId:'project'}),submitNotification:async()=>({queued:false as const,reason:'missing_card' as const,cardId:'project'}),processRunner:{closeAndTerminateDirectScope} as never,processScope:{} as never,processOwnerId:'activation',mcpToolInvocation:{} as never});
    expect(surface.providers).toHaveLength(1);
    expect(surface.providers[0]!.tools.map((tool)=>tool.name)).toEqual(['wait_process','kill_process']);
    expect(surface.providers[0]!.cleanup).toEqual(expect.any(Function));
    await cleanupInvocationSurface(surface,{kind:'activation_settled',status:'done'});
    expect(closeAndTerminateDirectScope).toHaveBeenCalledTimes(1);
  });
});
