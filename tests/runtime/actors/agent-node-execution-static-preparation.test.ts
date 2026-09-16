import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { AgentNodeExecution } from '../../../src/runtime/actors/agent-node-execution.js';
import { resolveSystemTemplate } from '../../../src/config/system-templates/registry.js';
import { initializeConversation, readConversation, readCurrentConversationSegment, type ConversationFileContext } from '../../../src/persistence/conversation-file.js';
import { canonicalJson, type ConversationSessionId } from '../../../src/schemas/index.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/saivage-config.js';
import { compileProjectWorkflows, describeNodeResultContract, type CompiledNodeContract } from '../../../src/runtime/card-process/card-process-config.js';
import { defineTool, executedToolOutcome, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE, type InvocationSurface, type ToolProviderCleanupReason } from '../../../src/tools/invocation.js';
import { toolSucceeded } from '../../../src/contracts/tool-result.js';
import { createPromptTemplateRegistry, renderCompiledPrompt } from '../../../src/utils/prompt-api.js';
import { dynamicBlocksSha256 } from '../../../src/runtime/actors/context/context-blocks.js';
import { appendActivationMarker } from '../../../src/runtime/actors/conversation-session.js';
import { appendLlmTurnToolCallBatch, type InvocationResultPolicy } from '../../../src/runtime/actors/llm-delivery-log.js';
import { conversationSha256 } from '../../../src/persistence/canonical-conversation-artifacts.js';
import { cardConversationVersionFile } from '../../../src/persistence/layout.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/publication-outcome.js';
import { deterministicRoundId } from '../../../src/schemas/round-id-server.js';
import { validateConversation } from '../../../src/contracts/conversation-validation.js';

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
  let conversationChanged: (target: { visible_message_id: string | null }) => void = () => undefined;
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
    notificationDelivery: { hasPendingNotifications: () => selectNotifications().length > 0, selectNotifications, removeNotifications },
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
    conversations: { projectRoot, changes: { conversationChanged: (target: Parameters<NonNullable<ConversationFileContext['changes']>['conversationChanged']>[0]) => conversationChanged(target), agentMembershipChanged: () => undefined } },
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
  return { events, cleanupReasons, llm, store, removeNotifications, selectNotifications, projectRoot, sessionId, process, processPromptGet, node, productionNode, run, onConversationChanged: (callback: typeof conversationChanged) => { conversationChanged = callback; } };
}

