import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { AgentNodeExecution } from '../../../src/runtime/actors/agent-node-execution.js';
import { resolveSystemTemplate } from '../../../src/config/system-templates/registry.js';
import { initializeConversation, readConversation } from '../../../src/persistence/conversation-file.js';
import { canonicalJson, type ConversationSessionId } from '../../../src/schemas/index.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/saivage-config.js';
import { compileProjectWorkflows, describeNodeResultContract, type CompiledNodeContract } from '../../../src/runtime/card-process/card-process-config.js';
import { defineTool, executedToolOutcome, OPERATIONAL_RESULT_POLICY_TEMPLATE, type InvocationSurface, type ToolProviderCleanupReason } from '../../../src/tools/invocation.js';
import { toolSucceeded } from '../../../src/contracts/tool-result.js';
import { createPromptTemplateRegistry, renderCompiledPrompt } from '../../../src/utils/prompt-api.js';
import { dynamicBlocksSha256 } from '../../../src/runtime/actors/context/context-blocks.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

type FailureMode = { kind: 'capacity'; systemPrompt: string } | { kind: 'render'; error: Error };

function harness(failure: FailureMode, cardType: 'project' | 'goal' = 'project', productionPlanner = false) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-static-preparation-'));
  roots.push(projectRoot);
  const cardId = cardType === 'project' ? 'project' : 'card-a';
  const cardDirectory = cardType === 'project'
    ? join(projectRoot, '.saivage', 'cards', 'project')
    : join(projectRoot, '.saivage', 'cards', 'project', 'children', 'a');
  mkdirSync(join(cardDirectory, 'conversations'), { recursive: true });
  const sessionId: ConversationSessionId = `agent:planner:${cardId}`;
  initializeConversation(projectRoot, sessionId);
  const events: string[] = [];
  const cleanupReasons: ToolProviderCleanupReason[] = [];
  const execute = jest.fn(async () => { events.push('tool-execute'); return { success: true as const, data: 'must not run' }; });
  const tool = defineTool({ name: 'lookup', description: 'lookup', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: z.object({}).strict(), executor: async () => executedToolOutcome('none', toolSucceeded((await execute()).data)) });
  const provider = {
    providerName: 'static-preparation',
    tools: [tool],
    cleanup: async (reason: ToolProviderCleanupReason) => { events.push('cleanup'); cleanupReasons.push(reason); },
  };
  const surface: InvocationSurface = { agentName: 'planner', tools: new Map([[tool.name, tool]]), providers: [provider] };
  const card = { id: cardId, type: cardType, title: cardType === 'project' ? 'Project' : 'Delivery goal', lifecycle: { status: 'running' } };
  let node = {
    kind: 'node',
    nodeId: 'work',
    promptId: 'work',
    correctionPromptId: 'correct',
    agent: { name: 'planner', tools: [], model: { temperature: 0, maxTokens: 100 } },
    requirements: [{ definition: { name: 'status.md' }, mode: 'clean', gate: 'exists' }],
    descendantContext: null,
    on: new Map(),
    childCreationTypes: new Set(),
    childActivationTypes: new Set(),
  };
  const processPromptValues = new Map([['work', { text: 'node prompt' }], ['correct', { text: 'correct' }]]);
  const processPromptGet = jest.fn((promptId: string) => processPromptValues.get(promptId));
  let process = {
    cardType,
    states: new Map<string, unknown>([
      ['entry:BACKLOG', { kind: 'entry', entry: 'BACKLOG', on: new Map([['entry:route', { targetStateId: 'node:work', reenter: false, semantic: { kind: 'entry-route', promptId: null } }]]) }],
      ['node:work', node],
    ]),
    processPrompts: { get: processPromptGet },
  };
  let transition = { context: { source: 'entry:BACKLOG', event: 'entry:route', target: 'node:work' }, acceptedResult: null };
  let stateId = 'node:work';
  let productionNode: CompiledNodeContract | null = null;
  let workflows = { agentBindings: new Map([['planner', { toolSet: { requiresProcessScope: false }, contract: { model: { temperature: 0, maxTokens: 100 } }, candidateChain: [{ provider: 'test', account: null, model: 'planner-model' }], routeUsableInputTokens: 20_000, capabilityRequest: {} }]]) };
  let promptTemplates = { render: () => { if (failure.kind === 'render') throw failure.error; return failure.systemPrompt; } };
  if (productionPlanner) {
    const template = resolveSystemTemplate('classic-typed');
    const compiled = compileProjectWorkflows(effectiveSaivageConfigSchema.parse(structuredClone(template.config)), { defaultPromptRoot: template.promptRoot, projectRoot });
    const compiledProcess = compiled.cardTypes.get(cardType)!;
    const compiledNode = compiledProcess.states.get('node:plan')!;
    if (compiledNode.kind !== 'node') throw new Error(`Missing ${cardType} Planner node.`);
    productionNode = compiledNode;
    process = compiledProcess as never;
    node = compiledNode as never;
    transition = { context: { source: 'entry:BACKLOG', event: 'entry:route', target: 'node:plan' }, acceptedResult: null };
    stateId = 'node:plan';
    workflows = { ...compiled, agentBindings: new Map([['planner', { toolSet: { requiresProcessScope: false }, contract: compiledNode.agent, candidateChain: [{ provider: 'test', account: null, model: 'planner-model' }], routeUsableInputTokens: 20_000, capabilityRequest: {} }]]) } as never;
    promptTemplates = createPromptTemplateRegistry(compiled) as never;
  }
  const selectNotifications = jest.fn(() => []);
  const removeNotifications = jest.fn(() => undefined);
  const input = {
    card,
    activationId: 'activation-1',
    notificationDelivery: { selectNotifications, removeNotifications },
    claimResult: () => { events.push('claim-result'); },
  };
  let statusRecordOpened = false;
  const store = {
    read: (_id: string) => card,
    workflows: { cardTypes: new Map([[cardType, { bootstrapRecord: { name: 'brief.md' } }]]) },
    readRecordCurrent: jest.fn((_cardId: string, name: string) => {
      events.push('read-record');
      if (name === 'brief.md') return { kind: 'found', value: { projection: { headVersion: 1, currentUrl: `record:///brief.md?card=${cardId}`, artifact: { state: 'open', accepted: { content: 'FULL ACCEPTED BRIEF\nwith all configured content' }, draft: { content: 'draft' } } } } };
      return { kind: 'found', value: { projection: statusRecordOpened ? { headVersion: 1, currentUrl: `record:///status.md?card=${cardId}`, artifact: { state: 'open', accepted: null, draft: null } } : null } };
    }),

    discardRecord: jest.fn(() => { events.push('discard-record'); }),
    openRecord: jest.fn(() => { events.push('open-record'); statusRecordOpened = true; }),
    listChildren: () => [],
  };
  const llm = { turn: jest.fn(async () => { events.push('turn'); throw new Error('turn sentinel'); }) };
  const execution = new AgentNodeExecution({
    projectRoot,
    cardId,
    store,
    conversations: { projectRoot },
    promptTemplates,
    compactionConfig: { context_utilization_fraction: 0.8, trigger_fraction: 0.7, tail_fraction: 0.25, snap: 'keep_straddler_verbatim' },
    processRunner: { createDirectScope: jest.fn(() => ({})) },
    runtimeProcessRootScope: {},
    workflows,
  } as never, {
    createLlm: () => llm,
    selectLlm: () => undefined,
    freshInputId: () => '00000000-0000-4000-8000-000000000001',
    assertCurrentActivation: () => undefined,
    assertPromotionAvailable: () => undefined,
  } as never);
  const surfaceOverride = execution as unknown as { buildSurface: (...args: unknown[]) => InvocationSurface };
  surfaceOverride.buildSurface = () => surface;
  const run = () => execution.execute({ process, stateId, node, transition, input, signal: new AbortController().signal, nodeOrdinal: 0 } as never);
  return { events, cleanupReasons, llm, store, removeNotifications, selectNotifications, projectRoot, sessionId, process, processPromptGet, node, productionNode, run };
}

