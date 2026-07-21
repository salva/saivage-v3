import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderTurnFailure, type LlmCompleteResult, type ProviderTurnCompletion } from '../../../src/agents/llm-contracts.js';
import { CardService } from '../../../src/cards/card-service.js';
import { LlmRequestError } from '../../../src/contracts/llm-failure.js';
import type { ProviderExchangeAttempt } from '../../../src/contracts/provider-exchange.js';
import { appendConversationBatch, readConversation } from '../../../src/persistence/conversation-file.js';
import { agentMessageSchema, parseConversationSessionId, type AgentMessage, type OperationalAgentRole, type ConversationSessionId } from '../../../src/schemas/index.js';
import { CompactionAppendError, CompactionSummaryConstructionError, prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import { SummarizerExchangeProjectionError } from '../../../src/runtime/actors/compaction/summarizer.js';
import { ConversationLLMActor, type CompactorPort, type LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import type { LlmInvocationInput, PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { appendAnalystIngressBatch } from '../../../src/runtime/actors/conversation-session.js';
import { initProjectTree } from '../../helpers/canonical-project.js';

const roots: string[] = [];
const INITIAL_INPUT_ID = '00000000-0000-4000-8000-000000000001';
afterEach(() => { jest.restoreAllMocks(); while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('ConversationLLMActor last-chance context recovery', () => {
  it.each([
    ['planner', 'planner:project'],
    ['reviewer', 'reviewer:project'],
    ['executor', 'executor:card-a'],
    ['analyst', 'analyst:global'],
  ] as Array<[OperationalAgentRole, ConversationSessionId]>)('recovers one %s logical input with one compacted retry and singular persistence', async (role, agentId) => {
    const source = message(agentId, 'source', 'user', 'original source');
    const trigger = message(agentId, 'trigger', 'user', 'logical input');
    const firstProjection = { sourceSessionId: agentId, messages: [source, trigger] };
    const compactedProjection = { sourceSessionId: agentId, messages: [message(agentId, 'compacted', 'system', 'smaller')] };
    const providerCalls: LlmInvocationInput[] = [];
    const ordering: string[] = [];
    const project = jest.fn<NonNullable<LLMProviderPort['projectProviderExchanges']>>();
    const provider: LLMProviderPort = {
      completeTurn: jest.fn<LLMProviderPort['completeTurn']>(async (input) => {
        ordering.push(`provider-${providerCalls.length + 1}`);
        providerCalls.push(input);
        if (providerCalls.length === 1) throw contextFailure(input, 'first context');
        return completion(input, { kind: 'message', content: 'done' });
      }),
      projectProviderExchanges: project,
    };
    const compact = jest.fn<CompactorPort['compact']>(async () => { ordering.push('compact'); return compacted(compactedProjection, 17); });
    const { actor, root } = actorHarness(role, agentId, provider, compact);
    if (role === 'analyst') appendAnalystIngressBatch({ projectRoot: root }, INITIAL_INPUT_ID, source.content, trigger.content);
    else appendConversationBatch({ projectRoot: root }, [source, trigger]);
    const initial = input(role, agentId, firstProjection);

    await expect(directTurn(actor, initial)).resolves.toMatchObject({ type: 'result', result: { content: 'done' } });

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]![0]).toMatchObject({ strategy: 'authoritative_context_recovery', input: { inputId: initial.inputId } });
    expect(providerCalls).toHaveLength(2);
    expect(ordering).toEqual(['provider-1', 'compact', 'provider-2']);
    const { providerConversation: _firstProjection, ...firstFields } = providerCalls[0]!;
    const { providerConversation: _secondProjection, ...secondFields } = providerCalls[1]!;
    expect(secondFields).toEqual(firstFields);
    expect(providerCalls[1]!.providerConversation).toEqual(compactedProjection);
    expect(project).toHaveBeenCalledTimes(1);
    expect(project.mock.calls[0]![2].map((attempt) => [attempt.status, attempt.attempt_index])).toEqual([['error', 0], ['ok', 1]]);
    const rows = readConversation(root, agentId).physicalRows;
    expect(rows.filter((row) => row.content === 'logical input')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'model_issue')).toHaveLength(0);
    expect(rows.filter((row) => row.role === 'assistant' && row.kind === 'text')).toHaveLength(1);
  });

  it('allows one independent recovery for each fresh plain-text continuation input', async () => {
    const agentId = 'planner:project';
    const seenInputIds: string[] = [];
    const callsByInput = new Map<string, number>();
    const provider: LLMProviderPort = {
      completeTurn: async (value) => {
        seenInputIds.push(value.inputId);
        const ordinal = (callsByInput.get(value.inputId) ?? 0) + 1;
        callsByInput.set(value.inputId, ordinal);
        if (ordinal === 1) throw contextFailure(value, 'context');
        return completion(value, { kind: 'message', content: value.inputId === INITIAL_INPUT_ID ? 'first' : 'second' });
      },
      projectProviderExchanges: jest.fn(),
    };
    const compact = jest.fn<CompactorPort['compact']>(async ({ input: value }) => compacted({ sourceSessionId: agentId, messages: value.providerConversation.messages }, 10));
    const { actor } = actorHarness('planner', agentId, provider, compact);

    await directTurn(actor, input('planner', agentId, { sourceSessionId: agentId, messages: [] }));
    await actor.continueAfterPlainText('repair', undefined, terminalHandoff);

    expect(new Set(seenInputIds).size).toBe(2);
    for (const count of callsByInput.values()) expect(count).toBe(2);
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it('grants a fresh single recovery allowance to a tool-result continuation', async () => {
    const agentId = 'planner:project';
    const inputs: LlmInvocationInput[] = [];
    const provider: LLMProviderPort = {
      completeTurn: async (value) => {
        inputs.push(value);
        if (inputs.length === 1) return completion(value, { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] });
        if (inputs.length === 2) throw contextFailure(value, 'continuation context');
        return completion(value, { kind: 'message', content: 'continued' });
      },
      projectProviderExchanges: jest.fn(),
    };
    const compact = jest.fn<CompactorPort['compact']>(async ({ input: value }) => compacted(value.providerConversation, 10));
    const { actor, root } = actorHarness('planner', agentId, provider, compact);

    const tool = await directTurn(actor, input('planner', agentId, { sourceSessionId: agentId, messages: [] }));
    if (tool.type !== 'tool_call') throw new Error('Expected tool call.');
    await actor.appendToolResult(tool.toolCallId, { success: true, data: { content: 'result' } });

    expect(inputs).toHaveLength(3);
    expect(inputs[1]!.inputId).toBe(inputs[2]!.inputId);
    expect(inputs[1]!.inputId).not.toBe(inputs[0]!.inputId);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(readConversation(root, agentId).physicalRows.filter((row) => row.kind === 'tool_result')).toHaveLength(1);
  });

  it('settles a second context rejection once with the exact exhausted diagnostic and combined attempts', async () => {
    const agentId = 'planner:project';
    let calls = 0;
    const project = jest.fn<NonNullable<LLMProviderPort['projectProviderExchanges']>>();
    const provider: LLMProviderPort = {
      completeTurn: async (value) => { calls += 1; throw contextFailure(value, `context-${calls}`); },
      projectProviderExchanges: project,
    };
    const { actor, root } = actorHarness('planner', agentId, provider, jest.fn(async () => compacted({ sourceSessionId: agentId, messages: [] }, 23)));

    await expect(directTurn(actor, input('planner', agentId, { sourceSessionId: agentId, messages: [] }))).resolves.toEqual({
      type: 'error',
      agentId,
      error: 'Provider input context remained exhausted after one forced compacted retry (first_pass_attempts=1, second_pass_attempts=1, compacted_estimated_message_tokens=23).',
    });
    expect(calls).toBe(2);
    expect(project).toHaveBeenCalledTimes(1);
    expect(project.mock.calls[0]![2].map((attempt) => attempt.attempt_index)).toEqual([0, 1]);
    expect(readConversation(root, agentId).physicalRows.filter((row) => row.kind === 'model_issue')).toHaveLength(1);
  });

  it('preserves a non-context second-pass failure while combining both route passes once', async () => {
    const agentId = 'planner:project';
    let calls = 0;
    const project = jest.fn<NonNullable<LLMProviderPort['projectProviderExchanges']>>();
    const provider: LLMProviderPort = {
      completeTurn: async (value) => {
        calls += 1;
        if (calls === 1) throw contextFailure(value, 'context');
        throw providerFailure(value, new LlmRequestError({ kind: 'auth_permanent', provider: 'test', status: 401, message: 'permanent auth' }), 401);
      },
      projectProviderExchanges: project,
    };
    const { actor } = actorHarness('planner', agentId, provider, jest.fn(async () => compacted({ sourceSessionId: agentId, messages: [] }, 12)));

    await expect(directTurn(actor, input('planner', agentId, { sourceSessionId: agentId, messages: [] }))).resolves.toMatchObject({ type: 'error', error: 'permanent auth' });
    expect(calls).toBe(2);
    expect(project).toHaveBeenCalledTimes(1);
    expect(project.mock.calls[0]![2].map((attempt) => [attempt.response_status, attempt.attempt_index])).toEqual([[400, 0], [401, 1]]);
  });

  it('turns clean no-smaller and summary construction failure into one normal model issue without retry', async () => {
    const cases = [
      {
        expected: 'Provider input context exhausted; last-chance compaction found no strictly smaller safe provider projection, so no provider retry was attempted.',
        compact: jest.fn<CompactorPort['compact']>(async () => ({ kind: 'no_smaller_projection', rejectedEstimatedProviderMessageTokens: 10, smallestCandidateEstimatedProviderMessageTokens: 10 })),
      },
      {
        expected: 'Provider input context exhausted; last-chance compaction failed while constructing a smaller projection: summary failed. No provider retry was attempted.',
        compact: jest.fn<CompactorPort['compact']>(async () => { throw new CompactionSummaryConstructionError(new Error('summary failed')); }),
      },
    ];
    for (const testCase of cases) {
      const agentId = 'planner:project';
      const provider = contextOnlyProvider();
      const { actor, root } = actorHarness('planner', agentId, provider, testCase.compact);
      await expect(directTurn(actor, input('planner', agentId, { sourceSessionId: agentId, messages: [] }))).resolves.toEqual({ type: 'error', agentId, error: testCase.expected });
      expect(provider.completeTurn).toHaveBeenCalledTimes(1);
      expect(provider.projectProviderExchanges).toHaveBeenCalledTimes(1);
      expect(readConversation(root, agentId).physicalRows.filter((row) => row.kind === 'model_issue')).toHaveLength(1);
    }
  });

  it.each(['projection', 'validation', 'append'] as const)('bypasses normal provider failure settlement for fatal %s errors', async (kind) => {
    const agentId = 'planner:project';
    const cause = new Error(`${kind} fatal`);
    const provider = contextOnlyProvider();
    const completionValue: ProviderTurnCompletion = { result: { kind: 'message', content: 'summary' }, provider_exchanges: [] };
    const thrown = kind === 'projection'
      ? new SummarizerExchangeProjectionError(cause, completionValue)
      : kind === 'append'
        ? new CompactionAppendError(cause)
        : cause;
    const compact = jest.fn<CompactorPort['compact']>(async () => { throw thrown; });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { actor, root } = actorHarness('planner', agentId, provider, compact);

    await expect(directTurn(actor, input('planner', agentId, { sourceSessionId: agentId, messages: [] }))).rejects.toBe(kind === 'append' ? cause : thrown);
    expect(provider.completeTurn).toHaveBeenCalledTimes(1);
    expect(provider.projectProviderExchanges).not.toHaveBeenCalled();
    expect(readConversation(root, agentId).physicalRows.filter((row) => row.kind === 'model_issue')).toHaveLength(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('propagates exact cancellation during forced compaction without model issue or exchange projection', async () => {
    const agentId = 'planner:project';
    const controller = new AbortController();
    const reason = new Error('cancel recovery');
    const provider = contextOnlyProvider();
    const compact = jest.fn<CompactorPort['compact']>(async () => { controller.abort(reason); throw reason; });
    const { actor, root } = actorHarness('planner', agentId, provider, compact);

    await expect(directTurn(actor, input('planner', agentId, { sourceSessionId: agentId, messages: [] }), controller.signal)).rejects.toBe(reason);
    expect(provider.projectProviderExchanges).not.toHaveBeenCalled();
    expect(readConversation(root, agentId).physicalRows.filter((row) => row.kind === 'model_issue')).toHaveLength(0);
  });

  it('propagates cancellation arriving after compaction returns and before pass two', async () => {
    const agentId = 'planner:project';
    const controller = new AbortController();
    const reason = new Error('cancel after compaction append');
    const provider = contextOnlyProvider();
    const compact = jest.fn<CompactorPort['compact']>(async () => {
      controller.abort(reason);
      return compacted({ sourceSessionId: agentId, messages: [] }, 10);
    });
    const { actor, root } = actorHarness('planner', agentId, provider, compact);

    await expect(directTurn(actor, input('planner', agentId, { sourceSessionId: agentId, messages: [] }), controller.signal)).rejects.toBe(reason);
    expect(provider.completeTurn).toHaveBeenCalledTimes(1);
    expect(provider.projectProviderExchanges).not.toHaveBeenCalled();
    expect(readConversation(root, agentId).physicalRows.filter((row) => row.kind === 'model_issue')).toHaveLength(0);
  });

  it('fails fatally on a returned compaction source-identity invariant without provider retry or model issue', async () => {
    const agentId = 'planner:project';
    const provider = contextOnlyProvider();
    const compact = jest.fn<CompactorPort['compact']>(async () => compacted({ sourceSessionId: 'reviewer:project', messages: [] }, 10));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { actor, root } = actorHarness('planner', agentId, provider, compact);

    await expect(directTurn(actor, input('planner', agentId, { sourceSessionId: agentId, messages: [] }))).rejects.toThrow(/Compaction changed provider conversation source session/);
    expect(provider.completeTurn).toHaveBeenCalledTimes(1);
    expect(provider.projectProviderExchanges).not.toHaveBeenCalled();
    expect(readConversation(root, agentId).physicalRows.filter((row) => row.kind === 'model_issue')).toHaveLength(0);
  });

  it.each([
    ['ok exchange', (value: LlmInvocationInput) => new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [exchange(value.inputId, 'ok', 200)], originalFailure: contextError('contradiction') })],
    ['terminal tool', (value: LlmInvocationInput) => new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [{ ...exchange(value.inputId, 'error', 400), terminal_tool_fired: 'emit_result' }], originalFailure: contextError('contradiction') })],
    ['empty exchanges', () => new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [], originalFailure: contextError('contradiction') })],
  ] as Array<[string, (input: LlmInvocationInput) => ProviderTurnFailure]>)('fails closed without replay for contradictory context metadata: %s', async (_label, failure) => {
    const agentId = 'planner:project';
    const provider: LLMProviderPort = { completeTurn: jest.fn<LLMProviderPort['completeTurn']>(async (value) => { throw failure(value); }), projectProviderExchanges: jest.fn() };
    const compact = jest.fn<CompactorPort['compact']>();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { actor, root } = actorHarness('planner', agentId, provider, compact);

    await expect(directTurn(actor, input('planner', agentId, { sourceSessionId: agentId, messages: [] }))).rejects.toBeInstanceOf(Error);
    expect(provider.completeTurn).toHaveBeenCalledTimes(1);
    expect(compact).not.toHaveBeenCalled();
    expect(provider.projectProviderExchanges).not.toHaveBeenCalled();
    expect(readConversation(root, agentId).physicalRows.filter((row) => row.kind === 'model_issue')).toHaveLength(0);
  });

  it.each([
    ['message', { kind: 'message', content: 'accepted' } as LlmCompleteResult],
    ['tool call', { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] } as LlmCompleteResult],
  ])('never replays an accepted provider %s completion', async (_label, result) => {
    const agentId = 'planner:project';
    const provider: LLMProviderPort = { completeTurn: jest.fn<LLMProviderPort['completeTurn']>(async (value) => completion(value, result)), projectProviderExchanges: jest.fn() };
    const compact = jest.fn<CompactorPort['compact']>();
    const { actor } = actorHarness('planner', agentId, provider, compact);

    await expect(directTurn(actor, input('planner', agentId, { sourceSessionId: agentId, messages: [] }))).resolves.toMatchObject({ type: result.kind === 'message' ? 'result' : 'tool_call' });
    expect(provider.completeTurn).toHaveBeenCalledTimes(1);
    expect(compact).not.toHaveBeenCalled();
  });

  it('does not replay after completion persistence begins, even when exchange projection fails', async () => {
    const agentId = 'planner:project';
    const projectionFailure = new Error('completion projection failed');
    const provider: LLMProviderPort = {
      completeTurn: jest.fn<LLMProviderPort['completeTurn']>(async (value) => completion(value, { kind: 'message', content: 'accepted' })),
      projectProviderExchanges: jest.fn(() => { throw projectionFailure; }),
    };
    const compact = jest.fn<CompactorPort['compact']>();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { actor, root } = actorHarness('planner', agentId, provider, compact);

    await expect(directTurn(actor, input('planner', agentId, { sourceSessionId: agentId, messages: [] }))).rejects.toBe(projectionFailure);
    expect(provider.completeTurn).toHaveBeenCalledTimes(1);
    expect(compact).not.toHaveBeenCalled();
    expect(readConversation(root, agentId).physicalRows.filter((row) => row.role === 'assistant' && row.kind === 'text')).toHaveLength(1);
  });
});

