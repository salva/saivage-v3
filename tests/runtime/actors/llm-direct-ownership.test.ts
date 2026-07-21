import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationLLMActor, type AnalystCancellationClaim, type CompactorPort, type LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import { prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import type { PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';
import type { ConversationEntryObservation } from '../../../src/persistence/conversation-file.js';
import type { CanonicalLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { initProjectTree } from '../../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('direct conversation LLM ownership', () => {
  it('keeps conversation, provider evidence, exact terminal handoff, and direct delivery ordered when disposal re-enters publication', async () => {
    const root = project();
    const trace: string[] = [];
    const disposed = new Error('dispose during completion publication');
    let actor!: ConversationLLMActor;
    const input = preparedInput();
    actor = llm(root, {
      completeTurn: async () => ({ result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [exchange(input.inputId)] }),
      projectProviderExchanges: (_session, source, _attempts, outputs) => { trace.push(`evidence:${source}:${outputs.join(',')}`); },
    }, {
      changes: {
        conversationChanged: () => trace.push('conversationChanged'),
        agentsChanged: () => trace.push('agentsChanged'),
      } as never,
      observeEntry: (entry: ConversationEntryObservation) => {
        if (entry.id === `${input.inputId}:message`) {
          trace.push('message-observed');
          expect(actor.dispose(disposed)).toBe('joining_owned_completion');
        }
      },
    });

    const terminal = jest.fn((completion: { input: PreparedLlmInvocationInput }) => {
      expect(completion.input).toBe(input);
      trace.push(`handoff:${completion.input.inputId}`);
    });
    const turn = actor.turn(input, undefined, terminal as never);
    turn.then(() => trace.push('delivery'));

    await expect(turn).resolves.toMatchObject({ type: 'result', result: { content: 'done' } });
    await expect(actor.join()).resolves.toEqual({ status: 'joined' });
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(trace).toEqual([
      'conversationChanged', 'agentsChanged', // llm_turn_started
      'conversationChanged', 'agentsChanged', 'message-observed',
      `evidence:${input.inputId}:${input.inputId}:message`,
      `handoff:${input.inputId}`,
      'delivery',
    ]);
  });

  it('propagates provider-exchange failure exactly and performs no terminal handoff or result delivery', async () => {
    const root = project();
    const input = preparedInput();
    const evidenceFailure = new Error('provider evidence append failed');
    const terminal = jest.fn();
    const actor = llm(root, {
      completeTurn: async () => ({ result: { kind: 'message' as const, content: 'committed' }, provider_exchanges: [exchange(input.inputId)] }),
      projectProviderExchanges: () => { throw evidenceFailure; },
    });

    const turn = actor.turn(input, undefined, terminal);
    await expect(turn).rejects.toBe(evidenceFailure);
    expect(terminal).not.toHaveBeenCalled();
    expect(readConversation(root, input.sessionId).physicalRows).toContainEqual(expect.objectContaining({ id: `${input.inputId}:message`, content: 'committed' }));
  });

  it('returns and observes the same direct promise when an arming callback fails synchronously', async () => {
    const root = project();
    const failure = new Error('projection failed while arming');
    const provider = jest.fn<LLMProviderPort['completeTurn']>();
    const actor = llm(root, { completeTurn: provider }, {}, () => { throw failure; });

    let turn!: Promise<unknown>;
    expect(() => { turn = actor.turn(preparedInput(), undefined, jest.fn()); }).not.toThrow();
    await expect(turn).rejects.toBe(failure);
    expect(provider).not.toHaveBeenCalled();
    actor.dispose(new Error('test cleanup'));
    await expect(actor.join()).resolves.toEqual({ status: 'joined' });
  });

  it('lets cancellation re-enter the tool-result writer, persists the caller result once, and appends one parked-source notice', async () => {
    const root = project();
    const input = preparedInput();
    let actor!: ConversationLLMActor;
    let cancellationDisposition: unknown;
    const claims: Array<{ input: CanonicalLlmInvocationInput; reason: string }> = [];
    const markPublished = jest.fn();
    const cancellation: AnalystCancellationClaim = (claimed, reason) => { claims.push({ input: claimed, reason }); return Object.freeze({ markPublished }); };
    actor = llm(root, toolProvider(), {
      observeEntry: (entry: ConversationEntryObservation) => {
        if (entry.id === `${input.inputId}:tool-result:call`) cancellationDisposition = actor.requestCancellation('operator');
      },
    });
    const parked = await actor.turn(input, undefined, jest.fn(), cancellation);
    if (parked.type !== 'tool_call') throw new Error('Expected a tool call.');

    const settlement = actor.appendToolResult('call', { success: true, data: { value: 1 } });
    await expect(settlement).rejects.toThrow('operator');
    expect(cancellationDisposition).toEqual({ kind: 'claimed', input, publicationOwnedByLlm: true });
    expect(claims).toEqual([{ input, reason: 'operator' }]);
    expect(markPublished).toHaveBeenCalledTimes(1);
    const rows = readConversation(root, input.sessionId).physicalRows;
    expect(rows.filter((row) => row.id === `${input.inputId}:tool-result:call`)).toHaveLength(1);
    expect(rows.filter((row) => row.id === `${input.inputId}:message`)).toEqual([expect.objectContaining({ content: 'Cancelled: operator' })]);
  });

  it('uses the fresh continuation source when cancellation wins from the continuation hook', async () => {
    const root = project();
    const input = preparedInput();
    let actor!: ConversationLLMActor;
    let continuationId = '';
    let claimedInputId = '';
    const markPublished = jest.fn();
    actor = llm(root, toolProvider());
    const parked = await actor.turn(input, undefined, jest.fn(), (claimed) => { claimedInputId = claimed.inputId; return Object.freeze({ markPublished }); });
    if (parked.type !== 'tool_call') throw new Error('Expected a tool call.');

    const settlement = actor.appendToolResult('call', { success: true }, undefined, (freshId) => {
      continuationId = freshId;
      expect(actor.requestCancellation('hook cancellation')).toMatchObject({ kind: 'claimed', input: { inputId: freshId } });
      return { messages: [{ role: 'user', content: 'must not be appended' }], afterAppend: jest.fn() };
    });
    await expect(settlement).rejects.toThrow('hook cancellation');
    expect(continuationId).not.toBe(input.inputId);
    expect(claimedInputId).toBe(continuationId);
    expect(markPublished).toHaveBeenCalledTimes(1);
    const rows = readConversation(root, input.sessionId).physicalRows;
    expect(rows).toContainEqual(expect.objectContaining({ id: `${input.inputId}:tool-result:call` }));
    expect(rows).toContainEqual(expect.objectContaining({ id: `${continuationId}:message`, content: 'Cancelled: hook cancellation' }));
    expect(rows.some((row) => row.content === 'must not be appended')).toBe(false);
    expect(rows.some((row) => row.id === `${continuationId}:tool-result:call`)).toBe(false);
  });

  it('finishes one continuation-context batch when cancellation re-enters its observer, then suppresses afterAppend and provider admission', async () => {
    const root = project();
    const input = preparedInput();
    let actor!: ConversationLLMActor;
    let continuationId = '';
    let cancellation: unknown;
    let contextObservations = 0;
    const afterAppend = jest.fn();
    const provider = toolProvider();
    actor = llm(root, provider, {
      observeEntry: (entry: ConversationEntryObservation) => {
        if (entry.role !== 'user' || entry.kind !== 'text') return;
        contextObservations += 1;
        if (contextObservations === 1) cancellation = actor.requestCancellation('context observer');
      },
    });
    const parked = await actor.turn(input, undefined, jest.fn(), () => Object.freeze({ markPublished: jest.fn() }));
    if (parked.type !== 'tool_call') throw new Error('Expected a tool call.');

    const settlement = actor.appendToolResult('call', { success: true }, undefined, (freshId) => {
      continuationId = freshId;
      return { messages: [{ role: 'user', content: 'context one' }, { role: 'user', content: 'context two' }], afterAppend };
    });
    await expect(settlement).rejects.toThrow('context observer');
    expect(cancellation).toMatchObject({ kind: 'claimed', input: { inputId: continuationId } });
    expect(contextObservations).toBe(2);
    expect(afterAppend).not.toHaveBeenCalled();
    expect(provider.completeTurn).toHaveBeenCalledTimes(1);
    const rows = readConversation(root, input.sessionId).physicalRows;
    expect(rows.filter((row) => row.content === 'context one' || row.content === 'context two')).toHaveLength(2);
    expect(rows).toContainEqual(expect.objectContaining({ id: `${continuationId}:message`, content: 'Cancelled: context observer' }));
  });

  it('lets a tool-result observer failure beat its re-entrant cancellation without a notice or markPublished', async () => {
    const root = project();
    const input = preparedInput();
    const observerFailure = new Error('tool result observer failed');
    const markPublished = jest.fn();
    let actor!: ConversationLLMActor;
    actor = llm(root, toolProvider(), {
      observeEntry: (entry: ConversationEntryObservation) => {
        if (entry.id !== `${input.inputId}:tool-result:call`) return;
        expect(actor.requestCancellation('losing cancellation')).toMatchObject({ kind: 'claimed' });
        throw observerFailure;
      },
    });
    const parked = await actor.turn(input, undefined, jest.fn(), () => Object.freeze({ markPublished }));
    if (parked.type !== 'tool_call') throw new Error('Expected a tool call.');

    await expect(actor.appendToolResult('call', { success: true })).rejects.toMatchObject({ cause: observerFailure });
    expect(markPublished).not.toHaveBeenCalled();
    const rows = readConversation(root, input.sessionId).physicalRows;
    expect(rows.filter((row) => row.id === `${input.inputId}:tool-result:call`)).toHaveLength(1);
    expect(rows.filter((row) => row.id === `${input.inputId}:message`)).toHaveLength(0);
  });

  it('preserves disposal-first precedence during the tool-result writer', async () => {
    const root = project();
    const input = preparedInput();
    const reason = new Error('disposed first');
    let actor!: ConversationLLMActor;
    let cancellation: unknown;
    actor = llm(root, toolProvider(), {
      observeEntry: (entry: ConversationEntryObservation) => {
        if (entry.id !== `${input.inputId}:tool-result:call`) return;
        expect(actor.dispose(reason)).toBe('joining_owned_completion');
        cancellation = actor.requestCancellation('losing cancellation');
      },
    });
    const parked = await actor.turn(input, undefined, jest.fn(), () => Object.freeze({ markPublished: jest.fn() }));
    if (parked.type !== 'tool_call') throw new Error('Expected a tool call.');

    await expect(actor.appendToolResult('call', { success: true })).rejects.toBe(reason);
    expect(cancellation).toEqual({ kind: 'not_claimed' });
    const rows = readConversation(root, input.sessionId).physicalRows;
    expect(rows.filter((row) => row.id === `${input.inputId}:tool-result:call`)).toHaveLength(1);
    expect(rows.filter((row) => row.id.endsWith(':message'))).toHaveLength(0);
  });

  it('finishes an entered plain-text repair writer but suppresses continuation after re-entrant disposal', async () => {
    const root = project();
    const input = preparedInput();
    const reason = new Error('disposed during repair');
    const provider = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'plain' }, provider_exchanges: [] }));
    let actor!: ConversationLLMActor;
    actor = llm(root, { completeTurn: provider }, {
      observeEntry: (entry: ConversationEntryObservation) => { if (entry.kind === 'model_repair') actor.dispose(reason); },
    });
    await actor.turn(input, undefined, jest.fn());

    let repair!: Promise<unknown>;
    expect(() => { repair = actor.continueAfterPlainText('repair now', undefined, jest.fn()); }).not.toThrow();
    await expect(repair).rejects.toBe(reason);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(readConversation(root, input.sessionId).physicalRows.filter((row) => row.kind === 'model_repair')).toHaveLength(1);
  });

  it('keeps an admitted publication-unknown child lease in the direct join until supervisor containment', async () => {
    const root = project();
    const actor = llm(root, toolProvider());
    const parked = await actor.turn(preparedInput(), undefined, jest.fn());
    if (parked.type !== 'tool_call') throw new Error('Expected a tool call.');
    const lease = actor.toolInvocationContext(parked).childInvocation.reserveChild('card-a');
    lease.markAdmitted();
    lease.markPublicationUnknown();
    actor.dispose(new Error('owner disposed'));
    let joined = false;
    const joinTask = actor.join().then((value) => { joined = true; return value; });
    await Promise.resolve();
    expect(joined).toBe(false);
    lease.markContained();
    lease.deliverInterruption(new Error('supervisor contained child'));
    await expect(lease.activation).rejects.toThrow('supervisor contained child');
    await expect(joinTask).resolves.toEqual({ status: 'joined' });
  });
});