const READ_POLICY: InvocationResultPolicy = (() => { const bytes = canonicalJson(OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE); return { resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, resultPolicyTemplateBytes: bytes, resultPolicyTemplateSha256: conversationSha256(bytes) }; })();
function seedUnmatched(test: ReturnType<typeof harness>, inputId = '00000000-0000-4000-8000-000000000031') {
  appendActivationMarker({ projectRoot: test.projectRoot }, test.sessionId, { event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: inputId });
  appendLlmTurnToolCallBatch({ projectRoot: test.projectRoot }, { inputId, sessionId: test.sessionId, agentName: 'planner' } as never, { id: 'old-read', type: 'function', function: { name: 'read', arguments: '{"path":"work:///"}' } }, READ_POLICY);
}
function appendRawRows(test: ReturnType<typeof harness>, rows: readonly unknown[]): void {
  const segment = readCurrentConversationSegment(test.projectRoot, test.sessionId)!;
  appendFileSync(cardConversationVersionFile(test.projectRoot, 'project', 'planner', segment.entry.filename), `${JSON.stringify({ version: 1, type: 'conversation-segment', rows })}\n`);
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

  it('settles one strict-valid final unmatched call immediately before a fresh activation', async () => {
    const test = harness({ kind: 'capacity', systemPrompt: 'system' });
    seedUnmatched(test);
    await expect(test.run()).rejects.toThrow('turn sentinel');
    const rows = readConversation(test.projectRoot, test.sessionId).physicalRows;
    const result = rows.findIndex((row) => row.kind === 'tool_result' && row.tool_call_id === 'old-read');
    expect(result).toBeGreaterThan(0);
    expect(JSON.parse(rows[result]!.content)).toEqual({ success: false, error: 'Prior activation ended without a recorded tool result. External or domain effects may or may not have happened. The prior call will not be replayed.', data: { outcome_unknown: true } });
    expect(rows[result]).toMatchObject({ tool: 'read', context_policy: { settlement_origin: 'execution_failed', call_policy_sha256: READ_POLICY.resultPolicyTemplateSha256, evidence: { kind: 'none' } } });
    expect(rows[result + 1]).toMatchObject({ kind: 'activity' });
    expect(rows.some((row) => row.kind === 'model_recovered')).toBe(false);
  });

  it.each(['complete malformed data', 'nonfinal unmatched call', 'multiple unmatched calls'] as const)('strictly rejects %s before activation or provider invocation', async (fixture) => {
    const test = harness({ kind: 'capacity', systemPrompt: 'system' });
    seedUnmatched(test);
    const segment = readCurrentConversationSegment(test.projectRoot, test.sessionId)!;
    const segmentPath = cardConversationVersionFile(test.projectRoot, 'project', 'planner', segment.entry.filename);
    if (fixture === 'complete malformed data') {
      appendFileSync(segmentPath, '{"version":1,"type":"conversation-segment","rows":[{"broken":true}]}\n');
    } else if (fixture === 'nonfinal unmatched call') {
      const marker = readConversation(test.projectRoot, test.sessionId).physicalRows[0]!;
      appendRawRows(test, [{ ...marker, id: `${marker.id}-later`, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: '00000000-0000-4000-8000-000000000032', timestamp: marker.timestamp }) }]);
    } else {
      const call = readConversation(test.projectRoot, test.sessionId).physicalRows[1]!;
      const secondInput = '00000000-0000-4000-8000-000000000033';
      const secondCall = { ...call, id: `${secondInput}:tool-call:second-read`, tool_call_id: 'second-read', round_id: deterministicRoundId('assistant', secondInput), content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'second-read', type: 'function', function: { name: 'read', arguments: '{"path":"work:///"}' } }] }) };
      const existing = readConversation(test.projectRoot, test.sessionId).physicalRows;
      expect(() => validateConversation(test.sessionId, [...existing, secondCall])).toThrow('Conversation contains more than one unmatched tool call.');
      appendRawRows(test, [secondCall]);
    }
    const corruptBytes = readFileSync(segmentPath);
    await expect(test.run()).rejects.toThrow(fixture === 'multiple unmatched calls' ? /more than one unmatched tool call/u : /malformed|invalid|unmatched/u);
    expect(test.llm.turn).not.toHaveBeenCalled();
    expect(test.events).not.toContain('turn');
    expect(readFileSync(segmentPath)).toEqual(corruptBytes);
  });

  it('treats uncertainty after the settlement append as fatal with no entry or cleanup follow-up', async () => {
    const test = harness({ kind: 'capacity', systemPrompt: 'system' });
    seedUnmatched(test);
    const failure = new PublicationOutcomeUnknownError();
    let publications = 0;
    test.onConversationChanged(({ visible_message_id }) => { publications += 1; if (visible_message_id?.endsWith(':tool-result:old-read')) throw failure; });
    await expect(test.run()).rejects.toBe(failure);
    expect(publications).toBe(1);
    expect(test.llm.turn).not.toHaveBeenCalled();
    expect(test.cleanupReasons).toEqual([]);
    expect(test.store.discardRecord).not.toHaveBeenCalled();
    const rows = readConversation(test.projectRoot, test.sessionId).physicalRows;
    expect(rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'old-read')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'activity')).toHaveLength(1);
  });

  it('treats uncertainty after the following activation append as fatal without replaying settlement', async () => {
    const test = harness({ kind: 'capacity', systemPrompt: 'system' });
    seedUnmatched(test);
    const failure = new PublicationOutcomeUnknownError();
    let publications = 0;
    test.onConversationChanged(() => { publications += 1; if (publications === 2) throw failure; });
    await expect(test.run()).rejects.toBe(failure);
    expect(publications).toBe(2);
    expect(test.llm.turn).not.toHaveBeenCalled();
    expect(test.cleanupReasons).toEqual([]);
    expect(test.store.discardRecord).not.toHaveBeenCalled();
    const rows = readConversation(test.projectRoot, test.sessionId).physicalRows;
    expect(rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'old-read')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'activity')).toHaveLength(2);
  });
});
