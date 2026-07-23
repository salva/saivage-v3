import { DebugGraphsResponseSchema, type DebugGraphsResponse } from '../../contracts/operator-api-files-debug.js';
import { cardTypeValues } from '../../schemas/index.js';
import {
  processTransitionPromptKey,
  type CardProcessEntry,
  type CompiledCardTypeWorkflow,
  type CompiledRuntimeWorkflows,
} from './card-process-config.js';

const entries = ['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'] as const;
const terminals = ['DONE', 'BLOCKED', 'FAILED'] as const;

function entryTarget(workflow: CompiledCardTypeWorkflow, entry: CardProcessEntry): string {
  const transition = workflow.definition.states.get(`entry:${entry}`)?.on.get('entry:route');
  if (!transition) throw new Error(`Compiled workflow '${workflow.cardType}' is missing entry '${entry}'.`);
  const target = transition.target;
  if (!target.startsWith('node:')) throw new Error(`Compiled workflow '${workflow.cardType}' entry '${entry}' does not target a node.`);
  return target.slice('node:'.length);
}

/** Safe operator projection of the already-bound startup artifact. No source or runtime-state reads occur here. */
export function projectCompiledGraphs(workflows: CompiledRuntimeWorkflows): DebugGraphsResponse {
  const graphs = cardTypeValues.map((cardType) => {
    const workflow = workflows.cardTypes.get(cardType);
    if (!workflow) throw new Error(`Compiled startup artifact is missing card type '${cardType}'.`);
    const graphEntries = entries.map((entry) => ({
      entry,
      node_id: entryTarget(workflow, entry),
      prompt_reference: workflow.transitionPrompts.get(processTransitionPromptKey(`entry:${entry}`, 'entry:route')) ?? null,
    }));
    const nodes = [...workflow.nodes.values()].map((node) => {
      const candidates = workflows.candidateChains.get(node.agent.name);
      if (!candidates) throw new Error(`Compiled startup artifact is missing candidates for agent '${node.agent.name}'.`);
      return {
        node_id: node.nodeId,
        agent_name: node.agent.name,
        session: { scope: 'card' as const, identity_pattern: `agent:${node.agent.name}:<card-id>` },
        prompt: { source: node.selectedAgentPrompt.source, reference: node.selectedAgentPrompt.reference, process_reference: node.promptId, correction_reference: node.correctionPromptId },
        model: {
          route: node.agent.modelRoute,
          candidates: candidates.map(({ provider, model }) => ({ provider, model })),
          temperature: node.agent.model.temperature,
          max_tokens: node.agent.model.maxTokens,
        },
        skills: node.agent.skills,
        tools: [...node.agent.tools],
        child_creation_types: [...node.childCreationTypes],
        child_activation_types: [...node.childActivationTypes],
        readable_records: [...node.readableRecords.keys()],
        writable_records: [...node.writableRecords.keys()],
        requirements: node.requirements.map((requirement) => ({ record_name: requirement.definition.name, kind: requirement.kind })),
        descendant_context: node.descendantContext === null ? null : {
          records: node.descendantContext.records.map((record) => record.name),
          require_unchanged_until_accept: node.descendantContext.requireUnchangedUntilAccept,
        },
        outcomes: [...node.outcomes],
      };
    });
    const edges = [...workflow.nodes.values()].flatMap((node) => [
      ...[...node.edges.values()].map((edge) => ({
        source_node_id: node.nodeId,
        outcome: edge.outcome,
        runtime_owned: false,
        prompt_reference: edge.promptId,
        target: edge.targetNodeId === null
          ? { kind: 'terminal' as const, terminal: edge.terminalRoute!.terminal }
          : { kind: 'node' as const, node_id: edge.targetNodeId },
        export_records: edge.terminalRoute?.exportRecords.map((record) => record.name) ?? [],
        promotion: edge.terminalRoute === null ? null : edge.terminalRoute.promotion.kind === 'current'
          ? { kind: 'current' as const }
          : { kind: 'latest-node' as const, node_id: edge.terminalRoute.promotion.nodeId },
      })),
      {
        source_node_id: node.nodeId,
        outcome: 'execution:failed',
        runtime_owned: true,
        prompt_reference: null,
        target: { kind: 'terminal' as const, terminal: 'FAILED' as const },
        export_records: [],
        promotion: null,
      },
    ]);
    return {
      card_type: cardType,
      permitted_child_types: [...workflow.permittedChildTypes],
      records: [...workflow.records.values()].map((record) => ({ ...record })),
      entries: graphEntries,
      nodes,
      edges,
      terminals: terminals.map((terminal) => ({ terminal })),
    };
  });
  return DebugGraphsResponseSchema.parse({ graphs });
}
