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
      expect(before.graphs.find((graph) => graph.card_type === 'project')!.nodes.find((node) => node.agent_name === 'planner')!.model.route).toBe('planner');
      expect(before.global_agents.map(({agent_name})=>agent_name)).toEqual(['analyst','oversight']);
      const afterRestart = projectCompiledGraphs(bind(authority.loadEffective()));
      expect(afterRestart.graphs.find((graph) => graph.card_type === 'project')!.nodes.find((node) => node.agent_name === 'planner')!.model.route).toBe('executor');
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
      expect(graph.edges.slice(0, 6).map((edge) => edge.outcome)).toEqual([
        'complete_direct',
        'admit_review',
        'blocked',
        'failed',
        'execution:failed',
        'execution:blocked',
      ]);
      expect(graph.edges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_node_id: 'plan',
          outcome: 'admit_review',
          runtime_owned: false,
          condition: 'default',
          prompt: { reference: 'plan-to-review', compactable: true },
          target: { kind: 'node', node_id: 'review' },
        }),
        expect.objectContaining({ source_node_id: 'review', outcome: 'revision_required', target: { kind: 'node', node_id: 'plan' } }),
        expect.objectContaining({ source_node_id: 'review', outcome: 'approved', export_records: ['review.md'], promotion: { kind: 'current' } }),
        expect.objectContaining({ source_node_id: 'review', outcome: 'approved', condition: 'pending_notifications', target: { kind: 'node', node_id: 'handle-notifications' }, prompt: { reference: 'review-to-notifications', compactable: true } }),
        expect.objectContaining({ source_node_id: 'plan', outcome: 'execution:failed', runtime_owned: true, target: { kind: 'terminal', terminal: 'FAILED' } }),
      ]));
      expect(JSON.stringify(graph)).not.toMatch(/prompt body|account|contractDescription|\.saivage/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects every specialized entry, node, requirement, edge, export, and promotion exactly',()=>{
    const expected=specializedCardTypes();
    const selected=specializedConfig();selected.models=structuredClone(TEST_SAIVAGE_CONFIG.models);selected.providers=structuredClone(TEST_SAIVAGE_CONFIG.providers);
    const config=effectiveSaivageConfigSchema.parse(selected);
    const bound=bindConfigured(compileProjectWorkflows(config,{defaultPromptRoot:resolveSystemTemplate('classic-typed').promptRoot}),config);
    const projected=projectCompiledGraphs(bound);
    expect(projected.graphs.map(({card_type})=>card_type)).toEqual(Object.keys(expected));
    for(const [cardType,source] of Object.entries(expected)){
      const graph=projected.graphs.find((candidate)=>candidate.card_type===cardType)!;
      expect(graph.permitted_child_types).toEqual(source.permitted_child_types);
      expect(graph.notification_recipient).toBe(source.workflow.notification_recipient);
      expect(graph.records).toEqual(Object.entries(source.records).map(([name,record])=>({name,...record})));
      expect(graph.entries).toEqual(Object.entries(source.workflow.entries).map(([entry,target])=>({entry,node_id:target.node,prompt:target.prompt?{reference:target.prompt.reference,compactable:target.prompt.compactable??true,...(target.prompt.compaction_key===undefined?{}:{compaction_key:target.prompt.compaction_key})}:null})));
      expect(graph.nodes.map((node)=>({node_id:node.node_id,agent_name:node.agent_name,process:node.prompt.process,correction:node.prompt.correction,requirements:node.requirements,descendant_context:node.descendant_context,outcomes:node.outcomes}))).toEqual(Object.entries(source.workflow.nodes).map(([nodeId,node])=>({node_id:nodeId,agent_name:node.agent,process:{reference:node.prompt.reference,compactable:node.prompt.compactable??true},correction:{reference:node.correction_prompt.reference,compactable:node.correction_prompt.compactable??true,...(node.correction_prompt.compaction_key===undefined?{}:{compaction_key:node.correction_prompt.compaction_key})},requirements:Object.entries(node.records??{}).map(([record_name,{mode,gate}])=>({record_name,mode,gate})),descendant_context:node.descendant_context?{records:node.descendant_context.records,require_unchanged_until_accept:node.descendant_context.require_unchanged_until_accept}:null,outcomes:Object.keys(node.edges)})));
      const expectedEdges=Object.entries(source.workflow.nodes).flatMap(([nodeId,node])=>[
        ...Object.entries(node.edges).flatMap(([outcome,edge])=>[
          {source_node_id:nodeId,outcome,runtime_owned:false,condition:'default' as const,prompt:edge.prompt?{reference:edge.prompt.reference,compactable:edge.prompt.compactable??true,...(edge.prompt.compaction_key===undefined?{}:{compaction_key:edge.prompt.compaction_key})}:null,target:'node'in edge.target?{kind:'node' as const,node_id:edge.target.node}:{kind:'terminal' as const,terminal:edge.target.terminal},export_records:'terminal'in edge.target?edge.target.export_records:[],promotion:'terminal'in edge.target?(edge.target.promote==='current'?{kind:'current' as const}:{kind:'latest-node' as const,node_id:edge.target.promote.latest_node}):null},
          ...(edge.pending_notifications?[{source_node_id:nodeId,outcome,runtime_owned:false,condition:'pending_notifications' as const,prompt:{reference:edge.pending_notifications.prompt.reference,compactable:edge.pending_notifications.prompt.compactable??true,...(edge.pending_notifications.prompt.compaction_key===undefined?{}:{compaction_key:edge.pending_notifications.prompt.compaction_key})},target:{kind:'node' as const,node_id:edge.pending_notifications.node},export_records:[],promotion:null}]:[]),
        ]),
        {source_node_id:nodeId,outcome:'execution:failed',runtime_owned:true,condition:'default' as const,prompt:null,target:{kind:'terminal' as const,terminal:'FAILED' as const},export_records:[],promotion:null},
        {source_node_id:nodeId,outcome:'execution:blocked',runtime_owned:true,condition:'default' as const,prompt:null,target:{kind:'terminal' as const,terminal:'BLOCKED' as const},export_records:[],promotion:null},
      ]);
      expect(graph.edges).toEqual(expectedEdges);
    }
  });

  it('keeps omitted-default projection byte-identical to the explicit historical default',()=>{
    const explicit=bindConfigured(compileProjectWorkflows(TEST_SAIVAGE_CONFIG),TEST_SAIVAGE_CONFIG);
    const root=mkdtempSync(join(tmpdir(),'saivage-selected-standard-'));try{const globals=structuredClone(TEST_SAIVAGE_CONFIG) as Record<string,unknown>;delete globals.card_types;const omitted=createTestConfigAuthority(root,{config:globals}).loadEffective();const omittedBound=bindConfigured(omitted.workflows,omitted.config);expect(projectCompiledGraphs(omittedBound)).toEqual(projectCompiledGraphs(explicit));}finally{rmSync(root,{recursive:true,force:true});}
  });
});
