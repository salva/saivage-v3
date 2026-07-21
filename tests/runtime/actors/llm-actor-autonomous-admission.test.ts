import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationLLMActor, type CompactorPort, type LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';
import { prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import type { PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { InvocationService } from '../../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../../src/agents/candidate-availability.js';
import { ProviderTurnFailure } from '../../../src/agents/llm-contracts.js';
import { ReadModelChangeBroadcaster } from '../../../src/application/read-model-changes.js';
import { testAppLogs } from '../../helpers/app-logs.js';
import { invocationProviderRegistry } from '../../helpers/invocation-provider-fixture.js';

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('prepared conversation LLM admission', () => {
  it('constructs one exact complete tool context and projects only supervisor-admitted child waiting', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-llm-child-context-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    let providerCalls = 0;
    const actor = toolCallingActor(projectRoot, async () => {
      providerCalls += 1;
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-call', type: 'function' as const, function: { name: 'activate_card', arguments: '{"card_id":"card-a"}' } }] }, provider_exchanges: [] };
    });
    const outcome = await actor.turn(preparedInput());
    if (outcome.type !== 'tool_call') throw new Error('Expected a tool call.');

    const context = actor.toolInvocationContext(outcome);
    expect(context).toBe(actor.toolInvocationContext(outcome));
    expect(context).toMatchObject({ sessionId: 'planner:project', sourceInputId: outcome.inputId, toolCallId: 'activate-call', toolName: 'activate_card' });
    expect(context.childInvocation.identity).toEqual({ sessionId: 'planner:project', sourceInputId: outcome.inputId, toolCallId: 'activate-call', toolName: 'activate_card' });
    const lease = context.childInvocation.reserveChild('card-a');
    expect(context.childInvocation.reserveChild('card-a')).toBe(lease);
    expect(() => context.childInvocation.reserveChild('card-b')).toThrow(/already reserved child/);
    expect(actor.executingActivity()).toEqual({ mode: 'active', barrier: null });

    lease.markAdmitted();
    expect(actor.executingActivity()).toEqual({ mode: 'waiting', barrier: { kind: 'child', relationship: expect.objectContaining({ childCardId: 'card-a', toolCallId: 'activate-call' }) } });
    expect(() => actor.settleToolResultWithoutContinuation('activate-call', { success: true })).toThrow(/child lease is 'admitted'/);
    expect(() => actor.assertInvocationCanHandoff()).toThrow(/cannot hand off/);
    expect(() => actor.abandonParkedTurn()).toThrow(/child invocation lease/);

    const order: string[] = [];
    lease.markSettling();
    lease.markReleased();
    lease.activation.then(() => order.push('lease-resolved'));
    order.push('ownership-invalidated');
    lease.deliverOutcome({ status: 'done', summary: 'done', result: { kind: 'done', summary: 'done' } });
    await lease.activation;
    expect(order).toEqual(['ownership-invalidated', 'lease-resolved']);
    actor.settleToolResultWithoutContinuation('activate-call', { success: true });
    expect(providerCalls).toBe(1);
  });

  it('rejects foreign tool outcomes and keeps publication-unknown leases unsettled through actor disposal', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-llm-child-unknown-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const actor = toolCallingActor(projectRoot, async () => ({ result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-call', type: 'function' as const, function: { name: 'activate_card', arguments: '{}' } }] }, provider_exchanges: [] }));
    const outcome = await actor.turn(preparedInput());
    if (outcome.type !== 'tool_call') throw new Error('Expected a tool call.');
    expect(() => actor.toolInvocationContext({ ...outcome, agentId: 'planner:card-a' })).toThrow(/belongs to/);
    expect(() => actor.toolInvocationContext({ ...outcome, inputId: 'stale-input' })).toThrow(/does not match/);
    expect(() => actor.toolInvocationContext({ ...outcome, toolName: 'other' })).toThrow(/does not match/);

    const lease = actor.toolInvocationContext(outcome).childInvocation.reserveChild('card-a');
    lease.markAdmitted();
    lease.markPublicationUnknown();
    let settled = false;
    void lease.activation.then(() => { settled = true; }, () => { settled = true; });
    actor.disposeInvocations(new Error('owner disposal'));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(actor.executingActivity()).toMatchObject({ mode: 'waiting', barrier: { kind: 'child' } });
    lease.markContained();
    lease.deliverInterruption(new Error('contained'));
    await expect(lease.activation).rejects.toThrow('contained');
  });

  it('persists and publishes inside the admitted raw callback before consumer delivery', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-llm-order-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const trace: string[] = [];
    const actor = new ConversationLLMActor({
      projectRoot,
      agentId: 'planner:project',
      provider: {
        completeTurn: async () => {
          trace.push('provider/aggregation return');
          return { result: { kind: 'message', content: 'done' }, provider_exchanges: [exchangeAttempt()] };
        },
        projectProviderExchanges: () => {
          trace.push('provider-exchange app-log append');
          trace.push('post-append read-model hint');
        },
      },
      conversations: {
        projectRoot,
        observeEntry: (entry) => {
          if (entry.role === 'assistant') trace.push('actor conversation persistence');
        },
      },
      compactor: { shouldCompact: () => false, compact: jest.fn<CompactorPort['compact']>() },
      summarizerProvider: { completeTurn: jest.fn<LLMProviderPort['completeTurn']>(), projectProviderExchanges: jest.fn() },
    });
    actor.start();

    const turn = actor.turn(preparedInput());
    turn.then(() => { trace.push('consumer delivery'); });
    await expect(turn).resolves.toMatchObject({ type: 'result', result: { kind: 'message', content: 'done' } });

    expect(trace).toEqual([
      'provider/aggregation return',
      'actor conversation persistence',
      'provider-exchange app-log append',
      'post-append read-model hint',
      'consumer delivery',
    ]);
  });

  it('abandons unresolved provider work immediately and fences its later completion from actor effects', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-llm-abandoned-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    let releaseProvider!: () => void;
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const providerSettled = jest.fn();
    let finishInternal!: () => void;
    const internalDone = new Promise<void>((resolve) => { finishInternal = resolve; });
    const project = jest.fn();
    let internalFailure: ProviderTurnFailure | undefined;
    const candidate = { provider: 'test', account: null, model: 'model' } as const;
    jest.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      providerStarted();
      return new Promise((_resolve, reject) => {
        releaseProvider = () => reject(init?.signal?.reason);
      });
    });
    const invocationService = new InvocationService({
      projectRoot,
      appLogs: testAppLogs(projectRoot),
      readModelChanges: new ReadModelChangeBroadcaster(),
      registry: invocationProviderRegistry([candidate]),
      router: { getLastCapabilitySkips: () => [] } as never,
      candidateAvailability: new MemoryCandidateAvailability(),
    });
    const actor = new ConversationLLMActor({
      projectRoot,
      agentId: 'planner:project',
      provider: {
        completeTurn: (input, signal) => invocationService.invokeWithRecovery({ ...input, abortSignal: signal, candidateChain: [candidate] }).catch((error) => {
          if (error instanceof ProviderTurnFailure) internalFailure = error;
          providerSettled();
          finishInternal();
          throw error;
        }),
        projectProviderExchanges: project,
      },
      conversations: { projectRoot },
      compactor: { shouldCompact: () => false, compact: jest.fn<CompactorPort['compact']>() },
      summarizerProvider: { completeTurn: jest.fn<LLMProviderPort['completeTurn']>(), projectProviderExchanges: jest.fn() },
    });
    actor.start();
    const controller = new AbortController();
    const reason = new Error('owner stopped');
    const turn = actor.turn(preparedInput(), controller.signal);
    await started;
    controller.abort(reason);
    await expect(turn).rejects.toBe(reason);

    releaseProvider();
    await internalDone;

    expect(providerSettled).toHaveBeenCalledTimes(1);
    expect(internalFailure).toMatchObject({ provider_exchanges: [{ attempt_index: 0, status: 'error', error: { name: 'Error', message: 'owner stopped' } }] });
    expect(project).not.toHaveBeenCalled();
    expect(readConversation(projectRoot, 'planner:project').physicalRows).not.toContainEqual(expect.objectContaining({ role: 'assistant', content: 'late' }));
  });

  it.each([
    'analyst:global',
    'planner:project',
    'reviewer:card-a',
    'executor:card-a-b',
  ])('admits canonical session %s at construction', (agentId) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-llm-identity-'));
    roots.push(projectRoot);
    const providerCall = jest.fn<LLMProviderPort['completeTurn']>();
    const shouldCompact = jest.fn<CompactorPort['shouldCompact']>();
    const compact = jest.fn<CompactorPort['compact']>();
    const summarize = jest.fn<LLMProviderPort['completeTurn']>();
    const projectionChanged = jest.fn();

    const actor = new ConversationLLMActor({
      projectRoot,
      agentId,
      provider: { completeTurn: providerCall },
      conversations: { projectRoot },
      compactor: { shouldCompact, compact },
      summarizerProvider: { completeTurn: summarize, projectProviderExchanges: jest.fn() },
      runtimeProjectionChanged: projectionChanged,
    });

    expect(actor.agentId).toBe(agentId);
    expect(readdirSync(projectRoot)).toEqual([]);
    expect(providerCall).not.toHaveBeenCalled();
    expect(shouldCompact).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(projectionChanged).not.toHaveBeenCalled();
  });

  it.each([
    'card:project',
    'processor:project',
    'analyst:test',
    'planner:',
    'planner:card-A',
    'reviewer:card-a-b-c-d-e-f',
    'executor:project:extra',
  ])('rejects noncanonical session %s at construction without side effects', (agentId) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-llm-identity-'));
    roots.push(projectRoot);
    const providerCall = jest.fn<LLMProviderPort['completeTurn']>();
    const shouldCompact = jest.fn<CompactorPort['shouldCompact']>();
    const compact = jest.fn<CompactorPort['compact']>();
    const summarize = jest.fn<LLMProviderPort['completeTurn']>();
    const projectionChanged = jest.fn();

    expect(() => new ConversationLLMActor({
      projectRoot,
      agentId,
      provider: { completeTurn: providerCall },
      conversations: { projectRoot },
      compactor: { shouldCompact, compact },
      summarizerProvider: { completeTurn: summarize, projectProviderExchanges: jest.fn() },
      runtimeProjectionChanged: projectionChanged,
    })).toThrow('Expected an exact canonical conversation session id.');

    expect(readdirSync(projectRoot)).toEqual([]);
    expect(providerCall).not.toHaveBeenCalled();
    expect(shouldCompact).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(projectionChanged).not.toHaveBeenCalled();
  });

  it('rejects cast unprepared input before transition, persistence, projection, or downstream calls', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-autonomous-admission-'));
    roots.push(projectRoot);
    const providerCall = jest.fn<LLMProviderPort['completeTurn']>();
    const shouldCompact = jest.fn<CompactorPort['shouldCompact']>();
    const compact = jest.fn<CompactorPort['compact']>();
    const summarize = jest.fn<LLMProviderPort['completeTurn']>();
    const projectionChanged = jest.fn();
    const actor = new ConversationLLMActor({
      projectRoot,
      agentId: 'planner:project',
      provider: { completeTurn: providerCall },
      conversations: { projectRoot },
      compactor: { shouldCompact, compact },
      summarizerProvider: { completeTurn: summarize, projectProviderExchanges: jest.fn() },
      runtimeProjectionChanged: projectionChanged,
    });
    actor.start();
    projectionChanged.mockClear();
    const input: LlmInvocationInput = {
      inputId: '00000000-0000-4000-8000-000000000001', agentId: actor.agentId, role: 'planner', sessionId: 'planner:project',
      systemPrompt: 'system', providerConversation: { sourceSessionId: 'planner:project', messages: [] }, tools: [], terminalToolNames: [],
      modelParams: { maxTokens: 100 }, capabilityRequest: {}, episodeContext: {},
    };

    await expect(actor.turn(input as never)).rejects.toThrow(/requires prepared compaction/);
    expect(actor.state()).toBe('idle');
    await expect(actor.awaitPendingTurn()).rejects.toThrow(/no pending provider turn/);
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toEqual([]);
    expect(projectionChanged).not.toHaveBeenCalled();
    expect(shouldCompact).not.toHaveBeenCalled();
    expect(compact).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(providerCall).not.toHaveBeenCalled();
  });
});

