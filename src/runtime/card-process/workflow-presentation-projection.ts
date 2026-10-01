import { WorkflowPresentationSchema, type WorkflowPresentation } from '../../contracts/index.js';
import type { CompiledCardTypeWorkflow } from './card-process-config.js';
import { workflowEdge, workflowEntryTarget } from './workflow-topology.js';

/** Structural facts only, from exactly one immutable installed workflow. */
export function projectWorkflowPresentation(workflow: CompiledCardTypeWorkflow): WorkflowPresentation {
  const nodes = [...workflow.states.values()].filter((state) => state.kind === 'node');
  return WorkflowPresentationSchema.parse({
    card_type: workflow.cardType,
    nodes: nodes.map((node) => ({ node_id: node.nodeId, agent_name: node.agent.name })),
    entries: (['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'] as const).map((entry) => ({ entry, node_id: workflowEntryTarget(workflow, entry) })),
    edges: nodes.flatMap((node) => [...node.on.values()].map((route) => workflowEdge(workflow, node, route))),
    terminals: ['DONE', 'BLOCKED', 'FAILED'].map((terminal) => ({ terminal })),
    records: [...workflow.records.values()].map(({ name, bootstrap }) => ({ name, bootstrap })),
  });
}
