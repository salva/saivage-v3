import { agentExecution, directEdge } from '../../helpers/workflow-execution.js';
import { describe, expect, it } from '@jest/globals';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';
import { createTestConfigAuthority } from '../../helpers/project-config.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';
import { bindRuntimeWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { projectCompiledGraphs } from '../../../src/runtime/card-process/compiled-graphs-projection.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileProjectWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { specializedCardTypes, specializedConfig } from '../../helpers/specialized-config.js';
import { resolveSystemTemplate } from '../../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/saivage-config.js';

function bindConfigured(workflows: Parameters<typeof bindRuntimeWorkflows>[0], config: typeof TEST_SAIVAGE_CONFIG) {
  const registry = new ProviderRegistry(config);
  return bindRuntimeWorkflows(workflows, new ModelRouter(registry), registry, config.compaction.context_utilization_fraction);
}

describe('compiled Debug graph projection', () => {
  it('remains the startup projection after restart-only reconfiguration and changes only with a fresh artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-graphs-reconfigure-'));
    try {
      const authority = createTestConfigAuthority(root);
      const current = authority.loadEffective();
      const bind = (effective: typeof current) => bindConfigured(effective.workflows, effective.config);
      const startup = bind(current);
      const before = projectCompiledGraphs(startup);
      expect(authority.applyChange({ kind: 'set_agent_model_route', agent: 'planner', modelRoute: 'executor' })).toMatchObject({ success: true, requires_restart: true });
      expect(projectCompiledGraphs(startup)).toEqual(before);
      expect(agentExecution(before.graphs.find((graph) => graph.card_type === 'project')!.nodes.find((node) => node.execution.kind === 'agent' && node.execution.agent_name === 'planner')!).model.route).toBe('planner');
      expect(before.global_agents.map(({agent_name})=>agent_name)).toEqual(['analyst','oversight']);
      const afterRestart = projectCompiledGraphs(bind(authority.loadEffective()));
      expect(agentExecution(afterRestart.graphs.find((graph) => graph.card_type === 'project')!.nodes.find((node) => node.execution.kind === 'agent' && node.execution.agent_name === 'planner')!).model.route).toBe('executor');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects cycles, terminal exports and runtime-owned failures without prompt bodies or account identities', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-graphs-shape-'));
    try {
      const effective = createTestConfigAuthority(root, { config: TEST_SAIVAGE_CONFIG }).loadEffective();
      const workflows = bindConfigured(effective.workflows, effective.config);
      const projected = projectCompiledGraphs(workflows);
      const graph = projected.graphs.find((candidate) => candidate.card_type === 'project')!;
      expect(projected.global_agents).toEqual([
        expect.objectContaining({agent_name:'analyst',session:{scope:'global',identity:'agent:analyst:global'},prompt:expect.objectContaining({declaration:{reference:'analyst',compactable:true}})}),
        expect.objectContaining({agent_name:'oversight',session:{scope:'global',identity:'agent:oversight:global'},prompt:expect.objectContaining({declaration:{reference:'oversight',compactable:true}})}),
      ]);
      expect(graph.notification_recipient).toBe('planner');
      expect(graph.entries).toEqual([
        { entry: 'BACKLOG', node_id: 'plan', prompt: null },
        { entry: 'CHANGED', node_id: 'plan', prompt: null },
        { entry: 'BLOCKED', node_id: 'plan', prompt: null },
        { entry: 'STOPPED', node_id: 'recover', prompt: { reference: 'stopped-recovery', compactable: true } },
      ]);
      expect(graph.edges.slice(0, 7).map((edge) => edge.outcome)).toEqual([
        'notification:interrupt',
        'admit_review',
        'blocked',
        'failed',
        'assess_completion',
        'execution:failed',
        'execution:blocked',
      ]);
      expect(graph.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ route_id: 'admit_review', test: null,
          source_node_id: 'plan',
          outcome: 'admit_review',
          runtime_owned: false,
          condition: 'default',
          prompt: { reference: 'plan-to-review', compactable: true },
          target: { kind: 'node', node_id: 'review' },
        }),
        expect.objectContaining({ route_id: 'revision_required', test: null, source_node_id: 'review', outcome: 'revision_required', target: { kind: 'node', node_id: 'plan' } }),
        expect.objectContaining({ source_node_id: 'review', outcome: 'approved', target: { kind: 'node', node_id: 'assess-completion' }, export_records: [], promotion: null }),
        expect.objectContaining({ source_node_id: 'assess-completion', outcome: 'complete_reviewed', export_records: ['status.md'], promotion: { kind: 'latest-node', node_id: 'review' } }),
        expect.objectContaining({ route_id: 'execution:failed', test: null, source_node_id: 'plan', outcome: 'execution:failed', runtime_owned: true, target: { kind: 'terminal', terminal: 'FAILED' } }),
      ]));
      expect(JSON.stringify(graph)).not.toMatch(/prompt body|account|contractDescription|\.saivage/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects every specialized entry, node, requirement, edge, export, and promotion exactly',()=>{
    const expected=specializedCardTypes();
    const selected=specializedConfig();selected.models=structuredClone(TEST_SAIVAGE_CONFIG.models);selected.providers=structuredClone(TEST_SAIVAGE_CONFIG.providers);
    selected.providers.test.capabilities={...selected.providers.test.capabilities,transportProtocol:'openai-responses',imageInput:true};
    const config=effectiveSaivageConfigSchema.parse(selected);
    const bound=bindConfigured(compileProjectWorkflows(config,{defaultPromptRoot:resolveSystemTemplate('classic-typed').promptRoot}),config);
    const projected=projectCompiledGraphs(bound);
    expect(projected.graphs.map(({card_type})=>card_type)).toEqual(Object.keys(expected));
    for(const [cardType,source] of Object.entries(expected)){
      const graph=projected.graphs.find((candidate)=>candidate.card_type===cardType)!;
      expect(graph.permitted_child_types).toEqual(source.permitted_child_types);
      expect(graph.notification_recipient).toBe(source.workflow.notification_recipient);
      expect(graph.records).toEqual(Object.entries(source.records).map(([name,record])=>({name,...record,initialization:record.initialization??null})));
      expect(graph.entries).toEqual(Object.entries(source.workflow.entries).map(([entry,target])=>({entry,node_id:target.node,prompt:target.prompt?{reference:target.prompt.reference,compactable:target.prompt.compactable??true,...(target.prompt.compaction_key===undefined?{}:{compaction_key:target.prompt.compaction_key})}:null})));
      expect(graph.nodes.map((node)=>({ node_id:node.node_id, process:agentExecution(node).prompt.process, correction:agentExecution(node).prompt.correction, requirements:node.requirements, descendant_context:node.descendant_context, outcomes:node.outcomes, execution: { kind: 'agent', agent_name:agentExecution(node).agent_name } }))).toEqual(Object.entries(source.workflow.nodes).map(([nodeId,node])=>({ node_id:nodeId, process:{reference:agentExecution(node).prompt.reference,compactable:agentExecution(node).prompt.compactable??true}, correction:{reference:agentExecution(node).correction_prompt.reference,compactable:agentExecution(node).correction_prompt.compactable??true,...(agentExecution(node).correction_prompt.compaction_key===undefined?{}:{compaction_key:agentExecution(node).correction_prompt.compaction_key})}, requirements:Object.entries(node.records??{}).map(([record_name,{mode,gate}])=>({record_name,mode,gate})), descendant_context:node.descendant_context?{records:node.descendant_context.records,require_unchanged_until_accept:node.descendant_context.require_unchanged_until_accept}:null, outcomes:Object.keys(node.edges), execution: { kind: 'agent', agent_name:agentExecution(node).agent } })));
      const declaredPrompt = (prompt: {reference:string;compactable?:boolean;compaction_key?:string}|undefined) => prompt ? {reference:prompt.reference,compactable:prompt.compactable??true,...(prompt.compaction_key===undefined?{}:{compaction_key:prompt.compaction_key})} : null;
      const expectedEdges=Object.entries(source.workflow.nodes).flatMap(([nodeId,node])=>[
        { route_id:'notification:interrupt',test:null,source_node_id:nodeId,outcome:'notification:interrupt',runtime_owned:true,condition:'default',prompt:declaredPrompt(source.workflow.entries.STOPPED.prompt),target:{kind:'node',node_id:source.workflow.entries.STOPPED.node},export_records:[],promotion:null},
        ...Object.entries(node.edges).flatMap(([outcome,configured])=>{
          const edge=directEdge(configured),target=edge.target,pending=edge.pending_notifications;
          return [
            {route_id:outcome,test:null,source_node_id:nodeId,outcome,runtime_owned:false,condition:'default',prompt:declaredPrompt(edge.prompt),target:'node'in target?{kind:'node',node_id:target.node}:{kind:'terminal',terminal:target.terminal},export_records:'terminal'in target?target.export_records:[],promotion:'terminal'in target?(target.promote==='current'?{kind:'current'}:{kind:'latest-node',node_id:target.promote.latest_node}):null},
            ...(pending?[{route_id:`${outcome}:pending-notifications`,test:null,source_node_id:nodeId,outcome,runtime_owned:false,condition:'pending_notifications',prompt:declaredPrompt(pending.prompt),target:{kind:'node',node_id:pending.node},export_records:[],promotion:null}]:[]),
          ];
        }),
        {route_id:'execution:failed',test:null,source_node_id:nodeId,outcome:'execution:failed',runtime_owned:true,condition:'default',prompt:null,target:{kind:'terminal',terminal:'FAILED'},export_records:[],promotion:null},
        {route_id:'execution:blocked',test:null,source_node_id:nodeId,outcome:'execution:blocked',runtime_owned:true,condition:'default',prompt:null,target:{kind:'terminal',terminal:'BLOCKED'},export_records:[],promotion:null},
      ]);
      expect(graph.edges).toEqual(expectedEdges);
    }
  });

  it('keeps omitted-default projection byte-identical to the explicit historical default',()=>{
    const explicit=bindConfigured(compileProjectWorkflows(TEST_SAIVAGE_CONFIG),TEST_SAIVAGE_CONFIG);
    const root=mkdtempSync(join(tmpdir(),'saivage-selected-standard-'));try{const globals=structuredClone(TEST_SAIVAGE_CONFIG) as Record<string,unknown>;delete globals.card_types;const omitted=createTestConfigAuthority(root,{config:globals}).loadEffective();const omittedBound=bindConfigured(omitted.workflows,omitted.config);expect(projectCompiledGraphs(omittedBound)).toEqual(projectCompiledGraphs(explicit));}finally{rmSync(root,{recursive:true,force:true});}
  });
});