function actorHarness(role: OperationalAgentRole, agentId: ConversationSessionId, provider: LLMProviderPort, compact: CompactorPort['compact']) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-last-chance-'));
  initProjectTree(root);
  if (role === 'executor') {
    const card = new CardService(root).create({
      type: 'code',
      parent: 'project',
      title: 'Executor card',
      brief: 'Execute the test.',
      tags: [],
      priority: 0,
      urgency: 'normal',
      created_by: 'planner',
      depends_on: [],
      related: [],
    });
    expect(agentId).toBe(`executor:${card.id}`);
  }
  roots.push(root);
  const actor = new ConversationLLMActor({
    projectRoot: root,
    agentId,
    provider,
    conversations: { projectRoot: root },
    runtimeProjectionChanged() {},
    compactor: { shouldCompact: () => false, compact },
    summarizerProvider: { completeTurn: jest.fn() as never, projectProviderExchanges: jest.fn() },
  });
  expect(role).toBe(agentId.split(':')[0]);
  return { actor, root };
}

const terminalHandoff = (): void => undefined;
function directTurn(actor: ConversationLLMActor, value: PreparedLlmInvocationInput, signal?: AbortSignal) { return actor.turn(value, signal, terminalHandoff); }

function input(role: OperationalAgentRole, agentId: ConversationSessionId, providerConversation: LlmInvocationInput['providerConversation']): PreparedLlmInvocationInput {
  return {
    inputId: INITIAL_INPUT_ID, agentId, role, sessionId: agentId, systemPrompt: 'system', providerConversation,
    tools: [], terminalToolNames: [], modelParams: {},
    preparedCompaction: prepareCompaction({ input_budget_tokens: 10_000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'compact_straddler' }, 'system', []),
    capabilityRequest: {}, episodeContext: {},
  };
}