function toolCallingActor(projectRoot: string, completeTurn: LLMProviderPort['completeTurn']): ConversationLLMActor {
  const actor = new ConversationLLMActor({
    projectRoot,
    agentId: 'planner:project',
    provider: { completeTurn },
    conversations: { projectRoot },
    compactor: { shouldCompact: () => false, compact: jest.fn<CompactorPort['compact']>() },
    summarizerProvider: { completeTurn: jest.fn<LLMProviderPort['completeTurn']>(), projectProviderExchanges: jest.fn() },
  });
  actor.start();
  return actor;
}

function preparedInput(): PreparedLlmInvocationInput {
  const systemPrompt = 'system';
  return {
    inputId: '00000000-0000-4000-8000-000000000001',
    agentId: 'planner:project',
    role: 'planner',
    sessionId: 'planner:project',
    systemPrompt,
    providerConversation: { sourceSessionId: 'planner:project', messages: [] },
    tools: [],
    terminalToolNames: [],
    modelParams: {},
    preparedCompaction: prepareCompaction({ input_budget_tokens: 10_000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'compact_straddler' }, systemPrompt, []),
    capabilityRequest: {},
    episodeContext: {},
  };
}

function exchangeAttempt() {
  return {
    contract_id: 'planner.v1',
    contract_name: 'planner',
    transport: 'generic' as const,
    provider: 'test',
    model: 'model',
    source_input_id: '00000000-0000-4000-8000-000000000001',
    request_params: {},
    started_at: '2026-07-20T00:00:00.000Z',
    completed_at: '2026-07-20T00:00:00.001Z',
    status: 'ok' as const,
    response_status: 200,
    terminal_tool_fired: null,
  };
}