describe('AgentNodeExecution static preparation', () => {
  it.each(['project', 'goal'] as const)('sends the selected Planner instruction and full frozen %s card block once on the actual initial actor request', async (cardType) => {
    const test = harness({ kind: 'capacity', systemPrompt: 'unused' }, cardType, true);
    if (!test.productionNode) throw new Error('Missing compiled Planner node.');
    const selectedNodeText = test.process.processPrompts.get(test.productionNode.promptId)?.text;
    if (!selectedNodeText) throw new Error('Missing compiled Planner process prompt.');

    await expect(test.run()).rejects.toThrow('turn sentinel');

    expect(test.llm.turn).toHaveBeenCalledTimes(1);
    const input = (test.llm.turn.mock.calls as unknown as [[unknown]])[0][0] as { systemPrompt: string; providerConversation: { messages: Array<{ kind: string; origin?: string; block_identity?: string; content: string }> } };
    const expectedInstruction = renderCompiledPrompt({ kind: 'workflow-agent', cardType }, test.productionNode.agent.name, test.productionNode.selectedAgentPrompt.compiled, { contractDescription: describeNodeResultContract(test.process as never, 'node:plan') });
    const cardId = cardType === 'project' ? 'project' : 'card-a';
    const expectedCard = canonicalJson({ cardId, cardType, title: cardType === 'project' ? 'Project' : 'Delivery goal', brief: 'FULL ACCEPTED BRIEF\nwith all configured content' });
    const expectedNode = `Current workflow node '${test.productionNode.nodeId}':\n\n${selectedNodeText}`;
    expect(test.productionNode.selectedAgentPrompt).toMatchObject({ source: 'bundled-shared', reference: 'planner' });
    expect(input.systemPrompt).toBe(expectedInstruction);
    expect(input.providerConversation.messages.slice(0, 2)).toEqual([
      expect.objectContaining({ kind: 'synthetic_context', origin: 'dynamic', block_identity: `card-activation:${cardId}`, content: expectedCard }),
      expect.objectContaining({ kind: 'synthetic_context', origin: 'dynamic', block_identity: `node-activation:${cardId}:${test.productionNode.nodeId}`, content: expectedNode }),
    ]);
    expect(input.providerConversation.messages.filter((item) => item.content === expectedCard)).toHaveLength(1);
    expect(input.providerConversation.messages.filter((item) => item.content === expectedNode)).toHaveLength(1);
    expect(input.providerConversation.messages.some((item) => item.content === expectedInstruction)).toBe(false);
    expect(expectedInstruction.split(describeNodeResultContract(test.process as never, 'node:plan'))).toHaveLength(2);
    expect(readConversation(test.projectRoot, test.sessionId).sourceRows.some((row) => row.content.includes(selectedNodeText))).toBe(false);
  });

  it('reads the selected compiled node text once before ingress and preserves it only in prepared context', async () => {
    const test = harness({ kind: 'capacity', systemPrompt: 'system' });

    await expect(test.run()).rejects.toThrow('turn sentinel');

    expect(test.processPromptGet.mock.calls.filter(([promptId]) => promptId === test.node.promptId)).toHaveLength(1);
    const input = (test.llm.turn.mock.calls as unknown as [[unknown]])[0][0] as { preparedContext: { dynamicBlocks: readonly { id: string; content: string }[]; dynamicBlocksSha256: string }; providerConversation: { messages: Array<{ content: string }> } };
    expect(input.preparedContext.dynamicBlocks.map((block) => block.id)).toEqual(['card-activation:project', 'node-activation:project:work']);
    expect(input.preparedContext.dynamicBlocks[1].content).toBe("Current workflow node 'work':\n\nnode prompt");
    expect(input.preparedContext.dynamicBlocksSha256).toBe(dynamicBlocksSha256(input.preparedContext.dynamicBlocks as never));
    expect(input.providerConversation.messages.filter((item) => item.content.endsWith('node prompt'))).toHaveLength(1);
    expect(readConversation(test.projectRoot, test.sessionId).sourceRows.some((row) => row.content.includes('node prompt'))).toBe(false);
  });

  it('rejects a static capacity failure before every durable node-entry effect', async () => {
    const test = harness({ kind: 'capacity', systemPrompt: 'x'.repeat(120_000) });

    await expect(test.run()).rejects.toThrow(/does not fit the route usable-input capacity/u);

    expect(readConversation(test.projectRoot, test.sessionId).sourceRows).toEqual([]);
    expect(test.store.discardRecord).not.toHaveBeenCalled();
    expect(test.store.openRecord).not.toHaveBeenCalled();
    expect(test.removeNotifications).not.toHaveBeenCalled();
    expect(test.llm.turn).not.toHaveBeenCalled();
    expect(test.events).toEqual(['read-record', 'cleanup']);
    expect(test.cleanupReasons).toEqual([{ kind: 'activation_settled', status: 'failed' }]);
  });

  it('fails directly on missing selected compiled node text before reads or ingress', async () => {
    const test = harness({ kind: 'capacity', systemPrompt: 'system' });
    test.processPromptGet.mockReturnValueOnce(undefined);

    await expect(test.run()).rejects.toThrow("Compiled workflow 'project' has no process prompt 'work'.");

    expect(readConversation(test.projectRoot, test.sessionId).sourceRows).toEqual([]);
    expect(test.events).toEqual([]);
    expect(test.store.readRecordCurrent).not.toHaveBeenCalled();
    expect(test.selectNotifications).not.toHaveBeenCalled();
  });

  it('rejects a prompt-render failure before every durable node-entry effect', async () => {
    const renderFailure = new Error('prompt render sentinel');
    const test = harness({ kind: 'render', error: renderFailure });

    await expect(test.run()).rejects.toBe(renderFailure);

    expect(readConversation(test.projectRoot, test.sessionId).sourceRows).toEqual([]);
    expect(test.store.discardRecord).not.toHaveBeenCalled();
    expect(test.store.openRecord).not.toHaveBeenCalled();
    expect(test.removeNotifications).not.toHaveBeenCalled();
    expect(test.llm.turn).not.toHaveBeenCalled();
    expect(test.events).toEqual(['read-record', 'cleanup']);
    expect(test.cleanupReasons).toEqual([{ kind: 'activation_settled', status: 'failed' }]);
  });

  it('performs durable node entry only after preparation succeeds', async () => {
    const test = harness({ kind: 'capacity', systemPrompt: 'system' });

    await expect(test.run()).rejects.toThrow('turn sentinel');

    expect(test.events).toEqual(['read-record', 'read-record', 'open-record', 'read-record', 'turn', 'cleanup']);
    expect(readConversation(test.projectRoot, test.sessionId).sourceRows).toEqual([
      expect.objectContaining({ kind: 'activity', role: 'system' }),
    ]);
    expect(test.cleanupReasons).toEqual([{ kind: 'activation_settled', status: 'failed' }]);
  });
});