function contextOnlyProvider() {
  return { completeTurn: jest.fn<LLMProviderPort['completeTurn']>(async (value) => { throw contextFailure(value, 'context'); }), projectProviderExchanges: jest.fn<NonNullable<LLMProviderPort['projectProviderExchanges']>>() };
}

function contextError(message: string): LlmRequestError {
  return new LlmRequestError({ kind: 'input_context_exhausted', provider: 'test', status: 400, message });
}

function contextFailure(value: LlmInvocationInput, message: string): ProviderTurnFailure {
  return providerFailure(value, contextError(message), 400);
}

function providerFailure(value: LlmInvocationInput, originalFailure: LlmRequestError, status: number): ProviderTurnFailure {
  return new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [exchange(value.inputId, 'error', status)], originalFailure });
}

function completion(value: LlmInvocationInput, result: LlmCompleteResult): ProviderTurnCompletion {
  return { result, provider_exchanges: [exchange(value.inputId, 'ok', 200)] };
}

function exchange(inputId: string, status: 'ok' | 'error', responseStatus: number): ProviderExchangeAttempt {
  const base = { contract_id: 'test.v1', contract_name: 'test', transport: 'generic' as const, provider: 'test', model: 'model', source_input_id: inputId, attempt_index: 0, request_params: {}, started_at: '2026-07-17T00:00:00.000Z', completed_at: '2026-07-17T00:00:00.001Z', response_status: responseStatus, terminal_tool_fired: null };
  return status === 'ok' ? { ...base, status } : { ...base, status, error: { name: 'LlmRequestError', message: 'failed', status: responseStatus } };
}

function compacted(providerConversation: LlmInvocationInput['providerConversation'], estimatedProviderMessageTokens: number) {
  return {
    kind: 'compacted' as const,
    providerConversation,
    compactionMessage: message(parseConversationSessionId(providerConversation.sourceSessionId), 'compaction', 'system', '{}'),
    estimatedProviderMessageTokens,
  };
}

function message(sessionId: ConversationSessionId, id: string, role: AgentMessage['role'], content: string): AgentMessage {
  return agentMessageSchema.parse({ id, session_id: sessionId, role, kind: 'text', content, round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-17T00:00:00.000Z' });
}
