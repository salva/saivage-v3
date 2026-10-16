import { describe, expect, it } from '@jest/globals';
import { TEST_WORKFLOWS } from '../../helpers/canonical-project.js';
import { projectWorkflowPresentation } from '../../../src/runtime/card-process/workflow-presentation-projection.js';
import { projectCompiledGraphs } from '../../../src/runtime/card-process/compiled-graphs-projection.js';
import { WorkflowPresentationSchema } from '../../../src/contracts/operator-api-workflows.js';
import { bindRuntimeWorkflows, compileProjectWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { resolveSystemTemplate } from '../../../src/config/system-templates/registry.js';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';

describe('compact workflow presentation', () => {
  it('projects configured record inputs without leaking declaration-key secrets or template bodies', () => {
    const config = structuredClone(TEST_SAIVAGE_CONFIG);
    config.card_types.project!.workflow.nodes.plan!.record_prompts = [{ record: 'brief.md', selection: 'accepted', presence: 'required', prompt: { reference: 'changed-record', compactable: false, compaction_key: 'token=graph-metadata-canary' } }];
    config.card_types.project!.records['status.md']!.initialization = { content: 'token=scaffold-canary', at: ['first_required_entry'] };
    const compiled = compileProjectWorkflows(config, { defaultPromptRoot: resolveSystemTemplate('classic').promptRoot });
    const registry = new ProviderRegistry(config);
    const bound = bindRuntimeWorkflows(compiled, new ModelRouter(registry), registry, config.compaction.context_utilization_fraction);
    const inputs = projectCompiledGraphs(bound).graphs.find(graph => graph.card_type === 'project')!.nodes.find(node => node.node_id === 'plan')!.record_prompts;
    expect(inputs).toHaveLength(1);
    expect(JSON.stringify(inputs)).not.toContain('graph-metadata-canary');
    expect(inputs[0]!.prompt).toMatchObject({ reference: 'changed-record', compactable: false, compaction_key: 'token=[REDACTED]' });
    expect(inputs[0]!.placeholders).toEqual(['recordSelection']);
    expect(inputs[0]).not.toHaveProperty('body');
    for (const projected of [projectCompiledGraphs(bound).graphs.find(graph => graph.card_type === 'project')!, projectWorkflowPresentation(compiled.cardTypes.get('project')!)]) {
      expect(projected.records.find(record => record.name === 'status.md')!.initialization).toEqual({ content: 'token=[REDACTED]', at: ['first_required_entry'] });
      expect(JSON.stringify(projected)).not.toContain('scaffold-canary');
    }
  });
  it('preserves complete per-type structural topology without installed bindings', () => {
    const registry = new ProviderRegistry(TEST_SAIVAGE_CONFIG);
    const bound = bindRuntimeWorkflows(TEST_WORKFLOWS, new ModelRouter(registry), registry, TEST_SAIVAGE_CONFIG.compaction.context_utilization_fraction);
    const rich = projectCompiledGraphs(bound);
    for (const workflow of TEST_WORKFLOWS.cardTypes.values()) {
      const graph = rich.graphs.find(({ card_type }) => card_type === workflow.cardType)!;
      const presentation = projectWorkflowPresentation(workflow);
      expect(presentation).toEqual({
        card_type: graph.card_type,
        nodes: graph.nodes.map(({ node_id, agent_name }) => ({ node_id, agent_name })),
        entries: graph.entries.map(({ entry, node_id }) => ({ entry, node_id })),
        edges: graph.edges.map(({ source_node_id, outcome, condition, target }) => ({ source_node_id, outcome, condition, target })),
        terminals: graph.terminals,
        records: graph.records.map(({ name, bootstrap, initialization }) => ({ name, bootstrap, initialization })),
      });
      expect(WorkflowPresentationSchema.safeParse(graph).success).toBe(false);
    }
  });
});
