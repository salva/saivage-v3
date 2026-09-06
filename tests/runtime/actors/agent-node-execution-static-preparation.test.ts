import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { AgentNodeExecution } from '../../../src/runtime/actors/agent-node-execution.js';
import { initializeConversation, readConversation } from '../../../src/persistence/conversation-file.js';
import type { ConversationSessionId } from '../../../src/schemas/index.js';
import { defineTool, executedToolOutcome, OPERATIONAL_RESULT_POLICY_TEMPLATE, type InvocationSurface, type ToolProviderCleanupReason } from '../../../src/tools/invocation.js';
import { toolSucceeded } from '../../../src/contracts/tool-result.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

type FailureMode = { kind: 'capacity'; systemPrompt: string } | { kind: 'render'; error: Error };

function harness(failure: FailureMode) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-static-preparation-'));
  roots.push(projectRoot);
  mkdirSync(join(projectRoot, '.saivage', 'cards', 'project', 'conversations'), { recursive: true });
  const sessionId: ConversationSessionId = 'agent:planner:project';
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
  const card = { id: 'project', type: 'project', title: 'Project', lifecycle: { status: 'running' } };
  const node = {
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
  const process = {
    cardType: 'project',
    states: new Map<string, unknown>([
      ['entry:BACKLOG', { kind: 'entry', entry: 'BACKLOG', on: new Map([['entry:route', { targetStateId: 'node:work', reenter: false, semantic: { kind: 'entry-route', promptId: null } }]]) }],
      ['node:work', node],
    ]),
    processPrompts: new Map([['work', { text: 'node prompt' }], ['correct', { text: 'correct' }]]),
  };
  const transition = { context: { source: 'entry:BACKLOG', event: 'entry:route', target: 'node:work' }, acceptedResult: null };
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
    read: (id: string) => card,
    workflows: { cardTypes: new Map([['project', { bootstrapRecord: { name: 'brief.md' } }]]) },
    readRecordCurrent: jest.fn((_cardId: string, name: string) => {
      events.push('read-record');
      if (name === 'brief.md') return { kind: 'found', value: { projection: { headVersion: 1, currentUrl: 'record:///brief.md?card=project', artifact: { state: 'open', accepted: { content: 'brief' }, draft: { content: 'draft' } } } } };
      return { kind: 'found', value: { projection: statusRecordOpened ? { headVersion: 1, currentUrl: 'record:///status.md?card=project', artifact: { state: 'open', accepted: null, draft: null } } : null } };
    }),

    discardRecord: jest.fn(() => { events.push('discard-record'); }),
    openRecord: jest.fn(() => { events.push('open-record'); statusRecordOpened = true; }),
    listChildren: () => [],
  };
  const llm = { turn: jest.fn(async () => { events.push('turn'); throw new Error('turn sentinel'); }) };
  const execution = new AgentNodeExecution({
    projectRoot,
    cardId: 'project',
    store,
    conversations: { projectRoot },
    promptTemplates: { render: () => { if (failure.kind === 'render') throw failure.error; return failure.systemPrompt; } },
    compactionConfig: { input_budget_tokens: 1_000, trigger_fraction: 0.7, completion_reserve_fraction: 0.2, merge_line_fraction: 0.2, summary_line_fraction: 0.4, escalate_merge_line_fraction: 0.3, escalate_summary_line_fraction: 0.5, snap: 'keep_straddler_verbatim' },
    processRunner: { createDirectScope: jest.fn(() => ({})) },
    runtimeProcessRootScope: {},
    workflows: { agentBindings: new Map([['planner', { toolSet: { requiresProcessScope: false }, contract: { model: { temperature: 0, maxTokens: 100 } }, candidateChain: [{ provider: 'test', account: null, model: 'planner-model' }], capabilityRequest: {} }]]) },
  } as never, {
    createLlm: () => llm,
    selectLlm: () => undefined,
    freshInputId: () => '00000000-0000-4000-8000-000000000001',
    assertCurrentActivation: () => undefined,
    assertPromotionAvailable: () => undefined,
  } as never);
  const surfaceOverride = execution as unknown as { buildSurface: (...args: unknown[]) => InvocationSurface };
  surfaceOverride.buildSurface = () => surface;
  const run = () => execution.execute({ process, stateId: 'node:work', node, transition, input, signal: new AbortController().signal, nodeOrdinal: 0 } as never);
  return { events, cleanupReasons, llm, store, removeNotifications, selectNotifications, projectRoot, sessionId, run };
}

describe('AgentNodeExecution static preparation', () => {
  it('rejects a static capacity failure before every durable node-entry effect', async () => {
    const test = harness({ kind: 'capacity', systemPrompt: 'x'.repeat(8_000) });

    await expect(test.run()).rejects.toThrow(/does not fit the compaction budget/u);

    expect(readConversation(test.projectRoot, test.sessionId).sourceRows).toEqual([]);
    expect(test.store.discardRecord).not.toHaveBeenCalled();
    expect(test.store.discardRecord).not.toHaveBeenCalled();
    expect(test.store.openRecord).not.toHaveBeenCalled();
    expect(test.removeNotifications).not.toHaveBeenCalled();
    expect(test.llm.turn).not.toHaveBeenCalled();
    expect(test.events).toEqual(['read-record', 'cleanup']);
    expect(test.cleanupReasons).toEqual([{ kind: 'activation_settled', status: 'failed' }]);
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
    expect(readConversation(test.projectRoot, test.sessionId).sourceRows.length).toBeGreaterThan(0);
    expect(test.cleanupReasons).toEqual([{ kind: 'activation_settled', status: 'failed' }]);
  });
});
