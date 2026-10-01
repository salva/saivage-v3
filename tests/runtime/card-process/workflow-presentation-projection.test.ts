import { describe, expect, it } from '@jest/globals';
import { TEST_WORKFLOWS } from '../../helpers/canonical-project.js';
import { projectWorkflowPresentation } from '../../../src/runtime/card-process/workflow-presentation-projection.js';
import { projectCompiledGraphs } from '../../../src/runtime/card-process/compiled-graphs-projection.js';
import { WorkflowPresentationSchema } from '../../../src/contracts/operator-api-workflows.js';
import { bindRuntimeWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';

describe('compact workflow presentation', () => {
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
        records: graph.records.map(({ name, bootstrap }) => ({ name, bootstrap })),
      });
      expect(WorkflowPresentationSchema.safeParse(graph).success).toBe(false);
    }
  });
});
