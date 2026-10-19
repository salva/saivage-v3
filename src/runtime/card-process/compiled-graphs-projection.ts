import { DebugGraphsResponseSchema, type DebugGraphsResponse } from '../../contracts/index.js';
import { effectiveCardNodeToolReferences } from '../../tools/tool-api.js';
import { redactTextForOutbound } from '../../redaction/index.js';
import { workflowEdge, workflowEntryTarget } from './workflow-topology.js';
import {
  type CardProcessEntry,
  type CompiledCardTypeWorkflow,
  type CompiledRuntimeWorkflows,
  runtimeAgentBinding,
  processNodeOutcomes,
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
        reference: redactTextForOutbound(declaration.promptId),
        compactable: declaration.compactable,
        ...(declaration.compactionKey === undefined
          ? {}
          : { compaction_key: redactTextForOutbound(declaration.compactionKey) }),
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
      const execution = node.execution;
      const binding =
        execution.kind === 'agent' ? runtimeAgentBinding(workflows, execution.agent.name) : null;
      const projectedExecution =
        execution.kind === 'action'
          ? {
              kind: 'action' as const,
              action: execution.operation.id,
              contract_version: execution.operation.contractVersion,
              provider: execution.operation.provider,
            }
          : {
              kind: 'agent' as const,
              agent_name: execution.agent.name,
              session: {
                scope: 'card' as const,
                identity_pattern: `agent:${execution.agent.name}:<card-id>`,
              },
              prompt: {
                source: execution.selectedAgentPrompt.source,
                declaration: {
                  reference: execution.agent.prompt.reference,
                  compactable: execution.agent.prompt.compactable,
                },
                process: projectedPrompt(execution.prompt)!,
                correction: projectedPrompt(execution.correctionPrompt)!,
              },
              model: {
                route: execution.agent.modelRoute,
                candidates: binding!.candidateChain.map(({ provider, model }) => ({
                  provider,
                  model,
                })),
                temperature: execution.agent.model.temperature,
                max_tokens: execution.agent.model.maxTokens,
              },
              skills: execution.agent.skills,
              tools: effectiveCardNodeToolReferences(
                execution.agent.tools,
                node.childCreationTypes,
              ).map((reference) => reference.name),
              record_write_patterns: execution.agent.recordWrites.map(({ source }) => source),
            };
      return {
        node_id: node.nodeId,
        execution: projectedExecution,
        child_creation_types: [...node.childCreationTypes],
        child_activation_types: [...node.childActivationTypes],
        readable_records: [...node.readableRecords.keys()],
        initialize_records: node.initializeRecords.map((record) => record.name),
        requirements: node.requirements.map((requirement) => ({
          record_name: requirement.definition.name,
          mode: requirement.mode,
          gate: requirement.gate,
        })),
        record_prompts: node.recordPrompts.map((input) => ({
          record: input.record,
          selection: input.selection,
          presence: input.presence,
          prompt: projectedPrompt(input.prompt)!,
          source: input.artifact.source,
          placeholders: input.artifact.compiled.tokens.flatMap((token) =>
            token.kind === 'placeholder' ? [token.key] : [],
          ),
        })),
        descendant_context:
          node.descendantContext === null
            ? null
            : {
                records: node.descendantContext.records.map((record) => record.name),
                require_unchanged_until_accept: node.descendantContext.requireUnchangedUntilAccept,
              },
        outcomes: processNodeOutcomes(workflow, `node:${node.nodeId}`),
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
      records: [...workflow.records.values()].map(
        ({ name, format, schema, bootstrap, initialization }) => ({
          name,
          format,
          schema,
          bootstrap,
          initialization: initialization
            ? { format_version: 1, template: redactTextForOutbound(initialization.template) }
            : null,
        }),
      ),
      entries: graphEntries,
      nodes,
      edges,
      terminals: terminals.map((terminal) => ({ terminal })),
    };
  });
  return DebugGraphsResponseSchema.parse({ global_agents: globalAgents, graphs });
}
