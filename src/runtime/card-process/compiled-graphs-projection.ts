import {
  DebugGraphsResponseSchema,
  type DebugGraphsResponse,
} from '../../contracts/operator-api-files-debug.js';
import { cardTypeValues } from '../../schemas/index.js';
import {
  type CardProcessEntry,
  type CompiledCardTypeWorkflow,
  type CompiledRuntimeWorkflows,
  runtimeAgentBinding,
} from './card-process-config.js';

const entries = ['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'] as const;
const terminals = ['DONE', 'BLOCKED', 'FAILED'] as const;

function entryTarget(workflow: CompiledCardTypeWorkflow, entry: CardProcessEntry): string {
  const transition = workflow.states.get(`entry:${entry}`)?.on.get('entry:route');
  if (!transition || transition.semantic.kind !== 'entry-route')
    throw new Error(`Compiled workflow '${workflow.cardType}' is missing entry '${entry}'.`);
  const target = workflow.states.get(transition.targetStateId);
  if (!target || target.kind !== 'node')
    throw new Error(
      `Compiled workflow '${workflow.cardType}' entry '${entry}' does not target a node.`,
    );
  return target.nodeId;
}

function entryPrompt(workflow: CompiledCardTypeWorkflow, entry: CardProcessEntry) {
  const route = workflow.states.get(`entry:${entry}`)?.on.get('entry:route');
  if (!route || route.semantic.kind !== 'entry-route')
    throw new Error(
      `Compiled workflow '${workflow.cardType}' entry '${entry}' has invalid semantics.`,
    );
  return route.semantic.promptId;
}

/** Safe operator projection of the already-bound startup artifact. No source or runtime-state reads occur here. */
export function projectCompiledGraphs(workflows: CompiledRuntimeWorkflows): DebugGraphsResponse {
  const graphs = cardTypeValues.map((cardType) => {
    const workflow = workflows.cardTypes.get(cardType);
    if (!workflow) throw new Error(`Compiled startup artifact is missing card type '${cardType}'.`);
    const graphEntries = entries.map((entry) => ({
      entry,
      node_id: entryTarget(workflow, entry),
      prompt_reference: entryPrompt(workflow, entry),
    }));
    const nodeStates = [...workflow.states.values()].filter((state) => state.kind === 'node');
    const nodes = nodeStates.map((node) => {
      const binding = runtimeAgentBinding(workflows, node.agent.name);
      return {
        node_id: node.nodeId,
        agent_name: node.agent.name,
        session: { scope: 'card' as const, identity_pattern: `agent:${node.agent.name}:<card-id>` },
        prompt: {
          source: node.selectedAgentPrompt.source,
          reference: node.selectedAgentPrompt.reference,
          process_reference: node.promptId,
          correction_reference: node.correctionPromptId,
        },
        model: {
          route: node.agent.modelRoute,
          candidates: binding.candidateChain.map(({ provider, model }) => ({ provider, model })),
          temperature: node.agent.model.temperature,
          max_tokens: node.agent.model.maxTokens,
        },
        skills: node.agent.skills,
        tools: [...binding.toolSet.names],
        child_creation_types: [...node.childCreationTypes],
        child_activation_types: [...node.childActivationTypes],
        readable_records: [...node.readableRecords.keys()],
        record_write_patterns: node.agent.recordWrites.map(({source})=>source),
        requirements: node.requirements.map((requirement) => ({
          record_name: requirement.definition.name,
          mode: requirement.mode,
          gate: requirement.gate,
        })),
        descendant_context:
          node.descendantContext === null
            ? null
            : {
                records: node.descendantContext.records.map((record) => record.name),
                require_unchanged_until_accept: node.descendantContext.requireUnchangedUntilAccept,
              },
        outcomes: [...node.on.values()].flatMap((route) =>
          route.semantic.kind === 'configured-outcome' ? [route.semantic.outcome] : [],
        ),
      };
    });
    const edges = nodeStates.flatMap((node) =>
      [...node.on.values()].map((route) => {
        const target = workflow.states.get(route.targetStateId)!;
        if (route.semantic.kind === 'configured-outcome') {
          if (target.kind !== 'node' && target.kind !== 'terminal')
            throw new Error(
              `Compiled workflow '${workflow.cardType}' node '${node.nodeId}' has invalid configured target.`,
            );
          const behavior = route.semantic.terminalBehavior;
          return {
            source_node_id: node.nodeId,
            outcome: route.semantic.outcome,
            runtime_owned: false,
            prompt_reference: route.semantic.promptId,
            target:
              target.kind === 'terminal'
                ? { kind: 'terminal' as const, terminal: target.terminal }
                : { kind: 'node' as const, node_id: target.nodeId },
            export_records: behavior?.exportRecords.map((record) => record.name) ?? [],
            promotion:
              behavior === null
                ? null
                : behavior.promotion.kind === 'current'
                  ? { kind: 'current' as const }
                  : { kind: 'latest-node' as const, node_id: behavior.promotion.nodeId },
          };
        }
        if (route.semantic.kind !== 'runtime-terminal' || target.kind !== 'terminal')
          throw new Error(
            `Compiled workflow '${workflow.cardType}' node '${node.nodeId}' has invalid runtime target.`,
          );
        return {
          source_node_id: node.nodeId,
          outcome: route.semantic.cause === 'failed' ? 'execution:failed' : 'execution:blocked',
          runtime_owned: true,
          prompt_reference: null,
          target: { kind: 'terminal' as const, terminal: target.terminal },
          export_records: [],
          promotion: null,
        };
      }),
    );
    return {
      card_type: cardType,
      permitted_child_types: [...workflow.permittedChildTypes],
      records: [...workflow.records.values()].map(({name,format,schema,bootstrap}) => ({name,format,schema,bootstrap})),
      entries: graphEntries,
      nodes,
      edges,
      terminals: terminals.map((terminal) => ({ terminal })),
    };
  });
  return DebugGraphsResponseSchema.parse({ graphs });
}
