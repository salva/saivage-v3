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

describe('compiled Debug graph projection', () => {
  it('remains the startup projection after restart-only reconfiguration and changes only with a fresh artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-graphs-reconfigure-'));
    try {
      const authority = createTestConfigAuthority(root);
      const current = authority.loadEffective();
      const bind = (effective: typeof current) => bindRuntimeWorkflows(effective.workflows, new ModelRouter(new ProviderRegistry(effective.config)));
      const startup = bind(current);
      const before = projectCompiledGraphs(startup);
      expect(authority.applyChange({ kind: 'set_agent_model_route', agent: 'planner', modelRoute: 'executor' })).toMatchObject({ success: true, requires_restart: true });
      expect(projectCompiledGraphs(startup)).toEqual(before);
      expect(before.graphs.find((graph) => graph.card_type === 'project')!.nodes.find((node) => node.agent_name === 'planner')!.model.route).toBe('planner');
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
      const workflows = bindRuntimeWorkflows(effective.workflows, new ModelRouter(new ProviderRegistry(effective.config)));
      const graph = projectCompiledGraphs(workflows).graphs.find((candidate) => candidate.card_type === 'project')!;
      expect(graph.entries).toEqual([
        { entry: 'BACKLOG', node_id: 'plan', prompt_reference: null },
        { entry: 'CHANGED', node_id: 'plan', prompt_reference: null },
        { entry: 'BLOCKED', node_id: 'plan', prompt_reference: null },
        { entry: 'STOPPED', node_id: 'recover', prompt_reference: 'stopped-recovery' },
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
          prompt_reference: 'plan-to-review',
          target: { kind: 'node', node_id: 'review' },
        }),
        expect.objectContaining({ source_node_id: 'review', outcome: 'revision_required', target: { kind: 'node', node_id: 'plan' } }),
        expect.objectContaining({ source_node_id: 'review', outcome: 'approved', export_records: ['review.md'], promotion: { kind: 'current' } }),
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
    const bound=bindRuntimeWorkflows(compileProjectWorkflows(config,{defaultPromptRoot:resolveSystemTemplate('classic-typed').promptRoot}),new ModelRouter(new ProviderRegistry(config)));
    const projected=projectCompiledGraphs(bound);
    expect(projected.graphs.map(({card_type})=>card_type)).toEqual(Object.keys(expected));
    for(const [cardType,source] of Object.entries(expected)){
      const graph=projected.graphs.find((candidate)=>candidate.card_type===cardType)!;
      expect(graph.permitted_child_types).toEqual(source.permitted_child_types);
      expect(graph.records).toEqual(Object.entries(source.records).map(([name,record])=>({name,...record})));
      expect(graph.entries).toEqual(Object.entries(source.workflow.entries).map(([entry,target])=>({entry,node_id:target.node,prompt_reference:target.prompt??null})));
      expect(graph.nodes.map((node)=>({node_id:node.node_id,agent_name:node.agent_name,process_reference:node.prompt.process_reference,correction_reference:node.prompt.correction_reference,requirements:node.requirements,descendant_context:node.descendant_context,outcomes:node.outcomes}))).toEqual(Object.entries(source.workflow.nodes).map(([nodeId,node])=>({node_id:nodeId,agent_name:node.agent,process_reference:node.prompt,correction_reference:node.correction_prompt,requirements:Object.entries(node.records).map(([record_name,{mode,gate}])=>({record_name,mode,gate})),descendant_context:node.descendant_context?{records:node.descendant_context.records,require_unchanged_until_accept:node.descendant_context.require_unchanged_until_accept}:null,outcomes:Object.keys(node.edges)})));
      const expectedEdges=Object.entries(source.workflow.nodes).flatMap(([nodeId,node])=>[
        ...Object.entries(node.edges).map(([outcome,edge])=>({source_node_id:nodeId,outcome,runtime_owned:false,prompt_reference:edge.prompt??null,target:'node'in edge.target?{kind:'node',node_id:edge.target.node}:{kind:'terminal',terminal:edge.target.terminal},export_records:'terminal'in edge.target?edge.target.export_records:[],promotion:'terminal'in edge.target?(edge.target.promote==='current'?{kind:'current'}:{kind:'latest-node',node_id:edge.target.promote.latest_node}):null})),
        {source_node_id:nodeId,outcome:'execution:failed',runtime_owned:true,prompt_reference:null,target:{kind:'terminal',terminal:'FAILED'},export_records:[],promotion:null},
        {source_node_id:nodeId,outcome:'execution:blocked',runtime_owned:true,prompt_reference:null,target:{kind:'terminal',terminal:'BLOCKED'},export_records:[],promotion:null},
      ]);
      expect(graph.edges).toEqual(expectedEdges);
    }
  });

  it('keeps omitted-default projection byte-identical to the explicit historical default',()=>{
    const explicit=bindRuntimeWorkflows(compileProjectWorkflows(TEST_SAIVAGE_CONFIG),new ModelRouter(new ProviderRegistry(TEST_SAIVAGE_CONFIG)));
    const root=mkdtempSync(join(tmpdir(),'saivage-selected-standard-'));try{const globals=structuredClone(TEST_SAIVAGE_CONFIG) as Record<string,unknown>;delete globals.card_types;const omitted=createTestConfigAuthority(root,{config:globals}).loadEffective();const omittedBound=bindRuntimeWorkflows(omitted.workflows,new ModelRouter(new ProviderRegistry(omitted.config)));expect(projectCompiledGraphs(omittedBound)).toEqual(projectCompiledGraphs(explicit));}finally{rmSync(root,{recursive:true,force:true});}
  });
});
