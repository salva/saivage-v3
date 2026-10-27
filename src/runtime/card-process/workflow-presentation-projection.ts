import { WorkflowPresentationSchema, type WorkflowPresentation } from '../../contracts/index.js';
import type { CompiledCardTypeWorkflow } from './card-process-config.js';
import { redactTextForOutbound } from '../../redaction/index.js';
import { workflowEdge, workflowEntryTarget } from './workflow-topology.js';

/** Structural facts only, from exactly one immutable installed workflow. */
export function projectWorkflowPresentation(
  workflow: CompiledCardTypeWorkflow,
): WorkflowPresentation {
  const nodes = [...workflow.states.values()].filter((state) => state.kind === 'node');
  return WorkflowPresentationSchema.parse({
    card_type: workflow.cardType,
    nodes: nodes.map((node) => ({
      node_id: node.nodeId,
      purpose: node.purpose,
      execution:
        node.execution.kind === 'agent'
          ? { kind: 'agent', agent_name: node.execution.agent.name }
          : {
              kind: 'action',
              action: node.execution.operation.id,
              contract_version: node.execution.operation.contractVersion,
              provider: node.execution.operation.provider,
            },
      initialize_records: node.initializeRecords.map((record) => record.name),
      output_record: node.outputRecord?.name ?? null,
    })),
    entries: (['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'] as const).map((entry) => ({
      entry,
      node_id: workflowEntryTarget(workflow, entry),
    })),
    edges: nodes.flatMap((node) =>
      [...node.on.values()].map((route) => workflowEdge(workflow, node, route)),
    ),
    terminals: ['DONE', 'BLOCKED', 'FAILED'].map((terminal) => ({ terminal })),
    records: [...workflow.records.values()].map(({ name, bootstrap, initialization }) => ({
      name,
      bootstrap,
      initialization: initialization
        ? { format_version: 1, template: redactTextForOutbound(initialization.template) }
        : null,
    })),
  });
}