function project(): string { const root = mkdtempSync(join(tmpdir(), 'saivage-llm-direct-')); roots.push(root); initProjectTree(root); return root; }

function llm(root: string, provider: LLMProviderPort, conversations: Record<string, unknown> = {}, runtimeProjectionChanged?: () => void): ConversationLLMActor {
  return new ConversationLLMActor({
    projectRoot: root,
    agentId: 'planner:project',
    provider,
    conversations: { projectRoot: root, ...conversations },
    compactor: { shouldCompact: () => false, compact: jest.fn<CompactorPort['compact']>() },
    summarizerProvider: { completeTurn: jest.fn<LLMProviderPort['completeTurn']>(), projectProviderExchanges: jest.fn() },
    runtimeProjectionChanged,
  });
}

function toolProvider(): LLMProviderPort {
  return { completeTurn: jest.fn(async () => ({ result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'call', type: 'function' as const, function: { name: 'read', arguments: '{}' } }] }, provider_exchanges: [] })) };
}

function preparedInput(): PreparedLlmInvocationInput {
  const inputId = '00000000-0000-4000-8000-000000000041';
  const systemPrompt = 'system';
  return {
    inputId, agentId: 'planner:project', role: 'planner', sessionId: 'planner:project', systemPrompt,
    providerConversation: { sourceSessionId: 'planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: {},
    preparedCompaction: prepareCompaction({ input_budget_tokens: 10_000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'compact_straddler' }, systemPrompt, []),
    capabilityRequest: {}, episodeContext: {},
  };
}

function exchange(inputId: string) {
  return { contract_id: 'planner.v1', contract_name: 'planner', transport: 'generic' as const, provider: 'test', model: 'model', source_input_id: inputId, attempt_index: 0, request_params: {}, started_at: '2026-07-21T00:00:00.000Z', completed_at: '2026-07-21T00:00:00.001Z', status: 'ok' as const, response_status: 200, terminal_tool_fired: null };
}
