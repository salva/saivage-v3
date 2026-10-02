import { DebugGraphsResponseSchema, type DebugGraphsResponse } from '../../contracts/index.js';
import { effectiveCardNodeToolReferences } from '../../tools/tool-api.js';
import { workflowEdge, workflowEntryTarget } from './workflow-topology.js';
import {
  type CardProcessEntry,
  type CompiledCardTypeWorkflow,
  type CompiledRuntimeWorkflows,
  runtimeAgentBinding,
} from './card-process-config.js';

const entries = ['BACKLOG', 'CHANGED', 'BLOCKED', 'STOPPED'] as const;
const terminals = ['DONE', 'BLOCKED', 'FAILED'] as const;

function entryPrompt(workflow: CompiledCardTypeWorkflow, entry: CardProcessEntry) {
  const route = workflow.states.get(`entry:${entry}`)?.on.get('entry:route');
  if (!route || route.semantic.kind !== 'entry-route')
    throw new Error(
      `Compiled workflow '${workflow.cardType}' entry '${entry}' has invalid semantics.`,
    );
  return route.semantic.prompt;
}
function projectedPrompt(
  declaration: import('./card-process-config.js').CompiledPromptDeclaration | null,
) {
  return declaration === null
    ? null
    : {
        reference: declaration.promptId,
        compactable: declaration.compactable,
        ...(declaration.compactionKey === undefined
          ? {}
          : { compaction_key: declaration.compactionKey }),
      };
}

/** Safe operator projection of the already-bound startup artifact. No source or runtime-state reads occur here. */
export function projectCompiledGraphs(workflows: CompiledRuntimeWorkflows): DebugGraphsResponse {
  const globalAgents = [...workflows.selectedGlobalParticipants.values()].map(
    ({ agent, prompt }) => {
      const binding = runtimeAgentBinding(workflows, agent.name);
      return {
        agent_name: agent.name,
        session: { scope: 'global' as const, identity: `agent:${agent.name}:global` },
        prompt: {
          source: prompt.source,
          declaration: { reference: agent.prompt.reference, compactable: agent.prompt.compactable },
        },
        model: {
          route: agent.modelRoute,
          candidates: binding.candidateChain.map(({ provider, model }) => ({ provider, model })),
          temperature: agent.model.temperature,
          max_tokens: agent.model.maxTokens,
        },
        skills: agent.skills,
        tools: agent.tools.map(({ name }) => name),
      };
    },
  );
  const graphs = [...workflows.cardTypes.values()].map((workflow) => {
    const cardType = workflow.cardType;
    const graphEntries = entries.map((entry) => ({
      entry,
      node_id: workflowEntryTarget(workflow, entry),
      prompt: projectedPrompt(entryPrompt(workflow, entry)),
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
          declaration: {
            reference: node.agent.prompt.reference,
            compactable: node.agent.prompt.compactable,
          },
          process: projectedPrompt(node.prompt)!,
          correction: projectedPrompt(node.correctionPrompt)!,
        },
        model: {
          route: node.agent.modelRoute,
          candidates: binding.candidateChain.map(({ provider, model }) => ({ provider, model })),
          temperature: node.agent.model.temperature,
          max_tokens: node.agent.model.maxTokens,
        },
        skills: node.agent.skills,
        tools: effectiveCardNodeToolReferences(node.agent.tools, node.childCreationTypes).map(
          (reference) => reference.name,
        ),
        child_creation_types: [...node.childCreationTypes],
        child_activation_types: [...node.childActivationTypes],
        readable_records: [...node.readableRecords.keys()],
        record_write_patterns: node.agent.recordWrites.map(({ source }) => source),
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
        const structural = workflowEdge(workflow, node, route);
        if (route.semantic.kind === 'configured-outcome') {
          const behavior = route.semantic.terminalBehavior;
          return {
            ...structural,
            runtime_owned: false,
            prompt: projectedPrompt(route.semantic.prompt),
            export_records: behavior?.exportRecords.map((record) => record.name) ?? [],
            promotion:
              behavior === null
                ? null
                : behavior.promotion.kind === 'current'
                  ? { kind: 'current' as const }
                  : { kind: 'latest-node' as const, node_id: behavior.promotion.nodeId },
          };
        }
        if (route.semantic.kind === 'configured-pending-notifications') {
          return {
            ...structural,
            runtime_owned: false,
            prompt: projectedPrompt(route.semantic.prompt),
            export_records: [],
            promotion: null,
          };
        }
        if (route.semantic.kind === 'notification-interrupt') {
          return {
            ...structural,
            runtime_owned: true,
            prompt: projectedPrompt(route.semantic.prompt),
            export_records: [],
            promotion: null,
          };
        }
        if (route.semantic.kind !== 'runtime-terminal')
          throw new Error(
            `Compiled workflow '${workflow.cardType}' node '${node.nodeId}' has invalid runtime target.`,
          );
        return {
          ...structural,
          runtime_owned: true,
          prompt: null,
          export_records: [],
          promotion: null,
        };
      }),
    );
    return {
      card_type: cardType,
      notification_recipient: workflow.notificationRecipient,
      permitted_child_types: [...workflow.permittedChildTypes],
      records: [...workflow.records.values()].map(({ name, format, schema, bootstrap }) => ({
        name,
        format,
        schema,
        bootstrap,
      })),
      entries: graphEntries,
      nodes,
      edges,
      terminals: terminals.map((terminal) => ({ terminal })),
    };
  });
  return DebugGraphsResponseSchema.parse({ global_agents: globalAgents, graphs });
}
