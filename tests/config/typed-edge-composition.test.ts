import { describe, expect, it } from '@jest/globals';
import { agentExecution } from '../helpers/workflow-execution.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';
import { resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { compileProjectWorkflows, describeNodeResultContract, processNodeOutcomes, type CompiledCardTypeWorkflow, type CompiledNodeContract } from '../../src/runtime/card-process/card-process-config.js';
import { createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';
import { AgentExecutor } from '../../src/runtime/actors/agent-executor.js';
import type { NodeTransition, AcceptedNodeResult } from '../../src/runtime/actors/node-execution.js';
import type { CardActivationInput } from '../../src/runtime/actors/card-activation-owner.js';
import type { ContextBlock } from '../../src/contracts/index.js';
import { buildUserContextMessage } from '../../src/runtime/actors/conversation-session.js';
import { composeContextProjection, providerConversationFromComposedContext } from '../../src/runtime/actors/context/composition-projector.js';
import { agentMessageSchema, DURABLE_PRIMARY_CONTENT_POLICY, STRUCTURAL_ROW_POLICY, sha256Hex, type AgentMessage, type ConversationSessionId } from '../../src/schemas/index.js';
import { validateConversation } from '../../src/contracts/conversation-validation.js';
import { createSequentialRefineAccumulator } from '../../src/runtime/actors/compaction/refine-accumulator.js';
import type { SummarizerProviderPort } from '../../src/runtime/actors/compaction/summarizer.js';

const INPUT = '11111111-1111-4111-8111-111111111111';
const SESSION: ConversationSessionId = 'agent:executor:card-a';
const renderer = new AgentExecutor({} as never, {} as never) as unknown as {
  transitionContext(process: CompiledCardTypeWorkflow, transition: NodeTransition): readonly { role: 'user'; content: string }[];
  nodeStableBlocks(input: CardActivationInput, node: CompiledNodeContract, text: string): { card: ContextBlock; node: ContextBlock; parent: ContextBlock | null };
};
const routes = [
  ['code', 'green', 'still_red', 'green', null],
  ['research', 'explore', 'evidence_ready', 'assess', null],
  ['test', 'diagnose', 'coverage_ready', 'verify', 'test-to-verify'],
  ['test', 'add-coverage', 'coverage_passing', 'verify', 'test-to-verify'],
  ['test', 'repair', 'tests_passing', 'verify', 'test-to-verify'],
] as const;

function node(process: CompiledCardTypeWorkflow, id: string): CompiledNodeContract {
  const state = process.states.get(`node:${id}`);
  if (state?.kind !== 'node') throw new Error(`Missing ${process.cardType}/${id}`);
  return state;
}

function transition(process: CompiledCardTypeWorkflow, source: string, outcome: string, version: number): NodeTransition {
  const from = node(process, source);
  const route = from.on.get(`result:${outcome}`)!;
  const acceptedResult: AcceptedNodeResult = {
    nodeOrdinal: version, source: null, nodeId: source,
    executor: { kind: 'agent', agent: agentExecution(from).agent.name },
    values: {}, outcome, event: `result:${outcome}`,
    summary: `Synthetic accepted visit ${version}: ${source}/${outcome}; unresolved obligation O-1; effects U-1 unknown.`,
    acceptedRecords: from.requirements.map(({ definition: { name } }) =>
      ({ name, url: `record:///${name}?card=card-a&v=${version}`, version })),
  };
  return { context: { source: `node:${source}`, event: acceptedResult.event, target: route.targetStateId }, acceptedResult } as NodeTransition;
}

function initialRows(): AgentMessage[] {
  const base = { session_id: SESSION, round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: '2026-11-14T00:00:00.000Z' };
  return [
    agentMessageSchema.parse({ ...base, id: 'boundary', role: 'system', kind: 'activity', context_policy: STRUCTURAL_ROW_POLICY.activation_boundary,
      content: JSON.stringify({ event: 'activation_open', instructions: { kind: 'unavailable', reason: 'not_recorded' }, agent_name: 'executor', card_id: 'card-a', input_id: INPUT, timestamp: base.timestamp }) }),
    agentMessageSchema.parse({ ...base, id: 'obligation', role: 'user', kind: 'text', context_policy: DURABLE_PRIMARY_CONTENT_POLICY,
      content: 'Synthetic parent obligation O-1 unresolved; prior check failed; interrupted effects U-1 unknown.' }),
  ];
}

async function summaryRequest(rows: AgentMessage[], preparedBlocks: ContextBlock[]) {
  let captured: Parameters<SummarizerProviderPort['completeTurn']>[0] | undefined;
  const stop = new Error('Offline request captured');
  const accumulator = createSequentialRefineAccumulator({
    conversation: validateConversation(SESSION, rows), inheritedHistory: null, preparedBlocks,
    summarizerProvider: {
      candidate: { provider: 'test', account: null, model: 'capture-only' }, contextWindowTokens: 1_000_000, maxOutputTokens: 10_000,
      serializeSummaryRequest(input) {
        const serializedRequest = JSON.stringify(input.providerConversation.messages);
        return { serializedRequest, requestSha256: sha256Hex(serializedRequest), estimatedInputTokens: Buffer.byteLength(serializedRequest) / 4, imageCount: 0 };
      },
      async completeTurn(input) { captured = input; throw stop; },
      async materializeImage() { throw new Error('Unexpected image'); },
      projectProviderExchanges() { throw new Error('Unexpected exchange'); },
    },
    budget: { contextUtilizationFraction: 0.8 }, signal: new AbortController().signal, progress: noCompactionProgress,
  });
  await expect(accumulator.materializeThrough(rows.length)).rejects.toBe(stop);
  expect(captured).toBeDefined();
  return captured!;
}

describe.each(['classic-typed', 'paad-typed', 'newloop', 'newloop2'] as const)('%s typed edge composition', profile => {
  const template = resolveSystemTemplate(profile);
  const workflows = compileProjectWorkflows(effectiveSaivageConfigSchema.parse(structuredClone(template.config)), { defaultPromptRoot: template.promptRoot });
  const registry = createPromptTemplateRegistry(workflows);

  it.each(routes)('preserves %s %s/%s -> %s acceptance and actual transition context', (type, source, outcome, target, promptId) => {
    const process = workflows.cardTypes.get(type)!;
    const from = node(process, source);
    const route = from.on.get(`result:${outcome}`)!;
    expect(route.targetStateId).toBe(`node:${target}`);
    expect(route.semantic).toMatchObject({ kind: 'configured-outcome', outcome, prompt: promptId ? { promptId } : null });
    for (const selected of [from, node(process, target)]) {
      expect(agentExecution(selected).agent.name).toBe('executor');
      expect(selected.requirements.map(({ definition, mode, gate }) => [definition.name, mode, gate]))
        .toEqual([['status.md', 'continue', 'updated']]);
      const contract = describeNodeResultContract(process, `node:${selected.nodeId}`);
      const role = registry.render({ kind: 'workflow-agent', cardType: type }, agentExecution(selected).agent.name, { contractDescription: contract });
      expect(role.split(contract)).toHaveLength(2);
      expect(processNodeOutcomes(process, `node:${selected.nodeId}`)).toEqual([...selected.on.values()]
        .flatMap(edge => edge.semantic.kind === 'configured-outcome' ? [edge.semantic.outcome] : []));
    }
    const accepted = transition(process, source, outcome, 2);
    const messages = renderer.transitionContext(process, accepted);
    expect(messages).toHaveLength(promptId ? 2 : 1);
    const facts = accepted.acceptedResult!;
    expect(messages[0]!.content).toBe(`Previous process node: ${source}\nAccepted outcome: ${outcome}\nSummary: ${facts.summary}\nRecords:\n${facts.acceptedRecords.map(record => `- ${record.url}`).join('\n')}${promptId ? '\n\n' : ''}`);
    if (route.semantic.kind === 'configured-outcome' && route.semantic.prompt)
      expect(messages[1]!.content).toBe(process.processPrompts.get(route.semantic.prompt.promptId)!.text);
  });

  it.each([
    ['code', [['green', 'still_red'], ['green', 'still_red']], 'green'],
    ['code', [['green', 'still_red'], ['green', 'green']], 'refactor'],
    ['research', [['explore', 'evidence_ready'], ['assess', 'evidence_gap']], 'explore'],
    ['research', [['explore', 'evidence_ready'], ['assess', 'evidence_gap'], ['explore', 'evidence_ready']], 'assess'],
    ['test', [['diagnose', 'coverage_ready'], ['verify', 'repair_needed']], 'repair'],
    ['test', [['diagnose', 'coverage_ready'], ['verify', 'repair_needed'], ['repair', 'tests_passing']], 'verify'],
  ] as const)('keeps %s cycle history distinct from prepared orientation', async (type, visits, destination) => {
    const process = workflows.cardTypes.get(type)!;
    const rows = initialRows();
    const transitions = visits.map(([source, outcome], index) => transition(process, source, outcome, index + 2));
    for (const [index, accepted] of transitions.entries()) {
      expect(accepted.context.target).toBe(`node:${visits[index + 1]?.[0] ?? destination}`);
      const messages = renderer.transitionContext(process, accepted);
      if (type === 'code' && accepted.acceptedResult!.outcome === 'still_red') expect(messages).toHaveLength(1);
      rows.push(...messages.map((message, ordinal) => buildUserContextMessage(SESSION, INPUT, 'process_transition', index * 10 + ordinal, message)));
    }
    await checkProjection(process, destination, rows, transitions);
  });

  it.each(['code', 'research', 'test'] as const)('prepares actual fresh and STOPPED %s entries without accepted-result inventions', async type => {
    const process = workflows.cardTypes.get(type)!;
    for (const entry of ['BACKLOG', 'STOPPED']) {
      const route = process.states.get(`entry:${entry}`)!.on.get('entry:route')!;
      const accepted = { context: { source: `entry:${entry}`, event: 'entry:route', target: route.targetStateId }, acceptedResult: null } as NodeTransition;
      const messages = renderer.transitionContext(process, accepted);
      expect(messages).toHaveLength(entry === 'BACKLOG' ? 0 : 2);
      const rows = initialRows();
      rows.push(...messages.map((message, ordinal) => buildUserContextMessage(SESSION, INPUT, 'process_transition', ordinal, message)));
      await checkProjection(process, route.targetStateId.slice('node:'.length), rows, []);
    }
  });

  async function checkProjection(process: CompiledCardTypeWorkflow, destination: string, rows: AgentMessage[], transitions: NodeTransition[]) {
    const current = node(process, destination);
    const input = { activationId: INPUT, card: { id: 'card-a', type: process.cardType, title: 'Synthetic assignment' },
      caller: { kind: 'parent', cardId: 'project', sessionId: 'agent:planner:project', sourceInputId: INPUT, toolCallId: 'synthetic', toolName: 'activate_card', instructions: 'Synthetic unresolved parent obligation O-1.' } } as unknown as CardActivationInput;
    const blocks = renderer.nodeStableBlocks(input, current, process.processPrompts.get(agentExecution(current).prompt.promptId)!.text);
    const prepared = [blocks.card, blocks.node, blocks.parent!];
    const composed = composeContextProjection({ sourceSessionId: SESSION, effectiveHistory: null, dynamicBlocks: prepared, uncoveredRows: rows });
    const primary = providerConversationFromComposedContext(composed);
    expect(primary.messages.filter(message => message.kind === 'synthetic_context' && message.origin === 'dynamic'))
      .toEqual(prepared.map(block => expect.objectContaining({ block_identity: block.id, content: block.content })));
    expect(composed.summarizer.filter(item => item.kind === 'message').map(item => item.content))
      .toEqual(rows.slice(1).map(row => row.content));
    const summary = await summaryRequest(rows, prepared);
    expect(summary.providerConversation.messages.slice(0, prepared.length).map(message => message.content))
      .toEqual(prepared.map((block, index) => `[order ${index + 1}/${summary.providerConversation.messages.length}] [kind=prepared_context source=${block.id}]\n${block.content}`));
    const primarySource = primary.messages.filter(message => message.kind !== 'synthetic_context').map(message => message.content);
    expect(primarySource).toEqual(rows.slice(1).map(row => row.content));
    const summarySource = summary.providerConversation.messages.slice(prepared.length).map(message => message.content);
    let previous = -1;
    for (const accepted of transitions) {
      const factual = renderer.transitionContext(process, accepted)[0]!.content;
      const position = primarySource.indexOf(factual);
      expect(position).toBeGreaterThan(previous);
      previous = position;
      expect(summarySource.some(content => content.endsWith(`\n${factual}`))).toBe(true);
    }
  }
});
